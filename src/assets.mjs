import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateDocument } from './contracts.mjs'
import { git } from './git.mjs'
import { HairnessError } from './lib/errors.mjs'
import { assertInside, digest, exists, resolvePackageFile } from './lib/io.mjs'

const builtinRoot = fileURLToPath(new URL('../assets', import.meta.url))
const MAX_FILE_BYTES = 5 * 1024 * 1024
const githubAddress = /^([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)\/(.+?)(?:#([^#]+))?$/

export async function resolveAsset(root, address) {
  const source = String(address)
  const official = source.match(/^@hairness\/([a-z0-9][a-z0-9._-]*)$/)
  if (official) return loadManifest(join(builtinRoot, official[1], 'asset.json'), { root, source, mobile: false, boundary: builtinRoot })
  if (source.startsWith('@')) throw new HairnessError('source_invalid', `Unsupported Asset namespace ${source}; use a GitHub, HTTPS or local asset.json address.`)
  if (/^https:\/\//.test(source)) return loadManifest(assertSafeUrl(source), { root, source, mobile: true })
  if (/^http:\/\//.test(source)) throw new HairnessError('source_insecure', 'Asset URLs must use HTTPS.')
  if (source.startsWith('.') || source.startsWith('/')) {
    if (source.split(/[\\/]/).at(-1) !== 'asset.json') {
      throw new HairnessError('legacy_asset_manifest', 'Local Assets must be addressed through asset.json.')
    }
    return loadManifest(source, { root, source, mobile: true })
  }
  const github = source.match(githubAddress)
  if (github) return loadGithub(source, github)
  throw new HairnessError('source_invalid', `Unsupported Asset address ${source}.`)
}

export async function addAssets(root, addresses, options = {}) {
  const scope = options.scope ?? 'home'
  if (!['home', 'desk'].includes(scope)) throw new HairnessError('scope_invalid', `Unsupported Asset scope ${scope}.`)
  const resolved = await Promise.all(addresses.map((address) => resolveAsset(root, address)))
  const ids = resolved.map((entry) => entry.manifest.name)
  if (new Set(ids).size !== ids.length) throw new HairnessError('asset_collision', 'Each Asset may be selected only once per add transaction.')
  const installed = (await installedAssets(root)).filter((entry) => !entry.invalid)
  const replacing = new Set(options.overwrite ? ids.map((id) => `${scope}:${id}`) : [])
  assertAssetNames([
    ...installed.filter((entry) => !replacing.has(`${entry.scope}:${entry.id}`)),
    ...resolved.map((entry) => ({ id: entry.manifest.name, scope })),
  ])
  const writes = []
  for (const asset of resolved) {
    const assetRoot = join(assetBase(root, scope), asset.manifest.name)
    if (installed.some((entry) => entry.scope === scope && entry.id === asset.manifest.name) && !options.overwrite) {
      throw new HairnessError('asset_exists', `${scope} Asset ${asset.manifest.name} is already installed.`)
    }
    for (const file of asset.files) {
      const path = assertInside(assetRoot, join(assetRoot, file.path), 'Asset destination')
      if (await exists(path) && !options.overwrite) throw new HairnessError('file_collision', `${relative(root, path)} already exists.`)
      writes.push({ path, content: file.content })
    }
    const manifestPath = join(assetRoot, 'asset.json')
    if (await exists(manifestPath) && !options.overwrite) throw new HairnessError('file_collision', `${relative(root, manifestPath)} already exists.`)
    writes.push({ path: manifestPath, content: manifestBytes(installedManifest(asset)) })
  }
  const preview = transactionPlan(root, writes, [])
  if (options.dryRun) return { status: 'planned', scope, assets: ids, ...preview }
  await applyTransaction(root, writes, [])
  return { status: 'added', scope, assets: ids, ...preview }
}

export async function installedAssets(root, options = {}) {
  await assertNoLegacyState(root)
  if (await exists(join(root, 'extensions'))) {
    throw new HairnessError('legacy_asset_layout', 'The legacy extensions/ layout is unsupported.')
  }
  if (await exists(join(root, '.overlay'))) {
    throw new HairnessError('legacy_overlay', 'The legacy .overlay/ layout is unsupported; migrate it to .desk/.')
  }
  const scopes = options.scope ? [options.scope] : ['home', 'desk']
  const values = []
  for (const scope of scopes) values.push(...await scanAssets(root, scope))
  assertAssetNames(values.filter((entry) => !entry.invalid))
  return values.sort((left, right) => `${left.scope}:${left.id}`.localeCompare(`${right.scope}:${right.id}`))
}

async function assertNoLegacyState(root) {
  for (const path of [join(root, '.codex', 'hooks.json'), join(root, '.claude', 'settings.json')]) {
    const content = await readFile(path, 'utf8').catch((error) => error.code === 'ENOENT' ? '' : Promise.reject(error))
    if (/(?:@hairness\/cli@\S+|(?:^|\s)hairness)\s+prologue\b/.test(content)) {
      throw new HairnessError('legacy_prologue', `${relative(root, path)} contains an unsupported Prologue hook; Hairness 0.5 uses the HUD.`)
    }
  }
}

export async function statusAssets(root, selector, options = {}) {
  const entries = selector ? [await findInstalled(root, selector, options)] : await installedAssets(root, options)
  return Promise.all(entries.map(assetStatus))
}

export async function validateAsset(root, selector, options = {}) {
  const entry = await requireValid(await findInstalled(root, selector, options))
  return { name: entry.id, scope: entry.scope, status: 'valid', paths: sourcePaths(entry.manifest) }
}

export async function diffAsset(root, selector, options = {}) {
  const installed = await requireValid(await findInstalled(root, selector, options))
  const origin = requireOrigin(installed)
  if (origin.kind === 'override') return diffOverride(root, installed)
  const local = await assetStatus(installed)
  const upstream = await resolveAsset(root, options.to ?? origin.source)
  assertSameAsset(installed, upstream)
  const base = origin.baseDigests
  const next = new Map(upstream.files.map((file) => [file.path, digest(file.content)]))
  const paths = [...new Set([...Object.keys(base), ...next.keys()])].sort()
  return {
    name: installed.id,
    scope: installed.scope,
    from: { version: installed.manifest.version, commit: origin.resolvedCommit },
    to: { version: upstream.manifest.version, commit: upstream.resolvedCommit },
    local: local.state,
    files: paths.map((path) => ({
      path,
      change: !(path in base) ? 'added' : !next.has(path) ? 'removed' : base[path] === next.get(path) ? 'unchanged' : 'changed',
      local: local.files.find((file) => file.path === path)?.state ?? 'absent',
    })),
  }
}

export async function syncAssets(root, selector, options = {}) {
  const selected = options.all ? await installedAssets(root, options) : [await findInstalled(root, selector, options)]
  const results = []
  for (const installed of selected) results.push(await syncOne(root, await requireValid(installed), options))
  return results
}

export async function removeAsset(root, selector, options = {}) {
  const installed = await requireValid(await findInstalled(root, selector, options))
  const current = await assetStatus(installed)
  const override = installed.manifest.origin?.kind === 'override'
  if (!override && (current.state !== 'clean' || !installed.manifest.origin) && !options.overwrite) {
    throw new HairnessError('asset_customized', `${installed.scope} Asset ${installed.id} is not safely recoverable; pass --overwrite to remove its declared files.`, { details: current })
  }
  const paths = installed.manifest.origin ? Object.keys(installed.manifest.origin.baseDigests) : sourcePaths(installed.manifest)
  const deletes = [...paths.map((path) => join(installed.root, path)), installed.path]
  await applyTransaction(root, [], deletes)
  await removeEmptyParents(installed.root, assetBase(root, installed.scope))
  return { status: 'removed', name: installed.id, scope: installed.scope, files: paths }
}

export async function overrideAsset(root, selector) {
  const home = await requireValid(await findInstalled(root, selector, { scope: 'home' }))
  const existing = (await installedAssets(root, { scope: 'desk' })).find((entry) => entry.id === home.id)
  if (existing) throw new HairnessError('asset_override_exists', `Desk Asset ${home.id} already exists.`)
  const snapshot = await snapshotAsset(home)
  const destination = join(assetBase(root, 'desk'), home.id)
  const writes = snapshot.files.map((file) => ({ path: join(destination, file.path), content: file.content }))
  writes.push({
    path: join(destination, 'asset.json'),
    content: manifestBytes({
      ...sourceManifest(home.manifest),
      origin: {
        kind: 'override',
        source: `home:${home.id}`,
        requestedRef: null,
        resolvedCommit: null,
        mobile: false,
        baseManifestDigest: snapshot.manifestDigest,
        baseDigests: snapshot.digests,
      },
    }),
  })
  await applyTransaction(root, writes, [])
  return { status: 'overridden', name: home.id, from: 'home', to: 'desk', files: snapshot.files.map((file) => file.path) }
}

export async function publishAsset(root, selector) {
  const installed = await requireValid(await findInstalled(root, selector, { scope: 'desk' }))
  const destination = join(assetBase(root, 'home'), installed.id)
  const override = installed.manifest.origin?.kind === 'override'
  const home = override ? await requireValid(await findInstalled(root, installed.id, { scope: 'home' })) : null
  if (!override && await exists(join(destination, 'asset.json'))) throw new HairnessError('asset_exists', `Home Asset ${installed.id} already exists.`)
  if (override) {
    const current = await snapshotAsset(home)
    const origin = installed.manifest.origin
    if (current.manifestDigest !== origin.baseManifestDigest || !same(current.digests, origin.baseDigests)) {
      throw new HairnessError('asset_override_stale', `Home Asset ${installed.id} changed after the Desk override was created.`, {
        details: await diffOverride(root, installed),
      })
    }
  }
  const paths = sourcePaths(installed.manifest)
  const writes = []
  for (const path of paths) {
    const source = await resolvePackageFile(installed.root, path, `${installed.id} source`)
    writes.push({ path: join(destination, path), content: await readFile(source) })
  }
  writes.push({ path: join(destination, 'asset.json'), content: manifestBytes(sourceManifest(installed.manifest)) })
  const replacedPaths = home ? sourcePaths(home.manifest).filter((path) => !paths.includes(path)).map((path) => join(home.root, path)) : []
  const deletes = [...replacedPaths, ...paths.map((path) => join(installed.root, path)), installed.path]
  await applyTransaction(root, writes, deletes)
  await removeEmptyParents(installed.root, assetBase(root, 'desk'))
  return { status: 'published', name: installed.id, from: 'desk', to: 'home', files: paths }
}

export async function assetStatus(entry) {
  if (entry.invalid) return { name: entry.id, scope: entry.scope, state: 'invalid', manifest: 'invalid', files: [], error: entry.invalid.message }
  const paths = entry.manifest.origin ? Object.keys(entry.manifest.origin.baseDigests) : sourcePaths(entry.manifest)
  const files = []
  for (const path of paths) {
    let state = 'clean'
    try {
      const info = await lstat(join(entry.root, path))
      if (info.isSymbolicLink() || !info.isFile()) state = 'invalid'
      else if (entry.manifest.origin && digest(await readFile(join(entry.root, path))) !== entry.manifest.origin.baseDigests[path]) state = 'customized'
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      state = 'missing'
    }
    files.push({ path, state, ...(entry.manifest.origin ? { baseDigest: entry.manifest.origin.baseDigests[path] } : {}) })
  }
  const manifest = !entry.manifest.origin ? 'local'
    : manifestDigest(entry.manifest) === entry.manifest.origin.baseManifestDigest ? 'clean' : 'customized'
  const state = files.some((file) => file.state === 'invalid') ? 'invalid'
    : files.some((file) => file.state === 'missing') ? 'missing'
      : manifest === 'customized' || files.some((file) => file.state === 'customized') ? 'customized'
        : manifest === 'local' ? 'local' : 'clean'
  return {
    name: entry.id,
    scope: entry.scope,
    version: entry.manifest.version,
    ...(entry.manifest.origin ? {
      source: entry.manifest.origin.source,
      requestedRef: entry.manifest.origin.requestedRef,
      resolvedCommit: entry.manifest.origin.resolvedCommit,
      mobile: entry.manifest.origin.mobile,
    } : {}),
    state,
    manifest,
    files,
  }
}

async function syncOne(root, installed, options) {
  const origin = requireOrigin(installed)
  if (origin.kind === 'override') throw new HairnessError('asset_override_sync_unsupported', `${installed.id} overrides a Home Asset; publish, remove or recreate the override instead of syncing it.`)
  const status = await assetStatus(installed)
  const upstream = await resolveAsset(root, options.to ?? origin.source)
  assertSameAsset(installed, upstream)
  if (status.state !== 'clean' && !options.overwrite) {
    const result = await diffAsset(root, installed.id, { ...options, scope: installed.scope })
    if (options.check) return { status: 'blocked', reason: 'customized', ...result }
    throw new HairnessError('sync_customized', `${installed.id} has local changes; inspect hairness asset diff or pass --overwrite.`, { details: result })
  }
  const writes = upstream.files.map((file) => ({ path: join(installed.root, file.path), content: file.content }))
  writes.push({ path: installed.path, content: manifestBytes(installedManifest(upstream)) })
  const nextPaths = new Set(upstream.files.map((file) => file.path))
  const deletes = Object.keys(origin.baseDigests).filter((path) => !nextPaths.has(path)).map((path) => join(installed.root, path))
  const changed = deletes.length > 0 || await anyWriteChanged(writes)
  if (options.check) return { status: changed ? 'available' : 'current', name: installed.id, scope: installed.scope, version: upstream.manifest.version, commit: upstream.resolvedCommit }
  await applyTransaction(root, writes, deletes)
  return { status: 'synced', name: installed.id, scope: installed.scope, version: upstream.manifest.version, commit: upstream.resolvedCommit }
}

async function scanAssets(root, scope) {
  const base = assetBase(root, scope)
  if (!await exists(base)) return []
  const values = []
  for (const namespace of await directories(base, root)) {
    for (const name of await directories(join(base, namespace), root)) {
      const directory = join(base, namespace, name)
      const legacy = join(directory, 'hairness.json')
      if (await exists(legacy)) throw new HairnessError('legacy_asset_manifest', `${relative(root, legacy)} is unsupported; Assets use asset.json.`)
      const path = join(directory, 'asset.json')
      if (!await exists(path)) continue
      values.push(await loadInstalled(root, path, `${namespace}/${name}`, scope))
    }
  }
  return values
}

function assetBase(root, scope) {
  return scope === 'desk' ? join(root, '.desk', 'assets') : join(root, 'assets')
}

async function loadGithub(source, match) {
  const [, owner, repository, assetPath, requestedRef] = match
  if (!assetPath || assetPath.startsWith('/') || assetPath.includes('..') || assetPath.includes('\\')) throw new HairnessError('source_invalid', `Invalid GitHub Asset path ${assetPath}.`)
  if (requestedRef && (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,239}$/.test(requestedRef) || requestedRef.includes('..') || requestedRef.includes('@{') || requestedRef.endsWith('.lock'))) {
    throw new HairnessError('source_invalid', `Invalid GitHub reference ${requestedRef}.`)
  }
  const stage = await mkdtemp(join(tmpdir(), 'hairness-asset-'))
  try {
    await git(['init', '--quiet'], { cwd: stage })
    await git(['remote', 'add', 'origin', `https://github.com/${owner}/${repository}.git`], { cwd: stage })
    await git(['fetch', '--quiet', '--depth=1', 'origin', requestedRef ?? 'HEAD'], { cwd: stage })
    await git(['checkout', '--quiet', '--detach', 'FETCH_HEAD'], { cwd: stage })
    const resolvedCommit = await git(['rev-parse', 'HEAD'], { cwd: stage })
    const tag = requestedRef ? await git(['ls-remote', '--tags', 'origin', `refs/tags/${requestedRef}`], { cwd: stage }).then(Boolean, () => false) : false
    const pinned = Boolean(requestedRef && (/^[a-f0-9]{40}$/i.test(requestedRef) || tag))
    const manifestPath = assetPath.endsWith('.json') ? assetPath : join(assetPath, 'asset.json')
    return await loadManifest(join(stage, manifestPath), { source, requestedRef: requestedRef ?? null, resolvedCommit, mobile: !pinned, boundary: stage })
  } finally {
    await rm(stage, { recursive: true, force: true })
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
    if (stat.isSymbolicLink()) throw new HairnessError('symlink_forbidden', `Asset manifest ${location} must not be a symbolic link.`)
    const path = await realpath(candidate)
    if (context.boundary) assertInside(await realpath(context.boundary), path, 'Asset manifest')
    document = JSON.parse(await readFile(path, 'utf8'))
    base = path
  }
  const manifest = sourceManifest(await validateDocument(document, 'asset'))
  validateManifest(manifest)
  const files = []
  for (const path of sourcePaths(manifest)) {
    const content = /^https:\/\//.test(base)
      ? await fetchBytes(new URL(path, base).href)
      : await readFile(await resolvePackageFile(dirname(base), path, 'Asset file'))
    if (content.length > MAX_FILE_BYTES) throw new HairnessError('source_too_large', `${path} exceeds 5 MiB.`)
    files.push({ path, content })
  }
  return {
    manifest,
    files,
    source: context.source,
    requestedRef: context.requestedRef ?? null,
    resolvedCommit: context.resolvedCommit ?? null,
    mobile: Boolean(context.mobile),
  }
}

async function loadInstalled(root, path, id, scope) {
  try {
    const info = await lstat(path)
    if (info.isSymbolicLink()) throw new HairnessError('symlink_forbidden', `Asset manifest ${relative(root, path)} must not be a symbolic link.`)
    const manifest = await validateDocument(JSON.parse(await readFile(path, 'utf8')), 'asset')
    if (manifest.name !== id) throw new HairnessError('asset_invalid', `${relative(root, path)} declares ${manifest.name}, expected ${id}.`)
    validateManifest(sourceManifest(manifest))
    return { id, scope, root: dirname(path), path, manifest }
  } catch (error) {
    return { id, scope, root: dirname(path), path, invalid: error }
  }
}

async function findInstalled(root, selector, options = {}) {
  const matches = (await installedAssets(root, options)).filter((entry) => entry.id === selector || entry.id.split('/').at(-1) === selector)
  if (!matches.length) throw new HairnessError('asset_not_installed', `${selector} is not installed.`)
  if (!options.scope && matches.length === 2) {
    const desk = matches.find((entry) => entry.scope === 'desk' && entry.manifest?.origin?.kind === 'override')
    if (desk) return desk
  }
  if (matches.length > 1) throw new HairnessError('asset_ambiguous', `${selector} matches multiple Assets; specify scope or full name.`)
  return matches[0]
}

function installedManifest(asset) {
  return {
    ...asset.manifest,
    origin: {
      kind: 'source',
      source: asset.source,
      requestedRef: asset.requestedRef,
      resolvedCommit: asset.resolvedCommit,
      mobile: asset.mobile,
      baseManifestDigest: manifestDigest(asset.manifest),
      baseDigests: Object.fromEntries(asset.files.map((file) => [file.path, digest(file.content)])),
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

export function sourcePaths(manifest) {
  const values = [
    ...(manifest.instructions ?? []).map((entry) => entry.source),
    ...(manifest.capabilities ?? []).map((entry) => entry.source),
    ...(manifest.references ?? []).map((entry) => entry.source),
    ...(manifest.files ?? []).map((entry) => entry.source),
    ...(manifest.artifactKinds ?? []).flatMap((entry) => [entry.schema, entry.template].filter(Boolean)),
    ...Object.values(manifest.settings ?? {}).filter(Boolean),
    ...(manifest.executables ?? []).map((entry) => entry.entry),
  ]
  return [...new Set(values)].sort()
}

function validateManifest(manifest) {
  const paths = sourcePaths(manifest)
  if (paths.includes('asset.json') || paths.includes('hairness.json')) throw new HairnessError('asset_invalid', 'Asset manifests cannot declare their own manifest as source material.')
  const capabilities = ids(manifest, 'capabilities')
  const commands = ids(manifest, 'commands')
  const executables = ids(manifest, 'executables')
  for (const skill of manifest.skills ?? []) if (!capabilities.has(skill.capability)) throw new HairnessError('asset_invalid', `Skill ${skill.id} references missing Capability ${skill.capability}.`)
  for (const command of manifest.commands ?? []) if (!capabilities.has(command.capability)) throw new HairnessError('asset_invalid', `Command ${command.id} references missing Capability ${command.capability}.`)
  for (const item of manifest.setup ?? []) if (!commands.has(item.command)) throw new HairnessError('asset_invalid', `Setup references missing Command ${item.command}.`)
  for (const group of manifest.cli ?? []) for (const route of group.routes) {
    if (route.executable && !executables.has(route.executable)) throw new HairnessError('asset_invalid', `CLI route ${group.namespace} ${route.name} references missing Executable ${route.executable}.`)
  }
  for (const section of ['instructions', 'capabilities', 'skills', 'commands', 'references', 'artifactKinds', 'executables']) ids(manifest, section)
}

function ids(manifest, section) {
  const values = (manifest[section] ?? []).map((entry) => entry.id)
  if (new Set(values).size !== values.length) throw new HairnessError('asset_invalid', `${manifest.name} declares duplicate ${section} ids.`)
  return new Set(values)
}

function assertAssetNames(entries) {
  const claims = new Map()
  for (const entry of entries) {
    const current = claims.get(entry.id)
    if (current && current.scope !== entry.scope) {
      const desk = entry.scope === 'desk' ? entry : current
      if (desk.manifest?.origin?.kind !== 'override') {
        throw new HairnessError('asset_collision', `${entry.id} exists in both the Home and Desk without an explicit override.`)
      }
    }
    claims.set(entry.id, entry)
  }
}

async function snapshotAsset(entry) {
  const manifest = sourceManifest(entry.manifest)
  const files = []
  for (const path of sourcePaths(manifest)) {
    const source = await resolvePackageFile(entry.root, path, `${entry.id} source`)
    files.push({ path, content: await readFile(source) })
  }
  return {
    manifestDigest: manifestDigest(manifest),
    digests: Object.fromEntries(files.map((file) => [file.path, digest(file.content)])),
    files,
  }
}

async function diffOverride(root, installed) {
  const origin = installed.manifest.origin
  const home = await requireValid(await findInstalled(root, installed.id, { scope: 'home' }))
  const [currentHome, currentDesk, local] = await Promise.all([
    snapshotAsset(home),
    snapshotAsset(installed),
    assetStatus(installed),
  ])
  const paths = [...new Set([...Object.keys(origin.baseDigests), ...Object.keys(currentHome.digests), ...Object.keys(currentDesk.digests)])].sort()
  return {
    name: installed.id,
    scope: 'desk',
    override: true,
    local: local.state,
    home: currentHome.manifestDigest === origin.baseManifestDigest && same(currentHome.digests, origin.baseDigests) ? 'unchanged' : 'changed',
    files: paths.map((path) => ({
      path,
      home: changeFrom(origin.baseDigests[path], currentHome.digests[path]),
      desk: changeFrom(origin.baseDigests[path], currentDesk.digests[path]),
    })),
  }
}

function changeFrom(base, current) {
  if (base === undefined) return current === undefined ? 'absent' : 'added'
  if (current === undefined) return 'removed'
  return base === current ? 'unchanged' : 'changed'
}

function same(left, right) {
  return JSON.stringify(stable(left)) === JSON.stringify(stable(right))
}

async function fetchDocument(url) {
  const response = await fetch(assertSafeUrl(url), { redirect: 'follow' })
  assertSafeResponse(response)
  if (!response.ok) throw new HairnessError('source_fetch_failed', `Asset request failed with HTTP ${response.status}.`, { exitCode: 4 })
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length > MAX_FILE_BYTES) throw new HairnessError('source_too_large', 'Asset manifest exceeds 5 MiB.')
  try { return { document: JSON.parse(bytes.toString('utf8')), url: response.url || url } }
  catch (error) { throw new HairnessError('invalid_json', 'Asset returned invalid JSON.', { cause: error }) }
}

async function fetchBytes(url) {
  const response = await fetch(assertSafeUrl(url), { redirect: 'follow' })
  assertSafeResponse(response)
  if (!response.ok) throw new HairnessError('source_fetch_failed', `Asset file request failed with HTTP ${response.status}.`, { exitCode: 4 })
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length > MAX_FILE_BYTES) throw new HairnessError('source_too_large', 'Asset file exceeds 5 MiB.')
  return bytes
}

function assertSafeUrl(value) {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username || url.password || url.search) throw new HairnessError('source_insecure', 'Asset URLs must use HTTPS without credentials or query secrets.')
  return url.href
}

function assertSafeResponse(response) {
  if (response.url) assertSafeUrl(response.url)
}

async function directories(root, home) {
  const values = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new HairnessError('symlink_forbidden', `Installed Asset contains symbolic link ${relative(home, join(root, entry.name))}.`)
    if (entry.isDirectory()) values.push(entry.name)
  }
  return values.sort()
}

async function requireValid(entry) {
  if (entry.invalid) throw new HairnessError('asset_invalid', `${entry.scope} Asset ${entry.id} is invalid: ${entry.invalid.message}`)
  return entry
}

function requireOrigin(entry) {
  if (!entry.manifest.origin) throw new HairnessError('asset_local', `${entry.id} has no upstream origin.`)
  return entry.manifest.origin
}

function assertSameAsset(installed, upstream) {
  if (installed.id !== upstream.manifest.name) throw new HairnessError('asset_identity_changed', `${upstream.manifest.name} cannot replace ${installed.id}.`)
}

async function anyWriteChanged(writes) {
  for (const entry of writes) {
    try { if (digest(await readFile(entry.path)) !== digest(entry.content)) return true }
    catch (error) { if (error.code === 'ENOENT') return true; throw error }
  }
  return false
}

export async function applyTransaction(root, writes, deletes) {
  const transaction = await mkdtemp(join(root, '.hairness-transaction-'))
  const staged = join(transaction, 'staged')
  const backup = join(transaction, 'backup')
  const touched = [...new Set([...writes.map((entry) => entry.path), ...deletes])]
  try {
    for (const entry of writes) {
      const relativePath = relative(root, assertInside(root, entry.path, 'transaction path'))
      const path = join(staged, relativePath)
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, entry.content, { mode: entry.mode ?? 0o644 })
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
      for (const entry of [...writes].reverse()) if (await exists(entry.path)) await rm(entry.path, { recursive: true, force: true })
      for (const entry of backedUp.reverse()) {
        await mkdir(dirname(entry.path), { recursive: true })
        await rename(entry.destination, entry.path)
      }
      throw error
    }
  } finally {
    await rm(transaction, { recursive: true, force: true })
  }
}

async function assertNoSymlink(root, path) {
  let current = resolve(path)
  while (current !== resolve(root)) {
    try { if ((await lstat(current)).isSymbolicLink()) throw new HairnessError('symlink_forbidden', `${relative(root, current)} is a symbolic link.`) }
    catch (error) { if (error.code !== 'ENOENT') throw error }
    current = dirname(current)
  }
}

async function removeEmptyParents(path, stop) {
  let current = path
  while (current !== stop) {
    try { await rm(current, { recursive: false }) } catch { break }
    current = dirname(current)
  }
}

function manifestBytes(value) { return Buffer.from(`${JSON.stringify(value, null, 2)}\n`) }
function transactionPlan(root, writes, deletes) { return { writes: writes.map((entry) => relative(root, entry.path)).sort(), deletes: deletes.map((path) => relative(root, path)).sort() } }
