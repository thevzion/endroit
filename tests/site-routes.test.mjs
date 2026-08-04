import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'
import { createHome } from '../src/create.mjs'
import { initDesk } from '../src/desk.mjs'
import { parseDocument, renderDocument } from '../src/documents.mjs'
import { removeTree } from '../src/lib/io.mjs'
import { dispatchRuntime } from '../src/runtime.mjs'
import { captureIo } from './helpers.mjs'

const exec = promisify(execFile)
const cliPath = fileURLToPath(new URL('../bin/endroit.mjs', import.meta.url))

test('Site worktrees are created, classified, discovered and adopted explicitly', async () => {
  const fixture = await siteFixture()
  try {
    const { home, repository, temporary } = fixture
    const sourceHead = await git(repository, ['rev-parse', 'HEAD'])
    await writeFile(join(repository, 'dirty.txt'), 'source-only\n')
    await git(repository, ['branch', 'existing', 'starting-point'])

    const existing = await runtimeJson(home, ['checkout', 'worktree', 'demo', '--id', 'existing-route', '--from', 'main', '--branch', 'existing'])
    assert.deepEqual(select(existing, ['site', 'route', 'branch', 'head', 'mode', 'checkout']), {
      site: 'demo',
      route: 'existing-route',
      branch: 'existing',
      head: await git(repository, ['rev-parse', 'starting-point']),
      mode: 'managed-worktree',
      checkout: 'linked-worktree',
    })

    const created = await runtimeJson(home, ['checkout', 'worktree', 'demo', '--id', 'new-route', '--from', 'main', '--new-branch', 'new-work', '--json'])
    assert.equal(created.head, sourceHead)
    assert.equal(created.path, join(await realpath(home), 'checkouts', 'demo', 'new-route'))
    assert.equal(await exists(join(created.path, 'dirty.txt')), false)

    const fromRef = await runtimeJson(home, ['checkout', 'worktree', 'demo', '--id', 'ref-route', '--from', 'main', '--new-branch', 'from-ref', '--start-point', 'starting-point'])
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
    const humanList = captureIo()
    assert.equal(await dispatchRuntime(home, 'site', ['checkout', 'list', 'demo', '--all'], humanList.io), 0, humanList.stderr())
    assert.match(humanList.stdout(), /worktree:demo\/[a-f0-9]{12} · observed · linked-worktree · available/)
    const doctor = await runtimeJson(home, ['doctor'])
    assert.ok(doctor.limits.includes('site-worktrees-unrouted:demo:1'))

    const hud = await runtimeJson(home, ['json'], 'hud')
    assert.equal(hud.attention.advisory.filter(({ code }) => code === 'site-worktrees-unrouted').length, 1)
    assert.match(hud.attention.advisory.find(({ code }) => code === 'site-worktrees-unrouted').message, /1 Git worktree/)

    const adopted = await runtimeJson(home, ['checkout', 'adopt', 'demo', external, '--id', 'external'])
    assert.equal(adopted.mode, 'existing')
    assert.equal(adopted.checkout, 'linked-worktree')
    const afterRoute = await runtimeJson(home, ['list'])
    assert.equal(afterRoute.sites[0].worktrees.find((worktree) => worktree.branch === 'external-work').route, 'external')
    await runtimeJson(home, ['route', 'remove', 'demo', '--id', 'external'])
    assert.equal(await exists(external), true)

    for (const route of ['existing-route', 'new-route', 'ref-route']) {
      await deleteManaged(home, 'demo', route)
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
    await runtimeFailure(home, ['checkout', 'worktree', 'demo', '--id', 'none'], 'site_worktree_branch_mode')
    await runtimeFailure(home, ['checkout', 'worktree', 'demo', '--id', 'both', '--branch', 'main', '--new-branch', 'other'], 'site_worktree_branch_mode')
    await runtimeFailure(home, ['checkout', 'worktree', 'demo', '--id', 'missing', '--from', 'main', '--branch', 'missing'], 'site_branch_missing')
    await runtimeFailure(home, ['checkout', 'worktree', 'demo', '--id', 'used', '--from', 'main', '--branch', 'main'], 'site_branch_in_use')
    await runtimeFailure(home, ['checkout', 'worktree', 'demo', '--id', 'bad-start', '--from', 'main', '--new-branch', 'bad-start', '--start-point', 'unknown-local-ref'], 'site_start_point_missing')
    assert.equal(await localBranch(repository, 'bad-start'), false)

    const occupied = join(home, 'checkouts', 'demo', 'occupied')
    await mkdir(occupied, { recursive: true })
    await runtimeFailure(home, ['checkout', 'worktree', 'demo', '--id', 'occupied', '--from', 'main', '--new-branch', 'occupied-branch'], 'route_checkout_exists')
    assert.equal(await localBranch(repository, 'occupied-branch'), false)
    await removeTree(occupied)

    await runtimeJson(home, ['checkout', 'worktree', 'demo', '--id', 'second', '--new-branch', 'second', '--from', 'main'])
    await runtimeFailure(home, ['checkout', 'worktree', 'demo', '--id', 'ambiguous', '--new-branch', 'ambiguous'], 'usage')
    assert.equal(await localBranch(repository, 'ambiguous'), false)
    await runtimeFailure(home, ['checkout', 'worktree', 'demo', '--id', 'existing-new', '--from', 'main', '--new-branch', 'second'], 'site_branch_exists')
    await deleteManaged(home, 'demo', 'second')

    const forged = join(home, '.desk', 'routes', 'demo', 'forged.json')
    await writeFile(forged, `${JSON.stringify({
      $schema: 'https://endroit.org/schema/v7/route.json',
      id: 'forged',
      site: 'demo',
      mode: 'managed-clone',
      path: repository,
    }, null, 2)}\n`)
    await runtimeFailure(home, ['checkout', 'delete', 'checkout:demo/forged', '--approve', 'checkout:demo/forged'], 'route_path_invalid')
    assert.equal(await exists(join(repository, 'README.md')), true)
  } finally {
    await fixture.cleanup()
  }
})

test('Checkout revisions are explicit and detached worktrees persist only their commit constraint', async () => {
  const fixture = await siteFixture()
  try {
    const { home, repository, temporary } = fixture
    const detached = await runtimeJson(home, ['checkout', 'worktree', 'demo', '--id', 'detached', '--from', 'main', '--detach', 'starting-point'])
    const document = await routeMetadata(home, 'demo', 'detached')
    assert.equal(detached.detached, true)
    assert.equal(detached.branch, null)
    assert.equal(document.checkout_mode, 'managed-worktree')
    assert.deepEqual(document.revision, { kind: 'commit', sha: await git(repository, ['rev-parse', 'starting-point']) })

    const external = join(temporary, 'external-revision')
    await git(repository, ['worktree', 'add', '-b', 'explicit-revision', external, 'HEAD'])
    await runtimeJson(home, ['checkout', 'adopt', 'demo', external, '--id', 'unconstrained'])
    assert.equal('revision' in await routeMetadata(home, 'demo', 'unconstrained'), false)
    await runtimeJson(home, ['route', 'remove', 'demo', '--id', 'unconstrained'])
    await runtimeFailure(home, ['checkout', 'adopt', 'demo', external, '--id', 'wrong', '--branch', 'other'], 'route_revision_divergent')
    assert.equal(await pathExists(routeDocumentPath(home, 'demo', 'wrong')), false)
    await runtimeJson(home, ['checkout', 'adopt', 'demo', external, '--id', 'constrained', '--branch', 'explicit-revision'])
    assert.deepEqual((await routeMetadata(home, 'demo', 'constrained')).revision, { kind: 'branch', name: 'explicit-revision' })
  } finally {
    await fixture.cleanup()
  }
})

test('unrouted worktrees have stable technical selectors and optional reconstructible surfaces', async () => {
  const fixture = await siteFixture()
  try {
    const { home, repository, temporary } = fixture
    const external = join(temporary, 'provider-worktree')
    await git(repository, ['worktree', 'add', '-b', 'provider/session', external, 'HEAD'])
    const listed = await runtimeJson(home, ['checkout', 'list', 'demo', '--all'])
    const observed = listed.checkouts.find((entry) => entry.ref.startsWith('worktree:demo/'))
    assert.ok(observed)
    assert.equal((await runtimeJson(home, ['checkout', 'inspect', observed.ref])).observed.path, await realpath(external))
    assert.equal((await runtimeJson(home, ['checkout', 'resolve', external])).source, 'checkout:demo/main')

    const deskPath = join(home, '.desk/DESK.md')
    const desk = parseDocument(await readFile(deskPath, 'utf8'), { path: deskPath })
    desk.metadata.settings = { ...(desk.metadata.settings ?? {}), 'endroit/sites': { observedWorktrees: 'surface' } }
    await writeFile(deskPath, renderDocument(desk))
    await runtimeJson(home, ['checkout', 'reconcile', '--apply'])
    const surfaced = (await runtimeJson(home, ['checkout', 'inspect', observed.ref])).observed.address
    assert.equal((await lstat(surfaced)).isSymbolicLink(), true)
    assert.equal(await realpath(surfaced), await realpath(external))

    const manifestPath = join(home, '.endroit/checkout-index.json')
    const manifestBefore = await readFile(manifestPath)
    desk.metadata.settings['endroit/sites'].observedWorktrees = 'report'
    await writeFile(deskPath, renderDocument(desk))
    const previousNodeEnv = process.env.NODE_ENV
    try {
      process.env.NODE_ENV = 'test'
      process.env.ENDROIT_TEST_FAULT_AFTER_CHECKOUT_INDEX_ACTION = 'remove'
      await runtimeFailure(home, ['checkout', 'reconcile', '--apply'], 'checkout_index_fault')
    } finally {
      delete process.env.ENDROIT_TEST_FAULT_AFTER_CHECKOUT_INDEX_ACTION
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV
      else process.env.NODE_ENV = previousNodeEnv
    }
    assert.equal((await lstat(surfaced)).isSymbolicLink(), true)
    assert.equal(await realpath(surfaced), await realpath(external))
    assert.deepEqual(await readFile(manifestPath), manifestBefore)

    const concurrentMarker = join(temporary, 'reconcile-concurrent-ready')
    const foreignPath = 'checkouts/demo/foreign-owner'
    const foreignTarget = await realpath(repository)
    const concurrentManifest = Buffer.from(`${JSON.stringify({
      version: 1,
      links: [{
        path: foreignPath,
        target: foreignTarget,
        ref: 'checkout:demo/foreign-owner',
        digest: createHash('sha256').update(`${foreignPath}\0${foreignTarget}`).digest('hex'),
      }],
    }, null, 2)}\n`)
    const rollbackMarker = join(temporary, 'reconcile-rollback-links-ready')
    const rollbackWindowReconcile = cliResult(home, ['checkout', 'reconcile', '--apply'], {
      NODE_ENV: 'test',
      ENDROIT_TEST_FAULT_AFTER_CHECKOUT_INDEX_ACTION: 'remove',
      ENDROIT_TEST_CHECKOUT_INDEX_ROLLBACK_LINKS_READY_FILE: rollbackMarker,
      ENDROIT_TEST_HOLD_CHECKOUT_INDEX_ROLLBACK_MS: '300',
    })
    await waitForPath(rollbackMarker)
    await writeFile(manifestPath, concurrentManifest)
    const rollbackWindowResult = await rollbackWindowReconcile
    assert.notEqual(rollbackWindowResult.code, 0)
    assert.match(rollbackWindowResult.stderr, /manifest changed concurrently; it and the failed apply link state were preserved/)
    assert.deepEqual(await readFile(manifestPath), concurrentManifest)
    assert.equal((await lstat(surfaced)).isSymbolicLink(), true)
    assert.equal(await realpath(surfaced), await realpath(external))

    await writeFile(manifestPath, manifestBefore)
    const concurrentReconcile = cliResult(home, ['checkout', 'reconcile', '--apply'], {
      NODE_ENV: 'test',
      ENDROIT_TEST_FAULT_AFTER_CHECKOUT_INDEX_ACTION: 'remove',
      ENDROIT_TEST_CHECKOUT_INDEX_FAULT_READY_FILE: concurrentMarker,
      ENDROIT_TEST_HOLD_CHECKOUT_INDEX_FAULT_MS: '300',
    })
    await waitForPath(concurrentMarker)
    await writeFile(manifestPath, concurrentManifest)
    const concurrentResult = await concurrentReconcile
    assert.notEqual(concurrentResult.code, 0)
    assert.match(concurrentResult.stderr, /manifest changed concurrently; it and the failed apply link state were preserved/)
    assert.deepEqual(await readFile(manifestPath), concurrentManifest)
    assert.equal(await exists(surfaced), false)

    await writeFile(manifestPath, manifestBefore)
    await writeFile(join(external, 'dirty.txt'), 'dirty\n')
    await runtimeFailure(home, ['checkout', 'worktree', 'demo', '--id', 'blocked', '--from', 'main', '--new-branch', 'blocked'], 'checkout_family_blocked')
    assert.equal(await localBranch(repository, 'blocked'), false)
  } finally {
    await fixture.cleanup()
  }
})

test('managed clone and worktree deletion refuse symlink escapes and preserve external targets', async () => {
  const fixture = await siteFixture()
  try {
    const { home, temporary } = fixture
    const routes = [
      await runtimeJson(home, ['checkout', 'clone', 'demo', '--id', 'escaped-clone']),
      await runtimeJson(home, ['checkout', 'worktree', 'demo', '--id', 'escaped-worktree', '--from', 'main', '--new-branch', 'escaped-worktree']),
    ]
    for (const route of routes) {
      const external = join(temporary, `external-${route.route}`)
      await rename(route.path, external)
      await symlink(external, route.path, 'dir')

      await runtimeFailure(home, ['checkout', 'delete', `checkout:demo/${route.route}`, '--approve', `checkout:demo/${route.route}`], 'route_checkout_symlink')
      assert.equal(await readFile(join(external, 'README.md'), 'utf8'), '# second\n')
      assert.equal((await lstat(route.path)).isSymbolicLink(), true)
      assert.equal(await exists(routeDocumentPath(home, 'demo', route.route)), true)
    }
  } finally {
    await fixture.cleanup()
  }
})

test('managed clone deletion refuses an inode race and restores its Route', async () => {
  const fixture = await siteFixture()
  try {
    const { home, temporary } = fixture
    const cloned = await runtimeJson(home, ['checkout', 'clone', 'demo', '--id', 'race'])
    const marker = join(temporary, 'delete-ready')
    const preserved = join(temporary, 'preserved-clone')
    const deletion = cliResult(home, ['checkout', 'delete', 'checkout:demo/race', '--approve', 'checkout:demo/race'], {
      NODE_ENV: 'test',
      ENDROIT_TEST_CHECKOUT_DELETE_READY_FILE: marker,
      ENDROIT_TEST_HOLD_CHECKOUT_DELETE_MS: '300',
    })
    await waitForPath(marker)
    await rename(cloned.path, preserved)
    await mkdir(cloned.path)
    await writeFile(join(cloned.path, 'valuable.txt'), 'preserve\n')
    const result = await deletion
    assert.notEqual(result.code, 0)
    assert.match(result.stderr, /route_checkout_changed/)
    assert.equal(await readFile(join(cloned.path, 'valuable.txt'), 'utf8'), 'preserve\n')
    assert.equal(await exists(join(preserved, 'README.md')), true)
    assert.equal(await exists(routeDocumentPath(home, 'demo', 'race')), true)
  } finally {
    await fixture.cleanup()
  }
})

test('managed clone deletion revalidates its staged inode immediately before recursive removal', async () => {
  const fixture = await siteFixture()
  try {
    const { home, temporary } = fixture
    const cloned = await runtimeJson(home, ['checkout', 'clone', 'demo', '--id', 'staged-race'])
    const marker = join(temporary, 'clone-staged-ready')
    const preserved = join(temporary, 'preserved-staged-clone')
    const deletion = cliResult(home, ['checkout', 'delete', 'checkout:demo/staged-race', '--approve', 'checkout:demo/staged-race'], {
      NODE_ENV: 'test',
      ENDROIT_TEST_CLONE_STAGED_READY_FILE: marker,
      ENDROIT_TEST_HOLD_CLONE_STAGED_MS: '300',
    })
    await waitForPath(marker)
    const stagedPath = await readFile(marker, 'utf8')
    await rename(stagedPath, preserved)
    await mkdir(stagedPath)
    await writeFile(join(stagedPath, 'valuable.txt'), 'preserve replacement\n')
    const result = await deletion
    assert.notEqual(result.code, 0)
    assert.match(result.stderr, /route_checkout_changed/)
    assert.match(result.stderr, /Route backup retained/)
    assert.equal(await readFile(join(stagedPath, 'valuable.txt'), 'utf8'), 'preserve replacement\n')
    assert.equal(await exists(join(preserved, 'README.md')), true)
    assert.equal(await exists(routeDocumentPath(home, 'demo', 'staged-race')), false)
    assert.ok((await readdir(dirname(routeDocumentPath(home, 'demo', 'staged-race')))).some((entry) => entry.startsWith('ROUTE.md.') && entry.endsWith('.delete')))
  } finally {
    await fixture.cleanup()
  }
})

test('managed deletion preserves a concurrently recreated canonical Route', async () => {
  const fixture = await siteFixture()
  try {
    const { home, temporary } = fixture
    const cloned = await runtimeJson(home, ['checkout', 'clone', 'demo', '--id', 'route-race'])
    const marker = join(temporary, 'route-staged-ready')
    const routePath = routeDocumentPath(home, 'demo', 'route-race')
    const concurrent = 'concurrent route replacement\n'
    const deletion = cliResult(home, ['checkout', 'delete', 'checkout:demo/route-race', '--approve', 'checkout:demo/route-race'], {
      NODE_ENV: 'test',
      ENDROIT_TEST_ROUTE_STAGED_READY_FILE: marker,
      ENDROIT_TEST_HOLD_ROUTE_STAGED_MS: '300',
    })
    await waitForPath(marker)
    await writeFile(routePath, concurrent)
    const result = await deletion
    assert.notEqual(result.code, 0)
    assert.match(result.stderr, /route_delete_drift/)
    assert.match(result.stderr, /was replaced while restoring its Route/)
    assert.equal(await readFile(routePath, 'utf8'), concurrent)
    assert.equal(await exists(join(cloned.path, 'README.md')), true)
    assert.ok((await readdir(dirname(routePath))).some((entry) => entry.startsWith('ROUTE.md.') && entry.endsWith('.delete')))
  } finally {
    await fixture.cleanup()
  }
})

test('managed clone deletion reports a recoverable partial state after its destructive boundary', async () => {
  const fixture = await siteFixture()
  try {
    const { home } = fixture
    const cloned = await runtimeJson(home, ['checkout', 'clone', 'demo', '--id', 'partial'])
    const result = await cliResult(home, ['checkout', 'delete', 'checkout:demo/partial', '--approve', 'checkout:demo/partial'], {
      NODE_ENV: 'test',
      ENDROIT_TEST_FAULT_AFTER_DESTRUCTIVE_BOUNDARY: 'checkout:demo/partial',
    })
    assert.notEqual(result.code, 0)
    assert.match(result.stderr, /checkout_partial_deletion/)
    assert.match(result.stderr, /Route recovery:/)
    assert.match(result.stderr, /Checkout recovery:/)
    assert.equal(await exists(cloned.path), false)
    assert.equal(await exists(routeDocumentPath(home, 'demo', 'partial')), false)
    const stagedCheckout = (await readdir(join(home, 'checkouts/demo'))).find((entry) => entry.startsWith('.partial.') && entry.endsWith('.delete'))
    assert.ok(stagedCheckout)
    assert.equal(await exists(join(home, 'checkouts/demo', stagedCheckout, 'README.md')), true)
    assert.ok((await readdir(dirname(routeDocumentPath(home, 'demo', 'partial')))).some((entry) => entry.startsWith('ROUTE.md.') && entry.endsWith('.delete')))
  } finally {
    await fixture.cleanup()
  }
})

test('Site unbind preserves dirty, locked, prunable, dependent and submodule worktrees', async () => {
  const fixture = await siteFixture()
  try {
    const { home, repository, temporary } = fixture

    const dirty = await runtimeJson(home, ['checkout', 'worktree', 'demo', '--id', 'dirty', '--from', 'main', '--new-branch', 'dirty-work'])
    await writeFile(join(dirty.path, 'change.txt'), 'dirty\n')
    assert.ok((await runtimeJson(home, ['doctor'])).limits.includes('route-dirty:demo:dirty'))
    await runtimeFailure(home, ['checkout', 'delete', 'checkout:demo/dirty', '--approve', 'checkout:demo/dirty'], 'route_dirty')
    assert.equal(await exists(dirty.path), true)
    await rm(join(dirty.path, 'change.txt'))
    await deleteManaged(home, 'demo', 'dirty')
    assert.equal(await localBranch(repository, 'dirty-work'), true)

    const locked = await runtimeJson(home, ['checkout', 'worktree', 'demo', '--id', 'locked', '--from', 'main', '--new-branch', 'locked-work'])
    await git(repository, ['worktree', 'lock', locked.path])
    await runtimeFailure(home, ['checkout', 'delete', 'checkout:demo/locked', '--approve', 'checkout:demo/locked'], 'site_worktree_locked')
    assert.ok((await runtimeJson(home, ['doctor'])).limits.some((limit) => limit.startsWith('site-worktree-locked:demo:')))
    assert.match(await git(repository, ['worktree', 'list', '--porcelain']), /locked/)
    await git(repository, ['worktree', 'unlock', locked.path])
    await deleteManaged(home, 'demo', 'locked')

    const cloned = await runtimeJson(home, ['checkout', 'clone', 'demo', '--id', 'clone'])
    assert.equal(cloned.checkout, 'main')
    await runtimeJson(home, ['checkout', 'worktree', 'demo', '--id', 'clone-worktree', '--from', 'clone', '--new-branch', 'clone-work'])
    await runtimeFailure(home, ['checkout', 'delete', 'checkout:demo/clone', '--approve', 'checkout:demo/clone'], 'site_clone_has_worktrees')
    await deleteManaged(home, 'demo', 'clone-worktree')
    await deleteManaged(home, 'demo', 'clone')

    const prunable = await runtimeJson(home, ['checkout', 'worktree', 'demo', '--id', 'prunable', '--from', 'main', '--new-branch', 'prunable-work'])
    await removeTree(prunable.path)
    const doctor = await runtimeJson(home, ['doctor'])
    assert.ok(doctor.limits.some((limit) => limit.startsWith('site-worktree-prunable:demo:')))
    assert.equal((await runtimeJson(home, ['list'])).sites[0].worktrees.find((worktree) => worktree.branch === 'prunable-work').prunable, true)
    assert.match(await git(repository, ['worktree', 'list', '--porcelain']), /prunable/)
    await runtimeFailure(home, ['checkout', 'delete', 'checkout:demo/prunable', '--approve', 'checkout:demo/prunable'], 'route_broken')
    await git(repository, ['worktree', 'prune'])

    const module = join(temporary, 'module')
    await gitInit(module)
    await writeFile(join(module, 'module.txt'), 'module\n')
    await commit(module, 'module')
    await exec('git', ['-c', 'protocol.file.allow=always', 'submodule', 'add', '--quiet', module, 'modules/demo'], { cwd: repository })
    await commit(repository, 'add submodule')
    const submodule = await runtimeJson(home, ['checkout', 'worktree', 'demo', '--id', 'submodule', '--from', 'main', '--new-branch', 'submodule-work'])
    await exec('git', ['-c', 'protocol.file.allow=always', 'submodule', 'update', '--init', '--quiet'], { cwd: submodule.path })
    await runtimeFailure(home, ['checkout', 'delete', 'checkout:demo/submodule', '--approve', 'checkout:demo/submodule'], 'git_failed')
    assert.equal(await exists(submodule.path), true)
    assert.equal(await exists(routeDocumentPath(home, 'demo', 'submodule')), true)
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
    await runtimeJson(home, ['checkout', 'adopt', 'product', first, '--id', 'local'])
    const firstDesk = join(temporary, 'desk-one')
    await rename(join(home, '.desk'), firstDesk)

    await initDesk(home, { id: 'two', member: 'owner', repository: 'tracked' })
    await runtimeJson(home, ['checkout', 'adopt', 'product', second, '--id', 'local'])
    const firstRoute = parseDocument(await readFile(join(firstDesk, 'routes/product/local/ROUTE.md'), 'utf8')).metadata
    const secondRoute = await routeMetadata(home, 'product', 'local')
    assert.equal(firstRoute.checkout_mode, 'existing')
    assert.equal(secondRoute.checkout_mode, 'existing')
    assert.equal('path' in firstRoute || 'path' in secondRoute, false)
    assert.match(await readFile(join(home, 'sites/product/SITE.md'), 'utf8'), /repository: "github.com\/example\/product"/)
  } finally {
    await removeTree(temporary, { force: true })
  }
})

test('the Checkout index reconciles reconstructible links without touching repositories', async () => {
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

    const address = join(await realpath(home), 'checkouts', 'demo', 'main')
    assert.equal((await lstat(address)).isSymbolicLink(), true)
    assert.equal(await realpath(address), await realpath(repository))
    assert.equal((await runtimeJson(home, ['checkout', 'reconcile', '--check'])).status, 'current')
    assert.equal((await runtimeJson(home, ['doctor'])).limits.some((limit) => limit.startsWith('checkout-index-')), false)

    const manifestPath = join(home, '.endroit/checkout-index.json')
    await rm(manifestPath)
    assert.ok((await runtimeJson(home, ['doctor'])).limits.includes('checkout-index-stale'))
    await runtimeJson(home, ['checkout', 'reconcile', '--apply'])
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    const stalePath = 'checkouts/demo/stale'
    manifest.links.push({
      path: stalePath,
      target: await realpath(repository),
      ref: 'checkout:demo/stale',
      digest: createHash('sha256').update(`${stalePath}\0${await realpath(repository)}`).digest('hex'),
    })
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    assert.ok((await runtimeJson(home, ['doctor'])).limits.includes('checkout-index-stale'))
    await runtimeJson(home, ['checkout', 'reconcile', '--apply'])
    assert.equal((await runtimeJson(home, ['doctor'])).limits.includes('checkout-index-stale'), false)

    await rename(repository, moved)
    assert.ok((await runtimeJson(home, ['doctor'])).limits.includes('checkout-index-broken:demo:main'))
    await runtimeJson(home, ['route', 'remove', 'demo'])
    assert.equal(await pathExists(address), false)
    assert.equal(await exists(join(moved, 'README.md')), true)
    await rename(moved, repository)
    const conflict = join(home, 'checkouts/demo/conflict')
    await mkdir(conflict, { recursive: true })
    await runtimeFailure(home, ['checkout', 'adopt', 'demo', repository, '--id', 'conflict'], 'checkout_index_conflict')
    assert.equal((await lstat(conflict)).isDirectory(), true)
    assert.equal(await pathExists(routeDocumentPath(home, 'demo', 'conflict')), false)
    await rm(conflict, { recursive: true })
    const direct = join(home, 'checkouts', 'demo', 'direct')
    await exec('git', ['clone', '--quiet', repository, direct])
    await runtimeJson(home, ['checkout', 'adopt', 'demo', direct, '--id', 'direct'])
    assert.equal((await runtimeJson(home, ['checkout', 'inspect', 'checkout:demo/direct'])).observed.index, 'direct')
    await runtimeJson(home, ['route', 'remove', 'demo', '--id', 'direct'])
    await removeTree(direct)
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
    const route = await runtimeJson(home, ['checkout', 'worktree', 'demo', '--id', 'conflict', '--from', 'main', '--branch', 'conflict-work'])
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
    const route = await runtimeJson(home, ['checkout', 'adopt', 'child', submodule, '--id', 'module'])
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

test('pinnedSites validates an initialized canonical gitlink without updating it', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'endroit-pinned-site-'))
  const home = join(temporary, 'home')
  const child = join(temporary, 'child')
  try {
    await createHome(home)
    await gitInit(home)
    await gitInit(child)
    await writeFile(join(child, 'README.md'), '# child\n')
    await commit(child, 'child')
    await runtimeJson(home, ['add', child, '--id', 'child'])
    await runtimeJson(home, ['route', 'remove', 'child'])
    await exec('git', ['-c', 'protocol.file.allow=always', 'submodule', 'add', '--force', '--quiet', child, 'checkouts/child/main'], { cwd: home })
    await runtimeJson(home, ['checkout', 'adopt', 'child', join(home, 'checkouts/child/main'), '--id', 'main'])
    const homePath = join(home, 'WORKPLACE.md')
    const declaration = parseDocument(await readFile(homePath, 'utf8'), { path: homePath })
    declaration.metadata.settings = { ...(declaration.metadata.settings ?? {}), 'endroit/sites': { pinnedSites: ['child'] } }
    await writeFile(homePath, renderDocument(declaration))
    assert.equal((await runtimeJson(home, ['doctor'])).limits.some((limit) => limit.startsWith('site-gitlink-')), false)

    const checkout = join(home, 'checkouts/child/main')
    await writeFile(join(checkout, 'next.txt'), 'next\n')
    await commit(checkout, 'next')
    assert.ok((await runtimeJson(home, ['doctor'])).limits.includes('site-gitlink-commit-divergent:child'))
  } finally {
    await removeTree(temporary, { force: true })
  }
})

test('Doctor reports pinnedSites entries that do not name a declared Site', async () => {
  const fixture = await siteFixture()
  try {
    const { home } = fixture
    const homePath = join(home, 'WORKPLACE.md')
    const declaration = parseDocument(await readFile(homePath, 'utf8'), { path: homePath })
    declaration.metadata.settings = { ...(declaration.metadata.settings ?? {}), 'endroit/sites': { pinnedSites: ['missing-site'] } }
    await writeFile(homePath, renderDocument(declaration))
    assert.ok((await runtimeJson(home, ['doctor'])).limits.includes('site-gitlink-site-missing:missing-site'))
  } finally {
    await fixture.cleanup()
  }
})

test('Route lifecycle changes only metadata and inactive Checkouts leave implicit selection', async () => {
  const fixture = await siteFixture()
  try {
    const { home, repository } = fixture
    const secondary = await runtimeJson(home, ['checkout', 'worktree', 'demo', '--id', 'feature--checkout-v8', '--from', 'main', '--new-branch', 'feature/checkout-v8'])
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
    await runtimeFailure(home, ['checkout', 'worktree', 'demo', '--id', 'inactive-source', '--from', 'main', '--new-branch', 'inactive/source'], 'route_inactive')
    assert.equal((await runtimeJson(home, ['route', 'activate', 'demo'])).route, 'main')
    await runtimeFailure(home, ['route', 'inspect', 'demo'], 'route_ambiguous')
    assert.equal((await runtimeJson(home, ['route', 'supersede', 'demo', '--id', 'main', '--by', 'feature--checkout-v8'])).status, 'superseded')
    await runtimeFailure(home, ['checkout', 'delete', 'checkout:demo/feature--checkout-v8', '--approve', 'checkout:demo/feature--checkout-v8'], 'route_supersession_target')

    const listed = await runtimeJson(home, ['checkout', 'list', 'demo', '--all'])
    assert.deepEqual(listed.checkouts.filter(({ declared }) => declared).map(({ ref, declared }) => [ref, declared.status]), [
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
    await runtimeFailure(home, ['checkout', 'adopt', 'demo', repository, '--id', 'duplicate'], 'checkout_duplicate_git_dir')
    const aliasRoot = join(home, 'sites', 'alias')
    await mkdir(aliasRoot)
    await writeFile(join(aliasRoot, 'SITE.md'), (await readFile(join(home, 'sites/demo/SITE.md'), 'utf8')).replace('id: "demo"', 'id: "alias"').replace('# demo', '# alias'))
    await runtimeFailure(home, ['checkout', 'adopt', 'alias', repository, '--id', 'main'], 'checkout_duplicate_git_dir')
    await runtimeJson(home, ['checkout', 'worktree', 'demo', '--id', 'review--shared', '--from', 'main', '--new-branch', 'review/shared'])
    const checkouts = (await runtimeJson(home, ['checkout', 'list', 'demo'])).checkouts
    assert.equal(new Set(checkouts.map((entry) => entry.observed.repository.gitDir)).size, 2)
    assert.equal(new Set(checkouts.map((entry) => entry.observed.repository.commonGitDir)).size, 1)

    await writeFile(join(home, '.desk/routes/demo/duplicate.json'), `${JSON.stringify({
      $schema: 'https://endroit.org/schema/v8/route.json',
      id: 'duplicate',
      site: 'demo',
      status: 'active',
      checkout: { mode: 'existing', path: await realpath(repository) },
    }, null, 2)}\n`)
    const doctor = await runtimeJson(home, ['doctor'])
    assert.ok(doctor.limits.some((limit) => limit.startsWith('duplicate-git-dir:') && limit.includes('checkout:demo/duplicate') && limit.includes('checkout:demo/main')))
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

test('v7 and v9 Route declarations preserve operational parity through Sites, HUD and Artifacts', async () => {
  const fixture = await siteFixture()
  try {
    const { home, repository } = fixture
    const siteV9 = (await runtimeJson(home, ['list'])).sites[0].routes[0]
    const hudV9 = (await runtimeJson(home, ['json'], 'hud')).sites[0].routes[0]
    const artifactsV9 = await runtimeJson(home, ['list', '--json'], 'artifact')
    assert.equal(siteV9.declaration, 'routes/demo/main/ROUTE.md')

    await writeLegacyRoute(join(home, '.desk/routes/demo/main.json'), {
      $schema: 'https://endroit.org/schema/v7/route.json',
      id: 'main',
      site: 'demo',
      mode: 'existing',
      path: await realpath(repository),
      branch: 'main',
    })

    const siteV7 = (await runtimeJson(home, ['list'])).sites[0].routes[0]
    const hudV7 = (await runtimeJson(home, ['json'], 'hud')).sites[0].routes[0]
    const artifactsV7 = await runtimeJson(home, ['list', '--json'], 'artifact')
    assert.equal(siteV7.declared.status, siteV9.declared.status)
    assert.equal(siteV7.declared.checkout.mode, siteV9.declared.checkout.mode)
    assert.equal(hudV7.declared.checkout.mode, hudV9.declared.checkout.mode)
    assert.equal(siteV7.observed.repository.available, siteV9.observed.repository.available)
    assert.deepEqual(artifactsV7.artifacts, artifactsV9.artifacts)
  } finally {
    await fixture.cleanup()
  }
})

test('Route migration derives explicit revisions for branchless v7 managed worktrees without effects during check', async () => {
  const fixture = await siteFixture()
  try {
    const { home } = fixture
    const branch = await runtimeJson(home, ['checkout', 'worktree', 'demo', '--id', 'branchless', '--from', 'main', '--new-branch', 'branchless'])
    const detached = await runtimeJson(home, ['checkout', 'worktree', 'demo', '--id', 'detached-branchless', '--from', 'main', '--detach', 'starting-point'])
    const originals = new Map()
    for (const [id, path] of [['branchless', branch.path], ['detached-branchless', detached.path]]) {
      const routePath = join(home, `.desk/routes/demo/${id}.json`)
      const bytes = Buffer.from(`${JSON.stringify({
        $schema: 'https://endroit.org/schema/v7/route.json',
        id,
        site: 'demo',
        mode: 'managed-worktree',
        path: `checkouts/demo/${id}`,
      }, null, 2)}\n`)
      await rm(join(home, `.desk/routes/demo/${id}`), { recursive: true, force: true })
      await writeFile(routePath, bytes)
      originals.set(id, { routePath, bytes, path })
    }

    const checked = await runtimeJson(home, ['route', 'migrate', 'demo', '--check'])
    assert.equal(checked.readOnly, true)
    assert.equal(checked.changes, 2)
    for (const { routePath, bytes } of originals.values()) assert.deepEqual(await readFile(routePath), bytes)

    const migrated = await runtimeJson(home, ['route', 'migrate', 'demo'])
    assert.deepEqual(JSON.parse(await readFile(originals.get('branchless').routePath, 'utf8')).revision, { kind: 'branch', name: 'branchless' })
    assert.deepEqual(JSON.parse(await readFile(originals.get('detached-branchless').routePath, 'utf8')).revision, {
      kind: 'commit',
      sha: await git(detached.path, ['rev-parse', 'HEAD']),
    })
    await runtimeJson(home, ['route', 'migrate', '--rollback', migrated.runId])
    for (const { routePath, bytes } of originals.values()) assert.deepEqual(await readFile(routePath), bytes)
  } finally {
    await fixture.cleanup()
  }
})

test('Route migration checks without effect and rollback preserves Git and index invariants', async () => {
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
    await rm(join(home, '.desk/routes/demo/main'), { recursive: true, force: true })
    await writeFile(routePath, original)
    await chmod(routePath, 0o640)
    await writeFile(join(repository, 'dirty.txt'), 'preserve me\n')
    await runtimeJson(home, ['checkout', 'reconcile', '--apply'])
    const address = join(home, 'checkouts/demo/main')
    const invariant = await checkoutInvariant(repository, address)
    const migrationsRoot = join(home, '.endroit/migrations/checkout-v8')

    const checked = await runtimeJson(home, ['route', 'migrate', 'demo', '--check'])
    assert.equal(checked.status, 'checked')
    assert.equal(checked.readOnly, true)
    assert.equal(checked.changes, 1)
    assert.deepEqual(await readFile(routePath), original)
    assert.equal(await pathExists(migrationsRoot), false)
    assert.deepEqual(await checkoutInvariant(repository, address), invariant)

    const migrated = await runtimeJson(home, ['route', 'migrate', 'demo'])
    assert.equal(migrated.status, 'migrated')
    assert.equal(migrated.changes, 1)
    assert.equal((await lstat(routePath)).mode & 0o777, 0o640)
    const v8 = JSON.parse(await readFile(routePath, 'utf8'))
    assert.equal(v8.$schema, 'https://endroit.org/schema/v8/route.json')
    assert.deepEqual(v8.checkout, { mode: 'existing', path: await realpath(repository) })
    assert.equal('revision' in v8, false)
    assert.equal('sourceRoute' in v8, false)
    const journalPath = join(migrationsRoot, migrated.runId, 'journal.json')
    const journal = await readFile(journalPath, 'utf8')
    assert.doesNotMatch(journal, /"(?:head|dirty|clean|gitDir|commonGitDir)"/)
    assert.equal(JSON.parse(journal).status, 'applied')
    assert.deepEqual(JSON.parse(journal).routes.map(({ progress }) => progress), ['after'])
    assert.deepEqual(await checkoutInvariant(repository, address), invariant)
    await runtimeFailure(home, ['route', 'migrate', 'demo', '--rollback', migrated.runId], 'usage')

    const appliedBytes = await readFile(routePath)
    await chmod(routePath, 0o600)
    await runtimeFailure(home, ['route', 'migrate', '--rollback', migrated.runId], 'route_rollback_drift')
    await chmod(routePath, 0o640)
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
    assert.deepEqual(await checkoutInvariant(repository, address), invariant)
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
    assert.deepEqual(worktreeV8.checkout, { mode: 'managed-worktree' })
    assert.deepEqual(worktreeV8.revision, { kind: 'branch', name: legacy.worktree.branch })
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

    const lockRoot = join(home, '.endroit/locks')
    const lockPath = join(lockRoot, 'routes.lock')
    await mkdir(lockRoot, { recursive: true })
    await writeFile(lockPath, `${JSON.stringify({ token: 'live-test-lock', pid: process.pid, startedAt: new Date().toISOString() })}\n`, { flag: 'wx' })
    const beforeLock = await readFile(join(home, '.desk/routes/demo/main.json'))
    await runtimeFailure(home, ['route', 'migrate', 'demo'], 'route_writer_locked')
    await runtimeFailure(home, ['route', 'park', 'demo'], 'route_writer_locked')
    assert.equal((await runtimeJson(home, ['route', 'list', 'demo'])).status, 'listed')
    assert.deepEqual(await readFile(join(home, '.desk/routes/demo/main.json')), beforeLock)
    await rm(lockPath)

    await writeFile(lockPath, `${JSON.stringify({ token: 'stale-test-lock', pid: 2147483647, startedAt: new Date().toISOString() })}\n`, { flag: 'wx' })
    await runtimeFailure(home, ['route', 'migrate', 'demo'], 'route_writer_lock_stale')
    assert.equal(JSON.parse(await readFile(lockPath, 'utf8')).token, 'stale-test-lock')
    await rm(lockPath)

    const expired = new Date(Date.now() - 60_000)
    await writeFile(lockPath, `${JSON.stringify({ token: 'recycled-pid-lock', pid: process.pid, startedAt: expired.toISOString() })}\n`, { flag: 'wx' })
    await utimes(lockPath, expired, expired)
    await runtimeFailure(home, ['route', 'migrate', 'demo'], 'route_writer_locked')
    assert.equal(JSON.parse(await readFile(lockPath, 'utf8')).token, 'recycled-pid-lock')
    await rm(lockPath)

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

test('Route migration recovers a fault after durable Route rename but before journal progress', async () => {
  const fixture = await siteFixture()
  const previousNodeEnv = process.env.NODE_ENV
  const previousFault = process.env.ENDROIT_TEST_FAULT_AFTER_ROUTE_RENAME
  try {
    const { home, repository } = fixture
    await legacyRouteSet(home, repository)
    const migrationsRoot = join(home, '.endroit/migrations/checkout-v8')
    const before = new Set(await readdir(migrationsRoot).catch((error) => error.code === 'ENOENT' ? [] : Promise.reject(error)))
    process.env.NODE_ENV = 'test'
    process.env.ENDROIT_TEST_FAULT_AFTER_ROUTE_RENAME = 'checkout:demo/main'
    await runtimeFailure(home, ['route', 'migrate', 'demo'], 'route_migration_fault')
    const runId = (await readdir(migrationsRoot)).find((entry) => !before.has(entry))
    assert.ok(runId)
    const run = await migrationRun(home, runId)
    assert.equal(run.journal.status, 'applying')
    assert.equal(run.journal.routes.find((entry) => entry.id === 'main').progress, 'original')
    assert.equal(JSON.parse(await readFile(join(home, '.desk/routes/demo/main.json'), 'utf8')).$schema, 'https://endroit.org/schema/v8/route.json')
    delete process.env.ENDROIT_TEST_FAULT_AFTER_ROUTE_RENAME
    const recovered = await runtimeJson(home, ['route', 'migrate', '--rollback', runId])
    assert.equal(recovered.status, 'rolled-back')
    assert.equal(recovered.changes, 2)
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = previousNodeEnv
    if (previousFault === undefined) delete process.env.ENDROIT_TEST_FAULT_AFTER_ROUTE_RENAME
    else process.env.ENDROIT_TEST_FAULT_AFTER_ROUTE_RENAME = previousFault
    await fixture.cleanup()
  }
})

test('Route migration check fully validates v7 without lock or journal effects', async () => {
  const fixture = await siteFixture()
  try {
    const { home } = fixture
    const routePath = join(home, '.desk/routes/demo/main.json')
    const document = {
      $schema: 'https://endroit.org/schema/v7/route.json',
      id: 'main',
      site: 'demo',
      mode: 'existing',
      path: '../repository',
      branch: 'main',
    }
    const original = await writeLegacyRoute(routePath, document)
    const lockRoot = join(home, '.endroit/locks')
    const locksBefore = await readdir(lockRoot).catch((error) => error.code === 'ENOENT' ? [] : Promise.reject(error))
    await runtimeFailure(home, ['route', 'migrate', 'demo', '--check'], 'route_path_invalid')
    assert.deepEqual(await readFile(routePath), original)
    assert.equal(await pathExists(join(home, '.endroit/migrations/checkout-v8')), false)
    assert.deepEqual(await readdir(lockRoot), locksBefore)
    assert.equal(await pathExists(join(lockRoot, 'routes.lock')), false)
    await runtimeFailure(home, ['route', 'migrate', '--rollback'], 'usage')
    assert.deepEqual(await readdir(lockRoot), locksBefore)
  } finally {
    await fixture.cleanup()
  }
})

test('Route writer lifecycle and migration work from a separate Desk boundary', async () => {
  const fixture = await siteFixture({ deskStrategy: 'separate' })
  try {
    const { home, repository } = fixture
    assert.equal((await runtimeJson(home, ['route', 'park', 'demo'])).status, 'parked')
    assert.equal((await runtimeJson(home, ['route', 'activate', 'demo'])).status, 'activated')
    const routePath = join(home, '.desk/routes/demo/main.json')
    await writeLegacyRoute(routePath, {
      $schema: 'https://endroit.org/schema/v7/route.json',
      id: 'main',
      site: 'demo',
      mode: 'existing',
      path: await realpath(repository),
      branch: 'main',
    })
    const migrated = await runtimeJson(home, ['route', 'migrate', 'demo'])
    assert.equal(migrated.status, 'migrated')
    assert.equal((await runtimeJson(home, ['route', 'migrate', '--rollback', migrated.runId])).status, 'rolled-back')
    assert.equal(await pathExists(join(home, '.endroit/locks/routes.lock')), false)
  } finally {
    await fixture.cleanup()
  }
})

test('Route migration resumes after a fault immediately after durable directory creation', async () => {
  const fixture = await siteFixture()
  const previousNodeEnv = process.env.NODE_ENV
  try {
    const { home, repository } = fixture
    const routePath = join(home, '.desk/routes/demo/main.json')
    await writeLegacyRoute(routePath, {
      $schema: 'https://endroit.org/schema/v7/route.json',
      id: 'main',
      site: 'demo',
      mode: 'existing',
      path: await realpath(repository),
      branch: 'main',
    })
    process.env.NODE_ENV = 'test'
    process.env.ENDROIT_TEST_FAULT_AFTER_DIRECTORY_FSYNC = '.endroit/migrations'
    await runtimeFailure(home, ['route', 'migrate', 'demo'], 'route_directory_fault')
    assert.equal(JSON.parse(await readFile(routePath, 'utf8')).$schema, 'https://endroit.org/schema/v7/route.json')
    assert.equal(await pathExists(join(home, '.endroit/migrations')), true)
    assert.equal(await pathExists(join(home, '.endroit/migrations/checkout-v8')), false)
    delete process.env.ENDROIT_TEST_FAULT_AFTER_DIRECTORY_FSYNC
    const migrated = await runtimeJson(home, ['route', 'migrate', 'demo'])
    assert.equal(migrated.status, 'migrated')
    assert.equal((await runtimeJson(home, ['route', 'migrate', '--rollback', migrated.runId])).status, 'rolled-back')
  } finally {
    delete process.env.ENDROIT_TEST_FAULT_AFTER_DIRECTORY_FSYNC
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = previousNodeEnv
    await fixture.cleanup()
  }
})

test('concurrent supersede and replacement removal cannot leave a dangling Route relation', async () => {
  const fixture = await siteFixture()
  try {
    const { home } = fixture
    await runtimeJson(home, ['checkout', 'worktree', 'demo', '--id', 'replacement', '--from', 'main', '--new-branch', 'replacement'])
    const lockPath = join(home, '.endroit/locks/routes.lock')
    const supersedePromise = cliResult(home, ['route', 'supersede', 'demo', '--id', 'main', '--by', 'replacement'], {
      NODE_ENV: 'test',
      ENDROIT_TEST_HOLD_ROUTE_WRITER_MS: '250',
    })
    await waitForPath(lockPath)
    const remove = await cliResult(home, ['checkout', 'delete', 'checkout:demo/replacement', '--approve', 'checkout:demo/replacement'])
    const supersede = await supersedePromise
    assert.equal(supersede.code, 0, supersede.stderr)
    assert.notEqual(remove.code, 0)
    assert.match(remove.stderr, /route_writer_locked/)
    const listed = await runtimeJson(home, ['route', 'list', 'demo'])
    for (const route of listed.routes.filter((entry) => entry.declared.status === 'superseded')) {
      assert.equal(listed.routes.some((entry) => entry.id === route.declared.supersededBy), true)
    }
  } finally {
    await fixture.cleanup()
  }
})

async function legacyRouteSet(home, repository) {
  await runtimeJson(home, ['checkout', 'worktree', 'demo', '--id', 'legacy-worktree', '--from', 'main', '--new-branch', 'legacy-worktree'])
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
  if (path.endsWith('.json')) await rm(path.slice(0, -5), { recursive: true, force: true })
  const bytes = Buffer.from(`${JSON.stringify(document, null, 2)}\n`)
  await writeFile(path, bytes)
  await chmod(path, mode)
  return bytes
}

function routeDocumentPath(home, site, route) {
  return join(home, `.desk/routes/${site}/${route}/ROUTE.md`)
}

async function routeMetadata(home, site, route) {
  return parseDocument(await readFile(routeDocumentPath(home, site, route), 'utf8'), { path: routeDocumentPath(home, site, route) }).metadata
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

async function siteFixture(options = {}) {
  const temporary = await mkdtemp(join(tmpdir(), 'endroit-site-worktrees-'))
  const home = join(temporary, 'home')
  const repository = join(temporary, 'repository')
  const remote = join(temporary, 'remote.git')
  await createHome(home, { deskStrategy: options.deskStrategy })
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

async function deleteManaged(home, site, route) {
  const ref = `checkout:${site}/${route}`
  return runtimeJson(home, ['checkout', 'delete', ref, '--approve', ref])
}

async function cliResult(home, args, environment = {}) {
  try {
    const { stdout, stderr } = await exec(process.execPath, [cliPath, ...args, '--home', home, '--json'], {
      cwd: home,
      env: { ...process.env, ...environment },
    })
    return { code: 0, stdout, stderr }
  } catch (error) {
    return {
      code: typeof error.code === 'number' ? error.code : 4,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? error.message,
    }
  }
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

async function waitForPath(path, timeout = 2_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await pathExists(path)) return
    await delay(10)
  }
  assert.fail(`Timed out waiting for ${path}`)
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
