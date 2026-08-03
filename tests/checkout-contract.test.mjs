import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'
import { API, validateRouteDocument } from '../src/contracts.mjs'
import { resolveCheckout, routeV8Document } from '../src/routes.mjs'

const root = '/tmp/endroit-checkout-contract'

test('Route v8 accepts exactly five Checkout modes and derives contextual paths', async () => {
  const modes = ['embedded', 'existing', 'managed-clone', 'managed-worktree', 'submodule']
  for (const mode of modes) {
    const path = ['existing', 'submodule'].includes(mode) ? `/tmp/${mode}` : undefined
    const document = await routeV8Document({ id: mode, site: 'demo', checkout: { mode, ...(path ? { path } : {}) } })
    const route = await resolveCheckout(root, document)
    assert.equal(route.ref, `checkout:demo/${mode}`)
    assert.equal(route.declared.checkout.mode, mode)
    assert.equal(route.declaredPath, mode === 'embedded' ? root : mode.startsWith('managed-') ? join(root, 'checkouts', 'demo', mode) : path)
  }
})

test('Route v8 closes properties and lifecycle combinations', async () => {
  const base = { $schema: API.routeV8, id: 'main', site: 'demo', status: 'active', checkout: { mode: 'embedded' } }
  for (const document of [
    { ...base, sourceRoute: 'other' },
    { ...base, head: 'abc' },
    { ...base, checkout: { mode: 'embedded', path: '.' } },
    { ...base, checkout: { mode: 'existing' } },
    { ...base, supersededBy: 'other' },
    { ...base, status: 'superseded' },
  ]) await assert.rejects(validateRouteDocument(document), (error) => error.code === 'document_invalid')
  await validateRouteDocument({ ...base, status: 'superseded', supersededBy: 'other' })
})

test('v7 and v8 resolve to the same declared Checkout without persisting observations', async () => {
  const v7 = {
    $schema: API.route,
    id: 'main',
    site: 'demo',
    mode: 'existing',
    path: '/tmp/demo',
    branch: 'main',
  }
  const v8 = await routeV8Document({ id: 'main', site: 'demo', checkout: { mode: 'existing', path: '/tmp/demo', expectedBranch: 'main' } })
  assert.deepEqual((await resolveCheckout(root, v7)).declared, (await resolveCheckout(root, v8)).declared)
  assert.equal('head' in v8, false)
  assert.equal('dirty' in v8, false)
})
