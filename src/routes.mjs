import { lstat, readFile, readdir, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { API, validateRouteDocument } from './contracts.mjs'
import { parseDocument, renderDocument, validateDocumentV9, V9_API } from './documents.mjs'
import { EndroitError } from './lib/errors.mjs'
import { assertId } from './lib/io.mjs'

export const ROUTE_V9 = V9_API.route
export const ROUTE_STATUSES = Object.freeze(['active', 'parked', 'superseded'])
export const CHECKOUT_MODES = Object.freeze(['embedded', 'existing', 'managed-clone', 'managed-worktree', 'submodule'])

export function managedCheckoutPath(homeRoot, site, route) {
  return join(homeRoot, 'checkouts', assertId(site, 'Site id'), assertId(route, 'Route id'))
}

export async function loadRoutes(homeRoot, deskRoot, sites = [], options = {}) {
  if (!deskRoot) return []
  const declaredSites = new Set(sites.map((site) => site.id))
  const values = []
  for (const siteEntry of await directories(join(deskRoot, 'routes'))) {
    if (!declaredSites.has(siteEntry.name)) {
      throw new EndroitError('route_site_missing', `Routes declare unknown Site ${siteEntry.name}.`)
    }
    const siteRoot = join(deskRoot, 'routes', siteEntry.name)
    const identities = new Set()
    for (const entry of await safeReadDir(siteRoot)) {
      if (entry.isSymbolicLink()) throw new EndroitError('route_invalid', `${relative(homeRoot, join(siteRoot, entry.name))} must not be a symbolic link.`)
      const legacy = entry.isFile() && entry.name.endsWith('.json')
      const current = entry.isDirectory()
      if (!legacy && !current) continue
      const id = legacy ? entry.name.slice(0, -5) : entry.name
      const documentPath = legacy ? join(siteRoot, entry.name) : join(siteRoot, entry.name, 'ROUTE.md')
      if (current) {
        const info = await lstat(documentPath).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error))
        if (!info && options.allowMissingRouteDocuments) continue
        if (!info || info.isSymbolicLink() || !info.isFile()) {
          throw new EndroitError('route_invalid', `${relative(homeRoot, documentPath)} must be a regular Route document.`)
        }
      }
      if (identities.has(id)) throw new EndroitError('route_source_collision', `Route ${siteEntry.name}/${id} has multiple declarations.`)
      identities.add(id)
      const document = legacy
        ? parseLegacyRoute(await readFile(documentPath, 'utf8'), relative(homeRoot, documentPath))
        : await parseRouteMarkdown(await readFile(documentPath, 'utf8'), relative(homeRoot, documentPath))
      values.push(await resolveCheckout(homeRoot, document, {
        site: siteEntry.name,
        id,
        documentPath,
      }))
    }
  }
  for (const route of values.filter((entry) => entry.declared.status === 'superseded')) {
    const replacement = values.find((entry) => entry.site === route.site && entry.id === route.declared.supersededBy)
    if (!replacement) throw new EndroitError('route_supersession_invalid', `Route ${route.site}/${route.id} supersedes to a missing Route ${route.declared.supersededBy}.`)
  }
  return values.sort((left, right) => left.site.localeCompare(right.site) || left.id.localeCompare(right.id))
}

export async function resolveCheckout(homeRoot, document, options = {}) {
  homeRoot = await realpath(homeRoot).catch(() => resolve(homeRoot))
  if (document?.$schema === ROUTE_V9) await validateDocumentV9(document, 'route')
  else await validateRouteDocument(document)
  const site = options.site ?? document.site
  const id = options.id ?? document.id
  if (document.site !== site || document.id !== id) {
    throw new EndroitError('route_invalid', `Route ${site}/${id} identity does not match its document.`)
  }
  const version = document.$schema === ROUTE_V9 ? 9 : document.$schema === API.route ? 8 : 7
  const supersededBy = version === 9 ? document.superseded_by : document.supersededBy
  if (version >= 8 && supersededBy === id) {
    throw new EndroitError('route_supersession_invalid', `Route ${site}/${id} cannot supersede itself.`)
  }
  const declared = version === 9 ? declaredV9(document) : version === 8 ? declaredV8(document) : declaredV7(homeRoot, document)
  if (version === 8 && ['existing', 'submodule'].includes(declared.checkout.mode) && !isAbsolute(declared.checkout.path)) {
    const segments = declared.checkout.path.split(/[\\/]+/)
    if (segments.includes('..')) throw new EndroitError('route_path_invalid', `Route ${site}/${id} path must not escape its Workplace context.`)
  }
  const declaredPath = version === 9 && declared.checkout.mode !== 'embedded'
    ? managedCheckoutPath(homeRoot, site, id)
    : checkoutPath(homeRoot, site, id, declared.checkout)
  return {
    id,
    site,
    ref: `checkout:${site}/${id}`,
    schemaVersion: version,
    declared,
    declaredPath,
    ...(version === 9 ? { owner: document.owner } : {}),
    ...(options.documentPath ? { documentPath: options.documentPath } : {}),
  }
}

export async function routeV9Document(route) {
  const document = {
    $schema: ROUTE_V9,
    kind: 'endroit/route',
    id: assertId(route.id, 'Route id'),
    site: assertId(route.site, 'Site id'),
    owner: route.owner,
    route_state: route.status ?? route.route_state ?? 'active',
    ...(route.supersededBy ? { superseded_by: route.supersededBy } : {}),
    checkout_mode: route.checkout?.mode ?? route.checkout_mode ?? route.mode,
    ...(route.revision ? { revision: { ...route.revision } } : {}),
  }
  return validateDocumentV9(document, 'route')
}

export async function routeV9Markdown(route) {
  const metadata = await routeV9Document(route)
  return renderDocument({
    metadata,
    body: `# ${metadata.site} / ${metadata.id}\n\nLocal address: \`checkout:${metadata.site}/${metadata.id}\`.`,
  })
}

export async function parseRouteMarkdown(source, label = 'ROUTE.md') {
  const document = parseDocument(source, { path: label })
  if (!document.body.trim()) throw new EndroitError('route_invalid', `${label} must contain a human-readable body.`)
  await validateDocumentV9(document.metadata, 'route')
  return document.metadata
}

export async function routeV8Document(route) {
  const checkout = route.checkout ?? legacyCheckout(route)
  const document = {
    $schema: API.route,
    id: assertId(route.id, 'Route id'),
    site: assertId(route.site, 'Site id'),
    status: route.status ?? 'active',
    ...(route.supersededBy ? { supersededBy: route.supersededBy } : {}),
    checkout,
    ...(route.revision ? { revision: { ...route.revision } } : legacyRevision(route, checkout)),
  }
  return validateRouteDocument(document)
}

function legacyCheckout(route) {
  return {
    mode: route.mode,
    ...(['existing', 'submodule'].includes(route.mode) && route.path !== undefined ? { path: route.path } : {}),
  }
}

function legacyRevision(route, checkout) {
  return checkout.mode === 'managed-worktree' && route.branch
    ? { revision: { kind: 'branch', name: route.branch } }
    : {}
}

function declaredV8(document) {
  return {
    status: document.status,
    ...(document.supersededBy ? { supersededBy: document.supersededBy } : {}),
    checkout: { ...document.checkout },
    ...(document.revision ? { revision: { ...document.revision } } : {}),
  }
}

function declaredV9(document) {
  return {
    status: document.route_state,
    ...(document.superseded_by ? { supersededBy: document.superseded_by } : {}),
    checkout: { mode: document.checkout_mode },
    ...(document.revision ? { revision: { ...document.revision } } : {}),
  }
}

function declaredV7(homeRoot, document) {
  if (document.mode === 'embedded' && document.path !== '.') {
    throw new EndroitError('route_path_invalid', `Embedded Route ${document.site}/${document.id} must resolve from its Workplace context.`)
  }
  if (document.mode.startsWith('managed-') && resolve(homeRoot, document.path) !== managedCheckoutPath(homeRoot, document.site, document.id)) {
    throw new EndroitError('route_path_invalid', `Managed Route ${document.site}/${document.id} must use its derived checkout path.`)
  }
  return {
    status: 'active',
    checkout: {
      mode: document.mode,
      ...(['existing', 'submodule'].includes(document.mode) ? { path: document.path } : {}),
    },
    ...(document.mode === 'managed-worktree' && document.branch ? { revision: { kind: 'branch', name: document.branch } } : {}),
  }
}

function checkoutPath(homeRoot, site, id, checkout) {
  if (checkout.mode === 'embedded') return resolve(homeRoot)
  if (checkout.mode.startsWith('managed-')) return managedCheckoutPath(homeRoot, site, id)
  return isAbsolute(checkout.path) ? resolve(checkout.path) : resolve(homeRoot, checkout.path)
}

function parseLegacyRoute(source, label) {
  try { return JSON.parse(source) } catch (error) {
    throw new EndroitError('route_invalid', `${label} is not valid JSON: ${error.message}`)
  }
}

async function directories(path) {
  return (await safeReadDir(path)).filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
}

async function safeReadDir(path) {
  try {
    const info = await lstat(path)
    if (info.isSymbolicLink() || !info.isDirectory()) throw new EndroitError('route_root_invalid', `${path} must be a directory.`)
    return (await readdir(path, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
}
