import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import {
  addAssets,
  overrideAsset,
  publishAsset,
  removeAsset,
  statusAssets,
  syncAssets,
  validateAssetSource,
} from '../src/assets.mjs'
import { buildHome } from '../src/build.mjs'
import { runCli } from '../src/cli.mjs'
import { createHome } from '../src/create.mjs'
import { doctorHome } from '../src/doctor.mjs'
import { resolveHome } from '../src/resolved.mjs'
import { dispatchRuntime, runtimeTrust, runtimeTrustState } from '../src/runtime.mjs'
import { asset, captureIo, writeAsset } from './helpers.mjs'

const exec = promisify(execFile)
const cliPath = new URL('../bin/hairness.mjs', import.meta.url).pathname

test('Asset add, sync and remove preserve source ownership and unknown files', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'hairness-lifecycle-'))
  try {
    const home = join(temporary, 'home')
    await createHome(home)
    const v1 = await writeAsset(join(temporary, 'v1'), asset(), { 'capabilities/review.md': 'Review version one.\n' })
    const validation = await validateAssetSource(temporary, v1)
    assert.equal(validation.status, 'valid')
    assert.match(validation.digest, /^sha256:/)
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
    const check = (await syncAssets(home, 'review', { to: v2, check: true }))[0]
    assert.equal(check.status, 'blocked')
    assert.equal(check.files.find((file) => file.path === 'reference.md').change, 'added')

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

test('external runtimes stay pending until their exact digest is approved', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'hairness-runtime-'))
  try {
    const home = join(temporary, 'home')
    await createHome(home)
    const runtime = await writeAsset(join(temporary, 'runtime'), asset({
      name: 'hairness/echo',
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
      'runtime.mjs': "import { writeFileSync } from 'node:fs'; import { join } from 'node:path'; let body=''; for await (const chunk of process.stdin) body += chunk; const input=JSON.parse(body); writeFileSync(join(input.homeRoot,'runtime-ran'),'yes\\n'); process.stdout.write(JSON.stringify({argv:input.argv,home:input.resolvedHome.home.name,invoke:input.kernel.invoke,invocation:input.invocation}));\n",
    })
    await addAssets(home, [runtime])
    await assert.rejects(readFile(join(home, 'runtime-ran')), (error) => error.code === 'ENOENT')
    const documentPath = join(home, 'hairness.json')
    const document = JSON.parse(await readFile(documentPath, 'utf8'))
    document.frontDoor = { wakeUp: 'hairness/echo:show' }
    await writeFile(documentPath, `${JSON.stringify(document, null, 2)}\n`)
    await buildHome(home)
    await assert.rejects(readFile(join(home, 'runtime-ran')), (error) => error.code === 'ENOENT')
    const launcher = join(home, '.hairness/dev-cli')
    await writeFile(launcher, `#!/usr/bin/env node\nawait import(${JSON.stringify(new URL(`file://${cliPath}`).href)})\n`)
    await chmod(launcher, 0o755)
    const wakeUp = (await exec(process.execPath, [join(home, '.claude/hooks/hairness-session-start.mjs')], { cwd: home })).stdout
    assert.equal(wakeUp, '<hairness-front-door version="1" status="degraded" reason="wake-up-unavailable" />\n')
    await assert.rejects(readFile(join(home, 'runtime-ran')), (error) => error.code === 'ENOENT')
    const installed = (await statusAssets(home, 'hairness/echo'))[0]
    assert.equal(installed.state, 'clean')
    assert.match(installed.effectiveDigest, /^sha256:/)
    const trust = await runtimeTrustState(home, 'hairness/echo')
    assert.equal(trust.trust, 'pending')
    await assert.rejects(() => dispatchRuntime(home, 'echo', ['show']), (error) => error.code === 'runtime_trust_required')
    await assert.rejects(() => runtimeTrust(home, 'echo', { digest: 'sha256:' + '0'.repeat(64) }), (error) => error.code === 'runtime_digest_mismatch')
    assert.equal((await runtimeTrust(home, 'echo', { digest: trust.digest })).trust, 'approved')
    assert.equal((await runtimeTrustState(home, 'hairness/echo')).trust, 'approved')
    const capture = captureIo()
    assert.equal(await dispatchRuntime(home, 'echo', ['show', '--value', 'one'], capture.io), 0)
    assert.deepEqual(JSON.parse(capture.stdout()), {
      argv: ['show', '--value', 'one'],
      home: 'home',
      invoke: 'node ./hairness.mjs',
      invocation: { kind: 'command' },
    })
    assert.equal(await readFile(join(home, 'runtime-ran'), 'utf8'), 'yes\n')

    await writeFile(join(home, 'assets/hairness/echo/runtime.mjs'), "process.stdout.write('changed')\n")
    assert.equal((await runtimeTrustState(home, 'hairness/echo')).trust, 'pending')
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

    const namespaceCollision = await writeAsset(join(temporary, 'namespace-collision'), asset({
      name: 'fixture/target-notes',
      workspaceNamespace: 'targeting',
    }), { 'capabilities/review.md': 'Target notes.\n' })
    await assert.rejects(() => addAssets(home, [namespaceCollision]), (error) => error.code === 'capability_collision')
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
})

test('Front Door routes remain valid across Asset mutations', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'hairness-front-door-'))
  try {
    const home = join(temporary, 'home')
    await createHome(home)
    await assert.rejects(() => removeAsset(home, 'hairness/hud'), (error) => error.code === 'front_door_runtime_missing')
    assert.equal((await statusAssets(home, 'hairness/hud'))[0].state, 'clean')

    const incompatible = await writeAsset(join(temporary, 'incompatible'), asset({
      name: 'hairness/hud',
      files: ['runtime.mjs'],
      capabilities: undefined,
      skills: undefined,
      commands: undefined,
      runtime: {
        namespace: 'hud',
        entry: 'runtime.mjs',
        commands: [{ name: 'show', description: 'Show only.' }],
      },
    }), { 'runtime.mjs': 'process.stdout.write("no prompt")\n' })
    await assert.rejects(
      () => syncAssets(home, 'hairness/hud', { to: incompatible, check: true }),
      (error) => error.code === 'front_door_command_missing',
    )

    const documentPath = join(home, 'hairness.json')
    const document = JSON.parse(await readFile(documentPath, 'utf8'))
    document.frontDoor.wakeUp = 'missing/runtime:prompt'
    await writeFile(documentPath, `${JSON.stringify(document, null, 2)}\n`)
    await assert.rejects(() => resolveHome(home), (error) => error.code === 'front_door_runtime_missing')
    const doctor = await doctorHome(home)
    assert.equal(doctor.status, 'partial')
    assert.deepEqual(doctor.limits, ['front_door_runtime_missing'])
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
})

test('standalone Asset validation checks referenced schemas outside a Home', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'hairness-asset-validation-'))
  try {
    const source = await writeAsset(join(temporary, 'source'), asset({
      files: ['capabilities/review.md', 'schemas/result.schema.json', 'templates/result.md'],
      artifactKinds: [{
        id: 'result',
        schema: 'schemas/result.schema.json',
        template: 'templates/result.md',
        owners: ['desk'],
      }],
    }), {
      'capabilities/review.md': 'Review.\n',
      'schemas/result.schema.json': '{"type":"object"}\n',
      'templates/result.md': '# Result\n',
    })
    assert.equal((await validateAssetSource(temporary, source)).status, 'valid')
    const cli = captureIo()
    assert.equal(await runCli(['asset', 'validate', source, '--json'], cli.io), 0)
    assert.equal(JSON.parse(cli.stdout()).name, 'fixture/review')
    await writeFile(join(temporary, 'source/schemas/result.schema.json'), '{broken\n')
    await assert.rejects(() => validateAssetSource(temporary, source), (error) => error.code === 'asset_schema_invalid')
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
})
