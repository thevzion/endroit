import Ajv2020 from 'ajv/dist/2020.js'
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateDocument } from './contracts.mjs'
import { git } from './git.mjs'
import { loadHome } from './home.mjs'
import { EndroitError } from './lib/errors.mjs'
import { assertInside, digest, exists, removeTree, resolvePackageFile } from './lib/io.mjs'

const builtinRoot = fileURLToPath(new URL('../equipment/endroit', import.meta.url))
const MAX_FILE_BYTES = 5 * 1024 * 1024
const githubAddress = /^([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)\/(.+?)(?:#([^#]+))?$/

export async function resolveEquipment(root, address) {
  const source = String(address)
  const official = source.match(/^@endroit\/([a-z0-9][a-z0-9._-]*)$/)
  if (official) return loadManifest(join(builtinRoot, official[1], 'equipment.json'), { root, source, mobile: false, firstParty: true })
  if (source.startsWith('@')) throw new EndroitError('source_invalid', `Unsupported Equipment namespace ${source}; use a GitHub, HTTPS or local manifest address.`)
  if (/^https:\/\//.test(source)) return loadManifest(assertSafeUrl(source), { root, source, mobile: true })
  if (/^http:\/\//.test(source)) throw new EndroitError('source_insecure', 'Equipment URLs must use HTTPS.')
  if (source.startsWith('.') || source.startsWith('/')) return loadManifest(source, { root, source, mobile: true })
  const github = source.match(githubAddress)
  if (github) return loadGithub(source, github)
  throw new EndroitError('source_invalid', `Unsupported Equipment address ${source}.`)
}

export async function addEquipment(root, addresses, options = {}) {
  const scope = options.scope === 'desk' ? 'desk' : 'home'
  const destinationRoot = await equipmentScopeRoot(root, scope)
  const resolved = await Promise.all(addresses.map((address) => resolveEquipment(root, address)))
  const ids = resolved.map((entry) => entry.manifest.name)
  if (new Set(ids).size !== ids.length) throw new EndroitError('equipment_collision', 'Each Equipment may be selected only once per add transaction.')
  const installed = (await installedEquipment(root, { scope })).filter((entry) => !entry.invalid)
  assertCapabilityCollisions([
    ...installed.filter((entry) => !options.overwrite || !ids.includes(entry.manifest.name)).map((entry) => entry.manifest),
    ...resolved.map((entry) => entry.manifest),
  ])
  const current = new Set(installed.map((entry) => entry.manifest.name))
  const writes = []
  for (const equipment of resolved) {
    const id = equipment.manifest.name
    if (current.has(id) && !options.overwrite) throw new EndroitError('equipment_exists', `${id} is already installed.`)
    const equipmentRoot = join(destinationRoot, id)
    for (const file of equipment.files) {
      const path = assertInside(equipmentRoot, join(equipmentRoot, file.path), 'Equipment destination')
      if (await exists(path) && !options.overwrite) throw new EndroitError('file_collision', `${relative(root, path)} already exists.`)
      writes.push({ path, content: file.content })
    }
    const manifestPath = join(equipmentRoot, 'equipment.json')
    if (await exists(manifestPath) && !options.overwrite) throw new EndroitError('file_collision', `${relative(root, manifestPath)} already exists.`)
    writes.push({ path: manifestPath, content: manifestBytes(installedManifest(equipment, 'source')) })
  }
  await assertFrontDoorAfter(root, resolved.map((entry) => ({
    id: entry.manifest.name,
    scope,
    manifest: entry.manifest,
  })))
  const preview = plan(root, writes, [])
  if (options.dryRun) return { status: 'planned', equipment: ids, ...preview }
  await applyTransaction(root, writes, [])
  return { status: 'added', equipment: ids, ...preview }
}

export async function installedEquipment(root, options = {}) {
  const scope = options.scope === 'desk' ? 'desk' : 'home'
  const base = scope === 'desk' ? join(root, '.desk', 'equipment') : join(root, 'equipment')
  if (!await exists(base)) return []
  const values = []
  for (const namespace of await directories(base, root)) {
    for (const name of await directories(join(base, namespace), root)) {
      const path = join(base, namespace, name, 'equipment.json')
      if (!await exists(path)) continue
      values.push(await loadInstalled(root, path, `${namespace}/${name}`, scope))
    }
  }
  const ids = values.filter((entry) => !entry.invalid).map((entry) => entry.manifest.name)
  if (new Set(ids).size !== ids.length) throw new EndroitError('equipment_invalid', 'Installed Equipment names must be unique.')
  return values.sort((left, right) => left.id.localeCompare(right.id))
}

export async function allInstalledEquipment(root) {
  const home = await installedEquipment(root, { scope: 'home' })
  const desk = await installedEquipment(root, { scope: 'desk' })
  return [...home, ...desk]
}

export async function catalogEquipment(root) {
  const installed = await allInstalledEquipment(root).catch(() => [])
  const scopes = new Map()
  for (const entry of installed.filter((candidate) => !candidate.invalid)) {
    const values = scopes.get(entry.id) ?? []
    values.push(entry.scope)
    scopes.set(entry.id, values)
  }
  const values = []
  for (const entry of await readdir(builtinRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue
    const manifestPath = join(builtinRoot, entry.name, 'equipment.json')
    if (!await exists(manifestPath)) continue
    const equipment = await resolveEquipment(root, `@endroit/${entry.name}`)
    const manifest = equipment.manifest
    values.push({
      id: manifest.name,
      version: manifest.version,
      description: manifest.description,
      installed: (scopes.get(manifest.name) ?? []).sort(),
      roomNamespace: manifest.roomNamespace ?? null,
      capabilities: (manifest.capabilities ?? []).map(({ id, description }) => ({ id, description })),
      surfaces: [
        ...(manifest.skills ?? []).map(({ id, description }) => ({ kind: 'skill', id, description })),
        ...(manifest.commands ?? []).map(({ id, description }) => ({ kind: 'command', id, description })),
      ],
      runtime: manifest.runtime ? {
        namespace: manifest.runtime.namespace,
        commands: manifest.runtime.commands,
      } : null,
    })
  }
  return values.sort((left, right) => left.id.localeCompare(right.id))
}

export async function validateEquipmentSource(root, source) {
  const equipment = await resolveEquipment(root, source)
  const files = new Map(equipment.files.map((entry) => [entry.path, entry.content]))
  for (const path of [
    ...(equipment.manifest.artifactKinds ?? []).map((entry) => entry.schema),
    ...Object.values(equipment.manifest.settings ?? {}),
  ]) {
    try {
      new Ajv2020({ allErrors: true, strict: false }).compile(JSON.parse(files.get(path).toString('utf8')))
    } catch (error) {
      throw new EndroitError('equipment_schema_invalid', `${equipment.manifest.name} contains an invalid schema at ${path}: ${error.message}`)
    }
  }
  for (const kind of equipment.manifest.artifactKinds ?? []) {
    if (!files.get(kind.template)?.length) throw new EndroitError('equipment_template_invalid', `${equipment.manifest.name} has an empty template at ${kind.template}.`)
  }
  return {
    status: 'valid',
    name: equipment.manifest.name,
    version: equipment.manifest.version,
    digest: equipmentDigest(equipment),
    source: equipment.source,
    mobile: equipment.mobile,
  }
}

export async function overrideEquipment(root, selector) {
  const home = await requireValid(await findInstalled(root, selector, { scope: 'home' }))
  const deskRoot = await equipmentScopeRoot(root, 'desk')
  const destination = join(deskRoot, home.id)
  if (await exists(join(destination, 'equipment.json'))) throw new EndroitError('equipment_exists', `${home.id} already has a Desk override.`)
  const manifest = sourceManifest(home.manifest)
  const files = await Promise.all(manifest.files.map(async (path) => ({ path, content: await readFile(join(home.root, path)) })))
  const source = {
    manifest,
    files,
    source: home.manifest.origin.source,
    requestedRef: home.manifest.origin.requestedRef,
    resolvedCommit: home.manifest.origin.resolvedCommit,
    mobile: home.manifest.origin.mobile,
  }
  const writes = files.map((file) => ({ path: join(destination, file.path), content: file.content }))
  writes.push({ path: join(destination, 'equipment.json'), content: manifestBytes(installedManifest(source, 'override')) })
  await assertFrontDoorAfter(root, [{ id: home.id, scope: 'desk', manifest }])
  await applyTransaction(root, writes, [])
  return { status: 'overridden', name: home.id, path: relative(root, destination) }
}

export async function promoteEquipment(root, selector) {
  const desk = await requireValid(await findInstalled(root, selector, { scope: 'desk' }))
  if (desk.manifest.origin.kind !== 'override') throw new EndroitError('equipment_not_override', `${desk.id} is not a Desk override.`)
  const home = await requireValid(await findInstalled(root, desk.id, { scope: 'home' }))
  const base = desk.manifest.origin
  if (manifestDigest(home.manifest) !== base.baseManifestDigest) throw new EndroitError('equipment_base_drifted', `${desk.id} Home manifest changed after the override was created.`)
  for (const [path, expected] of Object.entries(base.baseDigests)) {
    if (!await exists(join(home.root, path)) || digest(await readFile(join(home.root, path))) !== expected) {
      throw new EndroitError('equipment_base_drifted', `${desk.id} Home source changed after the override was created.`)
    }
  }
  const manifest = sourceManifest(desk.manifest)
  const files = await Promise.all(manifest.files.map(async (path) => ({ path, content: await readFile(join(desk.root, path)) })))
  const upstream = {
    manifest,
    files,
    source: home.manifest.origin.source,
    requestedRef: home.manifest.origin.requestedRef,
    resolvedCommit: home.manifest.origin.resolvedCommit,
    mobile: home.manifest.origin.mobile,
  }
  const writes = files.map((file) => ({ path: join(home.root, file.path), content: file.content }))
  writes.push({ path: home.path, content: manifestBytes(installedManifest(upstream, 'source')) })
  const next = new Set(manifest.files)
  const deletes = Object.keys(home.manifest.origin.baseDigests).filter((path) => !next.has(path)).map((path) => join(home.root, path))
  deletes.push(...Object.keys(desk.manifest.origin.baseDigests).map((path) => join(desk.root, path)), desk.path)
  await assertFrontDoorAfter(root, [
    { id: home.id, scope: 'home', manifest },
    { id: desk.id, scope: 'desk', manifest: null },
  ])
  await applyTransaction(root, writes, deletes)
  await removeEmptyParents(desk.root, join(root, '.desk', 'equipment'))
  return { status: 'promoted', name: desk.id, path: relative(root, home.root) }
}

export const publishEquipment = promoteEquipment

export async function statusEquipment(root, selector, options = {}) {
  const entries = selector ? [await findInstalled(root, selector, options)] : await installedEquipment(root, options)
  return Promise.all(entries.map(equipmentStatus))
}

async function upstreamDiff(installed, upstream) {
  const local = await equipmentStatus(installed)
  const base = installed.manifest.origin.baseDigests
  const next = new Map(upstream.files.map((file) => [file.path, digest(file.content)]))
  const paths = [...new Set([...Object.keys(base), ...next.keys()])].sort()
  return {
    name: installed.manifest.name,
    from: { version: installed.manifest.version, commit: installed.manifest.origin.resolvedCommit },
    to: { version: upstream.manifest.version, commit: upstream.resolvedCommit },
    local: local.state,
    files: paths.map((path) => ({
      path,
      change: !(path in base) ? 'added' : !next.has(path) ? 'removed' : base[path] === next.get(path) ? 'unchanged' : 'changed',
      local: local.files.find((file) => file.path === path)?.state ?? 'absent',
    })),
  }
}

export async function syncEquipment(root, selector, options = {}) {
  const selected = options.all ? await installedEquipment(root, options) : [await findInstalled(root, selector, options)]
  const results = []
  for (const installed of selected) results.push(await syncOne(root, await requireValid(installed), options))
  return results
}

export async function removeEquipment(root, selector, options = {}) {
  const installed = await requireValid(await findInstalled(root, selector, options))
  const current = await equipmentStatus(installed)
  if (current.state !== 'clean' && !options.overwrite) {
    throw new EndroitError('equipment_customized', `${installed.id} has customized, missing or invalid source-owned files.`, { details: current })
  }
  const deletes = [...Object.keys(installed.manifest.origin.baseDigests).map((path) => join(installed.root, path)), installed.path]
  await assertFrontDoorAfter(root, [{ id: installed.id, scope: installed.scope, manifest: null }])
  await applyTransaction(root, [], deletes)
  await removeEmptyParents(installed.root, installed.scope === 'desk' ? join(root, '.desk', 'equipment') : join(root, 'equipment'))
  return { status: 'removed', name: installed.id, files: Object.keys(installed.manifest.origin.baseDigests) }
}

export async function equipmentStatus(entry) {
  if (entry.invalid) return { name: entry.id, state: 'invalid', manifest: 'invalid', files: [], error: entry.invalid.message }
  const installation = entry.manifest.origin
  const expectedManifest = installation.baseManifestDigest
  const actualManifest = manifestDigest(entry.manifest)
  const manifest = actualManifest === expectedManifest ? 'clean' : 'customized'
  const files = []
  for (const [path, expected] of Object.entries(installation.baseDigests)) {
    let state
    try {
      const info = await lstat(join(entry.root, path))
      if (info.isSymbolicLink() || !info.isFile()) state = 'invalid'
      else state = digest(await readFile(join(entry.root, path))) === expected ? 'clean' : 'customized'
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      state = 'missing'
    }
    files.push({ path, state, baseDigest: expected })
  }
  const state = files.some((file) => file.state === 'invalid') ? 'invalid'
    : files.some((file) => file.state === 'missing') ? 'missing'
      : manifest !== 'clean' || files.some((file) => file.state === 'customized') ? 'customized'
        : 'clean'
  return {
    name: entry.manifest.name,
    scope: entry.scope,
    version: entry.manifest.version,
    source: installation.source,
    requestedRef: installation.requestedRef,
    resolvedCommit: installation.resolvedCommit,
    mobile: installation.mobile,
    state,
    manifest,
    effectiveDigest: await installedEquipmentDigest(entry).catch(() => null),
    files,
  }
}

async function syncOne(root, installed, options) {
  const status = await equipmentStatus(installed)
  const upstream = await resolveEquipment(root, options.to ?? installed.manifest.origin.source)
  assertSameEquipment(installed, upstream)
  const others = (await installedEquipment(root, { scope: installed.scope })).filter((entry) => !entry.invalid && entry.id !== installed.id).map((entry) => entry.manifest)
  assertCapabilityCollisions([...others, upstream.manifest])
  const result = await upstreamDiff(installed, upstream)
  if (status.state !== 'clean' && !options.overwrite) {
    if (options.check) return { status: 'blocked', reason: 'customized', ...result }
    throw new EndroitError('sync_customized', `${installed.id} has local changes; run equipment sync --check or pass --overwrite.`, { details: result })
  }
  const writes = upstream.files.map((file) => ({ path: join(installed.root, file.path), content: file.content }))
  writes.push({ path: installed.path, content: manifestBytes(installedManifest(upstream, 'source')) })
  const nextPaths = new Set(upstream.files.map((file) => file.path))
  const deletes = Object.keys(installed.manifest.origin.baseDigests).filter((path) => !nextPaths.has(path)).map((path) => join(installed.root, path))
  const changed = deletes.length > 0 || await anyWriteChanged(writes)
  await assertFrontDoorAfter(root, [{ id: installed.id, scope: installed.scope, manifest: upstream.manifest }])
  if (options.check) return { status: changed ? 'available' : 'current', ...result }
  await applyTransaction(root, writes, deletes)
  return { status: 'synced', name: installed.id, version: upstream.manifest.version, commit: upstream.resolvedCommit }
}

async function loadGithub(source, match) {
  const [, owner, repository, equipmentPath, requestedRef] = match
  if (!equipmentPath || equipmentPath.startsWith('/') || equipmentPath.includes('..') || equipmentPath.includes('\\')) throw new EndroitError('source_invalid', `Invalid GitHub Equipment path ${equipmentPath}.`)
  const stage = await mkdtemp(join(tmpdir(), 'endroit-equipment-'))
  try {
    await git(['init', '--quiet'], { cwd: stage })
    await git(['remote', 'add', 'origin', `https://github.com/${owner}/${repository}.git`], { cwd: stage })
    await git(['fetch', '--quiet', '--depth=1', 'origin', requestedRef ?? 'HEAD'], { cwd: stage })
    await git(['checkout', '--quiet', '--detach', 'FETCH_HEAD'], { cwd: stage })
    const resolvedCommit = await git(['rev-parse', 'HEAD'], { cwd: stage })
    const tag = requestedRef ? await git(['ls-remote', '--tags', 'origin', `refs/tags/${requestedRef}`], { cwd: stage }).then(Boolean, () => false) : false
    const pinned = Boolean(requestedRef && (/^[a-f0-9]{40}$/i.test(requestedRef) || tag))
    const manifestPath = equipmentPath.endsWith('.json') ? equipmentPath : join(equipmentPath, 'equipment.json')
    return await loadManifest(join(stage, manifestPath), { source, requestedRef: requestedRef ?? null, resolvedCommit, mobile: !pinned })
  } finally {
    await removeTree(stage, { force: true })
  }
}

async function loadManifest(location, context) {
  let document
  let base
  if (/^https:\/\//.test(location)) {
    const remote = await fetchDocument(location)
    document = remote.document
    base = remote.url
  } else {
    const candidate = resolve(context.root ?? process.cwd(), location)
    const stat = await lstat(candidate)
    if (stat.isSymbolicLink()) throw new EndroitError('symlink_forbidden', `Equipment manifest ${location} must not be a symbolic link.`)
    const path = await realpath(candidate)
    document = JSON.parse(await readFile(path, 'utf8'))
    base = path
  }
  const manifest = sourceManifest(await validateDocument(document, 'equipment'))
  validateManifest(manifest)
  const files = []
  for (const path of manifest.files) {
    const content = /^https:\/\//.test(base)
      ? await fetchBytes(new URL(path, base).href)
      : await readFile(await resolvePackageFile(dirname(base), path, 'Equipment file'))
    if (content.length > MAX_FILE_BYTES) throw new EndroitError('source_too_large', `${path} exceeds 5 MiB.`)
    files.push({ path, content })
  }
  return {
    manifest,
    files,
    source: context.source,
    requestedRef: context.requestedRef ?? null,
    resolvedCommit: context.resolvedCommit ?? null,
    mobile: Boolean(context.mobile),
    firstParty: Boolean(context.firstParty),
  }
}

async function loadInstalled(root, path, id, scope) {
  try {
    const info = await lstat(path)
    if (info.isSymbolicLink()) throw new EndroitError('symlink_forbidden', `Equipment manifest ${relative(root, path)} must not be a symbolic link.`)
    const manifest = await validateDocument(JSON.parse(await readFile(path, 'utf8')), 'equipment')
    if (!manifest.origin) throw new EndroitError('equipment_invalid', `${relative(root, path)} has no origin provenance.`)
    if (manifest.name !== id) throw new EndroitError('equipment_invalid', `${relative(root, path)} declares ${manifest.name}, expected ${id}.`)
    validateManifest(sourceManifest(manifest))
    return { id, root: dirname(path), path, manifest, scope }
  } catch (error) {
    return { id, root: dirname(path), path, invalid: error, scope }
  }
}

async function findInstalled(root, selector, options = {}) {
  const matches = (await installedEquipment(root, options)).filter((entry) => entry.id === selector || entry.id.split('/').at(-1) === selector)
  if (!matches.length) throw new EndroitError('equipment_not_installed', `${selector} is not installed.`)
  if (matches.length > 1) throw new EndroitError('equipment_ambiguous', `${selector} matches multiple Equipment; use the full name.`)
  return matches[0]
}

function installedManifest(equipment, kind) {
  return {
    ...equipment.manifest,
    origin: {
      kind,
      source: equipment.source,
      requestedRef: equipment.requestedRef,
      resolvedCommit: equipment.resolvedCommit,
      mobile: equipment.mobile,
      baseManifestDigest: manifestDigest(equipment.manifest),
      baseDigests: Object.fromEntries(equipment.files.map((file) => [file.path, digest(file.content)])),
    },
  }
}

function sourceManifest(manifest) {
  const { origin, ...source } = manifest
  return source
}

function manifestDigest(manifest) {
  return digest(stable(sourceManifest(manifest)))
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]))
  return value
}

export function equipmentDigest(equipment) {
  return digest(Buffer.concat([
    Buffer.from(JSON.stringify(stable(sourceManifest(equipment.manifest)))),
    ...[...equipment.files].sort((left, right) => left.path.localeCompare(right.path)).flatMap((file) => [
      Buffer.from(`\n${file.path}\0`),
      Buffer.from(file.content),
    ]),
  ]))
}

export async function installedEquipmentDigest(entry) {
  const manifest = sourceManifest(entry.manifest)
  const files = await Promise.all(manifest.files.map(async (path) => ({ path, content: await readFile(join(entry.root, path)) })))
  return equipmentDigest({ manifest, files })
}

function validateManifest(manifest) {
  const paths = new Set(manifest.files)
  if (paths.has('equipment.json')) throw new EndroitError('equipment_invalid', 'equipment.json is reserved for the Equipment manifest.')
  if (paths.size !== manifest.files.length) throw new EndroitError('equipment_invalid', `${manifest.name} declares a file more than once.`)
  const capabilities = ids(manifest.capabilities, 'Capability', manifest.name)
  ids(manifest.instructions, 'Instruction', manifest.name)
  ids(manifest.references, 'Reference', manifest.name)
  const skills = ids(manifest.skills, 'Skill', manifest.name)
  const commands = ids(manifest.commands, 'Command', manifest.name)
  ids(manifest.artifactKinds, 'Artifact kind', manifest.name)
  for (const entry of [...(manifest.instructions ?? []), ...(manifest.capabilities ?? []), ...(manifest.references ?? [])]) requireFile(paths, entry.path, manifest.name)
  for (const entry of [...(manifest.skills ?? []), ...(manifest.commands ?? [])]) {
    if (!capabilities.has(entry.capability)) throw new EndroitError('equipment_invalid', `${manifest.name} ${entry.id} references missing Capability ${entry.capability}.`)
  }
  for (const id of manifest.setup ?? []) if (!capabilities.has(id)) throw new EndroitError('equipment_invalid', `${manifest.name} setup references missing Capability ${id}.`)
  for (const kind of manifest.artifactKinds ?? []) {
    requireFile(paths, kind.schema, manifest.name)
    requireFile(paths, kind.template, manifest.name)
    for (const path of kind.requiredFiles ?? []) requireFile(paths, path, manifest.name)
  }
  if (manifest.settings?.home) requireFile(paths, manifest.settings.home, manifest.name)
  if (manifest.settings?.desk) requireFile(paths, manifest.settings.desk, manifest.name)
  if (manifest.runtime) {
    requireFile(paths, manifest.runtime.entry, manifest.name)
    const runtimeCommands = ids(manifest.runtime.commands, 'Runtime command', manifest.name, 'name')
    if (!runtimeCommands.size) throw new EndroitError('equipment_invalid', `${manifest.name} runtime must declare at least one command.`)
  }
  if (!skills.size && !commands.size && !manifest.runtime && !manifest.instructions?.length && !manifest.artifactKinds?.length) {
    throw new EndroitError('equipment_invalid', `${manifest.name} exposes no material or surface.`)
  }
}

function assertCapabilityCollisions(manifests) {
  const claims = new Map()
  for (const manifest of manifests) {
    if (manifest.runtime) claim(`runtime:${manifest.runtime.namespace}`, manifest.name)
    if (manifest.roomNamespace) claim(`room-namespace:${manifest.roomNamespace}`, manifest.name)
  }
  function claim(id, owner) {
    const current = claims.get(id)
    if (current && current !== owner) throw new EndroitError('capability_collision', `${id} is claimed by both ${current} and ${owner}.`)
    claims.set(id, owner)
  }
}

function ids(entries = [], label, owner, key = 'id') {
  const values = entries.map((entry) => entry[key])
  if (new Set(values).size !== values.length) throw new EndroitError('equipment_invalid', `${owner} ${label} ids must be unique.`)
  return new Set(values)
}

function requireFile(files, path, owner) {
  if (!files.has(path)) throw new EndroitError('equipment_invalid', `${owner} references undeclared file ${path}.`)
}

async function fetchDocument(url) {
  const response = await fetch(assertSafeUrl(url), { redirect: 'follow' })
  assertSafeResponse(response)
  if (!response.ok) throw new EndroitError('source_fetch_failed', `Equipment request failed with HTTP ${response.status}.`, { exitCode: 4 })
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length > MAX_FILE_BYTES) throw new EndroitError('source_too_large', 'Equipment manifest exceeds 5 MiB.')
  try { return { document: JSON.parse(bytes.toString('utf8')), url: response.url || url } }
  catch (error) { throw new EndroitError('invalid_json', 'Equipment returned invalid JSON.', { cause: error }) }
}

async function fetchBytes(url) {
  const response = await fetch(assertSafeUrl(url), { redirect: 'follow' })
  assertSafeResponse(response)
  if (!response.ok) throw new EndroitError('source_fetch_failed', `Equipment file request failed with HTTP ${response.status}.`, { exitCode: 4 })
  return Buffer.from(await response.arrayBuffer())
}

function assertSafeUrl(value) {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username || url.password || url.search) throw new EndroitError('source_insecure', 'Equipment URLs must use HTTPS without credentials or query secrets.')
  return url.href
}

function assertSafeResponse(response) {
  if (response.url) assertSafeUrl(response.url)
}

async function directories(root, home) {
  const values = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new EndroitError('symlink_forbidden', `Installed Equipment contains symbolic link ${relative(home, join(root, entry.name))}.`)
    if (entry.isDirectory()) values.push(entry.name)
  }
  return values.sort()
}

async function requireValid(entry) {
  if (entry.invalid) throw new EndroitError('equipment_invalid', `${entry.id} is invalid: ${entry.invalid.message}`)
  return entry
}

function assertSameEquipment(installed, upstream) {
  if (installed.id !== upstream.manifest.name) throw new EndroitError('equipment_identity_changed', `${upstream.manifest.name} cannot replace ${installed.id}.`)
}

async function anyWriteChanged(writes) {
  for (const entry of writes) {
    try { if (digest(await readFile(entry.path)) !== digest(entry.content)) return true }
    catch (error) { if (error.code === 'ENOENT') return true; throw error }
  }
  return false
}

export async function applyTransaction(root, writes, deletes) {
  const transaction = await mkdtemp(join(root, '.endroit-transaction-'))
  const staged = join(transaction, 'staged')
  const backup = join(transaction, 'backup')
  const touched = [...new Set([...writes.map((entry) => entry.path), ...deletes])]
  try {
    for (const entry of writes) {
      const relativePath = relative(root, assertInside(root, entry.path, 'transaction path'))
      const path = join(staged, relativePath)
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, entry.content, { mode: 0o644 })
    }
    for (const path of touched) await assertNoSymlink(root, path)
    const backedUp = []
    try {
      for (const path of touched) {
        if (!await exists(path)) continue
        const destination = join(backup, relative(root, path))
        await mkdir(dirname(destination), { recursive: true })
        await rename(path, destination)
        backedUp.push({ path, destination })
      }
      for (const entry of writes) {
        await mkdir(dirname(entry.path), { recursive: true })
        await rename(join(staged, relative(root, entry.path)), entry.path)
      }
    } catch (error) {
      for (const entry of [...writes].reverse()) if (await exists(entry.path)) await removeTree(entry.path, { force: true })
      for (const entry of backedUp.reverse()) {
        await mkdir(dirname(entry.path), { recursive: true })
        await rename(entry.destination, entry.path)
      }
      throw error
    }
  } finally {
    await removeTree(transaction, { force: true })
  }
}

async function assertNoSymlink(root, path) {
  let current = resolve(path)
  while (current !== resolve(root)) {
    try { if ((await lstat(current)).isSymbolicLink()) throw new EndroitError('symlink_forbidden', `${relative(root, current)} is a symbolic link.`) }
    catch (error) { if (error.code !== 'ENOENT') throw error }
    current = dirname(current)
  }
}

async function assertFrontDoorAfter(root, changes) {
  const home = await loadHome(root)
  if (!home.frontDoor) return
  const [homeEquipment, deskEquipment] = await Promise.all([
    installedEquipment(root, { scope: 'home' }),
    installedEquipment(root, { scope: 'desk' }),
  ])
  const homeManifests = new Map(homeEquipment.filter((entry) => !entry.invalid).map((entry) => [entry.id, sourceManifest(entry.manifest)]))
  const deskManifests = new Map(deskEquipment.filter((entry) => !entry.invalid).map((entry) => [entry.id, sourceManifest(entry.manifest)]))
  for (const change of changes) {
    const manifests = change.scope === 'desk' ? deskManifests : homeManifests
    if (change.manifest) manifests.set(change.id, sourceManifest(change.manifest))
    else manifests.delete(change.id)
  }
  const separator = home.frontDoor.wakeUp.lastIndexOf(':')
  const owner = home.frontDoor.wakeUp.slice(0, separator)
  const command = home.frontDoor.wakeUp.slice(separator + 1)
  const manifest = deskManifests.get(owner) ?? homeManifests.get(owner)
  if (!manifest?.runtime) {
    throw new EndroitError('front_door_runtime_missing', `${home.frontDoor.wakeUp} would no longer reference an effective Equipment runtime.`)
  }
  if (!manifest.runtime.commands.some((entry) => entry.name === command)) {
    throw new EndroitError('front_door_command_missing', `${home.frontDoor.wakeUp} would no longer reference a declared runtime command.`)
  }
}

async function removeEmptyParents(path, stop) {
  let current = path
  while (current !== stop) {
    try { await rm(current, { recursive: false }) } catch { break }
    current = dirname(current)
  }
}

async function equipmentScopeRoot(root, scope) {
  if (scope === 'home') return join(root, 'equipment')
  if (!await exists(join(root, '.desk', 'desk.json'))) throw new EndroitError('desk_missing', 'Configure a Desk before installing Desk Equipment.')
  return join(root, '.desk', 'equipment')
}

function manifestBytes(value) { return Buffer.from(`${JSON.stringify(value, null, 2)}\n`) }
function plan(root, writes, deletes) { return { writes: writes.map((entry) => relative(root, entry.path)).sort(), deletes: deletes.map((path) => relative(root, path)).sort() } }
