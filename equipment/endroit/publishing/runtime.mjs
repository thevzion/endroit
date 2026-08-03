#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, rename, rm, rmdir, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'

const MIGRATION = 'editorial-work-v1'
const FORMATS = new Set(['article', 'landing', 'proposal', 'profile', 'thread', 'post', 'comment'])
const STABILITIES = new Set(['living', 'release-aligned', 'dated', 'historical'])
const CANDIDATE_STATES = new Set(['draft', 'in_review', 'selected', 'declined', 'superseded'])
const LINEAGES = new Set(['root', 'iteration', 'alternative', 'synthesis'])
const WORK_STATES = new Set(['draft', 'active', 'paused', 'complete'])
let writes = 0

try {
  const input = JSON.parse(await stdin())
  const { positionals, flags } = argumentsOf(input.argv)
  const [command, ...rest] = positionals
  let value
  if (flags.help) value = { status: 'help', text: help(command) }
  else if (command === 'list') value = await list(input, flags)
  else if (command === 'inspect') value = await inspect(input, required(rest[0], 'Reference'))
  else if (command === 'validate') value = await validate(input, rest[0])
  else if (command === 'migrate') value = await migrate(input, required(rest[0], 'Migration'), required(rest[1], 'Phase'))
  else throw failure('usage', 'endroit publishing list|inspect|validate|migrate', 2)
  process.stdout.write(flags.json ? `${JSON.stringify(value, null, 2)}\n` : `${human(value)}\n`)
} catch (error) {
  process.stderr.write(`${error.code ?? 'publishing_failed'}: ${error.message}\n`)
  process.exitCode = error.exitCode ?? 4
}

async function migrate(input, migration, phase) {
  if (migration !== MIGRATION) throw failure('migration_unknown', `Unknown migration ${migration}.`, 2)
  if (phase === 'inspect') return inspectMigration(input)
  if (phase === 'prepare') return prepare(input)
  if (phase === 'apply') return apply(input)
  if (phase === 'verify') return verifyMigration(input)
  if (phase === 'cutover') return cutover(input)
  if (phase === 'rollback') return rollback(input)
  throw failure('migration_phase_unknown', `Unknown ${MIGRATION} phase ${phase}.`, 2)
}

async function inspectMigration(input) {
  const mappings = await loadMappings(input)
  const mappedRefs = mappedLegacyRefs(mappings)
  const rooms = []
  for (const mapping of mappings) {
    const inventory = await inventoryRoom(input, mapping, mappedRefs)
    const manifest = await readJson(manifestPath(input, mapping.room), null)
    rooms.push({
      room: mapping.room,
      state: manifest?.state ?? 'unprepared',
      works: mapping.works.length,
      candidates: mapping.works.flatMap(({ candidates }) => candidates).length,
      mappedPublications: mapping.works.flatMap(({ publications }) => publications).length,
      publications: inventory.publicationIds.length,
      legacyPublications: inventory.legacyPublicationIds.length,
      sourceFiles: inventory.sourceFiles.length,
      handles: inventory.handles.length,
      retainedHandles: inventory.retainedHandles.length,
      supportFiles: inventory.support.length,
      missing: inventory.missing,
      unmapped: inventory.unmapped,
    })
  }
  return { status: 'inspected', migration: MIGRATION, totals: totals(mappings), rooms }
}

async function prepare(input) {
  const mappings = await loadMappings(input)
  const mappedRefs = mappedLegacyRefs(mappings)
  const inspection = await inspectMigration(input)
  assertBaseline(inspection)
  const existing = await Promise.all(mappings.map(({ room }) => readJson(manifestPath(input, room), null)))
  if (existing.every((manifest) => manifest && ['prepared', 'applied', 'verified', 'cutover', 'rolled_back'].includes(manifest.state))) {
    return { status: 'prepared', migration: MIGRATION, unchanged: true, totals: inspection.totals }
  }
  if (existing.some(Boolean)) throw failure('migration_state_mixed', 'Prepare requires either all discovered manifests or none.')

  const completed = []
  const stages = []
  try {
    for (const mapping of mappings) {
      const inventory = await inventoryRoom(input, mapping, mappedRefs)
      const root = migrationRoot(input, mapping.room)
      const legacy = join(root, 'legacy')
      if (await exists(legacy)) throw failure('snapshot_exists', `${rel(input, legacy)} already exists without a manifest.`)
      const stage = join(root, `.legacy-stage-${process.pid}`)
      const entry = { legacy, manifest: manifestPath(input, mapping.room) }
      completed.push(entry)
      stages.push(stage)
      await rm(stage, { recursive: true, force: true })
      const snapshot = []
      for (const source of [...inventory.sourceFiles, ...inventory.handles]) {
        const sourceRelative = rel(input, source)
        const publishingRelative = relative(publishingRoot(input, mapping.room), source)
        const target = join(stage, publishingRelative)
        const bytes = await readRegular(source)
        await writeAtomic(target, bytes)
        injectFailure()
        snapshot.push({
          source: sourceRelative,
          snapshot: rel(input, join(legacy, publishingRelative)),
          size: bytes.length,
          sha256: digest(bytes),
        })
      }
      await rename(stage, legacy)
      injectFailure()
      const manifest = {
        version: 1,
        migration: MIGRATION,
        room: mapping.room,
        state: 'prepared',
        prepared_at: mapping.migration_at,
        baseline: {
          publications: inventory.publicationIds.length,
          source_files: inventory.sourceFiles.length,
          handles: inventory.handles.length,
          support_files: inventory.support.length,
        },
        snapshot,
        support: inventory.support,
        created_paths: [],
        modified_paths: [],
      }
      await writeJsonAtomic(entry.manifest, manifest)
      injectFailure()
    }
  } catch (error) {
    for (const stage of stages) await rm(stage, { recursive: true, force: true })
    for (const entry of completed) {
      await rm(entry.legacy, { recursive: true, force: true })
      await rm(entry.manifest, { force: true })
    }
    throw error
  }
  return { status: 'prepared', migration: MIGRATION, totals: inspection.totals, snapshotFiles: inspection.rooms.reduce((sum, room) => sum + room.sourceFiles + room.handles, 0) }
}

async function apply(input) {
  const mappings = await loadMappings(input)
  const manifests = await loadManifests(input, mappings)
  if (manifests.every(({ state }) => ['applied', 'verified', 'cutover'].includes(state))) {
    return { status: 'applied', migration: MIGRATION, unchanged: true, totals: totals(mappings) }
  }
  assertStates(manifests, ['prepared', 'rolled_back'], 'apply')
  await assertSnapshots(input, manifests)
  const handleIndex = await indexHandles(input, manifests)
  const created = []
  const stages = []
  try {
    for (const mapping of mappings) {
      const stage = join(migrationRoot(input, mapping.room), `.apply-stage-${process.pid}`)
      stages.push(stage)
      await rm(stage, { recursive: true, force: true })
      await mkdir(stage, { recursive: true })
      for (const work of mapping.works) await stageWork(input, mapping, work, stage, handleIndex)
      const workRoot = join(publishingRoot(input, mapping.room), 'work')
      await mkdir(workRoot, { recursive: true })
      for (const work of mapping.works) {
        const target = join(workRoot, work.id)
        if (await exists(target)) throw failure('work_exists', `${rel(input, target)} already exists.`)
        await rename(join(stage, work.id), target)
        created.push(target)
        injectFailure()
      }
      await rm(stage, { recursive: true, force: true })
    }
    for (let index = 0; index < mappings.length; index += 1) {
      const roomCreated = created.filter((path) => path.startsWith(`${publishingRoot(input, mappings[index].room)}/`))
      const manifest = { ...manifests[index], state: 'applied', created_paths: roomCreated.map((path) => rel(input, path)) }
      await writeJsonAtomic(manifestPath(input, mappings[index].room), manifest)
    }
  } catch (error) {
    for (const stage of stages) await rm(stage, { recursive: true, force: true })
    for (const path of created.sort((left, right) => right.length - left.length)) await rm(path, { recursive: true, force: true })
    for (const mapping of mappings) await removeEmpty(join(publishingRoot(input, mapping.room), 'work'))
    for (let index = 0; index < mappings.length; index += 1) {
      await writeJsonAtomic(manifestPath(input, mappings[index].room), manifests[index])
    }
    throw error
  }
  return { status: 'applied', migration: MIGRATION, totals: totals(mappings) }
}

async function stageWork(input, mapping, work, stageRoot, handleIndex) {
  const target = join(stageRoot, work.id)
  const sources = []
  for (const publication of work.publications) {
    const artifact = await snapshotBytes(input, mapping.room, `publication/${publication.id}/artifact.md`)
    sources.push(parseDocument(artifact.toString('utf8')).metadata)
  }
  const createdAt = sources.map(({ created_at }) => created_at).filter(Boolean).sort()[0] ?? mapping.migration_at
  const updatedAt = sources.map(({ updated_at }) => updated_at).filter(Boolean).sort().at(-1) ?? mapping.migration_at
  const metadata = {
    $schema: 'https://endroit.org/schema/v7/artifact.json',
    id: work.id,
    kind: 'endroit/publishing:work',
    status: work.status,
    owner: mapping.owner,
    created_at: createdAt,
    updated_at: updatedAt,
    derived_from: work.publications.map(({ id }) => legacyRef(mapping.room, id)),
    intent: work.intent,
    thesis: work.thesis,
    audience: work.audience,
    continuity: work.continuity,
    selected_candidate: work.selected_candidate ? candidateRef(mapping.room, work.id, work.selected_candidate) : null,
  }
  await writeAtomic(join(target, 'artifact.md'), renderDocument(metadata, workBody(work)))

  const candidateDigests = new Map()
  for (const candidate of work.candidates) {
    const source = await snapshotBytes(input, mapping.room, `publication/${candidate.source_publication}/content.md`)
    const contentDigest = digest(source)
    candidateDigests.set(candidate.id, contentDigest)
    const candidateMetadata = {
      $schema: 'https://endroit.org/schema/v7/publishing-candidate.json',
      id: candidate.id,
      kind: 'publishing-candidate',
      owner: mapping.owner,
      work: workRef(mapping.room, work.id),
      status: candidate.status,
      lineage: candidate.lineage,
      derived_from: candidate.derived_from.map((id) => candidateRef(mapping.room, work.id, id)),
      sources: [legacyRef(mapping.room, candidate.source_publication)],
      revision: 1,
      content_digest: contentDigest,
    }
    const root = join(target, 'candidates', candidate.id)
    await writeAtomic(join(root, 'candidate.md'), renderDocument(candidateMetadata, candidateBody(candidate)))
    await writeAtomic(join(root, 'content.md'), source)
    await writeAtomic(join(root, 'revisions', '.gitkeep'), '')
  }

  for (const publication of work.publications) {
    const artifactBytes = await snapshotBytes(input, mapping.room, `publication/${publication.id}/artifact.md`)
    const content = await snapshotBytes(input, mapping.room, `publication/${publication.id}/content.md`)
    const parsed = parseDocument(artifactBytes.toString('utf8'))
    const oldRef = legacyRef(mapping.room, publication.id)
    const canonical = publicationRef(mapping.room, work.id, publication.id)
    const candidate = candidateRef(mapping.room, work.id, publication.candidate)
    const candidateDigest = candidateDigests.get(publication.candidate)
    const handles = handleIndex.get(oldRef) ?? []
    const destination = parsed.metadata.intended_url ?? handles[0]?.url ?? parsed.metadata.channel
    const publicationMetadata = {
      ...parsed.metadata,
      format: publication.format,
      stability: STABILITIES.has(parsed.metadata.stability) ? parsed.metadata.stability : 'historical',
      derived_from: [...new Set([...(array(parsed.metadata.derived_from)), oldRef])],
      work: workRef(mapping.room, work.id),
      candidate,
      candidate_revision: 1,
      candidate_digest: candidateDigest,
      destination: String(destination ?? 'unspecified'),
      validation: {
        status: 'valid',
        content_digest: digest(content),
        candidate_digest: candidateDigest,
      },
      handles: handles.map(({ path }) => path),
      migrated_from: oldRef,
      canonical_ref: canonical,
    }
    const root = join(target, 'publication', publication.id)
    await writeAtomic(join(root, 'artifact.md'), renderDocument(publicationMetadata, parsed.body))
    await writeAtomic(join(root, 'content.md'), content)
  }
}

async function verifyMigration(input) {
  const mappings = await loadMappings(input)
  const manifests = await loadManifests(input, mappings)
  assertStates(manifests, ['applied', 'verified', 'cutover'], 'verify')
  const result = await verifyModel(input, mappings, manifests)
  const states = {}
  for (let index = 0; index < mappings.length; index += 1) {
    if (manifests[index].state === 'applied') {
      await writeJsonAtomic(manifestPath(input, mappings[index].room), { ...manifests[index], state: 'verified' })
      states[mappings[index].room] = 'verified'
    } else {
      states[mappings[index].room] = manifests[index].state
    }
  }
  return {
    status: 'verified',
    migration: MIGRATION,
    ...result,
    states,
  }
}

async function cutover(input) {
  const mappings = await loadMappings(input)
  const manifests = await loadManifests(input, mappings)
  if (manifests.every(({ state }) => state === 'cutover')) {
    return { status: 'cutover', migration: MIGRATION, unchanged: true, totals: totals(mappings) }
  }
  assertStates(manifests, ['verified'], 'cutover')
  await verifyModel(input, mappings, manifests)
  const index = mappingIndex(mappings)
  const modified = new Map(mappings.map(({ room }) => [room, []]))
  const created = new Map(mappings.map(({ room }) => [room, []]))
  try {
    for (const mapping of mappings) {
      for (const work of mapping.works) {
        for (const publication of work.publications) {
          const path = legacyPublicationPath(input, mapping.room, publication.id, 'artifact.md')
          const raw = await snapshotBytes(input, mapping.room, `publication/${publication.id}/artifact.md`)
          const canonical = publicationRef(mapping.room, work.id, publication.id)
          await writeAtomic(path, patchFrontmatter(raw.toString('utf8'), {
            status: 'superseded',
            updated_at: mapping.migration_at,
            migrated_to: canonical,
            superseded_by: canonical,
          }))
          modified.get(mapping.room).push(path)
          injectFailure()
        }
      }
    }
    for (const manifest of manifests) {
      for (const entry of manifest.snapshot.filter(({ source }) => source.includes('/publishing/handles/'))) {
        const path = homePath(input, entry.source)
        const raw = await readRegular(path)
        const current = parseDocument(raw.toString('utf8')).metadata.publication
        const canonical = index.get(current)
        if (!canonical) throw failure('handle_publication_unknown', `${entry.source} points to ${current}.`)
        await writeAtomic(path, patchFrontmatter(raw.toString('utf8'), { publication: canonical }))
        modified.get(manifest.room).push(path)
        injectFailure()
      }
    }
    for (const mapping of mappings) {
      for (const handle of mapping.new_handles ?? []) {
        const path = join(publishingRoot(input, mapping.room), 'handles', handle.system, `${handle.id}.md`)
        if (await exists(path)) throw failure('handle_exists', `${rel(input, path)} already exists.`)
        const mapped = findPublication(mapping, handle.publication)
        const canonical = publicationRef(mapping.room, mapped.work.id, mapped.publication.id)
        const content = await readRegular(canonicalPublicationPath(input, mapping.room, mapped.work.id, mapped.publication.id, 'content.md'))
        const metadata = {
          id: handle.id,
          kind: 'publishing-handle',
          status: handle.status,
          owner: mapping.owner,
          created_at: mapping.migration_at,
          updated_at: mapping.migration_at,
          derived_from: [legacyRef(mapping.room, handle.publication), canonical],
          publication: canonical,
          system: handle.system,
          remote_id: handle.remote_id,
          url: handle.url,
          published_at: handle.published_at,
          observed_at: handle.observed_at,
          content_digest: digest(content),
        }
        await writeAtomic(path, renderDocument(metadata, `# Publishing Handle\n\n${handle.evidence}\n`))
        created.get(mapping.room).push(path)
        injectFailure()
        const publicationArtifact = canonicalPublicationPath(input, mapping.room, mapped.work.id, mapped.publication.id, 'artifact.md')
        const publicationSource = await readRegular(publicationArtifact)
        const publicationMetadata = parseDocument(publicationSource.toString('utf8')).metadata
        await writeAtomic(publicationArtifact, patchFrontmatter(publicationSource.toString('utf8'), {
          handles: [...new Set([...array(publicationMetadata.handles), rel(input, path)])],
        }))
        injectFailure()
      }
    }
    for (let position = 0; position < mappings.length; position += 1) {
      const manifest = {
        ...manifests[position],
        state: 'cutover',
        modified_paths: modified.get(mappings[position].room).map((path) => rel(input, path)),
        created_paths: [
          ...manifests[position].created_paths,
          ...created.get(mappings[position].room).map((path) => rel(input, path)),
        ],
      }
      await writeJsonAtomic(manifestPath(input, mappings[position].room), manifest)
    }
  } catch (error) {
    await restoreBaseline(input, mappings, manifests, true)
    throw error
  }
  const refreshed = await loadManifests(input, mappings)
  const result = await verifyModel(input, mappings, refreshed)
  return { status: 'cutover', migration: MIGRATION, ...result }
}

async function rollback(input) {
  const mappings = await loadMappings(input)
  const manifests = await loadManifests(input, mappings)
  if (manifests.every(({ state }) => state === 'rolled_back')) {
    return { status: 'rolled_back', migration: MIGRATION, unchanged: true, totals: totals(mappings) }
  }
  await restoreBaseline(input, mappings, manifests, true)
  const inspection = await inspectMigration(input)
  assertBaseline(inspection)
  return { status: 'rolled_back', migration: MIGRATION, totals: inspection.totals }
}

async function restoreBaseline(input, mappings, manifests, removeCreated) {
  for (const manifest of manifests) {
    for (const entry of manifest.snapshot) {
      const bytes = await readRegular(homePath(input, entry.snapshot))
      await writeAtomic(homePath(input, entry.source), bytes)
    }
  }
  if (removeCreated) {
    for (const manifest of manifests) {
      for (const path of [...manifest.created_paths].sort((left, right) => right.length - left.length)) {
        await rm(homePath(input, path), { recursive: true, force: true })
      }
    }
    for (const mapping of mappings) await removeEmpty(join(publishingRoot(input, mapping.room), 'work'))
  }
  for (let index = 0; index < mappings.length; index += 1) {
    await writeJsonAtomic(manifestPath(input, mappings[index].room), {
      ...manifests[index],
      state: 'rolled_back',
    })
  }
}

async function validate(input, selector) {
  const mappings = await loadMappings(input)
  const manifests = await loadManifests(input, mappings)
  assertStates(manifests, ['applied', 'verified', 'cutover'], 'validate')
  const result = await verifyModel(input, mappings, manifests)
  if (selector) await selectEntity(input, selector, true)
  return { status: 'valid', selector: selector ?? 'all', ...result }
}

async function verifyModel(input, mappings, manifests) {
  await assertSnapshots(input, manifests)
  const refs = new Set()
  for (const mapping of mappings) {
    for (const work of mapping.works) {
      refs.add(workRef(mapping.room, work.id))
      for (const candidate of work.candidates) refs.add(candidateRef(mapping.room, work.id, candidate.id))
      for (const publication of work.publications) {
        refs.add(legacyRef(mapping.room, publication.id))
        refs.add(publicationRef(mapping.room, work.id, publication.id))
      }
    }
  }
  for (let position = 0; position < mappings.length; position += 1) {
    const mapping = mappings[position]
    const manifest = manifests[position]
    await assertSupport(input, manifest)
    for (const work of mapping.works) {
      const workPath = canonicalWorkPath(input, mapping.room, work.id)
      const workDocument = parseDocument((await readRegular(join(workPath, 'artifact.md'))).toString('utf8'))
      assertEqual(workDocument.metadata.kind, 'endroit/publishing:work', `${work.id} kind`)
      assertEqual(workDocument.metadata.owner, mapping.owner, `${work.id} owner`)
      assertEqual(workDocument.metadata.selected_candidate, work.selected_candidate ? candidateRef(mapping.room, work.id, work.selected_candidate) : null, `${work.id} selection`)
      for (const candidate of work.candidates) {
        const candidatePath = join(workPath, 'candidates', candidate.id)
        const document = parseDocument((await readRegular(join(candidatePath, 'candidate.md'))).toString('utf8'))
        const content = await readRegular(join(candidatePath, 'content.md'))
        assertEqual(document.metadata.kind, 'publishing-candidate', `${candidate.id} kind`)
        assertEqual(document.metadata.work, workRef(mapping.room, work.id), `${candidate.id} work`)
        assertEqual(document.metadata.content_digest, digest(content), `${candidate.id} digest`)
        assertEqual(JSON.stringify(document.metadata.derived_from), JSON.stringify(candidate.derived_from.map((id) => candidateRef(mapping.room, work.id, id))), `${candidate.id} lineage`)
      }
      for (const publication of work.publications) {
        const root = canonicalPublicationPath(input, mapping.room, work.id, publication.id)
        const document = parseDocument((await readRegular(join(root, 'artifact.md'))).toString('utf8'))
        const content = await readRegular(join(root, 'content.md'))
        const originalContent = await snapshotBytes(input, mapping.room, `publication/${publication.id}/content.md`)
        assertEqual(Buffer.compare(content, originalContent), 0, `${publication.id} exact content`)
        assertEqual(document.metadata.work, workRef(mapping.room, work.id), `${publication.id} work`)
        assertEqual(document.metadata.candidate, candidateRef(mapping.room, work.id, publication.candidate), `${publication.id} candidate`)
        assertEqual(document.metadata.format, publication.format, `${publication.id} format`)
        assertEqual(document.metadata.validation?.content_digest, digest(content), `${publication.id} validation digest`)
        assertEqual(document.metadata.validation?.candidate_digest, document.metadata.candidate_digest, `${publication.id} candidate validation`)
        for (const ref of [document.metadata.work, document.metadata.candidate, document.metadata.migrated_from, document.metadata.canonical_ref]) {
          if (!refs.has(ref)) throw failure('reference_broken', `${publication.id} points to unknown ${ref}.`)
        }
        const legacyArtifact = await readRegular(legacyPublicationPath(input, mapping.room, publication.id, 'artifact.md'))
        const legacyContent = await readRegular(legacyPublicationPath(input, mapping.room, publication.id, 'content.md'))
        assertEqual(Buffer.compare(legacyContent, originalContent), 0, `${publication.id} frozen compatibility content`)
        if (manifest.state === 'cutover') {
          const legacyMetadata = parseDocument(legacyArtifact.toString('utf8')).metadata
          assertEqual(legacyMetadata.status, 'superseded', `${publication.id} compatibility status`)
          assertEqual(legacyMetadata.migrated_to, publicationRef(mapping.room, work.id, publication.id), `${publication.id} compatibility target`)
        } else {
          const originalArtifact = await snapshotBytes(input, mapping.room, `publication/${publication.id}/artifact.md`)
          assertEqual(Buffer.compare(legacyArtifact, originalArtifact), 0, `${publication.id} unchanged before cutover`)
        }
      }
    }
  }
  if (manifests.every(({ state }) => state === 'cutover')) await verifyHandles(input, mappings, manifests, refs)
  return { totals: totals(mappings), states: Object.fromEntries(manifests.map(({ room, state }) => [room, state])) }
}

async function verifyHandles(input, mappings, manifests, refs) {
  const baseline = manifests.flatMap(({ snapshot }) => snapshot.filter(({ source }) => source.includes('/publishing/handles/')))
  for (const entry of baseline) {
    const document = parseDocument((await readRegular(join(input.homeRoot, entry.source))).toString('utf8'))
    if (!refs.has(document.metadata.publication) || !document.metadata.publication.includes('/publishing/work/')) {
      throw failure('handle_reference_broken', `${entry.source} points to ${document.metadata.publication}.`)
    }
    await assertPublicationOwnsHandle(input, mappings, document.metadata.publication, entry.source)
  }
  for (const mapping of mappings) {
    for (const handle of mapping.new_handles ?? []) {
      const path = join(publishingRoot(input, mapping.room), 'handles', handle.system, `${handle.id}.md`)
      const document = parseDocument((await readRegular(path)).toString('utf8'))
      if (!refs.has(document.metadata.publication)) throw failure('handle_reference_broken', `${rel(input, path)} points to ${document.metadata.publication}.`)
      assertEqual(document.metadata.status, handle.status, `${handle.id} Handle status`)
      assertEqual(document.metadata.url, handle.url, `${handle.id} Handle URL`)
      await assertPublicationOwnsHandle(input, mappings, document.metadata.publication, rel(input, path))
    }
  }
}

async function assertPublicationOwnsHandle(input, mappings, ref, handlePath) {
  for (const mapping of mappings) for (const work of mapping.works) for (const publication of work.publications) {
    if (publicationRef(mapping.room, work.id, publication.id) !== ref) continue
    const path = canonicalPublicationPath(input, mapping.room, work.id, publication.id, 'artifact.md')
    const document = parseDocument((await readRegular(path)).toString('utf8'))
    if (!array(document.metadata.handles).includes(handlePath)) throw failure('publication_handle_missing', `${ref} does not own ${handlePath}.`)
    return
  }
  throw failure('handle_reference_broken', `${handlePath} points to unknown ${ref}.`)
}

async function list(input, flags) {
  const found = await entities(input, { legacy: Boolean(flags.legacy), all: Boolean(flags.all), room: flags.room })
  return { status: 'listed', mode: flags.legacy ? 'legacy' : flags.all ? 'all' : 'works', entities: found }
}

async function inspect(input, selector) {
  const entity = await selectEntity(input, selector, false)
  const document = parseDocument((await readRegular(entity.source)).toString('utf8'))
  return { status: 'inspected', ...entity, metadata: document.metadata, body: document.body }
}

async function selectEntity(input, selector, validateOnly) {
  const discovered = [
    ...await entities(input, { all: true }),
    ...await entities(input, { legacy: true }),
  ]
  const all = [...new Map(discovered.map((entity) => [entity.ref, entity])).values()]
  const absolute = resolve(selector)
  const matches = all.filter((entity) => entity.ref === selector || entity.id === selector || entity.path === selector || entity.source === absolute)
  if (!matches.length) throw failure('publishing_missing', `${selector} was not found.`)
  if (matches.length > 1) throw failure('publishing_ambiguous', `${selector} matches multiple publishing objects.`)
  if (validateOnly && !await exists(matches[0].source)) throw failure('publishing_missing', `${selector} has no source.`)
  return matches[0]
}

async function entities(input, options) {
  const mappings = await loadMappings(input)
  const selectedRoom = options.room ? resolveRoomSelector(mappings, String(options.room)) : null
  const found = []
  for (const mapping of mappings.filter(({ room }) => !selectedRoom || room === selectedRoom)) {
    for (const work of mapping.works) {
      const workPath = canonicalWorkPath(input, mapping.room, work.id)
      if (options.legacy) {
        for (const publication of work.publications) {
          const source = legacyPublicationPath(input, mapping.room, publication.id, 'artifact.md')
          if (await exists(source)) found.push(entity('publication-compatibility', publication.id, legacyRef(mapping.room, publication.id), source, input))
        }
        continue
      }
      if (!await exists(join(workPath, 'artifact.md'))) continue
      found.push(entity('work', work.id, workRef(mapping.room, work.id), join(workPath, 'artifact.md'), input))
      if (!options.all) continue
      for (const candidate of work.candidates) {
        found.push(entity('candidate', candidate.id, candidateRef(mapping.room, work.id, candidate.id), join(workPath, 'candidates', candidate.id, 'candidate.md'), input))
      }
      for (const publication of work.publications) {
        found.push(entity('publication', publication.id, publicationRef(mapping.room, work.id, publication.id), join(workPath, 'publication', publication.id, 'artifact.md'), input))
      }
    }
  }
  if (!options.legacy && !found.length) return entities(input, { ...options, legacy: true })
  return found.sort((left, right) => left.ref.localeCompare(right.ref))
}

function entity(kind, id, ref, source, input) {
  return { kind, id, ref, path: rel(input, dirname(source)), source }
}

async function loadMappings(input) {
  const mappings = []
  for (const room of input.resolvedHome?.rooms ?? []) {
    const path = join(publishingRoot(input, room.ref), 'migrations', MIGRATION, 'mapping.json')
    const mapping = await readJson(path, null)
    if (!mapping) continue
    validateMapping(mapping, room)
    mappings.push({ ...mapping, room: room.ref })
  }
  if (!mappings.length) throw failure('mapping_missing', `No ${MIGRATION} mappings were discovered in the resolved Rooms.`)
  const publicationIds = mappings.flatMap(({ room, works }) => works.flatMap(({ publications }) => publications.map(({ id }) => `${room}/${id}`)))
  if (new Set(publicationIds).size !== publicationIds.length) throw failure('mapping_duplicate', 'A Publication is mapped more than once.')
  return mappings
}

function validateMapping(mapping, room) {
  assertEqual(mapping.version, 1, `${room.ref} mapping version`)
  assertEqual(mapping.migration, MIGRATION, `${room.ref} migration`)
  if (![room.ref, room.id].includes(mapping.room)) throw failure('validation_failed', `${room.ref} mapping identity must be ${room.ref}.`)
  assertEqual(mapping.owner, room.ref, `${room.ref} owner`)
  const workIds = new Set()
  const publicationIds = new Set()
  for (const work of mapping.works ?? []) {
    assertId(work.id)
    if (workIds.has(work.id)) throw failure('mapping_duplicate', `${room.ref} duplicates Work ${work.id}.`)
    workIds.add(work.id)
    if (!WORK_STATES.has(work.status)) throw failure('mapping_invalid', `${work.id} has invalid status ${work.status}.`)
    for (const key of ['intent', 'thesis', 'audience', 'continuity']) if (!work[key]) throw failure('mapping_invalid', `${work.id} requires ${key}.`)
    const candidates = new Map((work.candidates ?? []).map((candidate) => [candidate.id, candidate]))
    if (candidates.size !== work.candidates.length) throw failure('mapping_duplicate', `${work.id} duplicates a Candidate.`)
    for (const candidate of candidates.values()) {
      assertId(candidate.id)
      if (!CANDIDATE_STATES.has(candidate.status) || !LINEAGES.has(candidate.lineage)) throw failure('mapping_invalid', `${candidate.id} has invalid lifecycle metadata.`)
      for (const parent of candidate.derived_from ?? []) if (!candidates.has(parent)) throw failure('mapping_parent_missing', `${candidate.id} has unknown parent ${parent}.`)
    }
    assertAcyclic(candidates, work.id)
    const selected = [...candidates.values()].filter(({ status }) => status === 'selected')
    if (work.selected_candidate) {
      if (!candidates.has(work.selected_candidate) || selected.length !== 1 || selected[0].id !== work.selected_candidate) throw failure('mapping_selection_invalid', `${work.id} selection is inconsistent.`)
    } else if (selected.length) throw failure('mapping_selection_invalid', `${work.id} has a selected Candidate without selected_candidate.`)
    for (const publication of work.publications ?? []) {
      assertId(publication.id)
      if (publicationIds.has(publication.id)) throw failure('mapping_duplicate', `${room.ref} duplicates Publication ${publication.id}.`)
      publicationIds.add(publication.id)
      if (!candidates.has(publication.candidate)) throw failure('mapping_candidate_missing', `${publication.id} points to ${publication.candidate}.`)
      if (!FORMATS.has(publication.format)) throw failure('mapping_format_invalid', `${publication.id} has invalid format ${publication.format}.`)
    }
    for (const candidate of candidates.values()) {
      const source = work.publications.find(({ id }) => id === candidate.source_publication)
      if (!source || source.candidate !== candidate.id) throw failure('mapping_source_invalid', `${candidate.id} source Publication is inconsistent.`)
    }
  }
  const handlePaths = new Set()
  for (const handle of mapping.new_handles ?? []) {
    assertId(handle.id)
    assertId(handle.system)
    const key = `${handle.system}/${handle.id}`
    if (handlePaths.has(key)) throw failure('mapping_duplicate', `${room.ref} duplicates Handle ${key}.`)
    handlePaths.add(key)
    if (!publicationIds.has(handle.publication)) throw failure('mapping_publication_missing', `${key} points to unknown Publication ${handle.publication}.`)
  }
}

function assertAcyclic(candidates, work) {
  const visiting = new Set()
  const visited = new Set()
  const visit = (id) => {
    if (visiting.has(id)) throw failure('mapping_cycle', `${work} Candidate lineage contains a cycle at ${id}.`)
    if (visited.has(id)) return
    visiting.add(id)
    for (const parent of candidates.get(id).derived_from ?? []) visit(parent)
    visiting.delete(id)
    visited.add(id)
  }
  for (const id of candidates.keys()) visit(id)
}

async function inventoryRoom(input, mapping, mappedRefs) {
  const root = publishingRoot(input, mapping.room)
  const expected = mapping.works.flatMap(({ publications }) => publications.map(({ id }) => id)).sort()
  const actual = (await safeReadDir(join(root, 'publication'))).filter((entry) => entry.isDirectory() && !entry.isSymbolicLink()).map(({ name }) => name).sort()
  const actualSet = new Set(actual)
  const expectedSet = new Set(expected)
  const sourceFiles = expected.flatMap((id) => [
    join(root, 'publication', id, 'artifact.md'),
    join(root, 'publication', id, 'content.md'),
  ])
  for (const path of sourceFiles) await readRegular(path)
  const handles = []
  const retainedHandles = []
  for (const path of await findFiles(join(root, 'handles'))) {
    const document = parseDocument((await readRegular(path)).toString('utf8'))
    if (mappedRefs.has(document.metadata.publication)) handles.push(path)
    else retainedHandles.push(path)
  }
  const all = await findFiles(root)
  const support = []
  for (const path of all) {
    const local = relative(root, path)
    if (['publication/', 'handles/', 'work/', 'migrations/'].some((prefix) => local.startsWith(prefix))) continue
    const bytes = await readRegular(path)
    support.push({ path: rel(input, path), size: bytes.length, sha256: digest(bytes) })
  }
  return {
    publicationIds: expected.filter((id) => actualSet.has(id)),
    legacyPublicationIds: actual,
    sourceFiles,
    handles,
    retainedHandles,
    support,
    missing: expected.filter((id) => !actualSet.has(id)),
    unmapped: actual.filter((id) => !expectedSet.has(id)),
  }
}

function assertBaseline(inspection) {
  for (const room of inspection.rooms) {
    if (room.missing.length || room.publications !== room.mappedPublications) {
      throw failure('migration_inventory_drift', `${room.room} is missing mapped publishing sources.`)
    }
  }
}

async function loadManifests(input, mappings) {
  const manifests = []
  for (const mapping of mappings) {
    const manifest = await readJson(manifestPath(input, mapping.room), null)
    if (!manifest) throw failure('migration_unprepared', `${mapping.room} has no migration manifest; run prepare.`)
    if (manifest.migration !== MIGRATION || manifest.room !== mapping.room) throw failure('manifest_invalid', `${mapping.room} manifest identity is invalid.`)
    manifests.push(manifest)
  }
  return manifests
}

function assertStates(manifests, allowed, phase) {
  for (const manifest of manifests) if (!allowed.includes(manifest.state)) {
    throw failure('migration_state_invalid', `${phase} cannot consume ${manifest.room}:${manifest.state}.`)
  }
}

async function assertSnapshots(input, manifests) {
  for (const manifest of manifests) {
    for (const entry of manifest.snapshot) {
      const bytes = await readRegular(homePath(input, entry.snapshot))
      assertEqual(bytes.length, entry.size, `${entry.snapshot} size`)
      assertEqual(digest(bytes), entry.sha256, `${entry.snapshot} digest`)
    }
  }
}

async function assertSupport(input, manifest) {
  for (const entry of manifest.support) {
    const bytes = await readRegular(homePath(input, entry.path))
    assertEqual(bytes.length, entry.size, `${entry.path} size`)
    assertEqual(digest(bytes), entry.sha256, `${entry.path} digest`)
  }
}

async function indexHandles(input, manifests) {
  const index = new Map()
  for (const manifest of manifests) {
    for (const entry of manifest.snapshot.filter(({ source }) => source.includes('/publishing/handles/'))) {
      const document = parseDocument((await readRegular(homePath(input, entry.snapshot))).toString('utf8'))
      const values = index.get(document.metadata.publication) ?? []
      values.push({ path: entry.source, url: document.metadata.url })
      index.set(document.metadata.publication, values)
    }
  }
  return index
}

function mappingIndex(mappings) {
  const index = new Map()
  for (const mapping of mappings) for (const work of mapping.works) for (const publication of work.publications) {
    index.set(legacyRef(mapping.room, publication.id), publicationRef(mapping.room, work.id, publication.id))
  }
  return index
}

function mappedLegacyRefs(mappings) { return new Set(mappingIndex(mappings).keys()) }

function findPublication(mapping, id) {
  for (const work of mapping.works) {
    const publication = work.publications.find((entry) => entry.id === id)
    if (publication) return { work, publication }
  }
  throw failure('mapping_publication_missing', `${mapping.room} has no Publication ${id}.`)
}

async function snapshotBytes(input, room, local) {
  return readRegular(join(migrationRoot(input, room), 'legacy', local))
}

function publishingRoot(input, room) {
  const resolvedRoom = (input.resolvedHome?.rooms ?? []).find(({ ref }) => ref === room)
  if (!resolvedRoom?.path) throw failure('room_unknown', `Resolved Room ${room} was not found.`, 2)
  const roomSource = resolve(input.homeRoot, resolvedRoom.path)
  const local = relative(resolve(input.homeRoot), roomSource)
  if (!local || local.startsWith('..') || resolve(input.homeRoot, local) !== roomSource) {
    throw failure('room_path_invalid', `${room} has an invalid source path.`)
  }
  return join(dirname(roomSource), 'publishing')
}
function migrationRoot(input, room) { return join(publishingRoot(input, room), 'migrations', MIGRATION) }
function manifestPath(input, room) { return join(migrationRoot(input, room), 'manifest.json') }
function canonicalWorkPath(input, room, work) { return join(publishingRoot(input, room), 'work', work) }
function canonicalPublicationPath(input, room, work, publication, file) { return join(canonicalWorkPath(input, room, work), 'publication', publication, file ?? '') }
function legacyPublicationPath(input, room, publication, file) { return join(publishingRoot(input, room), 'publication', publication, file) }
function roomAddress(room) { return room.replace(/^room:/, '') }
function workRef(room, work) { return `artifact:${roomAddress(room)}/publishing/work/${work}` }
function candidateRef(room, work, candidate) { return `candidate:${roomAddress(room)}/publishing/work/${work}/candidate/${candidate}` }
function publicationRef(room, work, publication) { return `artifact:${roomAddress(room)}/publishing/work/${work}/publication/${publication}` }
function legacyRef(room, publication) { return `artifact:${roomAddress(room)}/publishing/publication/${publication}` }

function resolveRoomSelector(mappings, selector) {
  const candidates = mappings.filter(({ room }) => room === selector || roomAddress(room) === selector || room.endsWith(`/${selector}`))
  if (!candidates.length) throw failure('room_unknown', `Unknown publishing Room ${selector}.`, 2)
  if (candidates.length > 1) throw failure('room_ambiguous', `${selector} matches multiple publishing Rooms.`, 2)
  return candidates[0].room
}

function totals(mappings) {
  return {
    works: mappings.reduce((sum, { works }) => sum + works.length, 0),
    candidates: mappings.reduce((sum, { works }) => sum + works.reduce((total, { candidates }) => total + candidates.length, 0), 0),
    publications: mappings.reduce((sum, { works }) => sum + works.reduce((total, { publications }) => total + publications.length, 0), 0),
  }
}

function workBody(work) {
  return `# Editorial Work\n\n## Intent\n\n${work.intent}\n\n## Thesis\n\n${work.thesis}\n\n## Audience\n\n${work.audience}\n\n## Continuity\n\n${work.continuity}\n`
}

function candidateBody(candidate) {
  return `# Candidate\n\n## Direction\n\nSignificant editorial direction sourced from Publication \`${candidate.source_publication}\`.\n\n## Lineage\n\n\`${candidate.lineage}\`; minor corrections increment \`revision\` without creating another Candidate.\n`
}

function parseDocument(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!match) throw failure('document_invalid', 'Document must start with frontmatter.')
  const metadata = {}
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(':')
    if (separator < 1) throw failure('document_invalid', `Invalid frontmatter line: ${line}`)
    const key = line.slice(0, separator).trim()
    const raw = line.slice(separator + 1).trim()
    try { metadata[key] = JSON.parse(raw) } catch { metadata[key] = raw.replace(/^"|"$/g, '') }
  }
  return { metadata, body: match[2] }
}

function renderDocument(metadata, body) {
  const lines = Object.entries(metadata).map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
  return `---\n${lines.join('\n')}\n---\n\n${body.trim()}\n`
}

function patchFrontmatter(content, fields) {
  const match = content.match(/^(---\r?\n)([\s\S]*?)(\r?\n---[\s\S]*)$/)
  if (!match) throw failure('document_invalid', 'Document must start with frontmatter.')
  const lines = match[2].split(/\r?\n/)
  for (const [key, value] of Object.entries(fields)) {
    const replacement = `${key}: ${JSON.stringify(value)}`
    const index = lines.findIndex((line) => line.startsWith(`${key}:`))
    if (index < 0) lines.push(replacement)
    else lines[index] = replacement
  }
  return `${match[1]}${lines.join('\n')}${match[3]}`
}

async function writeAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true })
  const temporary = join(dirname(path), `.${basename(path)}.tmp-${process.pid}`)
  await writeFile(temporary, value)
  await rename(temporary, path)
}

async function writeJsonAtomic(path, value) { await writeAtomic(path, `${JSON.stringify(value, null, 2)}\n`) }

async function readRegular(path) {
  const info = await lstat(path).catch((error) => { if (error.code === 'ENOENT') throw failure('source_missing', `${path} does not exist.`); throw error })
  if (!info.isFile() || info.isSymbolicLink()) throw failure('source_invalid', `${path} must be a regular file.`)
  return readFile(path)
}

async function findFiles(root) {
  const found = []
  const visit = async (directory) => {
    for (const entry of await safeReadDir(directory)) {
      const path = join(directory, entry.name)
      if (entry.isSymbolicLink()) throw failure('symlink_forbidden', `${path} is a symbolic link.`)
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile()) found.push(path)
    }
  }
  await visit(root)
  return found.sort()
}

async function safeReadDir(path) {
  try { return await readdir(path, { withFileTypes: true }) }
  catch (error) { if (error.code === 'ENOENT') return []; throw error }
}

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')) }
  catch (error) { if (error.code === 'ENOENT' && arguments.length > 1) return fallback; throw error }
}

async function exists(path) {
  try { await lstat(path); return true }
  catch (error) { if (error.code === 'ENOENT') return false; throw error }
}

async function removeEmpty(path) {
  try {
    if ((await readdir(path)).length === 0) await rmdir(path)
  } catch (error) {
    if (!['ENOENT', 'ENOTEMPTY'].includes(error.code)) throw error
  }
}

function digest(value) { return `sha256:${createHash('sha256').update(value).digest('hex')}` }
function rel(input, path) { return relative(input.homeRoot, path) }
function homePath(input, path) {
  const root = resolve(input.homeRoot)
  const target = resolve(root, path)
  const local = relative(root, target)
  if (!local || local.startsWith('..') || resolve(root, local) !== target) throw failure('manifest_path_invalid', `${path} escapes the Home.`)
  return target
}
function array(value) { return value === undefined || value === null ? [] : Array.isArray(value) ? value : [value] }

function injectFailure() {
  const after = Number(process.env.ENDROIT_PUBLISHING_FAIL_AFTER ?? 0)
  writes += 1
  if (after > 0 && writes >= after) throw failure('migration_injected_failure', `Injected failure after ${writes} writes.`)
}

function assertId(value) {
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(value)) throw failure('mapping_id_invalid', `Invalid id ${value}.`)
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) throw failure('validation_failed', `${label}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}.`)
}

function required(value, label) {
  if (value === undefined || value === true || value === '') throw failure('usage', `${label} is required.`, 2)
  return value
}

function failure(code, message, exitCode = 4) {
  const error = new Error(message)
  error.code = code
  error.exitCode = exitCode
  return error
}

function argumentsOf(argv) {
  const flags = {}
  const positionals = []
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (!value.startsWith('--')) { positionals.push(value); continue }
    const [name, inline] = value.slice(2).split('=', 2)
    const next = inline ?? (argv[index + 1] && !argv[index + 1].startsWith('-') ? argv[++index] : true)
    flags[name] = next
  }
  return { flags, positionals }
}

function human(value) {
  if (value.status === 'help') return value.text
  if (value.status === 'listed') return value.entities.length ? value.entities.map(({ ref }) => ref).join('\n') : 'No publishing objects.'
  if (value.status === 'inspected') return `${value.ref}\n${value.path}\n${value.body}`.trim()
  return `${value.status}: ${value.migration ?? value.selector ?? ''}`.trim()
}

function help(command) {
  if (command === 'migrate') return 'Usage: endroit publishing migrate editorial-work-v1 inspect|prepare|apply|verify|cutover|rollback'
  if (command === 'inspect') return 'Usage: endroit publishing inspect <ref>'
  if (command === 'validate') return 'Usage: endroit publishing validate [selector]'
  if (command === 'list') return 'Usage: endroit publishing list [--room <room-ref>] [--all] [--legacy]'
  return 'Usage: endroit publishing list|inspect|validate|migrate'
}

function stdin() {
  return new Promise((resolvePromise, reject) => {
    const chunks = []
    process.stdin.on('data', (chunk) => chunks.push(chunk))
    process.stdin.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8')))
    process.stdin.on('error', reject)
  })
}
