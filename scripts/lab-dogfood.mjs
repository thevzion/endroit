import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { packHairness } from './lib/pack.mjs'

const exec = promisify(execFile)
const root = new URL('../', import.meta.url).pathname
const temporary = await mkdtemp(join(tmpdir(), 'hairness-lab-'))
try {
  const packs = await packHairness(root, join(temporary, 'packs'))
  const home = join(temporary, 'home')
  const target = join(temporary, 'target')
  const command = ['--yes', '--package', packs.cli, 'hairness']
  await exec('npx', [...command, 'create', home], { cwd: temporary, maxBuffer: 20 * 1024 * 1024 })
  const launcher = join(home, '.hairness', 'dev-cli')
  await mkdir(join(home, '.hairness'), { recursive: true })
  await writeFile(launcher, `#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
const result = spawnSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['--yes', '--package', ${JSON.stringify(packs.cli)}, 'hairness', ...process.argv.slice(2)], { stdio: 'inherit' })
process.exitCode = result.status ?? 1
`)
  await chmod(launcher, 0o755)
  const consoleArgs = [join(home, 'hairness.mjs')]
  await exec('git', ['init', '--quiet', '--initial-branch=main', target])
  await writeFile(join(target, 'README.md'), '# Lab Target\n')
  await exec('git', ['add', 'README.md'], { cwd: target })
  await exec('git', ['-c', 'user.name=Lab', '-c', 'user.email=lab@hairness.dev', 'commit', '--quiet', '-m', 'initial'], { cwd: target })
  await exec('git', ['remote', 'add', 'origin', 'https://github.com/example/lab-target.git'], { cwd: target })
  await exec(process.execPath, [...consoleArgs, 'target', 'add', target, '--id', 'lab'], { cwd: home, maxBuffer: 20 * 1024 * 1024 })
  await exec(process.execPath, [...consoleArgs, 'asset', 'add', '@hairness/scratch', '-y'], { cwd: home, maxBuffer: 20 * 1024 * 1024 })
  await exec(process.execPath, [...consoleArgs, 'build'], { cwd: home, maxBuffer: 20 * 1024 * 1024 })
  const codex = JSON.parse((await exec(process.execPath, [join(home, '.codex/hooks/hairness-session-start.mjs')], { cwd: home })).stdout)
  assert.match(codex.hookSpecificOutput.additionalContext, /^<hairness-hud /)
  assert.match(codex.hookSpecificOutput.additionalContext, /<kernel [^>]*source="development"/)
  const claude = (await exec(process.execPath, [join(home, '.claude/hooks/hairness-session-start.mjs')], { cwd: home })).stdout.trim()
  assert.match(claude, /^<hairness-hud /)
  assert.match(claude, /<kernel [^>]*source="development"/)
  const status = JSON.parse((await exec(process.execPath, [...consoleArgs, 'asset', 'status', '--json'], { cwd: home, maxBuffer: 20 * 1024 * 1024 })).stdout)
  assert.deepEqual(status.map((entry) => entry.name), ['hairness/artifacts', 'hairness/hud', 'hairness/onboarding', 'hairness/scratch', 'hairness/targets'])
  assert.ok(status.every((entry) => entry.state === 'clean'))
  const sync = JSON.parse((await exec(process.execPath, [...consoleArgs, 'asset', 'sync', 'hairness/scratch', '--check', '--json'], { cwd: home, maxBuffer: 20 * 1024 * 1024 })).stdout)
  assert.equal(sync[0].status, 'current')
  const { stdout } = await exec(process.execPath, [...consoleArgs, 'doctor', '--json'], { cwd: home, maxBuffer: 20 * 1024 * 1024 })
  const doctor = JSON.parse(stdout)
  assert.equal(doctor.status, 'ready')
  assert.deepEqual(doctor.assets.map((entry) => entry.id), ['hairness/artifacts', 'hairness/hud', 'hairness/onboarding', 'hairness/scratch', 'hairness/targets'])
  const targets = JSON.parse((await exec(process.execPath, [...consoleArgs, 'target', 'list', '--json'], { cwd: home, maxBuffer: 20 * 1024 * 1024 })).stdout)
  assert.equal(targets.targets[0].bindings[0].id, 'main')
  assert.equal(JSON.parse(await readFile(join(home, 'hairness.json'), 'utf8')).runtime, '@hairness/cli@0.5.0-alpha.1')
  console.log(`packed lab passed (${home})`)
} finally {
  await rm(temporary, { recursive: true, force: true })
}
