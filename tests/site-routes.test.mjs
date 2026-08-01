import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
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
    assert.deepEqual(select(existing, ['site', 'route', 'branch', 'head', 'sourceRoute', 'mode', 'checkout']), {
      site: 'demo',
      route: 'existing-route',
      branch: 'existing',
      head: await git(repository, ['rev-parse', 'starting-point']),
      sourceRoute: 'main',
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
      site.routes.map(({ id, mode, evidence }) => [id, mode, evidence.checkout]),
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
      $schema: 'https://endroit.org/schema/route.json',
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
    assert.equal(JSON.parse(await readFile(join(firstDesk, 'routes/product/local.json'), 'utf8')).path, await realpath(first))
    assert.equal(JSON.parse(await readFile(join(home, '.desk/routes/product/local.json'), 'utf8')).path, await realpath(second))
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
    await runtimeFailure(home, ['route', 'remove', 'demo'], 'route_mount_exists')

    await rename(repository, moved)
    assert.ok((await runtimeJson(home, ['doctor'])).limits.includes('route-mount-broken:demo:main'))
    await runtimeJson(home, ['route', 'unmount', 'demo'])
    assert.equal(await pathExists(mounted.path), false)
    assert.equal(await exists(join(moved, 'README.md')), true)
    await rename(moved, repository)
    await runtimeJson(home, ['route', 'remove', 'demo'])
    assert.equal(await exists(join(repository, 'README.md')), true)
  } finally {
    await removeTree(temporary, { force: true })
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
    await runtimeJson(home, ['route', 'remove', 'child', '--id', 'module'])
    assert.equal(await exists(submodule), true)
  } finally {
    await removeTree(temporary, { force: true })
  }
})

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
  assert.notEqual(await dispatchRuntime(home, 'site', args, output.io), 0)
  assert.match(output.stderr(), new RegExp(code))
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

function select(value, keys) {
  return Object.fromEntries(keys.map((key) => [key, value[key]]))
}
