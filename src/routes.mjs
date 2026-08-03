import { isAbsolute, join, resolve } from 'node:path'
import { API, validateRouteDocument } from './contracts.mjs'
import { EndroitError } from './lib/errors.mjs'
import { assertId } from './lib/io.mjs'

export const ROUTE_STATUSES = Object.freeze(['active', 'parked', 'superseded'])
export const CHECKOUT_MODES = Object.freeze(['embedded', 'existing', 'managed-clone', 'managed-worktree', 'submodule'])

export function managedCheckoutPath(homeRoot, site, route) {
  return join(homeRoot, 'checkouts', assertId(site, 'Site id'), assertId(route, 'Route id'))
}

export async function resolveCheckout(homeRoot, document, options = {}) {
  await validateRouteDocument(document)
  const site = options.site ?? document.site
  const id = options.id ?? document.id
  if (document.site !== site || document.id !== id) {
    throw new EndroitError('route_invalid', `Route ${site}/${id} identity does not match its document.`)
  }
  const version = document.$schema === API.routeV8 ? 8 : 7
  const declared = version === 8 ? declaredV8(document) : declaredV7(homeRoot, document)
  const declaredPath = checkoutPath(homeRoot, site, id, declared.checkout)
  return {
    id,
    site,
    ref: `checkout:${site}/${id}`,
    schemaVersion: version,
    declared,
    declaredPath,
    ...(options.documentPath ? { documentPath: options.documentPath } : {}),
  }
}

export async function routeV8Document(route) {
  const checkout = route.checkout ?? {
    mode: route.mode,
    ...(route.path !== undefined ? { path: route.path } : {}),
    ...(route.branch ? { expectedBranch: route.branch } : {}),
  }
  const document = {
    $schema: API.routeV8,
    id: assertId(route.id, 'Route id'),
    site: assertId(route.site, 'Site id'),
    status: route.status ?? 'active',
    ...(route.supersededBy ? { supersededBy: route.supersededBy } : {}),
    checkout,
  }
  return validateRouteDocument(document)
}

function declaredV8(document) {
  return {
    status: document.status,
    ...(document.supersededBy ? { supersededBy: document.supersededBy } : {}),
    checkout: { ...document.checkout },
  }
}

function declaredV7(homeRoot, document) {
  if (document.mode === 'embedded' && document.path !== '.') {
    throw new EndroitError('route_path_invalid', `Embedded Route ${document.site}/${document.id} must resolve from its Home context.`)
  }
  if (document.mode.startsWith('managed-') && resolve(homeRoot, document.path) !== managedCheckoutPath(homeRoot, document.site, document.id)) {
    throw new EndroitError('route_path_invalid', `Managed Route ${document.site}/${document.id} must use its derived checkout path.`)
  }
  return {
    status: 'active',
    checkout: {
      mode: document.mode,
      ...(['existing', 'submodule'].includes(document.mode) ? { path: document.path } : {}),
      ...(document.branch ? { expectedBranch: document.branch } : {}),
    },
  }
}

function checkoutPath(homeRoot, site, id, checkout) {
  if (checkout.mode === 'embedded') return resolve(homeRoot)
  if (checkout.mode.startsWith('managed-')) return managedCheckoutPath(homeRoot, site, id)
  return isAbsolute(checkout.path) ? resolve(checkout.path) : resolve(homeRoot, checkout.path)
}
