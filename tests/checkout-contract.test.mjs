import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { API, validateRouteDocument } from '../src/contracts.mjs'
import { createHome } from '../src/create.mjs'
import { checkoutLinkState, proposeRoutePurposes } from '../src/git-workplace.mjs'
import { removeTree } from '../src/lib/io.mjs'
import { loadRoutes, parseRouteMarkdown, resolveCheckout, routeV8Document, routeV9Document, routeV9Markdown } from '../src/routes.mjs'
import { publicPlan, resolveHome } from '../src/resolved.mjs'
import { writeRoute, writeSite } from '../src/sites.mjs'

const root = '/tmp/endroit-checkout-contract'

test('Route purpose proposals are exact and relational self targets need no link', () => {
  const routes = [
    ['main', 'existing', 'primary'],
    ['embedded-anything', 'embedded', 'primary'],
    ['work--slice', 'existing', 'development'],
    ['release--candidate', 'existing', 'release'],
    ['dogfood--home', 'existing', 'dogfood'],
    ['home-first-reset', 'existing', 'recovery'],
    ['recovery--safe', 'existing', 'recovery'],
    ['branch--preserve--old', 'existing', 'recovery'],
    ['integrated-main', 'existing', 'integration'],
    ['qualification', 'existing', 'integration'],
    ['managed-main', 'existing', 'integration'],
    ['site-hard-reset', 'existing', 'integration'],
  ].map(([id, mode, expected]) => ({ site: id, id, mode, status: 'active', expected }))
  const purposes = proposeRoutePurposes(routes)
  for (const route of routes) assert.equal(purposes.get(`${route.site}/${route.id}`), route.expected)
  assert.throws(() => proposeRoutePurposes([{ site: 'demo', id: 'custom', mode: 'existing', status: 'active' }]), (error) => error.code === 'route_purpose_mapping_required')
  assert.equal(checkoutLinkState('/work/home', '/work/home/checkouts/self/main', '/work/home'), 'relational')
  assert.equal(checkoutLinkState('/work/home', '/work/home/checkouts/self/main', '/work'), 'relational')
})

test('Route v8 accepts exactly five Checkout modes and derives contextual paths', async () => {
  const modes = ['embedded', 'existing', 'managed-clone', 'managed-worktree', 'submodule']
  for (const mode of modes) {
    const path = ['existing', 'submodule'].includes(mode) ? `/tmp/${mode}` : undefined
    const document = await routeV8Document({
      id: mode,
      site: 'demo',
      checkout: { mode, ...(path ? { path } : {}) },
      ...(mode === 'managed-worktree' ? { revision: { kind: 'branch', name: 'feature/topology' } } : {}),
    })
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
    { ...base, checkout: { mode: 'managed-worktree' } },
    { ...base, checkout: { mode: 'managed-worktree' }, revision: { kind: 'branch', name: '' } },
    { ...base, checkout: { mode: 'submodule', path: '/tmp/module' }, revision: { kind: 'commit', sha: 'a'.repeat(40) } },
  ]) await assert.rejects(validateRouteDocument(document), (error) => error.code === 'document_invalid')
  await validateRouteDocument({ ...base, status: 'superseded', supersededBy: 'other' })
  await validateRouteDocument({ ...base, checkout: { mode: 'managed-worktree' }, revision: { kind: 'branch', name: 'feature/checkout-v8' } })
  await validateRouteDocument({ ...base, revision: { kind: 'commit', sha: 'a'.repeat(40) } })
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
    assert.equal(publicPlan(plan).routes[0].document_path, '.desk/routes/self/embedded.json')
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
  const v8 = await routeV8Document({ id: 'main', site: 'demo', checkout: { mode: 'existing', path: '/tmp/demo' } })
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
      ['main', 8, join(await realpath(home), 'checkouts', 'demo', 'main')],
    ])
  } finally {
    await removeTree(home, { force: true })
  }
})

test('Route v9 is a pathless human-owned declaration with one derived Checkout address', async () => {
  const document = await routeV9Document({
    id: 'main',
    site: 'demo',
    owner: 'desk:alexis',
    purpose: 'primary',
    mode: 'existing',
  })
  assert.equal(document.kind, 'endroit/route')
  assert.equal(document.route_state, 'active')
  assert.equal(document.route_purpose, 'primary')
  assert.equal(document.checkout_mode, 'existing')
  assert.equal('path' in document, false)
  assert.equal(JSON.stringify(document).includes('/tmp/'), false)
  const markdown = await routeV9Markdown(document)
  assert.match(markdown, /^---\n\$schema: "https:\/\/endroit\.org\/schema\/v9\/route\.json"/)
  assert.match(markdown, /Local address: `checkout:demo\/main`\./)
  const parsed = await parseRouteMarkdown(markdown)
  assert.deepEqual(parsed, document)
  const route = await resolveCheckout(root, parsed)
  assert.equal(route.schemaVersion, 9)
  assert.equal(route.declaredPath, join(root, 'checkouts', 'demo', 'main'))
  assert.equal(route.owner, 'desk:alexis')
  await assert.rejects(resolveCheckout(root, { ...document, path: '/tmp/demo' }), (error) => error.code === 'document_invalid')
  await assert.rejects(resolveCheckout(root, { ...document, final: false }), (error) => error.code === 'document_invalid')
})

test('the Core loader reads v9 ROUTE.md beside legacy declarations and rejects source collisions', async () => {
  const home = await mkdtemp(join(tmpdir(), 'endroit-routes-v9-'))
  const desk = join(home, '.desk')
  const routeRoot = join(desk, 'routes', 'demo')
  try {
    await mkdir(join(routeRoot, 'current'), { recursive: true })
    await writeFile(join(routeRoot, 'current', 'ROUTE.md'), await routeV9Markdown({
      id: 'current', site: 'demo', owner: 'desk:local', purpose: 'primary', mode: 'managed-clone',
    }))
    await writeFile(join(routeRoot, 'legacy.json'), `${JSON.stringify(await routeV8Document({
      id: 'legacy', site: 'demo', checkout: { mode: 'existing', path: '/tmp/legacy' },
    }))}\n`)
    const routes = await loadRoutes(home, desk, [{ id: 'demo' }])
    assert.deepEqual(routes.map(({ id, schemaVersion }) => [id, schemaVersion]), [['current', 9], ['legacy', 8]])
    await writeFile(join(routeRoot, 'current.json'), `${JSON.stringify(await routeV8Document({
      id: 'current', site: 'demo', checkout: { mode: 'embedded' },
    }))}\n`)
    await assert.rejects(loadRoutes(home, desk, [{ id: 'demo' }]), (error) => error.code === 'route_source_collision')
  } finally {
    await removeTree(home, { force: true })
  }
})
