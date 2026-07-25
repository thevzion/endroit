import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, readlink, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { ensureDevelopmentHome, recreateDevelopmentHome } from '../scripts/development-home.mjs'

const exec = promisify(execFile)
const cli = new URL('../bin/hairness.mjs', import.meta.url).pathname

test('the repository recipe creates and safely recreates its Development Home', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'hairness-development-'))
  const home = join(temporary, 'home')
  try {
    const created = await ensureDevelopmentHome({ home, deskId: 'alexis' })
    assert.equal(created.status, 'ready')
    const document = JSON.parse(await readFile(join(home, 'hairness.json'), 'utf8'))
    assert.equal(document.mode, 'team')
    assert.deepEqual(document.providers, ['codex', 'claude'])
    assert.match(await readFile(join(home, '.hairness/dev-cli'), 'utf8'), /HAIRNESS_RUNTIME_SOURCE = 'development'/)
    assert.match(await readFile(join(home, '.hairness/dev-cli'), 'utf8'), /\.\.\/\.desk\/targets\/hairness\/main\/bin\/hairness\.mjs/)
    const directHud = JSON.parse((await exec(join(home, '.hairness/dev-cli'), ['hud', '--json', '--home', home], { cwd: home })).stdout)
    assert.equal(directHud.kernel.source, 'development')
    assert.equal(directHud.kernel.invoke, '.hairness/dev-cli')
    assert.match(await readFile(join(home, 'HOME.md'), 'utf8'), /hairness-development-home/)
    assert.match(await readFile(join(home, '.desk/DESK.md'), 'utf8'), /alexis/)
    assert.match(await readFile(join(home, 'assets/hairness/project/asset.json'), 'utf8'), /"hairness\/project:plan"|"id": "plan"/)
    assert.match(await readFile(join(home, '.codex/hooks/hairness-session-start.mjs'), 'utf8'), /hookSpecificOutput/)
    const plan = await hairnessJson(home, ['artifact', 'create', 'hairness/project:plan', 'self-hosted', '--owner', 'desk', '--json'])
    assert.match(await readFile(join(home, plan.path, 'artifact.md'), 'utf8'), /state: "draft"/)
    const published = await hairnessJson(home, ['artifact', 'publish', plan.path, '--to', 'home', '--json'])
    assert.match(await readFile(join(home, published.path, 'artifact.md'), 'utf8'), /owner: "home"/)
    assert.match(await readFile(join(home, plan.path, 'artifact.md'), 'utf8'), /owner: "desk"/)

    await commit(home, 'home')
    await commit(join(home, '.desk'), 'desk')
    const deskHead = await git(join(home, '.desk'), ['rev-parse', 'HEAD'])
    const deskDocument = await readFile(join(home, '.desk/desk.json'), 'utf8')
    const binding = await readlink(join(home, '.desk/targets/hairness/main'))

    await writeFile(join(home, 'dirty.md'), 'dirty\n')
    await assert.rejects(() => recreateDevelopmentHome({ home }), /Development Home must be clean/)
    await rm(join(home, 'dirty.md'))

    const recreated = await recreateDevelopmentHome({ home, deskId: 'alexis' })
    assert.equal(recreated.status, 'recreated')
    assert.equal(await readFile(join(home, '.desk/desk.json'), 'utf8'), deskDocument)
    assert.equal(await git(join(home, '.desk'), ['rev-parse', 'HEAD']), deskHead)
    assert.equal(await readlink(join(home, '.desk/targets/hairness/main')), binding)
    assert.equal(JSON.parse(await readFile(join(home, '.hairness/recreate.json'), 'utf8')).backup, recreated.backup)
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
})

async function commit(root, label) {
  await git(root, ['add', '--all'])
  await git(root, ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '-m', label])
}

async function git(root, args) {
  return (await exec('git', args, { cwd: root })).stdout.trim()
}

async function hairnessJson(home, args) {
  const { stdout } = await exec(process.execPath, [cli, ...args, '--home', home], { cwd: home })
  return JSON.parse(stdout)
}
