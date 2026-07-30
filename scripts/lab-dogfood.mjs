import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { removeTree } from '../src/lib/io.mjs'
import { installPackedRuntime, packEndroit } from './lib/pack.mjs'

const exec = promisify(execFile)
const root = new URL('../', import.meta.url).pathname
const temporary = await mkdtemp(join(tmpdir(), 'endroit-lab-'))
try {
  const packs = await packEndroit(root, join(temporary, 'packs'))
  const home = join(temporary, 'home')
  const target = join(temporary, 'target')
  const command = ['--yes', '--package', packs.cli, 'endroit']
  await exec('npx', [...command, 'create', home], { cwd: temporary, maxBuffer: 20 * 1024 * 1024 })
  await installPackedRuntime(home, packs.cli)
  const consoleArgs = [join(home, 'endroit.mjs')]
  await exec('git', ['init', '--quiet', '--initial-branch=main', target])
  await writeFile(join(target, 'README.md'), '# Lab Target\n')
  await exec('git', ['add', 'README.md'], { cwd: target })
  await exec('git', ['-c', 'user.name=Lab', '-c', 'user.email=lab@endroit.org', 'commit', '--quiet', '-m', 'initial'], { cwd: target })
  await exec('git', ['remote', 'add', 'origin', 'https://github.com/example/lab-target.git'], { cwd: target })
  await exec(process.execPath, [...consoleArgs, 'target', 'add', target, '--id', 'lab'], { cwd: home, maxBuffer: 20 * 1024 * 1024 })
  await exec(process.execPath, [...consoleArgs, 'asset', 'add', '@endroit/scratch', '-y'], { cwd: home, maxBuffer: 20 * 1024 * 1024 })
  await exec(process.execPath, [...consoleArgs, 'build'], { cwd: home, maxBuffer: 20 * 1024 * 1024 })
  const codex = JSON.parse((await exec(process.execPath, [join(home, '.codex/hooks/endroit-session-start.mjs')], { cwd: home })).stdout)
  assert.match(codex.hookSpecificOutput.additionalContext, /^<endroit-hud /)
  assert.match(codex.hookSpecificOutput.additionalContext, /<kernel [^>]*source="development"/)
  const claude = (await exec(process.execPath, [join(home, '.claude/hooks/endroit-session-start.mjs')], { cwd: home })).stdout.trim()
  assert.match(claude, /^<endroit-hud /)
  assert.match(claude, /<kernel [^>]*source="development"/)
  const status = JSON.parse((await exec(process.execPath, [...consoleArgs, 'asset', 'status', '--json'], { cwd: home, maxBuffer: 20 * 1024 * 1024 })).stdout)
  const coreAssets = ['endroit/artifacts', 'endroit/hud', 'endroit/onboarding', 'endroit/scratch', 'endroit/targets', 'endroit/workspaces']
  assert.deepEqual(status.map((entry) => entry.name), coreAssets)
  assert.ok(status.every((entry) => entry.state === 'clean'))
  const sync = JSON.parse((await exec(process.execPath, [...consoleArgs, 'asset', 'sync', 'endroit/scratch', '--check', '--json'], { cwd: home, maxBuffer: 20 * 1024 * 1024 })).stdout)
  assert.equal(sync[0].status, 'current')
  const { stdout } = await exec(process.execPath, [...consoleArgs, 'doctor', '--json'], { cwd: home, maxBuffer: 20 * 1024 * 1024 })
  const doctor = JSON.parse(stdout)
  assert.equal(doctor.status, 'ready')
  assert.deepEqual(doctor.assets.map((entry) => entry.id), coreAssets)
  const workspaces = JSON.parse((await exec(process.execPath, [...consoleArgs, 'workspace', 'list', '--json'], { cwd: home, maxBuffer: 20 * 1024 * 1024 })).stdout)
  assert.deepEqual(workspaces.workspaces.map(({ ref }) => ref), ['workspace:home/home'])
  const targets = JSON.parse((await exec(process.execPath, [...consoleArgs, 'target', 'list', '--json'], { cwd: home, maxBuffer: 20 * 1024 * 1024 })).stdout)
  assert.equal(targets.targets[0].bindings[0].id, 'main')
  assert.equal(JSON.parse(await readFile(join(home, 'endroit.json'), 'utf8')).runtime, '@endroit/cli@0.7.0-alpha.1')
  console.log(`packed lab passed (${home})`)
} finally {
  await removeTree(temporary, { force: true })
}
