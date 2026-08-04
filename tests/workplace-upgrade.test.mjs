import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { createHome } from '../src/create.mjs'
import { parseDocument } from '../src/documents.mjs'
import { workplaceGitStorage } from '../src/git-workplace.mjs'
import { removeTree } from '../src/lib/io.mjs'
import { applyWorkplaceUpgrade, planWorkplaceUpgrade, rollbackWorkplaceUpgrade } from '../src/workplace-upgrade.mjs'

const exec = promisify(execFile)

test('workplace upgrade plans, applies and exactly rolls back Route, binding and index changes', async () => {
  const fixture = await upgradeFixture()
  try {
    const { home, repository, routePath, routeBytes, indexPath, indexBytes, address, desk } = fixture
    const before = await gitInvariant(repository, address)
    const plan = await planWorkplaceUpgrade(home, {
      targetVersion: '0.10.0',
      sourceCommit: '0123456789abcdef',
      packageDigest: 'sha256:package',
      packageIntegrity: 'sha512-package',
    })

    assert.equal(plan.status, 'upgrade-available')
    assert.match(plan.planDigest, /^[a-f0-9]{64}$/)
    assert.deepEqual(plan.target, {
      version: '0.10.0',
      sourceCommit: '0123456789abcdef',
      packageDigest: 'sha256:package',
      packageIntegrity: 'sha512-package',
    })
    assert.deepEqual(plan.routePurposes, [{ site: 'demo', route: 'main', purpose: 'primary' }])
    assert.ok(plan.writes.some((entry) => entry.kind === 'checkout-bindings'))
    assert.ok(plan.writes.some((entry) => entry.kind === 'checkout-index'))
    assert.ok(plan.writes.some((entry) => entry.kind === 'route-v9'))
    assert.deepEqual(await readFile(routePath), routeBytes)
    assert.deepEqual(await readFile(indexPath), indexBytes)
    assert.deepEqual(await gitInvariant(repository, address), before)

    await assert.rejects(
      applyWorkplaceUpgrade(home, { expectPlan: 'wrong', approve: `workplace:${plan.workplace}`, verify: async () => true }),
      (error) => error.code === 'workplace_upgrade_plan_mismatch',
    )
    await assert.rejects(
      applyWorkplaceUpgrade(home, {
        targetVersion: '0.10.0',
        sourceCommit: '0123456789abcdef',
        packageDigest: 'sha256:package',
        packageIntegrity: 'sha512-package',
        expectPlan: plan.planDigest,
        approve: 'workplace:wrong',
        verify: async () => true,
      }),
      (error) => error.code === 'workplace_upgrade_approval_required',
    )

    let verified = false
    const upgraded = await applyWorkplaceUpgrade(home, {
      targetVersion: '0.10.0',
      sourceCommit: '0123456789abcdef',
      packageDigest: 'sha256:package',
      packageIntegrity: 'sha512-package',
      expectPlan: plan.planDigest,
      approve: `workplace:${plan.workplace}`,
      verify: async () => { verified = true; return { status: 'ready' } },
    })
    assert.equal(upgraded.status, 'upgraded')
    assert.equal(verified, true)
    assert.equal(await pathExists(routePath), false)
    const routeV9Path = join(dirname(routePath), 'main', 'ROUTE.md')
    const route = parseDocument(await readFile(routeV9Path, 'utf8'), { path: routeV9Path }).metadata
    assert.equal(route.route_purpose, 'primary')
    assert.equal(route.checkout_mode, 'existing')
    const bindingsPath = (await workplaceGitStorage(home, desk)).bindingsPath
    const bindings = JSON.parse(await readFile(bindingsPath, 'utf8'))
    assert.deepEqual(bindings.bindings, [{ site: 'demo', route: 'main', target: await realpath(repository) }])
    const index = JSON.parse(await readFile(indexPath, 'utf8'))
    assert.equal(index.version, 3)
    assert.equal(index.desk, desk)
    assert.equal(index.projections[0].target, await realpath(repository))
    assert.deepEqual(await gitInvariant(repository, address), before)

    const current = await planWorkplaceUpgrade(home, {
      targetVersion: '0.10.0',
      sourceCommit: '0123456789abcdef',
      packageDigest: 'sha256:package',
      packageIntegrity: 'sha512-package',
    })
    assert.equal(current.status, 'current')
    assert.equal(current.writes.length, 0)

    const rolledBack = await rollbackWorkplaceUpgrade(home, upgraded.runId)
    assert.equal(rolledBack.status, 'rolled-back')
    assert.deepEqual(await readFile(routePath), routeBytes)
    assert.equal(await pathExists(routeV9Path), false)
    assert.deepEqual(await readFile(indexPath), indexBytes)
    assert.equal(await pathExists(bindingsPath), false)
    assert.deepEqual(await gitInvariant(repository, address), before)
  } finally {
    await fixture.cleanup()
  }
})

test('workplace upgrade refuses unmapped Route purposes and accepts an explicit mapping', async () => {
  const fixture = await upgradeFixture({ route: 'custom' })
  try {
    await assert.rejects(() => planWorkplaceUpgrade(fixture.home), (error) => error.code === 'route_purpose_mapping_required')
    const plan = await planWorkplaceUpgrade(fixture.home, { purposes: { 'demo/custom': 'experiment' } })
    assert.deepEqual(plan.routePurposes, [{ site: 'demo', route: 'custom', purpose: 'experiment' }])
  } finally {
    await fixture.cleanup()
  }
})

test('workplace upgrade automatically restores exact bytes after a write fault', async () => {
  const fixture = await upgradeFixture()
  const previousNodeEnv = process.env.NODE_ENV
  const previousFault = process.env.ENDROIT_TEST_FAULT_AFTER_WORKPLACE_UPGRADE_WRITE
  try {
    const before = await gitInvariant(fixture.repository, fixture.address)
    const plan = await planWorkplaceUpgrade(fixture.home)
    process.env.NODE_ENV = 'test'
    process.env.ENDROIT_TEST_FAULT_AFTER_WORKPLACE_UPGRADE_WRITE = 'route-legacy-remove'
    await assert.rejects(
      applyWorkplaceUpgrade(fixture.home, {
        expectPlan: plan.planDigest,
        approve: `workplace:${plan.workplace}`,
        verify: async () => ({ status: 'ready' }),
      }),
      (error) => error.code === 'workplace_upgrade_fault' && /rolled back exactly/.test(error.message),
    )
    assert.deepEqual(await readFile(fixture.routePath), fixture.routeBytes)
    assert.deepEqual(await readFile(fixture.indexPath), fixture.indexBytes)
    assert.equal(await pathExists(join(dirname(fixture.routePath), 'main', 'ROUTE.md')), false)
    assert.deepEqual(await gitInvariant(fixture.repository, fixture.address), before)
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = previousNodeEnv
    if (previousFault === undefined) delete process.env.ENDROIT_TEST_FAULT_AFTER_WORKPLACE_UPGRADE_WRITE
    else process.env.ENDROIT_TEST_FAULT_AFTER_WORKPLACE_UPGRADE_WRITE = previousFault
    await fixture.cleanup()
  }
})

async function upgradeFixture(options = {}) {
  const temporary = await mkdtemp(join(tmpdir(), 'endroit-workplace-upgrade-'))
  const home = join(temporary, 'home')
  const repository = join(temporary, 'repository')
  await createHome(home)
  await exec('git', ['init', '--quiet', '--initial-branch=main', repository])
  await exec('git', ['config', 'user.name', 'Test'], { cwd: repository })
  await exec('git', ['config', 'user.email', 'test@example.com'], { cwd: repository })
  await writeFile(join(repository, 'README.md'), '# fixture\n')
  await exec('git', ['add', '--all'], { cwd: repository })
  await exec('git', ['commit', '--quiet', '-m', 'fixture'], { cwd: repository })
  const deskPath = join(home, '.desk', 'DESK.md')
  const desk = parseDocument(await readFile(deskPath, 'utf8'), { path: deskPath }).metadata.id
  const route = options.route ?? 'main'
  const routePath = join(home, '.desk', 'routes', 'demo', `${route}.json`)
  await mkdir(dirname(routePath), { recursive: true })
  const routeBytes = Buffer.from(`${JSON.stringify({
    $schema: 'https://endroit.org/schema/v8/route.json',
    id: route,
    site: 'demo',
    status: 'active',
    checkout: { mode: 'existing', path: await realpath(repository) },
  }, null, 2)}\n`)
  await writeFile(routePath, routeBytes)
  const address = join(home, 'checkouts', 'demo', route)
  await mkdir(dirname(address), { recursive: true })
  await symlink(await realpath(repository), address, 'dir')
  const indexPath = join(home, '.endroit', 'checkout-index.json')
  const indexBytes = Buffer.from(`${JSON.stringify({
    version: 2,
    desks: { [desk]: { links: [{ path: `checkouts/demo/${route}`, target: await realpath(repository), ref: `checkout:demo/${route}` }] } },
  }, null, 2)}\n`)
  await mkdir(dirname(indexPath), { recursive: true })
  await writeFile(indexPath, indexBytes)
  return {
    temporary,
    home,
    repository,
    desk,
    routePath,
    routeBytes,
    indexPath,
    indexBytes,
    address,
    cleanup: () => removeTree(temporary, { force: true }),
  }
}

async function gitInvariant(repository, address) {
  return {
    head: (await exec('git', ['rev-parse', 'HEAD'], { cwd: repository })).stdout.trim(),
    branch: (await exec('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: repository })).stdout.trim(),
    address: await realpath(address),
    inode: (await lstat(repository)).ino,
  }
}

async function pathExists(path) {
  try { await lstat(path); return true } catch (error) { if (error.code === 'ENOENT') return false; throw error }
}
