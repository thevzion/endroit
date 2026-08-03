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
  const site = join(temporary, 'site')
  const command = ['--yes', '--package', packs.cli, 'endroit']
  await exec('npx', [...command, 'create', home], { cwd: temporary, maxBuffer: 20 * 1024 * 1024 })
  await installPackedRuntime(home, packs.cli)
  const consoleArgs = [join(home, 'endroit.mjs')]
  await exec('git', ['init', '--quiet', '--initial-branch=main', site])
  await writeFile(join(site, 'README.md'), '# Lab Site\n')
  await exec('git', ['add', 'README.md'], { cwd: site })
  await exec('git', ['-c', 'user.name=Lab', '-c', 'user.email=lab@endroit.org', 'commit', '--quiet', '-m', 'initial'], { cwd: site })
  await exec('git', ['remote', 'add', 'origin', 'https://github.com/example/lab-site.git'], { cwd: site })
  await exec(process.execPath, [...consoleArgs, 'site', 'add', site, '--id', 'lab'], { cwd: home, maxBuffer: 20 * 1024 * 1024 })
  await exec(process.execPath, [...consoleArgs, 'equipment', 'add', '@endroit/scratch', '-y'], { cwd: home, maxBuffer: 20 * 1024 * 1024 })
  await exec(process.execPath, [...consoleArgs, 'build'], { cwd: home, maxBuffer: 20 * 1024 * 1024 })
  const codex = JSON.parse((await exec(process.execPath, [join(home, '.codex/hooks/endroit-session-start.mjs')], { cwd: home })).stdout)
  assert.match(codex.hookSpecificOutput.additionalContext, /^<endroit-hud /)
  assert.match(codex.hookSpecificOutput.additionalContext, /<kernel [^>]*source="development"/)
  const claude = (await exec(process.execPath, [join(home, '.claude/hooks/endroit-session-start.mjs')], { cwd: home })).stdout.trim()
  assert.match(claude, /^<endroit-hud /)
  assert.match(claude, /<kernel [^>]*source="development"/)
  const status = JSON.parse((await exec(process.execPath, [...consoleArgs, 'equipment', 'status', '--json'], { cwd: home, maxBuffer: 20 * 1024 * 1024 })).stdout)
  const coreEquipment = ['endroit/artifacts', 'endroit/hud', 'endroit/hygiene', 'endroit/onboarding', 'endroit/rooms', 'endroit/scratch', 'endroit/sites', 'endroit/work', 'endroit/workplace']
  assert.deepEqual(status.map((entry) => entry.name), coreEquipment)
  assert.ok(status.every((entry) => entry.state === 'clean'))
  const sync = JSON.parse((await exec(process.execPath, [...consoleArgs, 'equipment', 'sync', 'endroit/scratch', '--check', '--json'], { cwd: home, maxBuffer: 20 * 1024 * 1024 })).stdout)
  assert.equal(sync[0].status, 'current')
  const { stdout } = await exec(process.execPath, [...consoleArgs, 'doctor', '--json'], { cwd: home, maxBuffer: 20 * 1024 * 1024 })
  const doctor = JSON.parse(stdout)
  assert.equal(doctor.status, 'ready')
  assert.deepEqual(doctor.equipment.map((entry) => entry.id), coreEquipment)
  const hygiene = JSON.parse((await exec(process.execPath, [...consoleArgs, 'hygiene', 'maintain', '--json'], { cwd: home, maxBuffer: 20 * 1024 * 1024 })).stdout)
  assert.equal(hygiene.readOnly, true)
  assert.equal(hygiene.status, 'healthy')
  const rooms = JSON.parse((await exec(process.execPath, [...consoleArgs, 'room', 'list', '--json'], { cwd: home, maxBuffer: 20 * 1024 * 1024 })).stdout)
  assert.deepEqual(rooms.rooms.map(({ ref }) => ref), ['room:home/home'])
  const sites = JSON.parse((await exec(process.execPath, [...consoleArgs, 'site', 'list', '--json'], { cwd: home, maxBuffer: 20 * 1024 * 1024 })).stdout)
  assert.equal(sites.sites[0].routes[0].id, 'main')
  assert.equal(JSON.parse(await readFile(join(home, 'endroit.json'), 'utf8')).runtime, '@endroit/cli@0.9.0-alpha.0')
  console.log(`packed lab passed (${home})`)
} finally {
  await removeTree(temporary, { force: true })
}
