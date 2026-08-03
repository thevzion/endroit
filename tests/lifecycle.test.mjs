import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { removeTree } from '../src/lib/io.mjs'
import {
  addEquipment,
  overrideEquipment,
  publishEquipment,
  removeEquipment,
  statusEquipment,
  syncEquipment,
  validateEquipmentSource,
} from '../src/equipment.mjs'
import { buildHome } from '../src/build.mjs'
import { runCli } from '../src/cli.mjs'
import { createHome } from '../src/create.mjs'
import { doctorHome } from '../src/doctor.mjs'
import { resolveHome } from '../src/resolved.mjs'
import { dispatchRuntime, runtimeTrust, runtimeTrustState } from '../src/runtime.mjs'
import { equipment, captureIo, writeEquipment } from './helpers.mjs'

const exec = promisify(execFile)
const cliPath = new URL('../bin/endroit.mjs', import.meta.url).pathname

test('Equipment add, sync and remove preserve source ownership and unknown files', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'endroit-lifecycle-'))
  try {
    const home = join(temporary, 'home')
    await createHome(home)
    const v1 = await writeEquipment(join(temporary, 'v1'), equipment(), { 'capabilities/review.md': 'Review version one.\n' })
    const validation = await validateEquipmentSource(temporary, v1)
    assert.equal(validation.status, 'valid')
    assert.match(validation.digest, /^sha256:/)
    await addEquipment(home, [v1])
    assert.equal((await statusEquipment(home, 'fixture/review'))[0].state, 'clean')
    await buildHome(home)
    assert.match(await readFile(join(home, '.agents/skills/review-review/SKILL.md'), 'utf8'), /version one/)

    const sourceFile = join(home, 'equipment/fixture/review/capabilities/review.md')
    await writeFile(sourceFile, 'Local customization.\n')
    assert.equal((await statusEquipment(home, 'review'))[0].state, 'customized')
    const v2 = await writeEquipment(join(temporary, 'v2'), equipment({
      version: '2.0.0',
      files: ['capabilities/review.md', 'reference.md'],
      references: [{ id: 'reference', path: 'reference.md' }],
    }), {
      'capabilities/review.md': 'Review version two.\n',
      'reference.md': 'New reference.\n',
    })
    const before = await readFile(sourceFile)
    await assert.rejects(() => syncEquipment(home, 'review', { to: v2 }), (error) => error.code === 'sync_customized')
    assert.deepEqual(await readFile(sourceFile), before)
    const check = (await syncEquipment(home, 'review', { to: v2, check: true }))[0]
    assert.equal(check.status, 'blocked')
    assert.equal(check.files.find((file) => file.path === 'reference.md').change, 'added')

    const unknown = join(home, 'equipment/fixture/review/notes.md')
    await writeFile(unknown, 'Local note.\n')
    await syncEquipment(home, 'review', { to: v2, overwrite: true })
    assert.equal(await readFile(unknown, 'utf8'), 'Local note.\n')
    assert.equal(await readFile(sourceFile, 'utf8'), 'Review version two.\n')
    await removeEquipment(home, 'review')
    assert.equal(await readFile(unknown, 'utf8'), 'Local note.\n')
    await assert.rejects(readFile(sourceFile), (error) => error.code === 'ENOENT')
  } finally {
    await removeTree(temporary, { force: true })
  }
})

test('Capability-only Equipment installs and resolves without projecting a public accessor', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'endroit-capability-only-'))
  try {
    const home = join(temporary, 'home')
    await createHome(home)
    const source = await writeEquipment(join(temporary, 'control-decks'), equipment({
      name: 'control-decks/endroit-context',
      skills: undefined,
      commands: undefined,
    }), { 'capabilities/review.md': 'Own the HACP Cards without exposing a provider accessor.\n' })

    await addEquipment(home, [source])
    const plan = await resolveHome(home)
    assert.ok(plan.capabilities.some((entry) => entry.id === 'control-decks/endroit-context:review'))
    assert.equal(plan.skills.some((entry) => entry.owner === 'control-decks/endroit-context'), false)
    assert.equal(plan.commands.some((entry) => entry.owner === 'control-decks/endroit-context'), false)

    const build = await buildHome(home)
    assert.equal(build.outputs.some((entry) => entry.owner === 'control-decks/endroit-context'), false)
    await buildHome(home, { check: true })
  } finally {
    await removeTree(temporary, { force: true })
  }
})

test('Desk overrides publish only while their Home base is unchanged', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'endroit-override-'))
  try {
    const home = join(temporary, 'home')
    await createHome(home)
    const source = await writeEquipment(join(temporary, 'source'), equipment(), { 'capabilities/review.md': 'Base.\n' })
    await addEquipment(home, [source])
    await overrideEquipment(home, 'fixture/review')
    const deskSource = join(home, '.desk/equipment/fixture/review/capabilities/review.md')
    await writeFile(deskSource, 'Desk improvement.\n')
    await publishEquipment(home, 'fixture/review')
    assert.equal(await readFile(join(home, 'equipment/fixture/review/capabilities/review.md'), 'utf8'), 'Desk improvement.\n')
    await assert.rejects(readFile(join(home, '.desk/equipment/fixture/review/equipment.json')), (error) => error.code === 'ENOENT')

    await overrideEquipment(home, 'fixture/review')
    await writeFile(join(home, 'equipment/fixture/review/capabilities/review.md'), 'Concurrent Home edit.\n')
    await assert.rejects(() => publishEquipment(home, 'fixture/review'), (error) => error.code === 'equipment_base_drifted')
  } finally {
    await removeTree(temporary, { force: true })
  }
})

test('external runtimes stay pending until their exact digest is approved', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'endroit-runtime-'))
  try {
    const home = join(temporary, 'home')
    await createHome(home)
    const runtime = await writeEquipment(join(temporary, 'runtime'), equipment({
      name: 'endroit/echo',
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
      'runtime.mjs': "import { writeFileSync } from 'node:fs'; import { join } from 'node:path'; let body=''; for await (const chunk of process.stdin) body += chunk; const input=JSON.parse(body); writeFileSync(join(input.homeRoot,'runtime-ran'),'yes\\n'); process.stdout.write(JSON.stringify({protocol:input.protocol,argv:input.argv,home:input.resolvedHome.home.name,equipmentRoot:input.equipmentRoot,invoke:input.kernel.invoke,invocation:input.invocation,rootArtifacts:Object.hasOwn(input,'artifacts'),inspection:input.inspection??null}));\n",
    })
    await addEquipment(home, [runtime])
    await assert.rejects(readFile(join(home, 'runtime-ran')), (error) => error.code === 'ENOENT')
    const documentPath = join(home, 'endroit.json')
    const document = JSON.parse(await readFile(documentPath, 'utf8'))
    document.frontDoor = { wakeUp: 'endroit/echo:show' }
    await writeFile(documentPath, `${JSON.stringify(document, null, 2)}\n`)
    await buildHome(home)
    await assert.rejects(readFile(join(home, 'runtime-ran')), (error) => error.code === 'ENOENT')
    const launcher = join(home, '.endroit/dev-cli')
    await writeFile(launcher, `#!/usr/bin/env node\nawait import(${JSON.stringify(new URL(`file://${cliPath}`).href)})\n`)
    await chmod(launcher, 0o755)
    const wakeUp = (await exec(process.execPath, [join(home, '.claude/hooks/endroit-session-start.mjs')], { cwd: home })).stdout
    assert.equal(wakeUp, '<endroit-front-door version="1" status="degraded" reason="wake-up-unavailable" />\n')
    await assert.rejects(readFile(join(home, 'runtime-ran')), (error) => error.code === 'ENOENT')
    const installed = (await statusEquipment(home, 'endroit/echo'))[0]
    assert.equal(installed.state, 'clean')
    assert.match(installed.effectiveDigest, /^sha256:/)
    const trust = await runtimeTrustState(home, 'endroit/echo')
    assert.equal(trust.trust, 'pending')
    await assert.rejects(() => dispatchRuntime(home, 'echo', ['show']), (error) => error.code === 'runtime_trust_required')
    await assert.rejects(() => runtimeTrust(home, 'echo', { digest: 'sha256:' + '0'.repeat(64) }), (error) => error.code === 'runtime_digest_mismatch')
    assert.equal((await runtimeTrust(home, 'echo', { digest: trust.digest })).trust, 'approved')
    assert.equal((await runtimeTrustState(home, 'endroit/echo')).trust, 'approved')
    const capture = captureIo()
    assert.equal(await dispatchRuntime(home, 'echo', ['show', '--value', 'one'], capture.io), 0)
    assert.deepEqual(JSON.parse(capture.stdout()), {
      protocol: 'endroit.org/runtime/v2alpha1',
      argv: ['show', '--value', 'one'],
      home: 'home',
      equipmentRoot: join(home, 'equipment/endroit/echo'),
      invoke: 'node ./endroit.mjs',
      invocation: { kind: 'command' },
      rootArtifacts: false,
      inspection: null,
    })
    assert.equal(await readFile(join(home, 'runtime-ran'), 'utf8'), 'yes\n')

    await writeFile(join(home, 'equipment/endroit/echo/runtime.mjs'), "process.stdout.write('changed')\n")
    assert.equal((await runtimeTrustState(home, 'endroit/echo')).trust, 'pending')
  } finally {
    await removeTree(temporary, { force: true })
  }
})

test('HTTPS and Git sources retain pinned or mobile provenance', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'endroit-sources-'))
  const previousFetch = globalThis.fetch
  const previousGit = Object.fromEntries(['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0', 'GIT_CONFIG_KEY_1', 'GIT_CONFIG_VALUE_1'].map((key) => [key, process.env[key]]))
  try {
    const home = join(temporary, 'home')
    await createHome(home)
    globalThis.fetch = async (url) => String(url).endsWith('equipment.json')
      ? new Response(JSON.stringify(equipment({ name: 'remote/review' })), { status: 200 })
      : new Response('Remote review.\n', { status: 200 })
    await addEquipment(home, ['https://equipment.example/review/equipment.json'])
    const remote = JSON.parse(await readFile(join(home, 'equipment/remote/review/equipment.json'), 'utf8'))
    assert.equal(remote.origin.mobile, true)
    await assert.rejects(() => addEquipment(home, ['https://equipment.example/equipment.json?token=secret']), (error) => error.code === 'source_insecure')

    const repository = join(temporary, 'source')
    const github = join(temporary, 'github')
    const bare = join(github, 'acme/equipment.git')
    await exec('git', ['init', '--quiet', '--initial-branch=main', repository])
    await writeEquipment(join(repository, 'equipment/audit'), equipment({ name: 'acme/audit', prefix: 'audit' }), { 'capabilities/review.md': 'Git review.\n' })
    await exec('git', ['add', '--all'], { cwd: repository })
    await exec('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '-m', 'equipment'], { cwd: repository })
    await exec('git', ['tag', 'v1.0.0'], { cwd: repository })
    await mkdir(join(github, 'acme'), { recursive: true })
    await exec('git', ['clone', '--quiet', '--bare', repository, bare])
    const commit = (await exec('git', ['rev-parse', 'HEAD'], { cwd: repository })).stdout.trim()
    process.env.GIT_CONFIG_COUNT = '2'
    process.env.GIT_CONFIG_KEY_0 = `url.file://${github}/.insteadOf`
    process.env.GIT_CONFIG_VALUE_0 = 'https://github.com/'
    process.env.GIT_CONFIG_KEY_1 = 'protocol.file.allow'
    process.env.GIT_CONFIG_VALUE_1 = 'always'
    await addEquipment(home, ['acme/equipment/equipment/audit#v1.0.0'])
    const gitEquipment = JSON.parse(await readFile(join(home, 'equipment/acme/audit/equipment.json'), 'utf8'))
    assert.equal(gitEquipment.origin.requestedRef, 'v1.0.0')
    assert.equal(gitEquipment.origin.resolvedCommit, commit)
    assert.equal(gitEquipment.origin.mobile, false)
  } finally {
    globalThis.fetch = previousFetch
    for (const [key, value] of Object.entries(previousGit)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await removeTree(temporary, { force: true })
  }
})

test('symlinks and runtime namespace collisions are rejected before installation', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'endroit-safety-'))
  try {
    const home = join(temporary, 'home')
    await createHome(home)
    const linked = await writeEquipment(join(temporary, 'linked'), equipment({ files: ['capabilities/review.md'] }))
    await mkdir(join(temporary, 'linked/capabilities'), { recursive: true })
    await writeFile(join(temporary, 'outside.md'), 'outside\n')
    await symlink(join(temporary, 'outside.md'), join(temporary, 'linked/capabilities/review.md'))
    await assert.rejects(() => addEquipment(home, [linked]), (error) => error.code === 'symlink_forbidden')

    const colliding = await writeEquipment(join(temporary, 'colliding'), equipment({
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
    await assert.rejects(() => addEquipment(home, [colliding]), (error) => error.code === 'capability_collision')

    const namespaceCollision = await writeEquipment(join(temporary, 'namespace-collision'), equipment({
      name: 'fixture/site-notes',
      roomNamespace: 'site-mapping',
    }), { 'capabilities/review.md': 'Site notes.\n' })
    await assert.rejects(() => addEquipment(home, [namespaceCollision]), (error) => error.code === 'capability_collision')
  } finally {
    await removeTree(temporary, { force: true })
  }
})

test('Front Door routes remain valid across Equipment mutations', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'endroit-front-door-'))
  try {
    const home = join(temporary, 'home')
    await createHome(home)
    await assert.rejects(() => removeEquipment(home, 'endroit/hud'), (error) => error.code === 'front_door_runtime_missing')
    assert.equal((await statusEquipment(home, 'endroit/hud'))[0].state, 'clean')

    const incompatible = await writeEquipment(join(temporary, 'incompatible'), equipment({
      name: 'endroit/hud',
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
      () => syncEquipment(home, 'endroit/hud', { to: incompatible, check: true }),
      (error) => error.code === 'front_door_command_missing',
    )

    const documentPath = join(home, 'endroit.json')
    const document = JSON.parse(await readFile(documentPath, 'utf8'))
    document.frontDoor.wakeUp = 'missing/runtime:prompt'
    await writeFile(documentPath, `${JSON.stringify(document, null, 2)}\n`)
    await assert.rejects(() => resolveHome(home), (error) => error.code === 'front_door_runtime_missing')
    const doctor = await doctorHome(home)
    assert.equal(doctor.status, 'partial')
    assert.deepEqual(doctor.limits, ['front_door_runtime_missing'])
  } finally {
    await removeTree(temporary, { force: true })
  }
})

test('standalone Equipment validation checks referenced schemas outside a Home', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'endroit-equipment-validation-'))
  try {
    const source = await writeEquipment(join(temporary, 'source'), equipment({
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
    assert.equal((await validateEquipmentSource(temporary, source)).status, 'valid')
    const cli = captureIo()
    assert.equal(await runCli(['equipment', 'validate', source, '--json'], cli.io), 0)
    assert.equal(JSON.parse(cli.stdout()).name, 'fixture/review')
    await writeFile(join(temporary, 'source/schemas/result.schema.json'), '{broken\n')
    await assert.rejects(() => validateEquipmentSource(temporary, source), (error) => error.code === 'equipment_schema_invalid')
  } finally {
    await removeTree(temporary, { force: true })
  }
})
