#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'

const HELP = {
  create: {
    usage: 'endroit artifact create <kind> <id> (--room <home/id|desk/id>|--workplace|--site <site>) [--route <id>] [--status <status>] [--field <key=value>] [--derived-from <ref>] [--from <directory>] [--json]',
    effect: 'mutating — creates one new Artifact at its explicit owner',
    summary: 'Create a Room-, Workplace- or Site-owned Artifact.',
  },
  list: {
    usage: 'endroit artifact list [--json]',
    effect: 'read-only',
    summary: 'List Room Artifacts, legacy roots and Site projections.',
  },
  inspect: {
    usage: 'endroit artifact inspect <selector> [--json]',
    effect: 'read-only',
    summary: 'Inspect one Artifact selected by ref, id, kind and id, or path.',
  },
  validate: {
    usage: 'endroit artifact validate <selector> [--json]',
    effect: 'read-only',
    summary: 'Validate one Artifact against its owning kind.',
  },
  promote: {
    usage: 'endroit artifact promote <selector> --to <room:home/id|site:id> [--route <id>] [--json]',
    effect: 'mutating — copies one validated source to an explicit broader authority',
    summary: 'Promote a Room or legacy Artifact while preserving source lineage.',
  },
  publish: {
    usage: 'endroit artifact publish <selector> --to <home|site> [--site <id>] [--route <id>] [--json]',
    effect: 'deprecated alias — use artifact promote',
    summary: 'Deprecated compatibility alias for Artifact promotion.',
  },
}

try {
  const input = JSON.parse(await stdin())
  const { positionals, flags } = argumentsOf(input.argv)
  const [command, ...rest] = positionals
  if (flags.help) process.stdout.write(`${helpFor(command)}\n`)
  else {
    const value = await route(input, command, rest, flags)
    process.stdout.write(flags.json ? `${JSON.stringify(value, null, 2)}\n` : `${human(value)}\n`)
  }
} catch (error) {
  process.stderr.write(`${error.code ?? 'artifact_failed'}: ${error.message}\n`)
  process.exitCode = error.exitCode ?? 4
}

async function route(input, command, args, flags) {
  if (command === 'create') return createArtifact(input, required(args[0], 'Artifact kind'), required(args[1], 'Artifact id'), flags)
  if (command === 'list') return { status: 'listed', artifacts: await listArtifacts(input) }
  if (command === 'inspect') return inspectArtifact(input, required(args[0], 'Artifact selector'))
  if (command === 'validate') return validateArtifact(input, required(args[0], 'Artifact selector'))
  if (command === 'promote') return promoteArtifact(input, required(args[0], 'Artifact selector'), flags)
  if (command === 'publish') {
    const translated = { ...flags, to: legacyDestination(flags) }
    return {
      ...await promoteArtifact(input, required(args[0], 'Artifact selector'), translated),
      deprecated: 'artifact publish is deprecated; use artifact promote.',
    }
  }
  throw failure('usage', 'endroit artifact create|list|inspect|validate|promote', 2)
}

async function createArtifact(input, kindSelector, id, flags) {
  assertId(id)
  const kind = selectKind(input.resolvedHome, kindSelector)
  const target = await creationTarget(input, kind, id, flags)
  const { destination, owner, ref, scope } = target
  if (await exists(destination)) throw failure('artifact_exists', `${relative(input.homeRoot, destination)} already exists.`)
  const name = artifactDocument(kind)
  const template = await readFile(join(kind.root, kind.template), 'utf8')
  const state = flags.status ?? flags.state ?? kind.states?.[0] ?? 'draft'
  let metadata
  let body
  if (name === 'artifact.md') {
    const timestamp = new Date().toISOString()
    metadata = {
      ...extraFields(flags.field),
      $schema: 'https://endroit.org/schema/v7/artifact.json',
      id,
      kind: kind.id,
      status: state,
      owner,
      created_at: timestamp,
      updated_at: timestamp,
      derived_from: values(flags['derived-from']),
    }
    body = template
  } else {
    const parsed = parseArtifact(template, name)
    const stateKey = Object.hasOwn(parsed.metadata, 'work_state') ? 'work_state' : 'status'
    metadata = {
      ...parsed.metadata,
      ...extraFields(flags.field),
      id,
      kind: kind.id,
      owner,
      derived_from: values(flags['derived-from']),
      ...(Object.hasOwn(parsed.metadata, stateKey) ? { [stateKey]: state } : {}),
    }
    body = parsed.body
  }
  await mkdir(dirname(destination), { recursive: true })
  const stage = await mkdtemp(join(dirname(destination), '.endroit-artifact-'))
  try {
    if (flags.from) await copyInput(flags.from, stage)
    await writeFile(join(stage, name), renderArtifact(metadata, body), { mode: 0o644 })
    await installRequiredFiles(stage, kind)
    await validateDirectory(stage, metadata, kind, scope, false)
    await rename(stage, destination)
  } catch (error) {
    await rm(stage, { recursive: true, force: true })
    throw error
  }
  return {
    status: 'created',
    id,
    kind: kind.id,
    owner,
    ref,
    path: relative(input.homeRoot, destination),
    document: name,
  }
}

async function creationTarget(input, kind, id, flags) {
  const selected = [flags.room ? 'room' : null, flags.workplace ? 'workplace' : null, flags.site ? 'site' : null].filter(Boolean)
  if (!selected.length) throw failure('usage', 'Room is required unless --workplace or --site is selected.', 2)
  if (selected.length !== 1) throw failure('usage', 'Choose exactly one owner: --room, --workplace or --site.', 2)
  if (selected[0] === 'room') {
    if (!kind.roomNamespace) throw failure('artifact_room_namespace_missing', `${kind.id} does not declare a Room namespace.`)
    const room = selectRoom(input, flags.room)
    assertSourceScope(kind, room.scope)
    return { destination: roomDestination(input, kind, id, room), owner: room.ref, ref: artifactRef(room, kind, id), scope: room.scope }
  }
  if (selected[0] === 'workplace') {
    assertSourceScope(kind, 'home')
    if (!kind.workplacePath) throw failure('artifact_workplace_path_missing', `${kind.id} has no Workplace path.`)
    const workplace = input.resolvedHome.home?.id ?? input.resolvedHome.workplace?.id
    if (!workplace) throw failure('workplace_missing', 'The resolved Workplace has no identity.')
    return {
      destination: join(input.homeRoot, kind.workplacePath, id),
      owner: `workplace:${workplace}`,
      ref: `artifact:workplace/${kind.owner}/${kind.localId}/${id}`,
      scope: 'home',
    }
  }
  assertSourceScope(kind, 'site')
  if (!kind.sitePath) throw failure('artifact_site_path_missing', `${kind.id} has no Site path.`)
  const route = await selectRoute(input, flags.site, flags.route)
  return {
    destination: join(route.path, kind.sitePath, id),
    owner: `site:${flags.site}`,
    ref: `artifact:site/${flags.site}/${kind.owner}/${kind.localId}/${id}`,
    scope: 'site',
  }
}

function extraFields(entries) {
  const reserved = new Set(['$schema', 'id', 'kind', 'status', 'work_state', 'owner', 'contract', 'created_at', 'updated_at', 'derived_from', 'source_digest'])
  const fields = {}
  for (const entry of values(entries)) {
    const separator = String(entry).indexOf('=')
    if (separator < 1) throw failure('artifact_field_invalid', `Invalid Artifact field ${entry}; use key=value.`, 2)
    const key = String(entry).slice(0, separator)
    const raw = String(entry).slice(separator + 1)
    if (!/^[a-z][a-z0-9_]{0,127}$/.test(key) || reserved.has(key)) {
      throw failure('artifact_field_invalid', `Artifact field ${key} is reserved or invalid.`, 2)
    }
    try { fields[key] = JSON.parse(raw) } catch { fields[key] = raw }
  }
  return fields
}

async function listArtifacts(input) {
  return input.inspection?.artifacts ?? []
}

async function inspectArtifact(input, selector) {
  const artifact = await selectArtifact(input, selector)
  const kind = selectKind(input.resolvedHome, artifact.kind)
  const name = artifactDocument(kind, artifact)
  const document = parseArtifact(await readFile(join(artifact.path, name), 'utf8'), name)
  return { status: 'inspected', ...artifact, document: name, body: document.body }
}

async function validateArtifact(input, selector) {
  const artifact = await selectArtifact(input, selector)
  if (artifact.invalid) throw failure('artifact_invalid', artifact.invalid)
  const kind = selectKind(input.resolvedHome, artifact.kind)
  const name = artifactDocument(kind, artifact)
  const document = parseArtifact(await readFile(join(artifact.path, name), 'utf8'), name)
  const metadata = name === 'artifact.md' ? normalizeMetadata(document.metadata) : document.metadata
  const ownerScope = artifact.scope.startsWith('site:') ? 'site' : artifact.scope
  await validateDirectory(artifact.path, metadata, kind, ownerScope, artifact.legacy)
  return { status: 'valid', id: artifact.id, kind: artifact.kind, scope: artifact.scope, document: name, legacy: artifact.legacy }
}

async function promoteArtifact(input, selector, flags) {
  const artifact = await selectArtifact(input, selector)
  if (artifact.scope.startsWith('site:')) throw failure('artifact_scope_invalid', 'A Site projection cannot be promoted.')
  await validateArtifact(input, selector)
  const destination = parseDestination(required(flags.to, 'Promotion destination'))
  if (destination.kind === 'room' && artifact.scope !== 'desk') {
    throw failure('artifact_direction_invalid', 'Only a Desk Artifact can be promoted to a shared Workplace Room.')
  }
  const kind = selectKind(input.resolvedHome, artifact.kind)
  let sitePath
  let owner
  let destinationRef
  if (destination.kind === 'room') {
    const room = selectRoom(input, `home/${destination.id}`)
    assertSourceScope(kind, 'home')
    sitePath = roomDestination(input, kind, artifact.id, room)
    owner = room.ref
    destinationRef = artifactRef(room, kind, artifact.id)
  } else {
    if (!kind.owners.includes('site') || !kind.sitePath) {
      throw failure('artifact_site_path_missing', `${kind.id} has no Site destination.`)
    }
    const route = await selectRoute(input, destination.id, flags.route)
    sitePath = join(route.path, kind.sitePath, artifact.id)
    owner = `site:${destination.id}`
    destinationRef = `artifact:site/${destination.id}/${kind.roomNamespace ?? kind.owner}/${kind.localId}/${artifact.id}`
  }
  if (await exists(sitePath)) throw failure('artifact_exists', `${relative(input.homeRoot, sitePath)} already exists.`)
  const name = artifactDocument(kind, artifact)
  const source = parseArtifact(await readFile(join(artifact.path, name), 'utf8'), name)
  const current = name === 'artifact.md' ? normalizeMetadata(source.metadata) : source.metadata
  const metadata = name === 'artifact.md' ? {
    ...current,
    owner,
    updated_at: new Date().toISOString(),
    derived_from: [...new Set([...current.derived_from, artifact.ref])],
    source_digest: await treeDigest(artifact.path),
    ...(destination.kind === 'site' ? { sites: [...new Set([...(source.metadata.sites ?? []), destination.id])] } : {}),
  } : {
    ...current,
    owner,
    derived_from: [...new Set([...current.derived_from, artifact.ref])],
  }
  await mkdir(dirname(sitePath), { recursive: true })
  const stage = await mkdtemp(join(dirname(sitePath), '.endroit-artifact-'))
  try {
    await assertTree(artifact.path)
    for (const entry of await readdir(artifact.path, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw failure('symlink_forbidden', `Artifact contains symbolic link ${entry.name}.`)
      if (entry.name === name) continue
      await cp(join(artifact.path, entry.name), join(stage, entry.name), { recursive: true, errorOnExist: true })
    }
    await writeFile(join(stage, name), renderArtifact(metadata, source.body), { mode: 0o644 })
    await validateDirectory(stage, metadata, kind, destination.kind === 'site' ? 'site' : 'home', false)
    await rename(stage, sitePath)
  } catch (error) {
    await rm(stage, { recursive: true, force: true })
    throw error
  }
  return {
    status: 'promoted',
    id: artifact.id,
    kind: artifact.kind,
    owner,
    source: artifact.ref,
    ref: destinationRef,
    path: relative(input.homeRoot, sitePath),
  }
}

async function validateDirectory(directory, metadata, kind, ownerScope, legacy) {
  const name = artifactDocument(kind)
  if (name !== 'artifact.md') {
    for (const key of ['$schema', 'id', 'kind', 'owner', 'derived_from']) {
      if (metadata[key] === undefined || metadata[key] === '') throw failure('artifact_invalid', `Artifact metadata requires ${key}.`)
    }
    if (metadata.kind !== kind.id) throw failure('artifact_invalid', `Artifact kind ${metadata.kind} does not match ${kind.id}.`)
    if (!Array.isArray(metadata.derived_from)) throw failure('artifact_invalid', 'derived_from must be an array.')
    if (kind.states?.length && !kind.states.includes(metadata.work_state)) throw failure('artifact_invalid', `${metadata.work_state} is not valid for ${kind.id}.`)
    if (!legacy) assertSourceScope(kind, ownerScope)
    const schema = JSON.parse(await readFile(join(kind.root, kind.schema), 'utf8'))
    validateMetadataSchema(metadata, schema)
    return
  }
  for (const key of ['$schema', 'id', 'kind', 'owner', 'status', 'created_at', 'updated_at', 'derived_from']) {
    if (metadata[key] === undefined || metadata[key] === '') throw failure('artifact_invalid', `Artifact metadata requires ${key}.`)
  }
  const expectedSchema = legacy
    ? 'https://endroit.org/schema/artifact.json'
    : 'https://endroit.org/schema/v7/artifact.json'
  if (metadata.$schema !== expectedSchema) throw failure('artifact_invalid', `Artifact schema must be ${expectedSchema}.`)
  if (metadata.kind !== kind.id) throw failure('artifact_invalid', `Artifact kind ${metadata.kind} does not match ${kind.id}.`)
  if (!Array.isArray(metadata.derived_from)) throw failure('artifact_invalid', 'derived_from must be an array.')
  if (kind.states?.length && !kind.states.includes(metadata.status)) throw failure('artifact_invalid', `${metadata.status} is not valid for ${kind.id}.`)
  if (!legacy) assertSourceScope(kind, ownerScope)
  for (const source of kind.requiredFiles ?? []) {
    const path = join(directory, basename(source))
    if (!await exists(path)) throw failure('artifact_invalid', `${kind.id} requires ${basename(source)}.`)
    if ((await lstat(path)).isSymbolicLink()) throw failure('symlink_forbidden', `${basename(source)} must not be a symbolic link.`)
  }
  const schema = JSON.parse(await readFile(join(kind.root, kind.schema), 'utf8'))
  validateMetadataSchema(metadata, schema)
}

function selectKind(plan, selector) {
  const matches = plan.artifactKinds.filter((kind) => kind.id === selector || kind.localId === selector)
  if (!matches.length) throw failure('artifact_kind_missing', `${selector} is not a declared Artifact kind.`)
  if (matches.length > 1) throw failure('artifact_kind_ambiguous', `${selector} matches multiple Artifact kinds.`)
  return matches[0]
}

function selectRoom(input, selector) {
  const normalized = String(selector).replace(/^room:/, '')
  const [scope, ...segments] = normalized.split('/')
  if (!['home', 'desk'].includes(scope) || !segments.length || !segments.every(validId)) {
    throw failure('room_selector_invalid', `Invalid Room selector ${selector}.`, 2)
  }
  const id = segments.join('/')
  const room = (input.resolvedHome.rooms ?? []).find((entry) => entry.scope === scope && entry.id === id)
  if (!room) throw failure('room_missing', `${selector} was not found.`)
  return room
}

function roomDestination(input, kind, id, room) {
  const root = room.scope === 'home'
    ? join(input.homeRoot, 'rooms', room.id)
    : join(input.deskRoot, 'rooms', room.id)
  return join(root, kind.roomNamespace, kind.localId, id)
}

function roomFromOwner(owner, rooms = []) {
  const match = String(owner).match(/^room:(home|desk)\/(.+)$/)
  return match ? rooms.find((entry) => entry.scope === match[1] && entry.id === match[2]) : null
}

async function selectArtifact(input, selector) {
  const selectedPath = resolve(selector)
  const candidate = ['artifact.md', 'WORK.md'].includes(basename(selectedPath)) ? dirname(selectedPath) : selectedPath
  const selectedDirectory = await realpath(candidate).catch(() => candidate)
  const matches = (await listArtifacts(input)).filter((entry) =>
    entry.id === selector
    || `${entry.kind}:${entry.id}` === selector
    || entry.ref === selector
    || entry.path === selectedDirectory)
  if (!matches.length) throw failure('artifact_missing', `${selector} was not found.`)
  if (matches.length > 1) throw failure('artifact_ambiguous', `${selector} matches multiple Artifacts.`)
  return matches[0]
}

function artifactRef(room, kind, id) {
  return `artifact:${room.scope}/${room.id}/${kind.roomNamespace}/${kind.localId}/${id}`
}

function parseDestination(value) {
  const normalized = String(value).replace(/^room:/, '')
  const [scope, ...segments] = normalized.split('/')
  if (scope === 'home' && segments.length && segments.every(validId)) return { kind: 'room', id: segments.join('/') }
  const site = String(value).match(/^site:([a-z0-9][a-z0-9._-]{0,127})$/)
  if (site) return { kind: 'site', id: site[1] }
  throw failure('artifact_destination_invalid', 'Use --to room:home/<id> or --to site:<id>.', 2)
}

function legacyDestination(flags) {
  if (flags.to === 'home') return 'room:home/home'
  if (flags.to === 'site') return `site:${required(flags.site, 'Site id')}`
  throw failure('artifact_destination_invalid', 'Legacy publish requires --to home or --to site.', 2)
}

function normalizeMetadata(raw) {
  const createdAt = raw.created_at ?? raw.createdAt
  return {
    ...raw,
    status: raw.status ?? raw.work_state ?? raw.state,
    created_by: raw.created_by ?? raw.createdBy,
    created_at: createdAt,
    updated_at: raw.updated_at ?? createdAt,
    derived_from: values(raw.derived_from ?? raw.derivedFrom),
  }
}

async function installRequiredFiles(stage, kind) {
  for (const source of kind.requiredFiles ?? []) {
    const site = join(stage, basename(source))
    if (!await exists(site)) await cp(join(kind.root, source), site, { errorOnExist: true })
  }
}

async function copyInput(source, destination) {
  const root = await realpath(resolve(source))
  await assertTree(root)
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.name === 'artifact.md') throw failure('artifact_import_reserved', 'Imported files cannot include artifact.md.')
    if (entry.isSymbolicLink()) throw failure('symlink_forbidden', `Imported source contains symbolic link ${entry.name}.`)
    await cp(join(root, entry.name), join(destination, entry.name), { recursive: true, errorOnExist: true })
  }
}

async function assertTree(root) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw failure('symlink_forbidden', `Artifact source contains symbolic link ${entry.name}.`)
    if (entry.isDirectory()) await assertTree(join(root, entry.name))
  }
}

async function treeDigest(root) {
  const hash = createHash('sha256')
  async function visit(directory, prefix = '') {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.isSymbolicLink()) throw failure('symlink_forbidden', `Artifact source contains symbolic link ${entry.name}.`)
      const path = join(directory, entry.name)
      const name = join(prefix, entry.name)
      if (entry.isDirectory()) await visit(path, name)
      else {
        hash.update(`${name}\0`)
        hash.update(await readFile(path))
      }
    }
  }
  await visit(root)
  return `sha256:${hash.digest('hex')}`
}

function validateMetadataSchema(metadata, schema) {
  for (const key of schema.required ?? []) if (metadata[key] === undefined) throw failure('artifact_schema_invalid', `${key} is required by the Artifact kind.`)
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(metadata)) if (!Object.hasOwn(schema.properties ?? {}, key)) throw failure('artifact_schema_invalid', `${key} is not declared by the Artifact kind.`)
  }
  for (const [key, rule] of Object.entries(schema.properties ?? {})) {
    if (metadata[key] === undefined) continue
    if (rule.const !== undefined && metadata[key] !== rule.const) throw failure('artifact_schema_invalid', `${key} must equal ${rule.const}.`)
    if (rule.enum && !rule.enum.includes(metadata[key])) throw failure('artifact_schema_invalid', `${key} must be one of ${rule.enum.join(', ')}.`)
    if (rule.type === 'array' && !Array.isArray(metadata[key])) throw failure('artifact_schema_invalid', `${key} must be an array.`)
    if (rule.type === 'string' && typeof metadata[key] !== 'string') throw failure('artifact_schema_invalid', `${key} must be a string.`)
    if (rule.type === 'object' && (typeof metadata[key] !== 'object' || metadata[key] === null || Array.isArray(metadata[key]))) throw failure('artifact_schema_invalid', `${key} must be an object.`)
  }
}

function assertSourceScope(kind, scope) {
  if (!kind.owners.includes(scope)) throw failure('artifact_owner_invalid', `${kind.id} cannot be owned by ${scope}.`)
}

async function routes(input, siteId) {
  return Promise.all((input.resolvedHome.routes ?? [])
    .filter((route) => route.site === siteId)
    .map(async (route) => ({
      id: route.id,
      ref: route.ref,
      declared: route.declared,
      path: await realpath(route.declaredPath).catch(() => null),
    })))
    .then((found) => found.filter((route) => route.path))
}

async function selectRoute(input, siteId, routeId) {
  const found = await routes(input, siteId)
  if (routeId) {
    const selected = found.find((entry) => entry.id === routeId)
    if (!selected) throw failure('route_missing', `${siteId} has no Route ${routeId}.`)
    if (selected.declared.status !== 'active') throw failure('route_inactive', `Route ${siteId}/${routeId} is ${selected.declared.status}.`)
    return selected
  }
  const active = found.filter((route) => route.declared.status === 'active')
  if (!active.length) throw failure('site_unrouted', `${siteId} has no usable active Route.`)
  if (active.length > 1) throw failure('route_ambiguous', `${siteId} has multiple active Routes; pass --route.`)
  return active[0]
}

function renderArtifact(metadata, body) {
  const clean = Object.fromEntries(Object.entries(metadata).filter(([key, value]) =>
    value !== undefined && !['state', 'createdBy', 'createdAt', 'derivedFrom'].includes(key)))
  const lines = Object.entries(clean).map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
  return `---\n${lines.join('\n')}\n---\n\n${body.trim()}\n`
}

function artifactDocument(kind, artifact) {
  return artifact?.document ?? kind.document ?? 'artifact.md'
}

function parseArtifact(content, name = 'artifact.md') {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!match) throw failure('artifact_invalid', `${name} must start with frontmatter.`)
  const metadata = {}
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(':')
    if (separator < 1) throw failure('artifact_invalid', `Invalid frontmatter line: ${line}`)
    const key = line.slice(0, separator).trim()
    const value = line.slice(separator + 1).trim()
    try { metadata[key] = JSON.parse(value) } catch { metadata[key] = value }
  }
  return { metadata, body: match[2] }
}

async function safeReadDir(path) {
  try { return await readdir(path, { withFileTypes: true }) }
  catch (error) { if (error.code === 'ENOENT') return []; throw error }
}

async function exists(path) {
  try { await lstat(path); return true }
  catch (error) { if (error.code === 'ENOENT') return false; throw error }
}

function argumentsOf(argv) {
  const flags = {}
  const positionals = []
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (!value.startsWith('--')) { positionals.push(value); continue }
    const [name, inline] = value.slice(2).split('=', 2)
    const next = inline ?? (argv[index + 1] && !argv[index + 1].startsWith('-') ? argv[++index] : true)
    if (flags[name] === undefined) flags[name] = next
    else flags[name] = Array.isArray(flags[name]) ? [...flags[name], next] : [flags[name], next]
  }
  return { flags, positionals }
}

function values(value) {
  if (value === undefined || value === null || value === '') return []
  return Array.isArray(value) ? value : [value]
}

function assertId(value) {
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(value)) throw failure('artifact_id_invalid', `Invalid Artifact id ${value}.`, 2)
}

function validId(value) {
  return /^[a-z0-9][a-z0-9._-]{0,127}$/.test(value)
}

function human(value) {
  if (value.status === 'listed') return value.artifacts.length
    ? value.artifacts.map((entry) => `${entry.ref ?? entry.path} · ${entry.status ?? 'invalid'}${entry.legacy ? ' · legacy' : ''}`).join('\n')
    : 'No Artifacts.'
  if (value.status === 'inspected') return `${value.ref}\n${value.path}\n${value.body}`.trim()
  return `${value.status}: ${value.ref ?? `${value.kind}:${value.id}`}`
}

function helpFor(command) {
  if (!command) {
    return [
      'Usage: endroit artifact <command> [options]',
      '',
      'Commands:',
      ...Object.entries(HELP).map(([name, entry]) => `  ${name.padEnd(9)} ${entry.summary}`),
    ].join('\n')
  }
  const entry = HELP[command]
  if (!entry) throw failure('usage', `Unknown Artifact command ${command}.`, 2)
  return [`Usage: ${entry.usage}`, `Effect: ${entry.effect}`, '', entry.summary].join('\n')
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

function stdin() {
  return new Promise((resolvePromise, reject) => {
    const chunks = []
    process.stdin.on('data', (chunk) => chunks.push(chunk))
    process.stdin.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8')))
    process.stdin.on('error', reject)
  })
}
