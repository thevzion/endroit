import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { createHome } from '../src/create.mjs'
import { initDesk } from '../src/desk.mjs'
import { removeTree } from '../src/lib/io.mjs'
import { dispatchRuntime } from '../src/runtime.mjs'
import { captureIo } from './helpers.mjs'

const exec = promisify(execFile)

test('Site worktrees are created, classified, discovered and adopted explicitly', async () => {
  const fixture = await siteFixture()
  try {
    const { home, repository, temporary } = fixture
    const sourceHead = await git(repository, ['rev-parse', 'HEAD'])
    await writeFile(join(repository, 'dirty.txt'), 'source-only\n')
    await git(repository, ['branch', 'existing', 'starting-point'])

    const existing = await runtimeJson(home, ['route', 'worktree', 'demo', '--id', 'existing-route', '--from', 'main', '--branch', 'existing'])
    assert.deepEqual(select(existing, ['site', 'route', 'branch', 'head', 'mode', 'checkout']), {
      site: 'demo',
      route: 'existing-route',
      branch: 'existing',
      head: await git(repository, ['rev-parse', 'starting-point']),
      mode: 'managed-worktree',
      checkout: 'linked-worktree',
    })

    const created = await runtimeJson(home, ['route', 'worktree', 'demo', '--id', 'new-route', '--from', 'main', '--new-branch', 'new-work', '--json'])
    assert.equal(created.head, sourceHead)
    assert.equal(created.path, join(await realpath(home), 'checkouts', 'demo', 'new-route'))
    assert.equal(await exists(join(created.path, 'dirty.txt')), false)

    const fromRef = await runtimeJson(home, ['route', 'worktree', 'demo', '--id', 'ref-route', '--from', 'main', '--new-branch', 'from-ref', '--start-point', 'starting-point'])
    assert.equal(fromRef.head, await git(repository, ['rev-parse', 'starting-point']))

    const listed = await runtimeJson(home, ['list'])
    const site = listed.sites.find((entry) => entry.id === 'demo')
    assert.deepEqual(
      site.routes.map(({ id, declared, observed }) => [id, declared.checkout.mode, observed.repository.checkout]),
      [
        ['existing-route', 'managed-worktree', 'linked-worktree'],
        ['main', 'existing', 'main'],
        ['new-route', 'managed-worktree', 'linked-worktree'],
        ['ref-route', 'managed-worktree', 'linked-worktree'],
      ],
    )
    assert.equal(site.worktrees.every((worktree) => worktree.registered), true)

    const external = join(temporary, 'external-worktree')
    await git(repository, ['worktree', 'add', '-b', 'external-work', external, 'HEAD'])
    const beforeRoute = await runtimeJson(home, ['list'])
    assert.deepEqual(
      select(beforeRoute.sites[0].worktrees.find((worktree) => worktree.branch === 'external-work'), ['registered', 'locked', 'prunable']),
      { registered: false, locked: false, prunable: false },
    )
    const doctor = await runtimeJson(home, ['doctor'])
    assert.ok(doctor.limits.includes('site-worktrees-unrouted:demo:1'))

    const hud = await runtimeJson(home, ['json'], 'hud')
    assert.equal(hud.attention.advisory.filter(({ code }) => code === 'site-worktrees-unrouted').length, 1)
    assert.match(hud.attention.advisory.find(({ code }) => code === 'site-worktrees-unrouted').message, /1 Git worktree/)

    const adopted = await runtimeJson(home, ['route', 'bind', 'demo', external, '--id', 'external'])
    assert.equal(adopted.mode, 'existing')
    assert.equal(adopted.checkout, 'linked-worktree')
    const afterRoute = await runtimeJson(home, ['list'])
    assert.equal(afterRoute.sites[0].worktrees.find((worktree) => worktree.branch === 'external-work').route, 'external')
    await runtimeJson(home, ['route', 'remove', 'demo', '--id', 'external'])
    assert.equal(await exists(external), true)

    for (const route of ['existing-route', 'new-route', 'ref-route']) {
      await runtimeJson(home, ['route', 'remove', 'demo', '--id', route, '--delete'])
    }
    assert.equal(await localBranch(repository, 'existing'), true)
    assert.equal(await localBranch(repository, 'new-work'), true)
    assert.equal(await localBranch(repository, 'from-ref'), true)
  } finally {
    await fixture.cleanup()
  }
})

test('Site worktree validation rejects ambiguous or unsafe creation without implicit Git effects', async () => {
  const fixture = await siteFixture()
  try {
    const { home, repository } = fixture
    await runtimeFailure(home, ['route', 'worktree', 'demo', '--id', 'none'], 'site_worktree_branch_mode')
    await runtimeFailure(home, ['route', 'worktree', 'demo', '--id', 'both', '--branch', 'main', '--new-branch', 'other'], 'site_worktree_branch_mode')
    await runtimeFailure(home, ['route', 'worktree', 'demo', '--id', 'missing', '--branch', 'missing'], 'site_branch_missing')
    await runtimeFailure(home, ['route', 'worktree', 'demo', '--id', 'used', '--branch', 'main'], 'site_branch_in_use')
    await runtimeFailure(home, ['route', 'worktree', 'demo', '--id', 'bad-start', '--new-branch', 'bad-start', '--start-point', 'unknown-local-ref'], 'site_start_point_missing')
    assert.equal(await localBranch(repository, 'bad-start'), false)

    const occupied = join(home, 'checkouts', 'demo', 'occupied')
    await mkdir(occupied, { recursive: true })
    await runtimeFailure(home, ['route', 'worktree', 'demo', '--id', 'occupied', '--from', 'main', '--new-branch', 'occupied-branch'], 'route_checkout_exists')
    assert.equal(await localBranch(repository, 'occupied-branch'), false)
    await removeTree(occupied)

    await runtimeJson(home, ['route', 'worktree', 'demo', '--id', 'second', '--new-branch', 'second', '--from', 'main'])
    await runtimeFailure(home, ['route', 'worktree', 'demo', '--id', 'ambiguous', '--new-branch', 'ambiguous'], 'route_ambiguous')
    assert.equal(await localBranch(repository, 'ambiguous'), false)
    await runtimeFailure(home, ['route', 'worktree', 'demo', '--id', 'existing-new', '--from', 'main', '--new-branch', 'second'], 'site_branch_exists')
    await runtimeJson(home, ['route', 'remove', 'demo', '--id', 'second', '--delete'])

    const forged = join(home, '.desk', 'routes', 'demo', 'forged.json')
    await writeFile(forged, `${JSON.stringify({
      $schema: 'https://endroit.org/schema/v7/route.json',
      id: 'forged',
      site: 'demo',
      mode: 'managed-clone',
      path: repository,
    }, null, 2)}\n`)
    await runtimeFailure(home, ['route', 'remove', 'demo', '--id', 'forged', '--delete'], 'route_path_invalid')
    assert.equal(await exists(join(repository, 'README.md')), true)
  } finally {
    await fixture.cleanup()
  }
})

test('managed clone and worktree deletion refuse symlink escapes and preserve external targets', async () => {
  const fixture = await siteFixture()
  try {
    const { home, temporary } = fixture
    const routes = [
      await runtimeJson(home, ['route', 'clone', 'demo', '--id', 'escaped-clone']),
      await runtimeJson(home, ['route', 'worktree', 'demo', '--id', 'escaped-worktree', '--from', 'main', '--new-branch', 'escaped-worktree']),
    ]
    for (const route of routes) {
      const external = join(temporary, `external-${route.route}`)
      await rename(route.path, external)
      await symlink(external, route.path, 'dir')

      await runtimeFailure(home, ['route', 'remove', 'demo', '--id', route.route, '--delete'], 'route_checkout_symlink')
      assert.equal(await readFile(join(external, 'README.md'), 'utf8'), '# second\n')
      assert.equal((await lstat(route.path)).isSymbolicLink(), true)
      assert.equal(await exists(join(home, `.desk/routes/demo/${route.route}.json`)), true)
    }
  } finally {
    await fixture.cleanup()
  }
})

test('Site unbind preserves dirty, locked, prunable, dependent and submodule worktrees', async () => {
  const fixture = await siteFixture()
  try {
    const { home, repository, temporary } = fixture

    const dirty = await runtimeJson(home, ['route', 'worktree', 'demo', '--id', 'dirty', '--new-branch', 'dirty-work'])
    await writeFile(join(dirty.path, 'change.txt'), 'dirty\n')
    assert.ok((await runtimeJson(home, ['doctor'])).limits.includes('route-dirty:demo:dirty'))
    await runtimeFailure(home, ['route', 'remove', 'demo', '--id', 'dirty', '--delete'], 'route_dirty')
    assert.equal(await exists(dirty.path), true)
    await rm(join(dirty.path, 'change.txt'))
    await runtimeJson(home, ['route', 'remove', 'demo', '--id', 'dirty', '--delete'])
    assert.equal(await localBranch(repository, 'dirty-work'), true)

    const locked = await runtimeJson(home, ['route', 'worktree', 'demo', '--id', 'locked', '--new-branch', 'locked-work'])
    await git(repository, ['worktree', 'lock', locked.path])
    await runtimeFailure(home, ['route', 'remove', 'demo', '--id', 'locked', '--delete'], 'site_worktree_locked')
    assert.ok((await runtimeJson(home, ['doctor'])).limits.some((limit) => limit.startsWith('site-worktree-locked:demo:')))
    assert.match(await git(repository, ['worktree', 'list', '--porcelain']), /locked/)
    await git(repository, ['worktree', 'unlock', locked.path])
    await runtimeJson(home, ['route', 'remove', 'demo', '--id', 'locked', '--delete'])

    const cloned = await runtimeJson(home, ['route', 'clone', 'demo', '--id', 'clone'])
    assert.equal(cloned.checkout, 'main')
    await runtimeJson(home, ['route', 'worktree', 'demo', '--id', 'clone-worktree', '--from', 'clone', '--new-branch', 'clone-work'])
    await runtimeFailure(home, ['route', 'remove', 'demo', '--id', 'clone', '--delete'], 'site_clone_has_worktrees')
    await runtimeJson(home, ['route', 'remove', 'demo', '--id', 'clone-worktree', '--delete'])
    await runtimeJson(home, ['route', 'remove', 'demo', '--id', 'clone', '--delete'])

    const prunable = await runtimeJson(home, ['route', 'worktree', 'demo', '--id', 'prunable', '--new-branch', 'prunable-work'])
    await removeTree(prunable.path)
    const doctor = await runtimeJson(home, ['doctor'])
    assert.ok(doctor.limits.some((limit) => limit.startsWith('site-worktree-prunable:demo:')))
    assert.equal((await runtimeJson(home, ['list'])).sites[0].worktrees.find((worktree) => worktree.branch === 'prunable-work').prunable, true)
    assert.match(await git(repository, ['worktree', 'list', '--porcelain']), /prunable/)
    await runtimeFailure(home, ['route', 'remove', 'demo', '--id', 'prunable', '--delete'], 'route_broken')
    await git(repository, ['worktree', 'prune'])

    const module = join(temporary, 'module')
    await gitInit(module)
    await writeFile(join(module, 'module.txt'), 'module\n')
    await commit(module, 'module')
    await exec('git', ['-c', 'protocol.file.allow=always', 'submodule', 'add', '--quiet', module, 'modules/demo'], { cwd: repository })
    await commit(repository, 'add submodule')
    const submodule = await runtimeJson(home, ['route', 'worktree', 'demo', '--id', 'submodule', '--from', 'main', '--new-branch', 'submodule-work'])
    await exec('git', ['-c', 'protocol.file.allow=always', 'submodule', 'update', '--init', '--quiet'], { cwd: submodule.path })
    await runtimeFailure(home, ['route', 'remove', 'demo', '--id', 'submodule', '--delete'], 'git_failed')
    assert.equal(await exists(submodule.path), true)
    await git(repository, ['worktree', 'remove', '--force', submodule.path])
  } finally {
    await fixture.cleanup()
  }
})

test('Sites can stay remote-only while different Desks own independent Routes', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'endroit-site-desks-'))
  const home = join(temporary, 'home')
  const first = join(temporary, 'first')
  const second = join(temporary, 'second')
  try {
    await createHome(home, { deskStrategy: 'later' })
    await gitInit(first)
    await writeFile(join(first, 'README.md'), '# first\n')
    await commit(first, 'first')
    await git(first, ['remote', 'add', 'origin', 'https://github.com/example/product.git'])
    await gitInit(second)
    await writeFile(join(second, 'README.md'), '# second\n')
    await commit(second, 'second')
    await git(second, ['remote', 'add', 'origin', 'https://github.com/example/product.git'])

    await runtimeJson(home, ['add', 'https://github.com/example/product.git', '--id', 'product'])
    assert.equal((await runtimeJson(home, ['list'])).sites[0].state, 'declared')
    await initDesk(home, { id: 'one', member: 'owner', repository: 'tracked' })
    await runtimeJson(home, ['route', 'bind', 'product', first, '--id', 'local'])
    const firstDesk = join(temporary, 'desk-one')
    await rename(join(home, '.desk'), firstDesk)

    await initDesk(home, { id: 'two', member: 'owner', repository: 'tracked' })
    await runtimeJson(home, ['route', 'bind', 'product', second, '--id', 'local'])
    assert.equal(JSON.parse(await readFile(join(firstDesk, 'routes/product/local.json'), 'utf8')).checkout.path, await realpath(first))
    assert.equal(JSON.parse(await readFile(join(home, '.desk/routes/product/local.json'), 'utf8')).checkout.path, await realpath(second))
    assert.match(await readFile(join(home, 'sites/product/SITE.md'), 'utf8'), /repository: "github.com\/example\/product"/)
  } finally {
    await removeTree(temporary, { force: true })
  }
})

test('an existing Route can expose and remove a reconstructible Mount without touching its checkout', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'endroit-site-mount-'))
  const home = join(temporary, 'home')
  const repository = join(temporary, 'repository')
  const moved = join(temporary, 'repository-moved')
  try {
    await createHome(home)
    await gitInit(repository)
    await writeFile(join(repository, 'README.md'), '# mounted\n')
    await commit(repository, 'mounted')
    await runtimeJson(home, ['add', repository, '--id', 'demo'])

    const mounted = await runtimeJson(home, ['route', 'mount', 'demo'])
    assert.equal(mounted.path, join(await realpath(home), 'checkouts', 'demo', 'main'))
    assert.equal((await lstat(mounted.path)).isSymbolicLink(), true)
    assert.equal(await realpath(mounted.path), await realpath(repository))
    assert.equal((await runtimeJson(home, ['route', 'mount', 'demo'])).status, 'mounted')
    assert.equal((await runtimeJson(home, ['doctor'])).limits.some((limit) => limit.startsWith('route-mount-')), false)
    await runtimeFailure(home, ['route', 'remove', 'demo'], 'route_mount_exists')

    await rename(repository, moved)
    assert.ok((await runtimeJson(home, ['doctor'])).limits.includes('route-mount-broken:demo:main'))
    await runtimeJson(home, ['route', 'unmount', 'demo'])
    assert.equal(await pathExists(mounted.path), false)
    assert.equal(await exists(join(moved, 'README.md')), true)
    await mkdir(join(home, 'checkouts', 'demo'), { recursive: true })
    await symlink(moved, mounted.path, 'dir')
    assert.equal((await runtimeJson(home, ['checkout', 'inspect', 'checkout:demo/main'])).observed.mount.status, 'divergent')
    await rm(mounted.path)
    await mkdir(mounted.path)
    assert.equal((await runtimeJson(home, ['checkout', 'inspect', 'checkout:demo/main'])).observed.mount.status, 'conflict')
    await rm(mounted.path, { recursive: true })
    await rename(moved, repository)
    const direct = join(home, 'checkouts', 'demo', 'direct')
    await exec('git', ['clone', '--quiet', repository, direct])
    await runtimeJson(home, ['route', 'bind', 'demo', direct, '--id', 'direct'])
    assert.equal((await runtimeJson(home, ['checkout', 'inspect', 'checkout:demo/direct'])).observed.mount.status, 'direct')
    await runtimeJson(home, ['route', 'remove', 'demo', '--id', 'direct'])
    await removeTree(direct)
    await runtimeJson(home, ['route', 'remove', 'demo'])
    assert.equal(await exists(join(repository, 'README.md')), true)
  } finally {
    await removeTree(temporary, { force: true })
  }
})

test('Doctor diagnoses conflicted Checkouts without treating lifecycle as routability', async () => {
  const fixture = await siteFixture()
  try {
    const { home, repository } = fixture
    await git(repository, ['branch', 'conflict-work'])
    const route = await runtimeJson(home, ['route', 'worktree', 'demo', '--id', 'conflict', '--from', 'main', '--branch', 'conflict-work'])
    await writeFile(join(repository, 'README.md'), '# main change\n')
    await commit(repository, 'main change')
    await writeFile(join(route.path, 'README.md'), '# route change\n')
    await commit(route.path, 'route change')
    await assert.rejects(git(route.path, ['merge', 'main']))
    const doctor = await runtimeJson(home, ['doctor'])
    assert.ok(doctor.limits.includes('route-conflicts:demo:conflict'))
    assert.ok(doctor.limits.includes('route-dirty:demo:conflict'))
    await runtimeJson(home, ['route', 'park', 'demo', '--id', 'conflict'])
    const inactiveDoctor = await runtimeJson(home, ['doctor'])
    assert.ok(inactiveDoctor.limits.includes('route-conflicts:demo:conflict'))
    assert.equal(inactiveDoctor.sites[0].state, 'routed')
  } finally {
    await fixture.cleanup()
  }
})

test('a submodule is recognized as a Route without Endroit managing its lifecycle', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'endroit-site-submodule-'))
  const home = join(temporary, 'home')
  const parent = join(temporary, 'parent')
  const child = join(temporary, 'child')
  try {
    await createHome(home)
    await gitInit(child)
    await writeFile(join(child, 'README.md'), '# child\n')
    await commit(child, 'child')
    await git(child, ['remote', 'add', 'origin', 'https://github.com/example/child.git'])
    await gitInit(parent)
    await writeFile(join(parent, 'README.md'), '# parent\n')
    await commit(parent, 'parent')
    await exec('git', ['-c', 'protocol.file.allow=always', 'submodule', 'add', '--quiet', child, 'sites/child'], { cwd: parent })
    const submodule = join(parent, 'sites', 'child')
    await git(submodule, ['remote', 'set-url', 'origin', 'https://github.com/example/child.git'])
    await runtimeJson(home, ['add', 'https://github.com/example/child.git', '--id', 'child'])
    const route = await runtimeJson(home, ['route', 'bind', 'child', submodule, '--id', 'module'])
    assert.equal(route.mode, 'submodule')
    await exec('git', ['submodule', 'deinit', '--force', 'sites/child'], { cwd: parent })
    await rm(submodule, { recursive: true, force: true })
    await mkdir(submodule)
    const readmeBefore = await pathExists(join(submodule, 'README.md'))
    const inspected = await runtimeJson(home, ['checkout', 'inspect', 'checkout:child/module'])
    assert.equal(inspected.declared.checkout.mode, 'submodule')
    assert.equal(inspected.observed.repository.available, false)
    assert.equal(await pathExists(join(submodule, 'README.md')), readmeBefore)
    await runtimeJson(home, ['route', 'remove', 'child', '--id', 'module'])
    assert.equal(await exists(submodule), true)
  } finally {
    await removeTree(temporary, { force: true })
  }
})

test('Route lifecycle changes only metadata and inactive Checkouts leave implicit selection', async () => {
  const fixture = await siteFixture()
  try {
    const { home, repository } = fixture
    const secondary = await runtimeJson(home, ['route', 'worktree', 'demo', '--id', 'feature--checkout-v8', '--from', 'main', '--new-branch', 'feature/checkout-v8'])
    const before = {
      path: await realpath(repository),
      inode: (await lstat(repository)).ino,
      head: await git(repository, ['rev-parse', 'HEAD']),
      dirty: await git(repository, ['status', '--porcelain=v2', '--untracked-files=all']),
      secondaryHead: await git(secondary.path, ['rev-parse', 'HEAD']),
    }

    assert.equal((await runtimeJson(home, ['route', 'park', 'demo', '--id', 'main'])).status, 'parked')
    const implicit = await runtimeJson(home, ['route', 'inspect', 'demo'])
    assert.equal(implicit.route, 'feature--checkout-v8')
    await runtimeFailure(home, ['route', 'worktree', 'demo', '--id', 'inactive-source', '--from', 'main', '--new-branch', 'inactive/source'], 'route_inactive')
    await runtimeFailure(home, ['route', 'mount', 'demo', '--id', 'main'], 'route_inactive')
    assert.equal((await runtimeJson(home, ['route', 'activate', 'demo'])).route, 'main')
    await runtimeFailure(home, ['route', 'inspect', 'demo'], 'route_ambiguous')
    assert.equal((await runtimeJson(home, ['route', 'supersede', 'demo', '--id', 'main', '--by', 'feature--checkout-v8'])).status, 'superseded')
    await runtimeFailure(home, ['route', 'remove', 'demo', '--id', 'feature--checkout-v8', '--delete'], 'route_supersession_target')

    const listed = await runtimeJson(home, ['checkout', 'list', 'demo'])
    assert.deepEqual(listed.checkouts.map(({ ref, declared }) => [ref, declared.status]), [
      ['checkout:demo/feature--checkout-v8', 'active'],
      ['checkout:demo/main', 'superseded'],
    ])
    const inspected = await runtimeJson(home, ['checkout', 'inspect', 'checkout:demo/main'])
    assert.equal(inspected.declared.supersededBy, 'feature--checkout-v8')
    assert.equal(inspected.observed.repository.available, true)
    assert.equal(inspected.observed.repository.commonGitDir, listed.checkouts[0].observed.repository.commonGitDir)
    assert.notEqual(inspected.observed.repository.gitDir, listed.checkouts[0].observed.repository.gitDir)

    assert.deepEqual({
      path: await realpath(repository),
      inode: (await lstat(repository)).ino,
      head: await git(repository, ['rev-parse', 'HEAD']),
      dirty: await git(repository, ['status', '--porcelain=v2', '--untracked-files=all']),
      secondaryHead: await git(secondary.path, ['rev-parse', 'HEAD']),
    }, before)
  } finally {
    await fixture.cleanup()
  }
})

test('Checkout observation rejects duplicate gitDir but permits a shared commonGitDir', async () => {
  const fixture = await siteFixture()
  try {
    const { home, repository } = fixture
    await runtimeFailure(home, ['route', 'bind', 'demo', repository, '--id', 'duplicate'], 'checkout_duplicate_git_dir')
    const aliasRoot = join(home, 'sites', 'alias')
    await mkdir(aliasRoot)
    await writeFile(join(aliasRoot, 'SITE.md'), (await readFile(join(home, 'sites/demo/SITE.md'), 'utf8')).replace('id: "demo"', 'id: "alias"').replace('# demo', '# alias'))
    await runtimeFailure(home, ['route', 'bind', 'alias', repository, '--id', 'main'], 'checkout_duplicate_git_dir')
    await runtimeJson(home, ['route', 'worktree', 'demo', '--id', 'review--shared', '--from', 'main', '--new-branch', 'review/shared'])
    const checkouts = (await runtimeJson(home, ['checkout', 'list', 'demo'])).checkouts
    assert.equal(new Set(checkouts.map((entry) => entry.observed.repository.gitDir)).size, 2)
    assert.equal(new Set(checkouts.map((entry) => entry.observed.repository.commonGitDir)).size, 1)
  } finally {
    await fixture.cleanup()
  }
})

test('a Site with only inactive Routes is unrouted until its unique parked Route is activated', async () => {
  const fixture = await siteFixture()
  try {
    const { home } = fixture
    await runtimeJson(home, ['route', 'park', 'demo'])
    assert.equal((await runtimeJson(home, ['list'])).sites[0].state, 'unrouted')
    const hud = await runtimeJson(home, ['json'], 'hud')
    assert.equal(hud.sites[0].state, 'unrouted')
    assert.equal(hud.attention.warning.some((entry) => entry.code === 'site-unrouted'), true)
    await runtimeFailure(home, ['route', 'inspect', 'demo'], 'site_unrouted')
    assert.equal((await runtimeJson(home, ['route', 'activate', 'demo'])).status, 'activated')
    assert.equal((await runtimeJson(home, ['list'])).sites[0].state, 'routed')
  } finally {
    await fixture.cleanup()
  }
})

test('v7 and v8 Route declarations have parity through Sites, HUD and Artifacts', async () => {
  const fixture = await siteFixture()
  try {
    const { home, repository } = fixture
    const siteV8 = (await runtimeJson(home, ['list'])).sites[0].routes[0]
    const hudV8 = (await runtimeJson(home, ['json'], 'hud')).sites[0].routes[0]
    const artifactsV8 = await runtimeJson(home, ['list', '--json'], 'artifact')
    assert.equal(siteV8.declaration, 'routes/demo/main.json')

    await writeFile(join(home, '.desk/routes/demo/main.json'), `${JSON.stringify({
      $schema: 'https://endroit.org/schema/v7/route.json',
      id: 'main',
      site: 'demo',
      mode: 'existing',
      path: await realpath(repository),
      branch: 'main',
    }, null, 2)}\n`)

    const siteV7 = (await runtimeJson(home, ['list'])).sites[0].routes[0]
    const hudV7 = (await runtimeJson(home, ['json'], 'hud')).sites[0].routes[0]
    const artifactsV7 = await runtimeJson(home, ['list', '--json'], 'artifact')
    assert.deepEqual(siteV7.declared, siteV8.declared)
    assert.deepEqual(hudV7.declared, hudV8.declared)
    assert.equal(siteV7.observed.repository.available, siteV8.observed.repository.available)
    assert.deepEqual(artifactsV7.artifacts, artifactsV8.artifacts)
  } finally {
    await fixture.cleanup()
  }
})

test('Route migration checks without effect and rollback preserves Git and Mount invariants', async () => {
  const fixture = await siteFixture()
  try {
    const { home, repository } = fixture
    const routePath = join(home, '.desk/routes/demo/main.json')
    const original = Buffer.from(`${JSON.stringify({
      $schema: 'https://endroit.org/schema/v7/route.json',
      id: 'main',
      site: 'demo',
      mode: 'existing',
      path: await realpath(repository),
      branch: 'main',
    }, null, 2)}\n`)
    await writeFile(routePath, original)
    await chmod(routePath, 0o640)
    await writeFile(join(repository, 'dirty.txt'), 'preserve me\n')
    const mounted = await runtimeJson(home, ['route', 'mount', 'demo'])
    const invariant = await checkoutInvariant(repository, mounted.path)
    const migrationsRoot = join(home, '.endroit/migrations/checkout-v8')

    const checked = await runtimeJson(home, ['route', 'migrate', 'demo', '--check'])
    assert.equal(checked.status, 'checked')
    assert.equal(checked.readOnly, true)
    assert.equal(checked.changes, 1)
    assert.deepEqual(await readFile(routePath), original)
    assert.equal(await pathExists(migrationsRoot), false)
    assert.deepEqual(await checkoutInvariant(repository, mounted.path), invariant)

    const migrated = await runtimeJson(home, ['route', 'migrate', 'demo'])
    assert.equal(migrated.status, 'migrated')
    assert.equal(migrated.changes, 1)
    assert.equal((await lstat(routePath)).mode & 0o777, 0o640)
    const v8 = JSON.parse(await readFile(routePath, 'utf8'))
    assert.equal(v8.$schema, 'https://endroit.org/schema/v8/route.json')
    assert.deepEqual(v8.checkout, { mode: 'existing', path: await realpath(repository), expectedBranch: 'main' })
    assert.equal('sourceRoute' in v8, false)
    const journalPath = join(migrationsRoot, migrated.runId, 'journal.json')
    const journal = await readFile(journalPath, 'utf8')
    assert.doesNotMatch(journal, /"(?:head|dirty|clean|gitDir|commonGitDir)"/)
    assert.equal(JSON.parse(journal).status, 'applied')
    assert.deepEqual(JSON.parse(journal).routes.map(({ progress }) => progress), ['after'])
    assert.deepEqual(await checkoutInvariant(repository, mounted.path), invariant)
    await runtimeFailure(home, ['route', 'migrate', 'demo', '--rollback', migrated.runId], 'usage')

    const appliedBytes = await readFile(routePath)
    await writeFile(routePath, `${JSON.stringify({ ...v8, status: 'parked' }, null, 2)}\n`)
    assert.notEqual(createHash('sha256').update(await readFile(routePath)).digest('hex'), JSON.parse(journal).routes[0].afterSha256)
    await runtimeFailure(home, ['route', 'migrate', '--rollback', migrated.runId], 'route_rollback_drift')
    await writeFile(routePath, appliedBytes)
    const rolledBack = await runtimeJson(home, ['route', 'migrate', '--rollback', migrated.runId])
    assert.equal(rolledBack.status, 'rolled-back')
    assert.deepEqual(await readFile(routePath), original)
    assert.equal((await lstat(routePath)).mode & 0o777, 0o640)
    const completedJournal = JSON.parse(await readFile(journalPath, 'utf8'))
    assert.equal(completedJournal.status, 'rolled-back')
    assert.deepEqual(completedJournal.routes.map(({ progress }) => progress), ['original'])
    assert.deepEqual(
      await runtimeJson(home, ['route', 'migrate', '--rollback', migrated.runId]),
      { status: 'current', runId: migrated.runId, changes: 0, routes: [] },
    )
    assert.deepEqual(await checkoutInvariant(repository, mounted.path), invariant)
  } finally {
    await fixture.cleanup()
  }
})

test('Route migration filters one Site or Route and drops legacy worktree sourceRoute metadata', async () => {
  const fixture = await siteFixture()
  try {
    const { home, repository, temporary } = fixture
    const legacy = await legacyRouteSet(home, repository)
    const otherRepository = join(temporary, 'other-repository')
    await gitInit(otherRepository)
    await writeFile(join(otherRepository, 'README.md'), '# other\n')
    await commit(otherRepository, 'other')
    await runtimeJson(home, ['add', otherRepository, '--id', 'other'])
    const otherPath = join(home, '.desk/routes/other/main.json')
    await writeLegacyRoute(otherPath, {
      $schema: 'https://endroit.org/schema/v7/route.json',
      id: 'main',
      site: 'other',
      mode: 'existing',
      path: await realpath(otherRepository),
      branch: 'main',
    })

    assert.equal((await runtimeJson(home, ['route', 'migrate', '--check'])).changes, 3)
    assert.equal((await runtimeJson(home, ['route', 'migrate', 'demo', '--check'])).changes, 2)
    assert.equal((await runtimeJson(home, ['route', 'migrate', 'demo', '--id', 'main', '--check'])).changes, 1)

    const migrated = await runtimeJson(home, ['route', 'migrate', 'demo', '--id', legacy.worktree.id])
    assert.equal(migrated.changes, 1)
    const worktreeV8 = JSON.parse(await readFile(legacy.worktree.path, 'utf8'))
    assert.deepEqual(worktreeV8.checkout, { mode: 'managed-worktree', expectedBranch: legacy.worktree.branch })
    assert.equal('path' in worktreeV8.checkout, false)
    assert.equal('sourceRoute' in worktreeV8, false)
    assert.equal(JSON.parse(await readFile(legacy.main.path, 'utf8')).$schema, 'https://endroit.org/schema/v7/route.json')
    assert.equal(JSON.parse(await readFile(otherPath, 'utf8')).$schema, 'https://endroit.org/schema/v7/route.json')
  } finally {
    await fixture.cleanup()
  }
})

test('Route migration rollback resumes prepared, applying and rolling-back multi-Route runs under one lock', async () => {
  const fixture = await siteFixture()
  try {
    const { home, repository, temporary } = fixture
    await legacyRouteSet(home, repository)

    const prepared = await runtimeJson(home, ['route', 'migrate', 'demo'])
    const preparedRun = await migrationRun(home, prepared.runId)
    for (const entry of preparedRun.journal.routes) await restoreMigrationOriginal(home, preparedRun.root, entry)
    await rewriteMigrationJournal(preparedRun, 'prepared', () => 'original')
    const preparedRecovery = await runtimeJson(home, ['route', 'migrate', '--rollback', prepared.runId])
    assert.equal(preparedRecovery.status, 'rolled-back')
    assert.equal(preparedRecovery.changes, 0)

    const applying = await runtimeJson(home, ['route', 'migrate', 'demo'])
    const applyingRun = await migrationRun(home, applying.runId)
    await restoreMigrationOriginal(home, applyingRun.root, applyingRun.journal.routes[0])
    await rewriteMigrationJournal(applyingRun, 'applying', (_entry, index) => index === 0 ? 'original' : 'after')
    const applyingRecovery = await runtimeJson(home, ['route', 'migrate', '--rollback', applying.runId])
    assert.equal(applyingRecovery.status, 'rolled-back')
    assert.equal(applyingRecovery.changes, applyingRun.journal.routes.length - 1)
    assert.equal((await migrationRun(home, applying.runId)).journal.status, 'rolled-back')

    const rollingBack = await runtimeJson(home, ['route', 'migrate', 'demo'])
    const rollingBackRun = await migrationRun(home, rollingBack.runId)
    await restoreMigrationOriginal(home, rollingBackRun.root, rollingBackRun.journal.routes[0])
    await rewriteMigrationJournal(rollingBackRun, 'rolling-back', (_entry, index) => index === 0 ? 'original' : 'after')
    const rollbackRecovery = await runtimeJson(home, ['route', 'migrate', '--rollback', rollingBack.runId])
    assert.equal(rollbackRecovery.status, 'rolled-back')
    assert.equal(rollbackRecovery.changes, rollingBackRun.journal.routes.length - 1)
    assert.deepEqual((await migrationRun(home, rollingBack.runId)).journal.routes.map(({ progress }) => progress), ['original', 'original'])

    const lockRoot = join(home, '.endroit/migrations/checkout-v8')
    const lockPath = join(lockRoot, '.lock')
    await writeFile(lockPath, `${JSON.stringify({ pid: process.pid })}\n`, { flag: 'wx' })
    const beforeLock = await readFile(join(home, '.desk/routes/demo/main.json'))
    await runtimeFailure(home, ['route', 'migrate', 'demo'], 'route_migration_locked')
    assert.deepEqual(await readFile(join(home, '.desk/routes/demo/main.json')), beforeLock)
    await rm(lockPath)

    await writeFile(lockPath, `${JSON.stringify({ pid: 2147483647 })}\n`, { flag: 'wx' })
    const staleRecovered = await runtimeJson(home, ['route', 'migrate', 'demo'])
    assert.equal(staleRecovered.status, 'migrated')
    await runtimeJson(home, ['route', 'migrate', '--rollback', staleRecovered.runId])

    const corrupt = await runtimeJson(home, ['route', 'migrate', 'demo'])
    const corruptRun = await migrationRun(home, corrupt.runId)
    const originalRoot = join(corruptRun.root, 'originals')
    const originalSite = join(originalRoot, corruptRun.journal.routes[0].site)
    const external = join(temporary, 'forged-originals')
    await mkdir(external)
    await rm(originalSite, { recursive: true })
    await symlink(external, originalSite, 'dir')
    await runtimeFailure(home, ['route', 'migrate', '--rollback', corrupt.runId], 'route_rollback_corrupt')
    await runtimeFailure(home, ['route', 'migrate', '--rollback', 'missing-run'], 'route_migration_missing')
  } finally {
    await fixture.cleanup()
  }
})

async function legacyRouteSet(home, repository) {
  await runtimeJson(home, ['route', 'worktree', 'demo', '--id', 'legacy-worktree', '--from', 'main', '--new-branch', 'legacy-worktree'])
  const main = {
    id: 'main',
    path: join(home, '.desk/routes/demo/main.json'),
    document: {
      $schema: 'https://endroit.org/schema/v7/route.json',
      id: 'main',
      site: 'demo',
      mode: 'existing',
      path: await realpath(repository),
      branch: 'main',
    },
  }
  const worktree = {
    id: 'legacy-worktree',
    branch: 'legacy-worktree',
    path: join(home, '.desk/routes/demo/legacy-worktree.json'),
    document: {
      $schema: 'https://endroit.org/schema/v7/route.json',
      id: 'legacy-worktree',
      site: 'demo',
      mode: 'managed-worktree',
      path: 'checkouts/demo/legacy-worktree',
      branch: 'legacy-worktree',
      sourceRoute: 'main',
    },
  }
  await writeLegacyRoute(main.path, main.document)
  await writeLegacyRoute(worktree.path, worktree.document)
  return { main, worktree }
}

async function writeLegacyRoute(path, document, mode = 0o600) {
  const bytes = Buffer.from(`${JSON.stringify(document, null, 2)}\n`)
  await writeFile(path, bytes)
  await chmod(path, mode)
  return bytes
}

async function migrationRun(home, runId) {
  const root = join(home, '.endroit/migrations/checkout-v8', runId)
  const journalPath = join(root, 'journal.json')
  return { root, journalPath, journal: JSON.parse(await readFile(journalPath, 'utf8')) }
}

async function restoreMigrationOriginal(home, root, entry) {
  await writeFile(join(home, entry.declaration), await readFile(join(root, entry.original)))
  await chmod(join(home, entry.declaration), entry.mode)
}

async function rewriteMigrationJournal(run, status, progress) {
  run.journal = {
    ...run.journal,
    status,
    routes: run.journal.routes.map((entry, index) => ({ ...entry, progress: progress(entry, index) })),
  }
  await writeFile(run.journalPath, `${JSON.stringify(run.journal, null, 2)}\n`)
}

async function siteFixture() {
  const temporary = await mkdtemp(join(tmpdir(), 'endroit-site-worktrees-'))
  const home = join(temporary, 'home')
  const repository = join(temporary, 'repository')
  const remote = join(temporary, 'remote.git')
  await createHome(home)
  await exec('git', ['init', '--quiet', '--bare', remote])
  await gitInit(repository)
  await writeFile(join(repository, 'README.md'), '# first\n')
  await commit(repository, 'first')
  await git(repository, ['tag', 'starting-point'])
  await writeFile(join(repository, 'README.md'), '# second\n')
  await commit(repository, 'second')
  await git(repository, ['remote', 'add', 'origin', remote])
  await git(repository, ['push', '--quiet', '-u', 'origin', 'main'])
  await git(remote, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
  await runtimeJson(home, ['add', repository, '--id', 'demo'])
  return {
    home,
    repository,
    remote,
    temporary,
    cleanup: () => removeTree(temporary, { force: true }),
  }
}

async function gitInit(path) {
  await exec('git', ['init', '--quiet', '--initial-branch=main', path])
  await git(path, ['config', 'user.name', 'Test'])
  await git(path, ['config', 'user.email', 'test@example.com'])
}

async function commit(path, message) {
  await git(path, ['add', '--all'])
  await git(path, ['commit', '--quiet', '-m', message])
}

async function git(cwd, args) {
  return (await exec('git', args, { cwd })).stdout.trim()
}

async function runtimeJson(home, args, namespace = 'site') {
  const output = captureIo()
  const argv = namespace === 'site' && !args.includes('--json') ? [...args, '--json'] : args
  assert.equal(await dispatchRuntime(home, namespace, argv, output.io), 0, output.stderr())
  return JSON.parse(output.stdout())
}

async function runtimeFailure(home, args, code) {
  const output = captureIo()
  let thrown
  let exitCode
  try {
    exitCode = await dispatchRuntime(home, 'site', args, output.io)
  } catch (error) {
    thrown = error
  }
  if (thrown) assert.equal(thrown.code, code)
  else {
    assert.notEqual(exitCode, 0)
    assert.match(output.stderr(), new RegExp(code))
  }
}

async function localBranch(repository, branch) {
  try {
    await git(repository, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])
    return true
  } catch {
    return false
  }
}

async function exists(path) {
  try {
    await readFile(path)
    return true
  } catch (error) {
    if (error.code === 'EISDIR') return true
    if (error.code === 'ENOENT') return false
    throw error
  }
}

async function pathExists(path) {
  try { await lstat(path); return true } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

async function checkoutInvariant(repository, mount) {
  const repositoryInfo = await lstat(repository)
  const mountInfo = await lstat(mount)
  return {
    path: await realpath(repository),
    dev: repositoryInfo.dev,
    ino: repositoryInfo.ino,
    head: await git(repository, ['rev-parse', 'HEAD']),
    status: await git(repository, ['status', '--porcelain=v2', '--branch', '--untracked-files=all']),
    mountSymlink: mountInfo.isSymbolicLink(),
    mountTarget: await realpath(mount),
  }
}

function select(value, keys) {
  return Object.fromEntries(keys.map((key) => [key, value[key]]))
}
