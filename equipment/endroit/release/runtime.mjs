#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { lstat, mkdir, readFile, readdir, realpath, rename, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'

const execute = promisify(execFile)

try {
  const input = JSON.parse(await stdin())
  const { positionals, flags } = argumentsOf(input.argv)
  const [command, selector, ...rest] = positionals
  const release = selectRelease(input, required(selector, 'Release'))
  const value = await route(input, release, command, rest, flags)
  if (!value?.foreground) process.stdout.write(flags.json ? `${JSON.stringify(value, null, 2)}\n` : `${human(value)}\n`)
} catch (error) {
  process.stderr.write(`${error.code ?? 'release_failed'}: ${error.message}\n`)
  process.exitCode = error.exitCode ?? 4
}

async function route(input, release, command, rest, flags) {
  if (command === 'inspect') return inspectRelease(input, release, routeFlags(flags))
  if (command === 'preview') return previewRelease(input, release, flags)
  if (command === 'lock') return lockRelease(input, release, flags)
  if (command === 'verify') return verifyRelease(input, release)
  if (command === 'watch') return watchRelease(input, release, flags)
  if (command === 'observe') return observeRelease(input, release, flags)
  throw failure('usage', 'endroit release inspect|preview|lock|verify|watch|observe <release>', 2)
}

async function inspectRelease(input, release, selectedRoutes = {}) {
  const contract = releaseContract(release)
  const dogfood = await dogfoodEvidence(release, contract.dogfood)
  const sites = []
  for (const participant of contract.sites) {
    const route = await selectRoute(input, participant.site, selectedRoutes[participant.site])
    const repository = await inspectRepository(route.path)
    const exported = await resolveExport(input, participant, route, repository)
    sites.push({
      id: participant.id,
      site: participant.site,
      export: participant.export,
      effects: participant.effects,
      expectedHandle: participant.expected_handle,
      dependsOn: participant.depends_on ?? [],
      route: route.id,
      repository,
      exported,
    })
  }
  const lock = await readJson(join(release.path, 'release.lock.json'), null)
  const receipt = await readJson(join(release.path, 'release.receipt.json'), null)
  const blockers = [
    ...(dogfood.status !== 'passed' ? [`dogfood:${dogfood.status}`] : []),
    ...sites.flatMap((site) => [
      ...(!site.repository.clean ? [`${site.site}:dirty`] : []),
      ...(site.repository.conflicts ? [`${site.site}:conflicted`] : []),
      ...(site.repository.operation ? [`${site.site}:git-${site.repository.operation}`] : []),
    ]),
  ]
  return {
    status: 'inspected',
    id: release.id,
    ref: release.ref,
    title: contract.title,
    sourceDigest: release.source_digest,
    state: releaseState(lock, receipt, sites.length, dogfood),
    decision: {
      question: contract.question,
      readyForLock: blockers.length === 0,
      blockers,
      reviewGates: contract.reviewGates.map(({ id, question, required }) => ({ id, question, required })),
      dogfood,
    },
    dogfood,
    sites,
  }
}

async function lockRelease(input, release, flags) {
  const inspection = await inspectRelease(input, release, routeFlags(flags))
  if (inspection.dogfood.status !== 'passed') throw failure('release_dogfood_required', `${release.id} requires a matching passed dogfood.receipt.json.`)
  for (const site of inspection.sites) {
    assertLockable(site)
    if (!flags.check) {
      await qualify(site)
      site.repository = await inspectRepository(site.repository.root)
      assertLockable(site)
    }
    site.exported.digest = await exportDigest(site)
  }
  const lock = lockDocument(inspection)
  if (flags.check) return { status: 'lock-ready', lock, lockDigest: objectDigest(lock), writes: [] }
  const path = join(release.path, 'release.lock.json')
  await writeJsonAtomic(path, lock)
  return { status: 'locked', id: release.id, path: relative(input.homeRoot, path), lockDigest: objectDigest(lock), sites: lock.sites.length }
}

async function verifyRelease(input, release) {
  const path = join(release.path, 'release.lock.json')
  const lock = await readJson(path, null)
  if (!lock) throw failure('release_unlocked', `${release.id} has no release.lock.json.`)
  const selected = Object.fromEntries(lock.sites.map((site) => [site.site, site.route]))
  const inspection = await inspectRelease(input, release, selected)
  for (const site of inspection.sites) site.exported.digest = await exportDigest(site)
  const current = lockDocument(inspection)
  const expectedDigest = objectDigest(lock)
  const currentDigest = objectDigest(current)
  const drift = [
    ...lockDiff(lock, current),
    ...inspection.sites.flatMap((site) => [
      ...(!site.repository.clean ? [`${site.site}:dirty`] : []),
      ...(site.repository.conflicts ? [`${site.site}:conflicted`] : []),
      ...(site.repository.operation ? [`${site.site}:git-${site.repository.operation}`] : []),
    ]),
  ]
  return {
    status: drift.length ? 'drifted' : 'verified',
    id: release.id,
    lockDigest: expectedDigest,
    currentDigest,
    drift,
  }
}

async function watchRelease(input, release, flags) {
  const interval = duration(flags.interval ?? '15s')
  const timeout = duration(flags.timeout ?? '30m')
  const started = Date.now()
  do {
    const verification = await verifyRelease(input, release)
    if (verification.status === 'drifted') return { ...verification, status: 'failed' }
    const lock = await readJson(join(release.path, 'release.lock.json'))
    const remote = await remoteState(lock)
    if (remote.drift.length) return { status: 'drifted', id: release.id, lockDigest: verification.lockDigest, remote }
    if (remote.ci.status === 'unavailable') return { status: 'degraded', id: release.id, lockDigest: verification.lockDigest, remote }
    if (Date.now() - started >= timeout) return { status: 'timeout', id: release.id, lockDigest: verification.lockDigest, remote }
    await delay(Math.min(interval, 60_000))
  } while (true)
}

async function previewRelease(input, release, flags) {
  const inspection = await inspectRelease(input, release, routeFlags(flags))
  const candidates = inspection.sites.filter((site) => site.exported.preview)
  const selected = flags.site ? candidates.find((site) => site.site === flags.site) : candidates.length === 1 ? candidates[0] : null
  if (!selected) {
    if (!candidates.length) throw failure('preview_unavailable', `${release.id} has no declared preview.`)
    throw failure('preview_ambiguous', `${release.id} has multiple previews; pass --site.`, 2)
  }
  const preview = selected.exported.preview
  const [command, ...args] = preview.command
  const statePath = join(input.homeRoot, '.endroit', 'release-previews', `${release.id}--${selected.site}.json`)
  const child = spawn(command, args, { cwd: selected.repository.root, env: process.env, stdio: ['inherit', 'pipe', 'pipe'] })
  let stateWrite = Promise.resolve()
  const observe = (chunk, stream) => {
    stream.write(chunk)
    const found = String(chunk).match(/https?:\/\/[^\s]+/g)?.at(-1)
    if (found) stateWrite = writeJsonAtomic(statePath, { version: 1, release: release.id, site: selected.site, url: found, pid: child.pid })
  }
  child.stdout.on('data', (chunk) => observe(chunk, process.stdout))
  child.stderr.on('data', (chunk) => observe(chunk, process.stderr))
  const forward = (signal) => child.kill(signal)
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(signal, () => forward(signal))
  await new Promise((resolvePromise, reject) => {
    child.on('error', reject)
    child.on('close', (code, signal) => signal || code === 0 ? resolvePromise() : reject(failure('preview_failed', `${selected.site} preview exited with ${code}.`)))
  })
  await stateWrite
  return { foreground: true }
}

async function observeRelease(input, release, flags) {
  const site = required(flags.site, 'Site')
  const status = required(flags.status, 'Observed status')
  const handle = required(flags.handle, 'Observed handle')
  if (!['delivered', 'observed', 'failed'].includes(status)) throw failure('observation_status_invalid', 'Status must be delivered, observed or failed.', 2)
  try { new URL(handle) } catch { throw failure('observation_handle_invalid', 'Observed handle must be an absolute URL.', 2) }
  const verification = await verifyRelease(input, release)
  if (verification.status !== 'verified') throw failure('release_drifted', `${release.id} does not match its lock.`)
  const lock = await readJson(join(release.path, 'release.lock.json'))
  const participant = lock.sites.find((entry) => entry.site === site)
  if (!participant) throw failure('release_site_missing', `${site} is not a participant in ${release.id}.`)
  if (status !== 'failed' && handle !== participant.expectedHandle) throw failure('observation_handle_mismatch', `${site} must be observed at ${participant.expectedHandle}.`)
  const path = join(release.path, 'release.receipt.json')
  const receipt = await readJson(path, { version: 1, release: release.id, lockDigest: verification.lockDigest, sites: [] })
  if (receipt.lockDigest !== verification.lockDigest) throw failure('receipt_lock_mismatch', 'The existing receipt belongs to another lock.')
  const observation = { site, status, handle, observedAt: new Date().toISOString() }
  receipt.sites = [...receipt.sites.filter((entry) => entry.site !== site), observation].sort((left, right) => left.site.localeCompare(right.site))
  await writeJsonAtomic(path, receipt)
  return { status: 'recorded', id: release.id, site, path: relative(input.homeRoot, path), releaseState: releaseState(lock, receipt, lock.sites.length, { status: 'passed' }) }
}

function releaseContract(release) {
  assertMetadata(release.metadata, {
    $schema: 'https://endroit.org/schema/release/release/v1alpha1.json',
    kind: 'endroit/release:release',
    artifact_contract: 'endroit/release/release/v1alpha1',
  })
  const contracts = release.fragments.filter((fragment) => fragment.kind === 'release_contract')
  const sites = release.fragments.filter((fragment) => fragment.kind === 'release_site')
  const reviewGates = release.fragments.filter((fragment) => fragment.kind === 'review_gate')
  const dogfoods = release.fragments.filter((fragment) => fragment.kind === 'release_dogfood')
  const supported = new Set(['release_contract', 'release_site', 'review_gate', 'release_dogfood'])
  for (const fragment of release.fragments) if (!supported.has(fragment.kind)) throw failure('release_fragment_invalid', `Unsupported Release Fragment ${fragment.kind}.`)
  const fragmentIds = release.fragments.map((fragment) => fragment.id)
  if (fragmentIds.some((id) => !id) || new Set(fragmentIds).size !== fragmentIds.length) throw failure('release_fragment_duplicate', 'Release Fragment ids must be present and unique.')
  if (contracts.length !== 1) throw failure('release_contract_invalid', 'Release requires exactly one release_contract Fragment.')
  assertKeys(contracts[0], ['kind', 'id', 'title', 'question', 'heading', 'level', 'metadata', 'body'], ['kind', 'id', 'title', 'question'])
  if (!sites.length) throw failure('release_sites_missing', 'Release requires at least one release_site Fragment.')
  if (!reviewGates.length) throw failure('release_review_gate_missing', 'Release requires at least one review_gate Fragment.')
  if (dogfoods.length !== 1) throw failure('release_dogfood_invalid', 'Release requires exactly one release_dogfood Fragment.')
  for (const gate of reviewGates) {
    assertKeys(gate, ['kind', 'id', 'question', 'required', 'heading', 'level', 'metadata', 'body'], ['kind', 'id', 'question', 'required'])
    assertId(gate.id, 'review_gate id')
    if (typeof gate.required !== 'boolean') throw failure('release_review_gate_invalid', `${gate.id} required must be boolean.`)
  }
  assertKeys(dogfoods[0], ['kind', 'id', 'required', 'heading', 'level', 'metadata', 'body'], ['kind', 'id', 'required'])
  assertId(dogfoods[0].id, 'release_dogfood id')
  if (dogfoods[0].required !== true) throw failure('release_dogfood_invalid', 'release_dogfood.required must be true.')
  const ids = new Set()
  const siteIds = new Set()
  for (const site of sites) {
    assertKeys(site, ['kind', 'id', 'site', 'export', 'effects', 'expected_handle', 'depends_on', 'heading', 'level', 'metadata', 'body'], ['kind', 'id', 'site', 'export', 'effects', 'expected_handle'])
    assertId(site.id, 'release_site id')
    assertId(site.site, 'Site id')
    assertExport(site.export)
    if (ids.has(site.id) || siteIds.has(site.site)) throw failure('release_site_duplicate', `Duplicate release_site ${site.id}/${site.site}.`)
    if (!Array.isArray(site.effects) || !site.effects.length || site.effects.some((entry) => typeof entry !== 'string' || !entry) || new Set(site.effects).size !== site.effects.length) throw failure('release_effects_invalid', `${site.id} effects must be a non-empty unique array.`)
    assertUrl(site.expected_handle, `${site.id} expected_handle`)
    if (site.depends_on !== undefined && (!Array.isArray(site.depends_on) || site.depends_on.some((entry) => typeof entry !== 'string'))) throw failure('release_dependency_invalid', `${site.id} depends_on must be an array.`)
    for (const dependency of site.depends_on ?? []) if (!siteIds.has(dependency)) throw failure('release_dependency_invalid', `${site.id} dependency ${dependency} must name an earlier participant.`)
    ids.add(site.id); siteIds.add(site.site)
  }
  return { title: contracts[0].title, question: contracts[0].question, sites, reviewGates, dogfood: dogfoods[0] }
}

async function dogfoodEvidence(release, declaration) {
  const receipt = await readJson(join(release.path, 'dogfood.receipt.json'), null)
  if (!receipt) return { id: declaration.id, required: true, status: 'missing', receiptDigest: null }
  const valid = validDogfoodReceipt(receipt, release)
  return {
    id: declaration.id,
    required: true,
    status: valid ? 'passed' : 'invalid',
    receiptDigest: objectDigest(receipt),
  }
}

function validDogfoodReceipt(receipt, release) {
  const passed = (value) => value === 'passed'
  return receipt?.version === 1
    && receipt.release === release.id
    && receipt.sourceDigest === release.source_digest
    && receipt.status === 'passed'
    && /^[a-f0-9]{40,64}$/.test(receipt.home?.baseCommit ?? '')
    && typeof receipt.home?.revision === 'string' && receipt.home.revision.length > 0
    && typeof receipt.package?.version === 'string' && receipt.package.version.length > 0
    && /^[a-f0-9]{40,64}$/.test(receipt.package?.sourceCommit ?? '')
    && /^sha256:[a-f0-9]{64}$/.test(receipt.package?.digest ?? '')
    && /^sha512-[A-Za-z0-9+/]+={0,2}$/.test(receipt.package?.sri ?? '')
    && /^sha256:[a-f0-9]{64}$/.test(receipt.upgrade?.planDigest ?? '')
    && typeof receipt.upgrade?.revision === 'string' && receipt.upgrade.revision.length > 0
    && ['validate', 'build', 'doctor', 'roomDoctor', 'siteDoctor', 'checkout'].every((key) => passed(receipt.checks?.[key]))
    && ['git', 'checkouts'].every((key) => passed(receipt.invariants?.[key]))
    && typeof receipt.verifiedAt === 'string' && !Number.isNaN(Date.parse(receipt.verifiedAt))
}

async function resolveExport(input, participant, route, repository) {
  const root = repository.root
  const destination = assertInside(root, resolve(root, participant.export), 'Site export')
  const path = await realpath(destination).catch((error) => {
    if (error.code === 'ENOENT') throw failure('release_export_missing', `${participant.site} export ${participant.export} is missing.`)
    throw error
  })
  assertInside(root, path, 'Resolved Site export')
  const declaredSurfaces = (input.inspection?.artifacts ?? []).filter((artifact) => artifact.kind === 'endroit/release:public-surface' && artifact.site === participant.site)
  if (participant.export === './') {
    if (declaredSurfaces.length) throw failure('release_surface_bypass', `${participant.site} declares a public-surface; select its logical site_export instead of ./.`)
    return { path, digest: await trackedTreeDigest(root), surface: null, qualification: {}, preview: null }
  }
  const matches = declaredSurfaces.filter((artifact) => artifact.fragments?.some((fragment) => fragment.kind === 'site_export' && fragment.name === participant.export))
  if (matches.length !== 1) throw failure(matches.length ? 'release_export_ambiguous' : 'release_surface_missing', `${participant.site} export ${participant.export} must resolve to one public-surface Artifact.`)
  const surface = surfaceContract(matches[0], participant.site, participant.export)
  if (await realpath(matches[0].path) !== path) throw failure('release_export_divergent', `${participant.site} export ${participant.export} does not resolve to its Surface.`)
  return { path, digest: await treeDigest(path), surface: matches[0].ref, qualification: surface.qualification, preview: surface.preview }
}

function surfaceContract(surface, site, name) {
  assertMetadata(surface.metadata, {
    $schema: 'https://endroit.org/schema/release/public-surface/v1alpha1.json',
    kind: 'endroit/release:public-surface',
    owner: `site:${site}`,
    artifact_contract: 'endroit/release/public-surface/v1alpha1',
  })
  const contracts = surface.fragments.filter((fragment) => fragment.kind === 'surface_contract')
  const exports = surface.fragments.filter((fragment) => fragment.kind === 'site_export')
  const content = surface.fragments.filter((fragment) => fragment.kind === 'content')
  const supported = new Set(['surface_contract', 'site_export', 'content'])
  for (const fragment of surface.fragments) if (!supported.has(fragment.kind)) throw failure('surface_fragment_invalid', `Unsupported Surface Fragment ${fragment.kind}.`)
  if (contracts.length !== 1 || exports.length !== 1 || !content.length) throw failure('surface_contract_invalid', `${surface.ref} requires one surface_contract, one site_export and at least one content Fragment.`)
  assertKeys(contracts[0], ['kind', 'id', 'entrypoint', 'heading', 'level', 'metadata', 'body'], ['kind', 'id', 'entrypoint'])
  assertKeys(exports[0], ['kind', 'id', 'name', 'renderer', 'qualification', 'outputs', 'preview', 'heading', 'level', 'metadata', 'body'], ['kind', 'id', 'name', 'renderer', 'qualification', 'outputs'])
  for (const fragment of content) assertKeys(fragment, ['kind', 'id', 'heading', 'level', 'metadata', 'body'], ['kind', 'id'])
  const ids = surface.fragments.map((fragment) => fragment.id)
  if (ids.some((id) => !id) || new Set(ids).size !== ids.length) throw failure('surface_fragment_duplicate', `${surface.ref} Fragment ids must be present and unique.`)
  if (exports[0].name !== name) throw failure('surface_export_mismatch', `${surface.ref} exports ${exports[0].name}, expected ${name}.`)
  assertQualification(exports[0].qualification)
  if (!Array.isArray(exports[0].outputs) || exports[0].outputs.some((entry) => typeof entry !== 'string')) throw failure('surface_outputs_invalid', `${surface.ref} outputs must be an array.`)
  if (exports[0].preview !== undefined) assertPreview(exports[0].preview)
  return exports[0]
}

function lockDocument(inspection) {
  return {
    version: 1,
    release: inspection.id,
    sourceDigest: inspection.sourceDigest,
    dogfood: {
      id: inspection.dogfood.id,
      status: inspection.dogfood.status,
      receiptDigest: inspection.dogfood.receiptDigest,
    },
    sites: inspection.sites.map((site) => ({
      site: site.site,
      export: site.export,
      effects: site.effects,
      expectedHandle: site.expectedHandle,
      dependsOn: site.dependsOn,
      route: site.route,
      repository: site.repository.remote?.repository ?? null,
      commit: site.repository.head,
      branch: site.repository.branch,
      upstream: site.repository.upstream,
      upstreamCommit: site.repository.upstreamHead,
      exportDigest: site.exported.digest,
      surface: site.exported.surface,
    })),
  }
}

async function selectRoute(input, siteId, routeId) {
  const routes = []
  for (const route of (input.resolvedHome.routes ?? []).filter((entry) => entry.site === siteId && entry.declared.status === 'active')) {
    const path = await realpath(route.declaredPath).catch(() => null)
    if (path) routes.push({ ...route, path })
  }
  if (routeId) {
    const route = routes.find((entry) => entry.id === routeId)
    if (!route) throw failure('route_missing', `${siteId} has no active Route ${routeId}.`)
    return route
  }
  if (!routes.length) throw failure('site_unrouted', `${siteId} has no active Route.`)
  if (routes.length > 1) {
    const releases = routes.filter((route) => (route.declared.purpose ?? route.purpose) === 'release')
    if (releases.length === 1) return releases[0]
    throw failure('route_ambiguous', `${siteId} has multiple active Routes; declare one purpose=release or pass --route ${siteId}=<route>.`, 2)
  }
  return routes[0]
}

async function inspectRepository(path) {
  const root = await git(['rev-parse', '--show-toplevel'], path)
  const [head, branch, status, remoteUrl, upstream, operation] = await Promise.all([
    git(['rev-parse', 'HEAD'], root),
    git(['symbolic-ref', '--quiet', '--short', 'HEAD'], root).catch(() => null),
    git(['status', '--porcelain=v2', '--branch', '--untracked-files=all'], root, false),
    git(['remote', 'get-url', 'origin'], root).catch(() => null),
    git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], root).catch(() => null),
    gitOperation(root),
  ])
  const changes = status.split('\n').filter((line) => /^(1 |2 |u |\? )/.test(line))
  const upstreamHead = upstream ? await git(['rev-parse', '@{upstream}'], root).catch(() => null) : null
  return {
    root,
    head,
    branch,
    detached: !branch,
    clean: changes.length === 0,
    changes: changes.length,
    conflicts: changes.filter((line) => line.startsWith('u ')).length,
    operation,
    upstream,
    upstreamHead,
    remote: remoteUrl ? { url: remoteUrl, repository: normalizeRepository(remoteUrl) } : null,
  }
}

function assertLockable(site) {
  if (!site.repository.clean) throw failure('release_checkout_dirty', `${site.site}/${site.route} has ${site.repository.changes} change(s).`)
  if (site.repository.conflicts) throw failure('release_checkout_conflicted', `${site.site}/${site.route} is conflicted.`)
  if (site.repository.operation) throw failure('release_git_operation', `${site.site}/${site.route} has an active ${site.repository.operation}.`)
}

async function qualify(site) {
  for (const [name, argv] of Object.entries(site.exported.qualification ?? {})) {
    const [command, ...args] = argv
    try { await execute(command, args, { cwd: site.repository.root, env: process.env, maxBuffer: 16 * 1024 * 1024 }) }
    catch (error) { throw failure('release_qualification_failed', `${site.site} ${name} failed: ${error.stderr?.trim() || error.message}`) }
  }
}

function exportDigest(site) {
  return site.export === './' ? trackedTreeDigest(site.repository.root) : treeDigest(site.exported.path)
}

async function trackedTreeDigest(root) {
  const index = await git(['ls-files', '--stage', '-z'], root, false)
  return `sha256:${createHash('sha256').update(index).digest('hex')}`
}

async function remoteState(lock) {
  const ready = []
  const pending = []
  const drift = []
  for (const site of lock.sites) {
    if (!site.repository || !site.branch) { pending.push({ site: site.site, reason: 'remote-unavailable' }); continue }
    const output = await gitGlobal(['ls-remote', `https://${site.repository}`, `refs/heads/${site.branch}`]).catch(() => '')
    const head = output.split(/\s+/)[0] || null
    if (!head) pending.push({ site: site.site, reason: 'branch-unavailable' })
    else if (head === site.commit) ready.push({ site: site.site, head })
    else drift.push({ site: site.site, expected: site.commit, observed: head })
  }
  return {
    ready,
    pending,
    drift,
    ci: {
      status: 'unavailable',
      reason: 'ci-observer-unavailable',
      detail: 'Endroit has no generic CI observer; use the delivery Equipment for the host in this Workplace.',
    },
  }
}

function lockDiff(expected, current) {
  const fields = []
  if (expected.release !== current.release) fields.push('release')
  if (expected.sourceDigest !== current.sourceDigest) fields.push('sourceDigest')
  if (JSON.stringify(expected.dogfood) !== JSON.stringify(current.dogfood)) fields.push('dogfood')
  if (JSON.stringify(expected.sites) !== JSON.stringify(current.sites)) fields.push('sites')
  return fields
}

function releaseState(lock, receipt, participants, dogfood) {
  if (dogfood.status !== 'passed') return 'blocked'
  if (!lock) return 'resolved'
  const observed = receipt?.sites?.filter((site) => site.status !== 'failed').length ?? 0
  if (!observed) return 'locked'
  return observed >= participants ? 'observed' : 'partially-observed'
}

function assertMetadata(metadata, expected) {
  for (const [key, value] of Object.entries(expected)) if (metadata?.[key] !== value) throw failure('artifact_contract_invalid', `${key} must equal ${value}.`)
  if (!['retained', 'archived'].includes(metadata.material_state) || !['current', 'superseded', 'withdrawn'].includes(metadata.currentness) || !Array.isArray(metadata.derived_from)) {
    throw failure('artifact_contract_invalid', 'Artifact lifecycle metadata is invalid.')
  }
}

function assertKeys(value, allowed, requiredKeys) {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw failure('fragment_field_invalid', `${value.kind} contains unsupported field ${key}.`)
  for (const key of requiredKeys) if (value[key] === undefined || value[key] === '') throw failure('fragment_field_missing', `${value.kind} requires ${key}.`)
}

function assertQualification(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw failure('surface_qualification_invalid', 'site_export qualification must be an object.')
  for (const [name, argv] of Object.entries(value)) {
    assertId(name, 'qualification id')
    if (!Array.isArray(argv) || !argv.length || argv.some((entry) => typeof entry !== 'string' || !entry)) throw failure('surface_qualification_invalid', `${name} must be a non-empty argv array.`)
  }
}

function assertPreview(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !['command'].includes(key))) throw failure('surface_preview_invalid', 'preview supports only command.')
  if (!Array.isArray(value.command) || !value.command.length || value.command.some((entry) => typeof entry !== 'string' || !entry)) throw failure('surface_preview_invalid', 'preview.command must be a non-empty argv array.')
}

function assertUrl(value, label) {
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error()
  } catch { throw failure('release_handle_invalid', `${label} must be an absolute HTTP(S) URL.`) }
}

function assertExport(value) {
  if (value !== './' && (!String(value).startsWith('./') || isAbsolute(value) || String(value).includes('..') || String(value).includes('\\'))) throw failure('release_export_invalid', `Invalid logical export ${value}.`)
}

function assertId(value, label) {
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(String(value))) throw failure('release_id_invalid', `Invalid ${label}: ${value}.`)
}

function assertInside(root, candidate, label) {
  const rel = relative(resolve(root), resolve(candidate))
  if (rel === '..' || rel.startsWith(`..${sep}`)) throw failure('path_escape', `${label} escapes its Site.`)
  return resolve(candidate)
}

async function treeDigest(root) {
  const hash = createHash('sha256')
  async function visit(directory, prefix = '') {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue
      if (entry.isSymbolicLink()) throw failure('symlink_forbidden', `Export contains symbolic link ${join(prefix, entry.name)}.`)
      const path = join(directory, entry.name)
      const name = join(prefix, entry.name)
      if (entry.isDirectory()) await visit(path, name)
      else { hash.update(`${name}\0`); hash.update(await readFile(path)) }
    }
  }
  const stat = await lstat(root)
  if (stat.isDirectory()) await visit(root)
  else hash.update(await readFile(root))
  return `sha256:${hash.digest('hex')}`
}

async function git(args, cwd, trim = true) {
  try {
    const { stdout } = await execute('git', args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, maxBuffer: 8 * 1024 * 1024 })
    return trim ? stdout.trim() : stdout
  } catch (error) { throw failure('git_failed', `git ${args.join(' ')} failed: ${error.stderr?.trim() || error.message}`) }
}

async function gitGlobal(args) { return git(args, process.cwd()) }

async function gitOperation(root) {
  for (const [operation, marker] of [['merge', 'MERGE_HEAD'], ['cherry-pick', 'CHERRY_PICK_HEAD'], ['revert', 'REVERT_HEAD'], ['rebase', 'rebase-merge'], ['rebase', 'rebase-apply']]) {
    const path = await git(['rev-parse', '--git-path', marker], root)
    try { await lstat(isAbsolute(path) ? path : join(root, path)); return operation }
    catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  return null
}

function normalizeRepository(value) {
  let source = String(value).trim()
  const scp = source.match(/^(?:[^@]+@)?([^:/]+):(.+)$/)
  if (scp && !source.includes('://')) source = `ssh://${scp[1]}/${scp[2]}`
  try {
    const url = new URL(source)
    return `${url.hostname.toLowerCase()}/${url.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '').toLowerCase()}`
  } catch { return source.replace(/\.git$/i, '').replace(/^\/+|\/+$/g, '').toLowerCase() }
}

function selectRelease(input, selector) {
  const matches = (input.inspection?.artifacts ?? []).filter((artifact) => artifact.kind === 'endroit/release:release' && (artifact.id === selector || artifact.ref === selector || `${artifact.kind}:${artifact.id}` === selector))
  if (!matches.length) throw failure('release_missing', `${selector} was not found.`)
  if (matches.length > 1) throw failure('release_ambiguous', `${selector} matches multiple Releases.`)
  return matches[0]
}

function routeFlags(flags) {
  const routes = {}
  for (const value of values(flags.route)) {
    const separator = String(value).indexOf('=')
    if (separator < 1) throw failure('usage', '--route must use <site>=<route>.', 2)
    const site = String(value).slice(0, separator)
    if (routes[site]) throw failure('usage', `Duplicate Route for ${site}.`, 2)
    routes[site] = String(value).slice(separator + 1)
  }
  return routes
}

function objectDigest(value) { return `sha256:${createHash('sha256').update(`${JSON.stringify(value, null, 2)}\n`).digest('hex')}` }
async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o644 })
  await rename(temporary, path)
}
async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')) }
  catch (error) { if (error.code === 'ENOENT' && fallback !== undefined) return fallback; throw error }
}
function duration(value) {
  const match = String(value).match(/^(\d+)(ms|s|m)?$/)
  if (!match) throw failure('duration_invalid', `Invalid duration ${value}.`, 2)
  return Number(match[1]) * ({ ms: 1, s: 1000, m: 60_000 }[match[2] ?? 'ms'])
}
function delay(ms) { return new Promise((resolvePromise) => setTimeout(resolvePromise, ms)) }
function argumentsOf(argv) {
  const flags = {}; const positionals = []
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
function values(value) { return value === undefined ? [] : Array.isArray(value) ? value : [value] }
function required(value, label) { if (value === undefined || value === true || value === '') throw failure('usage', `${label} is required.`, 2); return value }
function failure(code, message, exitCode = 4) { const error = new Error(message); error.code = code; error.exitCode = exitCode; return error }
function human(value) {
  if (value.status === 'inspected') return [
    `Release ${value.id} · ${value.state}`,
    `Decision: ${value.decision.question}`,
    `Dogfood: ${value.decision.dogfood.status}`,
    ...(value.decision.blockers.length ? ['Blockers:', ...value.decision.blockers.map((item) => `- ${item}`)] : []),
    'Review gates:',
    ...value.decision.reviewGates.map((gate) => `- ${gate.required ? 'required' : 'optional'} · ${gate.id}: ${gate.question}`),
    'Sites:',
    ...value.sites.map((site) => `- ${site.site} ${site.export} · ${site.effects.join(', ')} · ${site.route} · ${site.repository.head}`),
  ].join('\n')
  return `${value.status}: ${value.id ?? value.release ?? ''}`.trim()
}
function stdin() { return new Promise((resolvePromise, reject) => { const chunks = []; process.stdin.on('data', (chunk) => chunks.push(chunk)); process.stdin.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8'))); process.stdin.on('error', reject) }) }
