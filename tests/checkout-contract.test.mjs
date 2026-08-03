import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { API, validateRouteDocument } from '../src/contracts.mjs'
import { createHome } from '../src/create.mjs'
import { removeTree } from '../src/lib/io.mjs'
import { loadRoutes, resolveCheckout, routeV8Document } from '../src/routes.mjs'
import { publicPlan, resolveHome } from '../src/resolved.mjs'
import { writeRoute, writeSite } from '../src/sites.mjs'

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
  const base = { $schema: API.route, id: 'main', site: 'demo', status: 'active', checkout: { mode: 'embedded' } }
  for (const document of [
    { ...base, sourceRoute: 'other' },
    { ...base, head: 'abc' },
    { ...base, checkout: { mode: 'embedded', path: '.' } },
    { ...base, checkout: { mode: 'existing' } },
    { ...base, supersededBy: 'other' },
    { ...base, status: 'superseded' },
    { ...base, checkout: { mode: 'unknown' } },
    { ...base, checkout: { mode: 'managed-clone', path: '/tmp/managed' } },
    { ...base, checkout: { mode: 'managed-worktree', expectedBranch: '' } },
  ]) await assert.rejects(validateRouteDocument(document), (error) => error.code === 'document_invalid')
  await validateRouteDocument({ ...base, status: 'superseded', supersededBy: 'other' })
  await validateRouteDocument({ ...base, checkout: { mode: 'managed-worktree', expectedBranch: 'feature/checkout-v8' } })
  await assert.rejects(resolveCheckout(root, { ...base, status: 'superseded', supersededBy: 'main' }), (error) => error.code === 'route_supersession_invalid')
  await assert.rejects(resolveCheckout(root, { ...base, checkout: { mode: 'existing', path: '../escape' } }), (error) => error.code === 'route_path_invalid')
  await assert.rejects(validateRouteDocument({
    $schema: API.routeV7,
    id: 'main',
    site: 'demo',
    mode: 'existing',
    path: '/tmp/demo',
    branch: '',
  }), (error) => error.code === 'document_invalid')
})

test('the Core loader rejects orphaned and invalid supersession relations', async () => {
  const home = await mkdtemp(join(tmpdir(), 'endroit-routes-relations-'))
  const desk = join(home, '.desk')
  const routeRoot = join(desk, 'routes', 'demo')
  try {
    await mkdir(routeRoot, { recursive: true })
    await writeFile(join(routeRoot, 'old.json'), `${JSON.stringify(await routeV8Document({
      id: 'old', site: 'demo', status: 'superseded', supersededBy: 'next', checkout: { mode: 'embedded' },
    }))}\n`)
    await assert.rejects(loadRoutes(home, desk, []), (error) => error.code === 'route_site_missing')
    await assert.rejects(loadRoutes(home, desk, [{ id: 'demo' }]), (error) => error.code === 'route_supersession_invalid')
    await writeFile(join(routeRoot, 'next.json'), `${JSON.stringify(await routeV8Document({ id: 'next', site: 'demo', checkout: { mode: 'embedded' } }))}\n`)
    assert.equal((await loadRoutes(home, desk, [{ id: 'demo' }])).length, 2)
  } finally {
    await removeTree(home, { force: true })
  }
})

test('resolveHome and publicPlan expose one normalized v8 Checkout declaration', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'endroit-routes-plan-'))
  const home = join(temporary, 'home')
  try {
    await createHome(home)
    await writeSite(home, { id: 'self', summary: 'Embedded fixture.' })
    await writeRoute(home, join(home, '.desk'), { id: 'embedded', site: 'self', mode: 'embedded' })
    const plan = await resolveHome(home)
    assert.equal(plan.routes.length, 1)
    assert.equal(plan.routes[0].ref, 'checkout:self/embedded')
    assert.equal(plan.routes[0].declared.checkout.mode, 'embedded')
    assert.equal(publicPlan(plan).routes[0].documentPath, '.desk/routes/self/embedded.json')
  } finally {
    await removeTree(temporary, { force: true })
  }
})

test('v7 and v8 resolve to the same declared Checkout without persisting observations', async () => {
  const v7 = {
    $schema: API.routeV7,
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

test('the Core loader reads mixed v7/v8 Routes once into the Resolved Home shape', async () => {
  const home = await mkdtemp(join(tmpdir(), 'endroit-routes-loader-'))
  const desk = join(home, '.desk')
  try {
    const routeRoot = join(desk, 'routes', 'demo')
    await mkdir(routeRoot, { recursive: true })
    await writeFile(join(routeRoot, 'legacy.json'), `${JSON.stringify({
      $schema: API.routeV7,
      id: 'legacy',
      site: 'demo',
      mode: 'existing',
      path: '/tmp/legacy',
    })}\n`)
    await writeFile(join(routeRoot, 'main.json'), `${JSON.stringify(await routeV8Document({
      id: 'main',
      site: 'demo',
      checkout: { mode: 'managed-clone' },
    }))}\n`)
    const routes = await loadRoutes(home, desk, [{ id: 'demo' }])
    assert.deepEqual(routes.map(({ id, schemaVersion, declaredPath }) => [id, schemaVersion, declaredPath]), [
      ['legacy', 7, '/tmp/legacy'],
      ['main', 8, join(home, 'checkouts', 'demo', 'main')],
    ])
  } finally {
    await removeTree(home, { force: true })
  }
})
