import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { createHome } from '../src/create.mjs'
import { buildHome } from '../src/build.mjs'
import { runCli } from '../src/cli.mjs'
import { parseDocument } from '../src/documents.mjs'
import { addEquipment } from '../src/equipment.mjs'
import { workplaceGitStorage } from '../src/git-workplace.mjs'
import { removeTree } from '../src/lib/io.mjs'
import { resolveHome } from '../src/resolved.mjs'
import { applyWorkplaceUpgrade, planWorkplaceUpgrade, rollbackWorkplaceUpgrade } from '../src/workplace-upgrade.mjs'
import { captureIo, equipment, writeEquipment } from './helpers.mjs'

const exec = promisify(execFile)
const TARGET = {
  targetVersion: '0.10.0-alpha.0',
  sourceCommit: '0123456789abcdef0123456789abcdef01234567',
  packageDigest: 'sha256:package',
  packageIntegrity: 'sha512-package',
}

test('workplace upgrade plans, applies and exactly rolls back Route, binding and index changes', async () => {
  const fixture = await upgradeFixture()
  try {
    const { home, repository, routePath, routeBytes, indexPath, indexBytes, address, desk } = fixture
    const before = await gitInvariant(repository, address)
    const plan = await planWorkplaceUpgrade(home, TARGET)

    assert.equal(plan.status, 'upgrade-available')
    assert.match(plan.planDigest, /^[a-f0-9]{64}$/)
    assert.deepEqual(plan.target, {
      version: TARGET.targetVersion,
      sourceCommit: TARGET.sourceCommit,
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
      applyWorkplaceUpgrade(home, { ...TARGET, expectPlan: 'wrong', approve: `workplace:${plan.workplace}`, verify: async () => true }),
      (error) => error.code === 'workplace_upgrade_plan_mismatch',
    )
    await assert.rejects(
      applyWorkplaceUpgrade(home, {
        ...TARGET,
        expectPlan: plan.planDigest,
        approve: 'workplace:wrong',
        verify: async () => true,
      }),
      (error) => error.code === 'workplace_upgrade_approval_required',
    )

    let verified = false
    const upgraded = await applyWorkplaceUpgrade(home, {
      ...TARGET,
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

    const current = await planWorkplaceUpgrade(home, TARGET)
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
    await assert.rejects(() => planWorkplaceUpgrade(fixture.home, TARGET), (error) => error.code === 'route_purpose_mapping_required')
    const plan = await planWorkplaceUpgrade(fixture.home, { ...TARGET, purposes: { 'demo/custom': 'experiment' } })
    assert.deepEqual(plan.routePurposes, [{ site: 'demo', route: 'custom', purpose: 'experiment' }])
  } finally {
    await fixture.cleanup()
  }
})

test('workplace upgrade preserves a managed Checkout from the primary Home in a linked worktree', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'endroit-workplace-managed-upgrade-'))
  const home = join(temporary, 'home')
  const dogfood = join(temporary, 'dogfood')
  try {
    await createHome(home)
    const deskPath = join(home, '.desk', 'DESK.md')
    const desk = parseDocument(await readFile(deskPath, 'utf8'), { path: deskPath }).metadata.id
    const routePath = join(home, '.desk', 'routes', 'demo', 'work--slice.json')
    const existingRoutePath = join(home, '.desk', 'routes', 'demo', 'recovery--legacy-local.json')
    await mkdir(dirname(routePath), { recursive: true })
    await writeFile(routePath, `${JSON.stringify({
      $schema: 'https://endroit.org/schema/v8/route.json',
      id: 'work--slice',
      site: 'demo',
      status: 'active',
      checkout: { mode: 'managed-worktree' },
      revision: { kind: 'branch', name: 'codex/work/slice' },
    }, null, 2)}\n`)
    await writeFile(existingRoutePath, `${JSON.stringify({
      $schema: 'https://endroit.org/schema/v8/route.json',
      id: 'recovery--legacy-local',
      site: 'demo',
      status: 'parked',
      checkout: { mode: 'existing', path: '.desk/sites/demo/legacy-local' },
    }, null, 2)}\n`)
    const target = join(home, 'checkouts', 'demo', 'work--slice')
    const existingTarget = join(home, '.desk', 'sites', 'demo', 'legacy-local')
    await mkdir(target, { recursive: true })
    await mkdir(existingTarget, { recursive: true })
    await exec('git', ['add', '-f', '.desk/routes/demo/work--slice.json', '.desk/routes/demo/recovery--legacy-local.json'], { cwd: home })
    await exec('git', ['commit', '--quiet', '-m', 'add managed route'], { cwd: home })
    await exec('git', ['worktree', 'add', '--quiet', '-b', 'codex/dogfood', dogfood], { cwd: home })

    const primaryPlan = await planWorkplaceUpgrade(home, TARGET)
    const plan = await planWorkplaceUpgrade(dogfood, TARGET)
    assert.equal(plan.planDigest, primaryPlan.planDigest)
    assert.equal(plan.homeGit.primaryRoot, await realpath(home))
    const upgraded = await applyWorkplaceUpgrade(dogfood, {
      ...TARGET,
      expectPlan: plan.planDigest,
      approve: `workplace:${plan.workplace}`,
      verify: async () => ({ status: 'ready' }),
    })
    assert.equal(upgraded.status, 'upgraded')
    const bindings = JSON.parse(await readFile((await workplaceGitStorage(dogfood, desk)).bindingsPath, 'utf8'))
    assert.deepEqual(bindings.bindings, [
      { site: 'demo', route: 'recovery--legacy-local', target: await realpath(existingTarget) },
      { site: 'demo', route: 'work--slice', target: await realpath(target) },
    ])
  } finally {
    await removeTree(temporary, { force: true })
  }
})

test('workplace rollback detects drift before restoring any entry', async () => {
  const fixture = await upgradeFixture()
  try {
    const plan = await planWorkplaceUpgrade(fixture.home, TARGET)
    const upgraded = await applyWorkplaceUpgrade(fixture.home, {
      ...TARGET,
      expectPlan: plan.planDigest,
      approve: `workplace:${plan.workplace}`,
      verify: async () => ({ status: 'ready' }),
    })
    const journal = JSON.parse(await readFile(join(fixture.home, '.endroit', 'upgrades', 'workplace-v1', upgraded.runId, 'journal.json'), 'utf8'))
    const drifted = journal.entries[0]
    const untouched = journal.entries.at(-1)
    const untouchedBytes = await readFile(untouched.path).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error))
    await writeFile(drifted.path, 'concurrent drift\n')

    await assert.rejects(() => rollbackWorkplaceUpgrade(fixture.home, upgraded.runId), (error) => error.code === 'workplace_upgrade_rollback_drift')
    assert.deepEqual(await readFile(untouched.path).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error)), untouchedBytes)
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
    const plan = await planWorkplaceUpgrade(fixture.home, TARGET)
    process.env.NODE_ENV = 'test'
    process.env.ENDROIT_TEST_FAULT_AFTER_WORKPLACE_UPGRADE_WRITE = 'route-legacy-remove'
    await assert.rejects(
      applyWorkplaceUpgrade(fixture.home, {
        ...TARGET,
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

test('legacy Workplace upgrade is deterministic, owner-correct, CLI-accessible and exactly reversible', async () => {
  const fixture = await legacyFixture()
  try {
    const publishingRuntime = join(fixture.home, 'equipment', 'endroit', 'publishing', 'runtime.mjs')
    const targetRuntime = await readFile(publishingRuntime)
    await writeFile(publishingRuntime, 'export default "customized"\n')
    await assert.rejects(
      () => planWorkplaceUpgrade(fixture.home, TARGET),
      (error) => error.code === 'workplace_upgrade_equipment_customized',
    )
    await writeFile(publishingRuntime, targetRuntime)

    const first = await planWorkplaceUpgrade(fixture.home, TARGET)
    const second = await planWorkplaceUpgrade(fixture.home, TARGET)
    assert.equal(first.planDigest, second.planDigest)
    assert.deepEqual(first.compatibility, ['rooms', 'sites', 'artifacts', 'work'])
    assert.ok(first.writes.some((entry) => entry.kind === 'workplace-v9'))
    assert.ok(first.writes.some((entry) => entry.kind === 'desk-v9'))
    assert.ok(first.writes.some((entry) => entry.kind === 'member-v9'))
    assert.ok(first.equipment.length > 0)
    assert.equal(first.equipment.some((entry) => entry.id === 'endroit/release'), false)
    assert.deepEqual(first.retired, [{ id: 'endroit/retired', version: '0.9.0-alpha.0', retained: ['LOCAL.md'] }])

    const checkIo = captureIo()
    assert.equal(await runCli([
      'workplace', 'upgrade', '--check', '--workplace', fixture.home, '--json',
      '--target-version', TARGET.targetVersion,
      '--source-commit', TARGET.sourceCommit,
      '--package-digest', TARGET.packageDigest,
      '--package-integrity', TARGET.packageIntegrity,
    ], checkIo.io), 0, checkIo.stderr())
    assert.equal(JSON.parse(checkIo.stdout()).planDigest, first.planDigest)

    await writeFile(join(fixture.home, 'dirty.tmp'), 'dirty\n')
    await assert.rejects(
      applyWorkplaceUpgrade(fixture.home, {
        ...TARGET,
        expectPlan: first.planDigest,
        approve: `workplace:${first.workplace}`,
        verify: async () => true,
      }),
      (error) => error.code === 'workplace_upgrade_home_dirty',
    )
    await rm(join(fixture.home, 'dirty.tmp'))

    const applyIo = captureIo()
    assert.equal(await runCli([
      'workplace', 'upgrade', '--apply', '--workplace', fixture.home, '--json',
      '--target-version', TARGET.targetVersion,
      '--source-commit', TARGET.sourceCommit,
      '--package-digest', TARGET.packageDigest,
      '--package-integrity', TARGET.packageIntegrity,
      '--expect-plan', first.planDigest,
      '--approve', `workplace:${first.workplace}`,
    ], applyIo.io), 0, applyIo.stderr())
    const applied = JSON.parse(applyIo.stdout())
    assert.equal(applied.status, 'upgraded')

    const plan = await resolveHome(fixture.home)
    assert.equal(plan.resolvedWorkplace.status, 'resolved')
    assert.equal(plan.home.runtime, `@endroit/cli@${TARGET.targetVersion}`)
    assert.equal(await pathExists(join(fixture.home, 'endroit.json')), false)
    assert.equal(await pathExists(join(fixture.home, 'HOME.md')), false)
    assert.equal(await pathExists(join(fixture.home, '.desk', 'desk.json')), false)
    const workplace = parseDocument(await readFile(join(fixture.home, 'WORKPLACE.md')), { path: 'WORKPLACE.md' })
    assert.match(workplace.sections.find((entry) => entry.title === 'Constitution').body, /Human direction, judgment, acceptance and delivery consent remain explicit\./)
    assert.doesNotMatch(workplace.sections.find((entry) => entry.title === 'Constitution').body, /Legacy constitution sentence\./)
    assert.match(workplace.sections.find((entry) => entry.title === 'Migrated guidance').body, /Legacy constitution sentence\./)
    assert.match(workplace.sections.find((entry) => entry.title === 'Migrated guidance').body, /Historical guidance item 299\./)
    const desk = parseDocument(await readFile(join(fixture.home, '.desk', 'DESK.md')), { path: 'DESK.md' })
    assert.equal(desk.metadata.$schema, 'https://endroit.org/schema/v9/desk.json')
    assert.match(desk.body, /Legacy Desk guidance\./)
    const member = parseDocument(await readFile(join(fixture.home, 'members', 'owner', 'MEMBER.md')), { path: 'MEMBER.md' })
    assert.equal(member.metadata.$schema, 'https://endroit.org/schema/v9/member.json')
    assert.match(member.body, /Legacy Member context\./)
    for (const entry of plan.equipment.filter((item) => item.id.startsWith('endroit/'))) {
      const manifest = JSON.parse(await readFile(join(entry.root, 'equipment.json'), 'utf8'))
      const origin = manifest.origin
      assert.equal(origin.requestedRef ?? origin.requested_ref, TARGET.sourceCommit)
      assert.equal(origin.resolvedCommit ?? origin.resolved_commit, TARGET.sourceCommit)
    }
    assert.deepEqual(await readFile(fixture.studioMarker), fixture.studioBytes)
    assert.equal(await pathExists(join(fixture.home, 'equipment', 'endroit', 'release')), false)
    assert.equal(await pathExists(fixture.retiredManifest), false)
    assert.equal(await pathExists(fixture.retiredCapability), false)
    assert.deepEqual(await readFile(fixture.retiredLocal), fixture.retiredLocalBytes)
    await buildHome(fixture.home, { check: true })

    const rollbackIo = captureIo()
    assert.equal(await runCli(['workplace', 'upgrade', '--rollback', applied.runId, '--workplace', fixture.home, '--json'], rollbackIo.io), 0, rollbackIo.stderr())
    assert.equal(JSON.parse(rollbackIo.stdout()).status, 'rolled-back')
    for (const [path, before] of fixture.before) {
      const current = await lstat(path)
      assert.equal(current.mode & 0o777, before.mode, path)
      assert.deepEqual(await readFile(path), before.bytes, path)
    }
    assert.equal(await pathExists(join(fixture.home, 'WORKPLACE.md')), false)
    assert.deepEqual(await readFile(fixture.studioMarker), fixture.studioBytes)
  } finally {
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

async function legacyFixture() {
  const temporary = await mkdtemp(join(tmpdir(), 'endroit-legacy-workplace-upgrade-'))
  const home = join(temporary, 'home')
  await createHome(home, { equipment: ['@endroit/publishing'] })
  const adoptedManifestPath = join(home, 'equipment', 'endroit', 'publishing', 'equipment.json')
  const adoptedManifest = JSON.parse(await readFile(adoptedManifestPath, 'utf8'))
  adoptedManifest.origin.baseDigests['runtime.mjs'] = `sha256:${'0'.repeat(64)}`
  await writeFile(adoptedManifestPath, `${JSON.stringify(adoptedManifest, null, 2)}\n`)
  const retiredSource = join(temporary, 'retired-source')
  await writeEquipment(retiredSource, equipment({
    name: 'endroit/retired',
    version: '0.9.0-alpha.0',
  }), { 'capabilities/review.md': '# Retired capability\n' })
  await addEquipment(home, [join(retiredSource, 'equipment.json')])
  const workplacePath = join(home, 'WORKPLACE.md')
  const homePath = join(home, 'HOME.md')
  const declarationPath = join(home, 'endroit.json')
  const deskPath = join(home, '.desk', 'DESK.md')
  const deskDeclarationPath = join(home, '.desk', 'desk.json')
  const memberPath = join(home, 'members', 'owner', 'MEMBER.md')
  await rm(workplacePath)
  await writeFile(declarationPath, `${JSON.stringify({
    $schema: 'https://endroit.org/schema/v7/home.json',
    name: 'legacy-studio',
    emoji: '🏠',
    runtime: '@endroit/cli@0.9.0-alpha.0',
    providers: ['codex', 'claude'],
    settings: { 'endroit/sites': { pinnedSites: [] } },
  }, null, 2)}\n`)
  await writeFile(homePath, [
    '# Legacy Studio',
    '',
    'Legacy constitution sentence.',
    '',
    '## Operating agreement',
    '',
    'Keep the human in charge.',
    '',
    ...Array.from({ length: 300 }, (_, index) => `- Historical guidance item ${index}.`),
    '',
  ].join('\n'))
  await writeFile(deskDeclarationPath, `${JSON.stringify({
    $schema: 'https://endroit.org/schema/v7/desk.json',
    id: 'local',
    member: 'owner',
    settings: { 'endroit/sites': { observedWorktrees: 'report' } },
  }, null, 2)}\n`)
  await writeFile(deskPath, '# Legacy Desk\n\nLegacy Desk guidance.\n')
  await writeFile(memberPath, [
    '---',
    '$schema: "https://endroit.org/schema/v7/member.json"',
    'id: "owner"',
    'name: "Legacy Owner"',
    'status: "active"',
    'accounts: []',
    '---',
    '',
    '# Legacy Owner',
    '',
    'Legacy Member context.',
    '',
  ].join('\n'))
  await chmod(homePath, 0o640)
  await chmod(deskPath, 0o600)
  await chmod(memberPath, 0o640)
  const studioMarker = join(home, 'equipment', 'studio', 'delivery', 'KEEP.md')
  const studioBytes = Buffer.from('Studio-owned and untouched.\n')
  await mkdir(dirname(studioMarker), { recursive: true })
  await writeFile(studioMarker, studioBytes)
  const retiredManifest = join(home, 'equipment', 'endroit', 'retired', 'equipment.json')
  const retiredCapability = join(home, 'equipment', 'endroit', 'retired', 'capabilities', 'review.md')
  const retiredLocal = join(home, 'equipment', 'endroit', 'retired', 'LOCAL.md')
  const retiredLocalBytes = Buffer.from('Unknown local file retained.\n')
  await writeFile(retiredLocal, retiredLocalBytes)
  const studioSource = join(temporary, 'studio-delivery-source')
  await addEquipment(home, [await writeEquipment(studioSource, equipment({
    name: 'studio/delivery',
    files: ['runtime.mjs'],
    capabilities: undefined,
    skills: undefined,
    commands: undefined,
    runtime: {
      namespace: 'delivery',
      entry: 'runtime.mjs',
      commands: [{ name: 'status', description: 'Inspect delivery state.' }],
    },
  }), { 'runtime.mjs': 'process.stdout.write("{}")\n' })])
  await rm(join(home, '.endroit', 'build.json'), { force: true })
  await exec('git', ['add', '--all'], { cwd: home })
  await exec('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '-m', 'fixture: legacy Workplace'], { cwd: home })
  const beforePaths = [
    declarationPath,
    homePath,
    deskDeclarationPath,
    deskPath,
    memberPath,
    studioMarker,
    join(home, 'equipment', 'endroit', 'workplace', 'equipment.json'),
    retiredManifest,
    retiredCapability,
    retiredLocal,
    join(home, 'AGENTS.md'),
    join(home, 'CLAUDE.md'),
    join(home, 'endroit.mjs'),
  ]
  const before = new Map()
  for (const path of beforePaths) {
    const info = await lstat(path)
    before.set(path, { bytes: await readFile(path), mode: info.mode & 0o777 })
  }
  return {
    temporary,
    home,
    studioMarker,
    studioBytes,
    retiredManifest,
    retiredCapability,
    retiredLocal,
    retiredLocalBytes,
    before,
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
