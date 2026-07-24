import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import {
  addAssets,
  diffAsset,
  overrideAsset,
  publishAsset,
  removeAsset,
  reviewAsset,
  statusAssets,
  syncAssets,
} from '../src/assets.mjs'
import { buildHome } from '../src/build.mjs'
import { createHome } from '../src/create.mjs'
import { dispatchRuntime, runtimeTrust, runtimeTrustState } from '../src/runtime.mjs'
import { asset, captureIo, writeAsset } from './helpers.mjs'

const exec = promisify(execFile)

test('Asset add, sync and remove preserve source ownership and unknown files', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'hairness-lifecycle-'))
  try {
    const home = join(temporary, 'home')
    await createHome(home)
    const v1 = await writeAsset(join(temporary, 'v1'), asset(), { 'capabilities/review.md': 'Review version one.\n' })
    const review = await reviewAsset(home, v1)
    assert.equal(review.installed, false)
    assert.deepEqual(review.files, ['capabilities/review.md'])
    await addAssets(home, [v1])
    assert.equal((await statusAssets(home, 'fixture/review'))[0].state, 'clean')
    await buildHome(home)
    assert.match(await readFile(join(home, '.agents/skills/review-review/SKILL.md'), 'utf8'), /version one/)

    const sourceFile = join(home, 'assets/fixture/review/capabilities/review.md')
    await writeFile(sourceFile, 'Local customization.\n')
    assert.equal((await statusAssets(home, 'review'))[0].state, 'customized')
    const v2 = await writeAsset(join(temporary, 'v2'), asset({
      version: '2.0.0',
      files: ['capabilities/review.md', 'reference.md'],
      references: [{ id: 'reference', path: 'reference.md' }],
    }), {
      'capabilities/review.md': 'Review version two.\n',
      'reference.md': 'New reference.\n',
    })
    const before = await readFile(sourceFile)
    await assert.rejects(() => syncAssets(home, 'review', { to: v2 }), (error) => error.code === 'sync_customized')
    assert.deepEqual(await readFile(sourceFile), before)
    assert.equal((await diffAsset(home, 'review', { to: v2 })).files.find((file) => file.path === 'reference.md').change, 'added')

    const unknown = join(home, 'assets/fixture/review/notes.md')
    await writeFile(unknown, 'Local note.\n')
    await syncAssets(home, 'review', { to: v2, overwrite: true })
    assert.equal(await readFile(unknown, 'utf8'), 'Local note.\n')
    assert.equal(await readFile(sourceFile, 'utf8'), 'Review version two.\n')
    await removeAsset(home, 'review')
    assert.equal(await readFile(unknown, 'utf8'), 'Local note.\n')
    await assert.rejects(readFile(sourceFile), (error) => error.code === 'ENOENT')
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
})

test('Desk overrides publish only while their Home base is unchanged', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'hairness-override-'))
  try {
    const home = join(temporary, 'home')
    await createHome(home)
    const source = await writeAsset(join(temporary, 'source'), asset(), { 'capabilities/review.md': 'Base.\n' })
    await addAssets(home, [source])
    await overrideAsset(home, 'fixture/review')
    const deskSource = join(home, '.desk/assets/fixture/review/capabilities/review.md')
    await writeFile(deskSource, 'Desk improvement.\n')
    await publishAsset(home, 'fixture/review')
    assert.equal(await readFile(join(home, 'assets/fixture/review/capabilities/review.md'), 'utf8'), 'Desk improvement.\n')
    await assert.rejects(readFile(join(home, '.desk/assets/fixture/review/asset.json')), (error) => error.code === 'ENOENT')

    await overrideAsset(home, 'fixture/review')
    await writeFile(join(home, 'assets/fixture/review/capabilities/review.md'), 'Concurrent Home edit.\n')
    await assert.rejects(() => publishAsset(home, 'fixture/review'), (error) => error.code === 'asset_base_drifted')
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
})

test('external runtimes are inert until their exact digest is trusted', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'hairness-runtime-'))
  try {
    const home = join(temporary, 'home')
    await createHome(home)
    const runtime = await writeAsset(join(temporary, 'runtime'), asset({
      name: 'fixture/echo',
      files: ['runtime.mjs'],
      capabilities: undefined,
      skills: undefined,
      commands: undefined,
      runtime: {
        namespace: 'echo',
        entry: 'runtime.mjs',
        commands: [{ name: 'show', description: 'Echo the runtime input.' }],
      },
    }), {
      'runtime.mjs': "import { writeFileSync } from 'node:fs'; import { join } from 'node:path'; let body=''; for await (const chunk of process.stdin) body += chunk; const input=JSON.parse(body); writeFileSync(join(input.homeRoot,'runtime-ran'),'yes\\n'); process.stdout.write(JSON.stringify({argv:input.argv,home:input.resolvedHome.home.name}));\n",
    })
    await addAssets(home, [runtime])
    await assert.rejects(readFile(join(home, 'runtime-ran')), (error) => error.code === 'ENOENT')
    await buildHome(home)
    await assert.rejects(readFile(join(home, 'runtime-ran')), (error) => error.code === 'ENOENT')
    const installedReview = await reviewAsset(home, 'fixture/echo')
    assert.equal(installedReview.local.state, 'clean')
    assert.match(installedReview.fileDigests['runtime.mjs'], /^sha256:/)
    const trust = await runtimeTrustState(home, 'fixture/echo')
    assert.equal(trust.trusted, false)
    await assert.rejects(() => dispatchRuntime(home, 'echo', ['show']), (error) => error.code === 'runtime_trust_required')
    await assert.rejects(() => runtimeTrust(home, 'echo', { digest: 'sha256:' + '0'.repeat(64) }), (error) => error.code === 'runtime_digest_mismatch')
    await runtimeTrust(home, 'echo', { digest: trust.digest })
    const capture = captureIo()
    assert.equal(await dispatchRuntime(home, 'echo', ['show', '--value', 'one'], capture.io), 0)
    assert.deepEqual(JSON.parse(capture.stdout()), { argv: ['show', '--value', 'one'], home: 'home' })
    assert.equal(await readFile(join(home, 'runtime-ran'), 'utf8'), 'yes\n')

    await writeFile(join(home, 'assets/fixture/echo/runtime.mjs'), "process.stdout.write('changed')\n")
    assert.equal((await runtimeTrustState(home, 'fixture/echo')).trusted, false)
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
})

test('HTTPS and Git sources retain pinned or mobile provenance', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'hairness-sources-'))
  const previousFetch = globalThis.fetch
  const previousGit = Object.fromEntries(['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0', 'GIT_CONFIG_KEY_1', 'GIT_CONFIG_VALUE_1'].map((key) => [key, process.env[key]]))
  try {
    const home = join(temporary, 'home')
    await createHome(home)
    globalThis.fetch = async (url) => String(url).endsWith('asset.json')
      ? new Response(JSON.stringify(asset({ name: 'remote/review' })), { status: 200 })
      : new Response('Remote review.\n', { status: 200 })
    await addAssets(home, ['https://assets.example/review/asset.json'])
    const remote = JSON.parse(await readFile(join(home, 'assets/remote/review/asset.json'), 'utf8'))
    assert.equal(remote.origin.mobile, true)
    await assert.rejects(() => addAssets(home, ['https://assets.example/asset.json?token=secret']), (error) => error.code === 'source_insecure')

    const repository = join(temporary, 'source')
    const github = join(temporary, 'github')
    const bare = join(github, 'acme/assets.git')
    await exec('git', ['init', '--quiet', '--initial-branch=main', repository])
    await writeAsset(join(repository, 'assets/audit'), asset({ name: 'acme/audit', prefix: 'audit' }), { 'capabilities/review.md': 'Git review.\n' })
    await exec('git', ['add', '--all'], { cwd: repository })
    await exec('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '-m', 'asset'], { cwd: repository })
    await exec('git', ['tag', 'v1.0.0'], { cwd: repository })
    await mkdir(join(github, 'acme'), { recursive: true })
    await exec('git', ['clone', '--quiet', '--bare', repository, bare])
    const commit = (await exec('git', ['rev-parse', 'HEAD'], { cwd: repository })).stdout.trim()
    process.env.GIT_CONFIG_COUNT = '2'
    process.env.GIT_CONFIG_KEY_0 = `url.file://${github}/.insteadOf`
    process.env.GIT_CONFIG_VALUE_0 = 'https://github.com/'
    process.env.GIT_CONFIG_KEY_1 = 'protocol.file.allow'
    process.env.GIT_CONFIG_VALUE_1 = 'always'
    await addAssets(home, ['acme/assets/assets/audit#v1.0.0'])
    const gitAsset = JSON.parse(await readFile(join(home, 'assets/acme/audit/asset.json'), 'utf8'))
    assert.equal(gitAsset.origin.requestedRef, 'v1.0.0')
    assert.equal(gitAsset.origin.resolvedCommit, commit)
    assert.equal(gitAsset.origin.mobile, false)
  } finally {
    globalThis.fetch = previousFetch
    for (const [key, value] of Object.entries(previousGit)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(temporary, { recursive: true, force: true })
  }
})

test('symlinks and runtime namespace collisions are rejected before installation', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'hairness-safety-'))
  try {
    const home = join(temporary, 'home')
    await createHome(home)
    const linked = await writeAsset(join(temporary, 'linked'), asset({ files: ['capabilities/review.md'] }))
    await mkdir(join(temporary, 'linked/capabilities'), { recursive: true })
    await writeFile(join(temporary, 'outside.md'), 'outside\n')
    await symlink(join(temporary, 'outside.md'), join(temporary, 'linked/capabilities/review.md'))
    await assert.rejects(() => addAssets(home, [linked]), (error) => error.code === 'symlink_forbidden')

    const colliding = await writeAsset(join(temporary, 'colliding'), asset({
      name: 'fixture/other',
      files: ['runtime.mjs'],
      capabilities: undefined,
      skills: undefined,
      commands: undefined,
      runtime: {
        namespace: 'hud',
        entry: 'runtime.mjs',
        commands: [{ name: 'show', description: 'Collide with the HUD namespace.' }],
      },
    }), { 'runtime.mjs': '' })
    await assert.rejects(() => addAssets(home, [colliding]), (error) => error.code === 'capability_collision')
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
})
