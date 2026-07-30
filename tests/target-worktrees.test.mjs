import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { createHome } from '../src/create.mjs'
import { removeTree } from '../src/lib/io.mjs'
import { dispatchRuntime } from '../src/runtime.mjs'
import { captureIo } from './helpers.mjs'

const exec = promisify(execFile)

test('Target worktrees are created, classified, discovered and adopted explicitly', async () => {
  const fixture = await targetFixture()
  try {
    const { home, repository, temporary } = fixture
    const sourceHead = await git(repository, ['rev-parse', 'HEAD'])
    await writeFile(join(repository, 'dirty.txt'), 'source-only\n')
    await git(repository, ['branch', 'existing', 'starting-point'])

    const existing = await runtimeJson(home, ['worktree', 'demo', '--binding', 'existing-binding', '--from-binding', 'main', '--branch', 'existing'])
    assert.deepEqual(select(existing, ['target', 'binding', 'branch', 'head', 'sourceBinding', 'type', 'checkout']), {
      target: 'demo',
      binding: 'existing-binding',
      branch: 'existing',
      head: await git(repository, ['rev-parse', 'starting-point']),
      sourceBinding: 'main',
      type: 'managed',
      checkout: 'linked-worktree',
    })

    const created = await runtimeJson(home, ['worktree', 'demo', '--binding', 'new-binding', '--from-binding', 'main', '--new-branch', 'new-work', '--json'])
    assert.equal(created.head, sourceHead)
    assert.equal(await exists(join(created.path, 'dirty.txt')), false)

    const fromRef = await runtimeJson(home, ['worktree', 'demo', '--binding', 'ref-binding', '--from-binding', 'main', '--new-branch', 'from-ref', '--start-point', 'starting-point'])
    assert.equal(fromRef.head, await git(repository, ['rev-parse', 'starting-point']))

    const listed = await runtimeJson(home, ['list'])
    const target = listed.targets.find((entry) => entry.id === 'demo')
    assert.deepEqual(
      target.bindings.map(({ id, type, checkout }) => [id, type, checkout]),
      [
        ['existing-binding', 'managed', 'linked-worktree'],
        ['main', 'bound', 'main'],
        ['new-binding', 'managed', 'linked-worktree'],
        ['ref-binding', 'managed', 'linked-worktree'],
      ],
    )
    assert.equal(target.worktrees.every((worktree) => worktree.registered), true)

    const external = join(temporary, 'external-worktree')
    await git(repository, ['worktree', 'add', '-b', 'external-work', external, 'HEAD'])
    const beforeBinding = await runtimeJson(home, ['list'])
    assert.deepEqual(
      select(beforeBinding.targets[0].worktrees.find((worktree) => worktree.branch === 'external-work'), ['registered', 'locked', 'prunable']),
      { registered: false, locked: false, prunable: false },
    )
    const doctor = await runtimeJson(home, ['doctor'])
    assert.ok(doctor.limits.includes('target-worktrees-unbound:demo:1'))

    const hud = await runtimeJson(home, ['json'], 'hud')
    assert.equal(hud.attention.advisory.filter(({ code }) => code === 'target-worktrees-unbound').length, 1)
    assert.match(hud.attention.advisory.find(({ code }) => code === 'target-worktrees-unbound').message, /1 Git worktree/)

    const adopted = await runtimeJson(home, ['bind', 'demo', external, '--binding', 'external'])
    assert.equal(adopted.type, 'bound')
    assert.equal(adopted.checkout, 'linked-worktree')
    const afterBinding = await runtimeJson(home, ['list'])
    assert.equal(afterBinding.targets[0].worktrees.find((worktree) => worktree.branch === 'external-work').binding, 'external')
    await runtimeJson(home, ['unbind', 'demo', '--binding', 'external'])
    assert.equal(await exists(external), true)

    for (const binding of ['existing-binding', 'new-binding', 'ref-binding']) {
      await runtimeJson(home, ['unbind', 'demo', '--binding', binding, '--delete'])
    }
    assert.equal(await localBranch(repository, 'existing'), true)
    assert.equal(await localBranch(repository, 'new-work'), true)
    assert.equal(await localBranch(repository, 'from-ref'), true)
  } finally {
    await fixture.cleanup()
  }
})

test('Target worktree validation rejects ambiguous or unsafe creation without implicit Git effects', async () => {
  const fixture = await targetFixture()
  try {
    const { home, repository } = fixture
    await runtimeFailure(home, ['worktree', 'demo', '--binding', 'none'], 'target_worktree_branch_mode')
    await runtimeFailure(home, ['worktree', 'demo', '--binding', 'both', '--branch', 'main', '--new-branch', 'other'], 'target_worktree_branch_mode')
    await runtimeFailure(home, ['worktree', 'demo', '--binding', 'missing', '--branch', 'missing'], 'target_branch_missing')
    await runtimeFailure(home, ['worktree', 'demo', '--binding', 'used', '--branch', 'main'], 'target_branch_in_use')
    await runtimeFailure(home, ['worktree', 'demo', '--binding', 'bad-start', '--new-branch', 'bad-start', '--start-point', 'unknown-local-ref'], 'target_start_point_missing')
    assert.equal(await localBranch(repository, 'bad-start'), false)

    const occupied = join(home, '.desk', 'targets', 'demo', 'occupied')
    await mkdir(occupied)
    await runtimeFailure(home, ['worktree', 'demo', '--binding', 'occupied', '--from-binding', 'main', '--new-branch', 'occupied-branch'], 'target_binding_exists')
    assert.equal(await localBranch(repository, 'occupied-branch'), false)
    await removeTree(occupied)

    await runtimeJson(home, ['worktree', 'demo', '--binding', 'second', '--new-branch', 'second', '--from-binding', 'main'])
    await runtimeFailure(home, ['worktree', 'demo', '--binding', 'ambiguous', '--new-branch', 'ambiguous'], 'target_binding_ambiguous')
    assert.equal(await localBranch(repository, 'ambiguous'), false)
    await runtimeFailure(home, ['worktree', 'demo', '--binding', 'existing-new', '--from-binding', 'main', '--new-branch', 'second'], 'target_branch_exists')
    await runtimeJson(home, ['unbind', 'demo', '--binding', 'second', '--delete'])
  } finally {
    await fixture.cleanup()
  }
})

test('Target unbind preserves dirty, locked, prunable, dependent and submodule worktrees', async () => {
  const fixture = await targetFixture()
  try {
    const { home, repository, temporary } = fixture

    const dirty = await runtimeJson(home, ['worktree', 'demo', '--binding', 'dirty', '--new-branch', 'dirty-work'])
    await writeFile(join(dirty.path, 'change.txt'), 'dirty\n')
    await runtimeFailure(home, ['unbind', 'demo', '--binding', 'dirty', '--delete'], 'target_binding_dirty')
    assert.equal(await exists(dirty.path), true)
    await rm(join(dirty.path, 'change.txt'))
    await runtimeJson(home, ['unbind', 'demo', '--binding', 'dirty', '--delete'])
    assert.equal(await localBranch(repository, 'dirty-work'), true)

    const locked = await runtimeJson(home, ['worktree', 'demo', '--binding', 'locked', '--new-branch', 'locked-work'])
    await git(repository, ['worktree', 'lock', locked.path])
    await runtimeFailure(home, ['unbind', 'demo', '--binding', 'locked', '--delete'], 'target_worktree_locked')
    assert.ok((await runtimeJson(home, ['doctor'])).limits.some((limit) => limit.startsWith('target-worktree-locked:demo:')))
    assert.match(await git(repository, ['worktree', 'list', '--porcelain']), /locked/)
    await git(repository, ['worktree', 'unlock', locked.path])
    await runtimeJson(home, ['unbind', 'demo', '--binding', 'locked', '--delete'])

    const cloned = await runtimeJson(home, ['clone', 'demo', '--binding', 'clone'])
    assert.equal(cloned.checkout, 'main')
    await runtimeJson(home, ['worktree', 'demo', '--binding', 'clone-worktree', '--from-binding', 'clone', '--new-branch', 'clone-work'])
    await runtimeFailure(home, ['unbind', 'demo', '--binding', 'clone', '--delete'], 'target_clone_has_worktrees')
    await runtimeJson(home, ['unbind', 'demo', '--binding', 'clone-worktree', '--delete'])
    await runtimeJson(home, ['unbind', 'demo', '--binding', 'clone', '--delete'])

    const prunable = await runtimeJson(home, ['worktree', 'demo', '--binding', 'prunable', '--new-branch', 'prunable-work'])
    await removeTree(prunable.path)
    const doctor = await runtimeJson(home, ['doctor'])
    assert.ok(doctor.limits.some((limit) => limit.startsWith('target-worktree-prunable:demo:')))
    assert.equal((await runtimeJson(home, ['list'])).targets[0].worktrees.find((worktree) => worktree.branch === 'prunable-work').prunable, true)
    assert.match(await git(repository, ['worktree', 'list', '--porcelain']), /prunable/)
    await runtimeFailure(home, ['unbind', 'demo', '--binding', 'prunable', '--delete'], 'target_binding_missing')
    await git(repository, ['worktree', 'prune'])

    const module = join(temporary, 'module')
    await gitInit(module)
    await writeFile(join(module, 'module.txt'), 'module\n')
    await commit(module, 'module')
    await exec('git', ['-c', 'protocol.file.allow=always', 'submodule', 'add', '--quiet', module, 'modules/demo'], { cwd: repository })
    await commit(repository, 'add submodule')
    const submodule = await runtimeJson(home, ['worktree', 'demo', '--binding', 'submodule', '--new-branch', 'submodule-work'])
    await exec('git', ['-c', 'protocol.file.allow=always', 'submodule', 'update', '--init', '--quiet'], { cwd: submodule.path })
    await runtimeFailure(home, ['unbind', 'demo', '--binding', 'submodule', '--delete'], 'git_failed')
    assert.equal(await exists(submodule.path), true)
    await git(repository, ['worktree', 'remove', '--force', submodule.path])
  } finally {
    await fixture.cleanup()
  }
})

async function targetFixture() {
  const temporary = await mkdtemp(join(tmpdir(), 'endroit-target-worktrees-'))
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

async function runtimeJson(home, args, namespace = 'target') {
  const output = captureIo()
  const argv = namespace === 'target' && !args.includes('--json') ? [...args, '--json'] : args
  assert.equal(await dispatchRuntime(home, namespace, argv, output.io), 0, output.stderr())
  return JSON.parse(output.stdout())
}

async function runtimeFailure(home, args, code) {
  const output = captureIo()
  assert.notEqual(await dispatchRuntime(home, 'target', args, output.io), 0)
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

function select(value, keys) {
  return Object.fromEntries(keys.map((key) => [key, value[key]]))
}
