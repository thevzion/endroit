import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)

export const CHECKOUT_BINDINGS_VERSION = 1
export const CHECKOUT_INDEX_VERSION = 3
export const ROUTE_PURPOSES = Object.freeze(['primary', 'development', 'integration', 'release', 'dogfood', 'recovery', 'experiment'])

export function assertRoutePurpose(value) {
  if (!ROUTE_PURPOSES.includes(value)) throw failure('route_purpose_invalid', `Invalid Route purpose ${value}.`)
  return value
}

export async function workplaceGitStorage(homeRoot, desk) {
  homeRoot = await realpath(homeRoot).catch(() => resolve(homeRoot))
  const commonGitDir = await gitCommonDirectory(homeRoot)
  const root = commonGitDir ? join(commonGitDir, 'endroit') : join(homeRoot, '.endroit')
  const deskRoot = join(root, 'desks', desk)
  return {
    homeRoot,
    commonGitDir,
    root,
    managedRoot: join(root, 'checkouts'),
    bindingsPath: join(deskRoot, 'checkout-bindings.json'),
    bindingsLockPath: join(deskRoot, 'checkout-bindings.lock'),
    indexPath: join(homeRoot, '.endroit', 'checkout-index.json'),
  }
}

export function checkoutBindingsDocument(desk, bindings) {
  const normalized = [...bindings]
    .map(({ site, route, target }) => ({ site, route, target: resolve(target) }))
    .sort((left, right) => left.site.localeCompare(right.site) || left.route.localeCompare(right.route))
  const identities = new Set()
  for (const binding of normalized) {
    if (!validId(binding.site) || !validId(binding.route) || !isAbsolute(binding.target)) throw failure('checkout_bindings_invalid', `Invalid Checkout binding ${binding.site}/${binding.route}.`)
    const ref = `${binding.site}/${binding.route}`
    if (identities.has(ref)) throw failure('checkout_bindings_invalid', `Duplicate Checkout binding ${ref}.`)
    identities.add(ref)
  }
  const document = { version: CHECKOUT_BINDINGS_VERSION, desk, bindings: normalized }
  return { ...document, digest: checkoutBindingsDigest(document) }
}

export function validateCheckoutBindings(document, desk) {
  if (!document || document.version !== CHECKOUT_BINDINGS_VERSION || document.desk !== desk || !Array.isArray(document.bindings)
    || Object.keys(document).some((key) => !['version', 'desk', 'bindings', 'digest'].includes(key))) {
    throw failure('checkout_bindings_invalid', `Invalid Checkout bindings for Desk ${desk}.`)
  }
  const normalized = checkoutBindingsDocument(desk, document.bindings)
  if (document.digest !== normalized.digest || JSON.stringify(document.bindings) !== JSON.stringify(normalized.bindings)) {
    throw failure('checkout_bindings_invalid', `Checkout bindings for Desk ${desk} are not canonical.`)
  }
  return document
}

export async function readCheckoutBindings(path, desk) {
  let document
  try { document = JSON.parse(await readFile(path, 'utf8')) }
  catch (error) {
    if (error.code === 'ENOENT') return checkoutBindingsDocument(desk, [])
    throw failure('checkout_bindings_invalid', `${path} is not valid Checkout binding JSON.`)
  }
  return validateCheckoutBindings(document, desk)
}

export function checkoutIndexDocument(desk, projections) {
  const normalized = [...projections]
    .map(({ site, route, address, target, linkState }) => {
      const value = { site, route, address, target: resolve(target), linkState }
      return { ...value, digest: checkoutProjectionDigest(value) }
    })
    .sort((left, right) => left.address.localeCompare(right.address) || left.site.localeCompare(right.site) || left.route.localeCompare(right.route))
  const addresses = new Set()
  for (const projection of normalized) {
    if (!validId(projection.site) || !validId(projection.route) || !validAddress(projection.address)
      || !isAbsolute(projection.target) || !['linked', 'direct', 'relational'].includes(projection.linkState)
      || addresses.has(projection.address)) throw failure('checkout_index_invalid', `Invalid Checkout projection ${projection.address}.`)
    addresses.add(projection.address)
  }
  return { version: CHECKOUT_INDEX_VERSION, desk, projections: normalized }
}

export function validateCheckoutIndex(document) {
  if (!document || document.version !== CHECKOUT_INDEX_VERSION || !validId(document.desk) || !Array.isArray(document.projections)
    || Object.keys(document).some((key) => !['version', 'desk', 'projections'].includes(key))) throw failure('checkout_index_invalid', 'Invalid Checkout index.')
  const normalized = checkoutIndexDocument(document.desk, document.projections)
  if (JSON.stringify(document) !== JSON.stringify(normalized)) throw failure('checkout_index_invalid', 'Checkout index is not canonical.')
  return document
}

export function checkoutLinkState(homeRoot, address, target) {
  homeRoot = resolve(homeRoot)
  address = resolve(address)
  target = resolve(target)
  if (address === target) return 'direct'
  if (contains(homeRoot, target) || contains(target, homeRoot)) return 'relational'
  return 'linked'
}

export function proposeRoutePurposes(routes, explicit = {}) {
  const proposals = new Map()
  const bySite = new Map()
  for (const route of routes) bySite.set(route.site, [...(bySite.get(route.site) ?? []), route])
  for (const [site, siteRoutes] of [...bySite].sort(([left], [right]) => left.localeCompare(right))) {
    const activePrimary = siteRoutes.filter((route) => route.status === 'active' && route.purpose === 'primary')
    if (activePrimary.length > 1) throw failure('route_primary_ambiguous', `${site} has multiple active primary Routes.`)
    for (const route of siteRoutes.filter((entry) => !entry.purpose)) {
      const ref = `${route.site}/${route.id}`
      const purpose = explicit[ref] ?? explicit[route.id] ?? mappedPurpose(route)
      if (!purpose) throw failure('route_purpose_mapping_required', `${ref} requires an explicit Route purpose mapping.`)
      proposals.set(ref, assertRoutePurpose(purpose))
    }
    const proposedPrimary = siteRoutes.filter((route) => route.status === 'active' && (route.purpose === 'primary' || proposals.get(`${route.site}/${route.id}`) === 'primary'))
    if (proposedPrimary.length > 1) throw failure('route_primary_ambiguous', `${site} would have multiple active primary Routes.`)
  }
  return proposals
}

export function checkoutBindingsDigest(document) {
  return sha256(JSON.stringify({ version: document.version, desk: document.desk, bindings: document.bindings }))
}

export function checkoutProjectionDigest(projection) {
  return sha256(`${projection.site}\0${projection.route}\0${projection.address}\0${projection.target}\0${projection.linkState}`)
}

async function gitCommonDirectory(homeRoot) {
  try {
    const { stdout } = await exec('git', ['rev-parse', '--git-common-dir'], { cwd: homeRoot, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
    return realpath(resolve(homeRoot, stdout.trim()))
  } catch { return null }
}

function mappedPurpose(route) {
  const mode = route.modeName ?? route.mode ?? route.checkoutMode
  if (route.id === 'main' || mode === 'embedded') return 'primary'
  if (route.id.startsWith('work--')) return 'development'
  if (route.id.startsWith('release--')) return 'release'
  if (route.id.startsWith('dogfood--')) return 'dogfood'
  if (route.id === 'home-first-reset' || route.id.startsWith('recovery--') || /(^|--)preserve(?:--|$)/.test(route.id)) return 'recovery'
  if (['integrated-main', 'qualification', 'managed-main', 'site-hard-reset'].includes(route.id)) return 'integration'
  return null
}

function validId(value) { return /^[a-z0-9][a-z0-9._-]{0,127}$/.test(value) }
function validAddress(value) { return typeof value === 'string' && value.startsWith('checkouts/') && !value.split(/[\\/]+/).includes('..') }
function contains(root, candidate) { const path = relative(root, candidate); return path === '' || path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path) }
function sha256(value) { return createHash('sha256').update(value).digest('hex') }
function failure(code, message) { const error = new Error(message); error.code = code; return error }
