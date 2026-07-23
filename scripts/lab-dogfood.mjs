import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
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
  const command = ['--yes', '--package', packs.cli, 'hairness']
  await exec('npx', [...command, 'create', home], { cwd: temporary, maxBuffer: 20 * 1024 * 1024 })
  const targets = []
  for (const id of ['api', 'web', 'handbook']) {
    const target = join(temporary, id)
    await exec('git', ['init', '--quiet', '--initial-branch=main', target])
    await writeFile(join(target, 'README.md'), `# ${id}\n`)
    await exec('git', ['add', 'README.md'], { cwd: target })
    await exec('git', ['-c', 'user.name=Lab', '-c', 'user.email=lab@hairness.dev', 'commit', '--quiet', '-m', 'initial'], { cwd: target })
    await exec('git', ['remote', 'add', 'origin', `https://github.com/example/${id}.git`], { cwd: target })
    await exec('npx', [...command, 'target', 'add', target], { cwd: home, maxBuffer: 20 * 1024 * 1024 })
    targets.push(target)
  }
  await exec('npx', [...command, 'target', 'use', 'api'], { cwd: home, maxBuffer: 20 * 1024 * 1024 })
  await exec('npx', [...command, 'asset', 'add', '@hairness/scratch', '-y'], { cwd: home, maxBuffer: 20 * 1024 * 1024 })
  await exec('npx', [...command, 'build'], { cwd: home, maxBuffer: 20 * 1024 * 1024 })
  await exec('npx', [...command, 'scratch', 'create', 'lab-proof'], { cwd: home, maxBuffer: 20 * 1024 * 1024 })
  const status = JSON.parse((await exec('npx', [...command, 'asset', 'status', '--json'], { cwd: home, maxBuffer: 20 * 1024 * 1024 })).stdout)
  assert.deepEqual(status.map((entry) => entry.name), ['hairness/home', 'hairness/scratch', 'hairness/targets'])
  assert.ok(status.every((entry) => entry.state === 'clean'))
  const sync = JSON.parse((await exec('npx', [...command, 'asset', 'sync', 'hairness/scratch', '--check', '--json'], { cwd: home, maxBuffer: 20 * 1024 * 1024 })).stdout)
  assert.equal(sync[0].status, 'current')
  const hud = JSON.parse((await exec('npx', [...command, 'hud', '--full', '--json'], { cwd: home, maxBuffer: 20 * 1024 * 1024 })).stdout)
  assert.equal(hud.kind, 'HUD')
  assert.equal(hud.home.name, 'home')
  assert.ok(hud.surfaces.some((entry) => entry.kind === 'artifact' && entry.id === 'hairness/scratch:scratch'))
  assert.equal(hud.probes.targets.find((entry) => entry.active).id, 'api')
  const { stdout } = await exec('npx', [...command, 'doctor', '--home', home, '--json'], { cwd: temporary, maxBuffer: 20 * 1024 * 1024 })
  const doctor = JSON.parse(stdout)
  assert.equal(doctor.status, 'ready')
  assert.deepEqual(doctor.assets.map((entry) => entry.name), ['hairness/home', 'hairness/scratch', 'hairness/targets'])
  assert.deepEqual(doctor.targets.map((entry) => entry.binding), await Promise.all(targets.map((path) => realpath(path))))
  assert.equal(JSON.parse(await readFile(join(home, 'hairness.json'), 'utf8')).runtime, '@hairness/cli@0.5.0-alpha.0')
  console.log(`packed lab passed (${home})`)
} finally {
  await rm(temporary, { recursive: true, force: true })
}
