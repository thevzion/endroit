import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { ensureDevelopmentHome, recreateDevelopmentHome } from '../scripts/development-home.mjs'
import { removeTree } from '../src/lib/io.mjs'

const exec = promisify(execFile)
const cli = new URL('../bin/endroit.mjs', import.meta.url).pathname
const bootstrap = new URL('../scripts/bootstrap-home.mjs', import.meta.url).pathname

test('the repository recipe creates and safely recreates its Development Home', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'endroit-development-'))
  const home = join(temporary, 'home')
  try {
    const created = await ensureDevelopmentHome({ home, deskId: 'alexis' })
    assert.equal(created.status, 'ready')
    const document = JSON.parse(await readFile(join(home, 'endroit.json'), 'utf8'))
    const projectPackage = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
    assert.equal(document.mode, 'team')
    assert.deepEqual(document.providers, ['codex', 'claude'])
    const site = await readFile(join(home, 'sites/endroit/SITE.md'), 'utf8')
    assert.match(site, /when: \["Developing or releasing Endroit\."\]/)
    assert.match(site, /tags: \["endroit"\]/)
    document.runtime = '@endroit/cli@0.0.0'
    await writeFile(join(home, 'endroit.json'), `${JSON.stringify(document, null, 2)}\n`)
    assert.equal((await ensureDevelopmentHome({ home, deskId: 'alexis' })).status, 'ready')
    assert.equal(
      JSON.parse(await readFile(join(home, 'endroit.json'), 'utf8')).runtime,
      `${projectPackage.name}@${projectPackage.version}`,
    )
    assert.match(await readFile(join(home, '.endroit/dev-cli'), 'utf8'), /bin\/endroit\.mjs/)
    const directHud = JSON.parse((await exec(process.execPath, [join(home, 'endroit.mjs'), 'hud', 'json'], { cwd: home })).stdout)
    assert.equal(directHud.kernel.source, 'development')
    assert.equal(directHud.kernel.invoke, 'node ./endroit.mjs')
    assert.match(await readFile(join(home, 'HOME.md'), 'utf8'), /endroit-development-home/)
    assert.match(await readFile(join(home, '.desk/DESK.md'), 'utf8'), /alexis/)
    assert.match(await readFile(join(home, 'equipment/endroit/project/equipment.json'), 'utf8'), /"endroit\/project:plan"|"id": "plan"/)
    assert.match(await readFile(join(home, '.codex/hooks/endroit-session-start.mjs'), 'utf8'), /hookSpecificOutput/)
    const plan = await endroitJson(home, ['artifact', 'create', 'endroit/planning:initiative', 'self-hosted', '--room', 'desk/endroit', '--json'])
    assert.match(await readFile(join(home, plan.path, 'artifact.md'), 'utf8'), /status: "draft"/)
    const published = await endroitJson(home, ['artifact', 'publish', plan.path, '--to', 'home', '--json'])
    assert.match(await readFile(join(home, published.path, 'artifact.md'), 'utf8'), /owner: "room:home\/home"/)
    assert.match(await readFile(join(home, plan.path, 'artifact.md'), 'utf8'), /owner: "room:desk\/endroit"/)

    await commit(home, 'home')
    await commit(join(home, '.desk'), 'desk')
    const deskHead = await git(join(home, '.desk'), ['rev-parse', 'HEAD'])
    const deskDocument = await readFile(join(home, '.desk/desk.json'), 'utf8')
    const route = await readFile(join(home, '.desk/routes/endroit/main.json'), 'utf8')

    await writeFile(join(home, 'dirty.md'), 'dirty\n')
    await assert.rejects(() => recreateDevelopmentHome({ home }), /Development Home must be clean/)
    await rm(join(home, 'dirty.md'))

    const recreated = await recreateDevelopmentHome({ home, deskId: 'alexis' })
    assert.equal(recreated.status, 'recreated')
    assert.equal(await readFile(join(home, '.desk/desk.json'), 'utf8'), deskDocument)
    assert.equal(await git(join(home, '.desk'), ['rev-parse', 'HEAD']), deskHead)
    assert.equal(await readFile(join(home, '.desk/routes/endroit/main.json'), 'utf8'), route)
    assert.equal(JSON.parse(await readFile(join(home, '.endroit/recreate.json'), 'utf8')).backup, recreated.backup)
  } finally {
    await removeTree(temporary, { force: true })
  }
})

test('dev bootstrap preserves the canonical first-run experience with a packed local runtime', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'endroit-bootstrap-test-'))
  const home = join(temporary, 'home')
  try {
    const { stdout } = await exec(process.execPath, [
      bootstrap,
      home,
      '--with', 'none',
      '--no-interactive',
      '--yes',
    ], { maxBuffer: 20 * 1024 * 1024 })
    assert.match(stdout, /Endroit Home created/)
    assert.match(stdout, /Local packed runtime attached/)

    const launcher = await lstat(join(home, '.endroit', 'dev-cli'))
    assert.equal(launcher.isFile(), true)
    assert.match(await readFile(join(home, '.endroit', 'dev-cli'), 'utf8'), /'packages'/)

    const hud = JSON.parse((await exec(process.execPath, [
      join(home, 'endroit.mjs'), 'hud', 'json',
    ], { cwd: home, maxBuffer: 20 * 1024 * 1024 })).stdout)
    assert.equal(hud.kernel.source, 'development')

    const doctor = JSON.parse((await exec(process.execPath, [
      join(home, 'endroit.mjs'), 'doctor', '--json',
    ], { cwd: home, maxBuffer: 20 * 1024 * 1024 })).stdout)
    assert.equal(doctor.status, 'ready')
    assert.equal(await git(home, ['status', '--porcelain']), '')
  } finally {
    await removeTree(temporary, { force: true })
  }
})

async function commit(root, label) {
  await git(root, ['add', '--all'])
  await git(root, ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '-m', label])
}

async function git(root, args) {
  return (await exec('git', args, { cwd: root })).stdout.trim()
}

async function endroitJson(home, args) {
  const { stdout } = await exec(process.execPath, [cli, ...args, '--home', home], { cwd: home })
  return JSON.parse(stdout)
}
