import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { buildHome } from '../src/build.mjs'
import { runCli } from '../src/cli.mjs'
import { compileSchemas, validateDocument } from '../src/contracts.mjs'
import { createHome, initHome } from '../src/create.mjs'
import { cloneDesk, deskStatus, initDesk } from '../src/desk.mjs'
import { doctorHome } from '../src/doctor.mjs'
import { assertRuntime } from '../src/home.mjs'
import { resolveHome } from '../src/resolved.mjs'
import { addAssets } from '../src/assets.mjs'
import { asset, captureIo, writeAsset } from './helpers.mjs'

const exec = promisify(execFile)

test('create builds a source-owned Home and tracks shared provider projections', async () => {
  assert.deepEqual(await compileSchemas(), ['home', 'desk', 'asset', 'runtime'])
  const help = captureIo()
  assert.equal(await runCli([], help.io), 0)
  assert.doesNotMatch(help.stdout(), /\b(?:registry|catalog|prologue|adapter)\b/i)
  const temporary = await mkdtemp(join(tmpdir(), 'hairness-kernel-'))
  try {
    const home = join(temporary, 'home')
    await createHome(home, { providers: ['codex', 'claude'], prefix: 'acme' })
    const document = JSON.parse(await readFile(join(home, 'hairness.json'), 'utf8'))
    await validateDocument(document, 'home')
    assert.deepEqual(document, {
      $schema: 'https://hairness.dev/schema/home.json',
      name: 'home',
      runtime: '@hairness/cli@0.5.0-alpha.0',
      mode: 'solo',
      providers: ['codex', 'claude'],
      prefix: 'acme',
    })
    for (const name of ['artifacts', 'hud', 'onboarding', 'targets']) {
      const manifest = JSON.parse(await readFile(join(home, `assets/hairness/${name}/asset.json`), 'utf8'))
      assert.equal(manifest.origin.source, `@hairness/${name}`)
      assert.match(manifest.origin.baseManifestDigest, /^sha256:[a-f0-9]{64}$/)
    }
    await assert.rejects(readFile(join(home, 'assets/hairness/scratch/asset.json')), (error) => error.code === 'ENOENT')
    const tracked = (await exec('git', ['ls-files'], { cwd: home })).stdout
    for (const path of [
      'AGENTS.md',
      'CLAUDE.md',
      '.agents/skills/acme-hairness-onboarding/SKILL.md',
      '.agents/skills/acme-hairness-artifacts/SKILL.md',
      '.agents/skills/acme-hairness-target-manage/SKILL.md',
      '.claude/settings.json',
      '.claude/hooks/hairness-session-start.mjs',
      '.codex/hooks.json',
      '.codex/hooks/hairness-session-start.mjs',
      'assets/hairness/hud/runtime.mjs',
    ]) assert.match(tracked, new RegExp(`^${escape(path)}$`, 'm'))
    assert.doesNotMatch(tracked, /^\.hairness\//m)
    assert.equal((await doctorHome(home)).status, 'ready')
    await buildHome(home, { check: true })
    const plan = await resolveHome(home)
    assert.deepEqual(plan.runtimes.map((entry) => entry.namespace), ['artifact', 'hud', 'target'])

    document.runtime = '@hairness/cli@9.0.0'
    await writeFile(join(home, 'hairness.json'), `${JSON.stringify(document, null, 2)}\n`)
    await assert.rejects(() => assertRuntime(home), (error) => error.code === 'runtime_mismatch' && /npx --yes/.test(error.message))
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
})

test('provider session wrappers inject exact transport and fail closed without leaking stderr', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'hairness-session-'))
  try {
    const home = join(temporary, 'home')
    await createHome(home)
    const local = join(home, '.hairness/dev-cli')
    await mkdir(join(home, '.hairness'), { recursive: true })
    await executable(local, `#!/usr/bin/env node
process.stdout.write('<hairness-hud source="' + process.env.HAIRNESS_RUNTIME_SOURCE + '"/>\\n')
`)

    const codexPath = join(home, '.codex/hooks/hairness-session-start.mjs')
    const claudePath = join(home, '.claude/hooks/hairness-session-start.mjs')
    const codex = JSON.parse((await exec('node', [codexPath], { cwd: home })).stdout)
    assert.deepEqual(codex, {
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: '<hairness-hud source="development"/>',
      },
    })
    assert.equal((await exec('node', [claudePath], { cwd: home })).stdout, '<hairness-hud source="development"/>\n')

    await executable(local, `#!/usr/bin/env node
process.stderr.write('private-downstream-secret\\n')
process.exitCode = 4
`)
    const failed = (await exec('node', [codexPath], { cwd: home })).stdout
    assert.deepEqual(JSON.parse(failed), {
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: '<hairness-hud status="unavailable" reason="runtime-unavailable"/>',
      },
    })
    assert.doesNotMatch(failed, /private-downstream-secret/)

    await rm(local)
    await symlink('missing-cli', local)
    assert.equal((await exec('node', [claudePath], { cwd: home })).stdout, '<hairness-hud status="unavailable" reason="runtime-unavailable"/>\n')

    await rm(local)
    const fakeBin = join(temporary, 'bin')
    const argsPath = join(temporary, 'npx-args.json')
    await mkdir(fakeBin)
    await executable(join(fakeBin, 'npx'), `#!/usr/bin/env node
import { writeFileSync } from 'node:fs'
writeFileSync(process.env.HAIRNESS_TEST_ARGS, JSON.stringify(process.argv.slice(2)))
process.stdout.write('<hairness-hud source="' + process.env.HAIRNESS_RUNTIME_SOURCE + '"/>\\n')
`)
    const registry = await exec('node', [claudePath], {
      cwd: home,
      env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, HAIRNESS_TEST_ARGS: argsPath },
    })
    assert.equal(registry.stdout, '<hairness-hud source="registry"/>\n')
    assert.deepEqual(JSON.parse(await readFile(argsPath, 'utf8')), [
      '--yes',
      '@hairness/cli@0.5.0-alpha.0',
      'hud',
      '--prompt',
      '--home',
      await realpath(home),
    ])

    const hooks = JSON.parse(await readFile(join(home, '.codex/hooks.json'), 'utf8'))
    hooks.hooks.SessionStart.unshift({
      matcher: 'startup',
      hooks: [
        { type: 'command', command: 'node user-session-hook.mjs' },
        { type: 'command', command: 'npx --yes @hairness/cli@0.5.0-alpha.0 hud --prompt' },
      ],
    })
    await writeFile(join(home, '.codex/hooks.json'), `${JSON.stringify(hooks, null, 2)}\n`)
    await buildHome(home)
    const rebuilt = JSON.parse(await readFile(join(home, '.codex/hooks.json'), 'utf8'))
    assert.deepEqual(rebuilt.hooks.SessionStart, [
      { matcher: 'startup', hooks: [{ type: 'command', command: 'node user-session-hook.mjs' }] },
      {
        matcher: 'startup|resume|clear|compact',
        hooks: [{ type: 'command', command: 'node .codex/hooks/hairness-session-start.mjs' }],
      },
    ])
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
})

test('init stays bare and team Homes remain usable before a private Desk exists', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'hairness-team-'))
  try {
    const home = join(temporary, 'team-home')
    await mkdir(home)
    await initHome(home, { name: 'team-home', mode: 'team', providers: ['codex'] })
    assert.equal((await deskStatus(home)).status, 'missing')
    await buildHome(home)
    assert.equal((await doctorHome(home)).status, 'ready')
    await initDesk(home, { id: 'alexis', git: true })
    assert.equal((await deskStatus(home)).repository, true)

    await exec('git', ['-C', join(home, '.desk'), 'add', '--all'])
    await exec('git', ['-C', join(home, '.desk'), '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '-m', 'desk'])
    const second = join(temporary, 'second-home')
    await mkdir(second)
    await initHome(second, { name: 'second-home', mode: 'team', providers: ['codex'] })
    await cloneDesk(second, join(home, '.desk'))
    assert.equal((await deskStatus(second)).id, 'alexis')
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
})

test('a clone is immediately usable from tracked projections without local build state', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'hairness-clone-'))
  try {
    const source = join(temporary, 'source')
    const clone = join(temporary, 'clone')
    await createHome(source)
    await exec('git', ['clone', '--quiet', source, clone])
    await assert.rejects(readFile(join(clone, '.hairness/build.json')), (error) => error.code === 'ENOENT')
    assert.equal((await doctorHome(clone)).status, 'ready')
    await buildHome(clone, { check: true })
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
})

test('doctor reports a missing runtime as a limit instead of crashing', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'hairness-doctor-'))
  try {
    const home = join(temporary, 'home')
    await createHome(home)
    await rm(join(home, 'assets/hairness/hud/runtime.mjs'))
    const report = await doctorHome(home)
    assert.equal(report.status, 'partial')
    assert.equal(report.runtimes.find((entry) => entry.name === 'hairness/hud').error, 'ENOENT')
    assert.ok(report.limits.includes('runtime-invalid:hairness/hud:ENOENT'))
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
})

test('team Desk projections remain local while Desk sources stay in the nested repository', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'hairness-team-projection-'))
  try {
    const home = join(temporary, 'home')
    await createHome(home, { mode: 'team', providers: ['codex'] })
    await initDesk(home, { id: 'alexis', git: true })
    const source = await writeAsset(join(temporary, 'personal'), asset({
      name: 'alexis/review',
      files: ['capabilities/review.md', 'instructions/personal.md'],
      instructions: [{ id: 'personal', path: 'instructions/personal.md' }],
    }), {
      'capabilities/review.md': 'Review from my Desk.\n',
      'instructions/personal.md': 'Reply in French.\n',
    })
    await addAssets(home, [source], { scope: 'desk' })
    await buildHome(home)
    const projection = '.agents/skills/review-review/SKILL.md'
    assert.match(await readFile(join(home, projection), 'utf8'), /my Desk/)
    assert.equal((await exec('git', ['check-ignore', '-q', projection], { cwd: home }).then(() => true, () => false)), true)
    const prompt = captureIo()
    assert.equal(await runCli(['hud', '--prompt', '--home', home], prompt.io), 0)
    assert.match(prompt.stdout(), /Reply in French/)
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
})

async function executable(path, content) {
  await writeFile(path, content)
  await chmod(path, 0o755)
}

test('legacy Overlay and Extensions layouts are rejected as a clean break', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'hairness-legacy-'))
  try {
    const home = join(temporary, 'home')
    await createHome(home)
    await mkdir(join(home, '.overlay'))
    await assert.rejects(() => resolveHome(home), (error) => error.code === 'legacy_overlay_layout')
    await rm(join(home, '.overlay'), { recursive: true })
    await mkdir(join(home, 'extensions'))
    await assert.rejects(() => resolveHome(home), (error) => error.code === 'legacy_asset_layout')
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
})

function escape(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
