import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { buildHome } from '../src/build.mjs'
import { runCli } from '../src/cli.mjs'
import { createHome, initializeExistingHome } from '../src/create.mjs'
import { addEquipment } from '../src/equipment.mjs'
import { doctorMembers } from '../src/member.mjs'
import { removeTree } from '../src/lib/io.mjs'
import { resolveHome } from '../src/resolved.mjs'
import { dispatchRuntime } from '../src/runtime.mjs'
import { captureIo, equipment, writeEquipment } from './helpers.mjs'

const exec = promisify(execFile)
const cli = new URL('../bin/endroit.mjs', import.meta.url).pathname

test('create and init choose explicit Desk Git boundaries around Home-owned Members', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'endroit-members-'))
  try {
    const tracked = join(temporary, 'tracked')
    await createHome(tracked, { memberId: 'alexis', memberName: 'Alexis' })
    assert.match(await readFile(join(tracked, 'members/alexis/MEMBER.md'), 'utf8'), /id: "alexis"/)
    assert.deepEqual(JSON.parse(await readFile(join(tracked, '.desk/desk.json'), 'utf8')), {
      $schema: 'https://endroit.org/schema/desk.json', id: 'local', member: 'alexis',
    })
    assert.equal(await gitRoot(join(tracked, '.desk')), await realpath(tracked))
    assert.match((await exec('git', ['ls-files'], { cwd: tracked })).stdout, /^members\/alexis\/MEMBER\.md$/m)

    const embedded = join(temporary, 'embedded')
    await exec('git', ['init', '--quiet', '--initial-branch=main', embedded])
    await initializeExistingHome(embedded, { memberId: 'alexis', memberName: 'Alexis' })
    assert.equal(await gitRoot(join(embedded, '.desk')), await realpath(join(embedded, '.desk')))
    assert.equal((await exec('git', ['check-ignore', '.desk/desk.json'], { cwd: embedded })).stdout.trim(), '.desk/desk.json')
    assert.equal(await readFile(join(embedded, '.agents/skills/work-on-self/SKILL.md'), 'utf8').then(Boolean), true)
    assert.equal(await readFile(join(embedded, '.claude/skills/deliver-this-to-self/SKILL.md'), 'utf8').then(Boolean), true)

    const later = join(temporary, 'later')
    await createHome(later, { deskStrategy: 'later' })
    await assert.rejects(readFile(join(later, '.desk/desk.json')), (error) => error.code === 'ENOENT')
    assert.equal((await resolveHome(later)).members[0].id, 'owner')
  } finally {
    await removeTree(temporary, { force: true })
  }
})

test('Member CLI validates accounts and Desk references without accepting secret fields', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'endroit-member-cli-'))
  try {
    const home = join(temporary, 'home')
    await createHome(home)
    const created = captureIo()
    assert.equal(await runCli(['member', 'create', 'sam', '--name', 'Sam', '--account', 'github:public:42:sam', '--home', home, '--json'], created.io), 0, created.stderr())
    assert.deepEqual(JSON.parse(created.stdout()).accounts, [{ service: 'github', scope: 'public', identifier: '42', handle: 'sam' }])
    const listed = captureIo()
    assert.equal(await runCli(['member', 'list', '--home', home, '--json'], listed.io), 0, listed.stderr())
    assert.deepEqual(JSON.parse(listed.stdout()).map((member) => member.id), ['owner', 'sam'])

    const memberPath = join(home, 'members/sam/MEMBER.md')
    await writeFile(memberPath, (await readFile(memberPath, 'utf8')).replace('accounts:', 'token: "secret"\naccounts:'))
    assert.equal((await doctorMembers(home)).issues[0].code, 'member_invalid')

    const deskPath = join(home, '.desk/desk.json')
    const desk = JSON.parse(await readFile(deskPath, 'utf8'))
    desk.member = 'missing'
    await writeFile(deskPath, `${JSON.stringify(desk, null, 2)}\n`)
    await assert.rejects(() => resolveHome(home), (error) => error.code === 'member_missing')
  } finally {
    await removeTree(temporary, { force: true })
  }
})

test('legacy solo/team mode is rejected with the 0.8 migration direction', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'endroit-legacy-mode-'))
  try {
    await assert.rejects(() => createHome(join(temporary, 'api'), { mode: 'solo' }), (error) => error.code === 'legacy_mode_unsupported')
    const output = captureIo()
    assert.equal(await runCli(['create', join(temporary, 'cli'), '--mode', 'team', '--no-interactive'], output.io), 2)
    assert.match(output.stderr(), /--desk tracked\|separate\|later/)
  } finally {
    await removeTree(temporary, { force: true })
  }
})

test('projectedName expands exact route names for both providers and refuses final collisions', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'endroit-projected-name-'))
  try {
    const home = join(temporary, 'home')
    await createHome(home)
    const source = await writeEquipment(join(temporary, 'source'), equipment({
      skills: [
        { id: 'literal', capability: 'review', description: 'Literal surface.', projectedName: 'custom-enter-home' },
        { id: 'room', capability: 'review', description: 'Room surface.', projectedName: 'custom-enter-{route}-room', forEach: 'room' },
      ],
      commands: [],
    }), { 'capabilities/review.md': 'Reload the bound authoritative source.\n' })
    await addEquipment(home, [source])
    await buildHome(home)
    for (const path of ['.agents/skills/custom-enter-home/SKILL.md', '.claude/skills/custom-enter-home/SKILL.md', '.agents/skills/custom-enter-home-room/SKILL.md']) {
      assert.equal(await readFile(join(home, path), 'utf8').then(Boolean), true)
    }

    const colliding = await writeEquipment(join(temporary, 'collision'), equipment({
      name: 'fixture/collision',
      skills: [
        { id: 'one', capability: 'review', description: 'One.', projectedName: 'same-name' },
        { id: 'two', capability: 'review', description: 'Two.', projectedName: 'same-name' },
      ],
      commands: [],
    }), { 'capabilities/review.md': 'Collision.\n' })
    await addEquipment(home, [colliding])
    await assert.rejects(() => resolveHome(home), (error) => error.code === 'surface_collision')
  } finally {
    await removeTree(temporary, { force: true })
  }
})

test('the static vertical slice is concrete on Codex and Claude and fails closed for missing native delegation', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'endroit-workplace-slice-'))
  try {
    const home = join(temporary, 'home')
    await createHome(home)
    const gestures = [
      'enter-the-home', 'enter-the-home-room', 'call-the-researcher',
      'work-as-an-engineer', 'use-research', 'retain-this', 'accept-this',
      'deliver-this', 'archive-this', 'maintain-the-home',
    ]
    for (const providerRoot of ['.agents/skills', '.claude/skills']) {
      for (const gesture of gestures) assert.equal(await readFile(join(home, providerRoot, gesture, 'SKILL.md'), 'utf8').then(Boolean), true)
    }
    for (const gesture of ['call-the-researcher', 'work-as-an-engineer']) {
      assert.match(await readFile(join(home, '.agents/skills', gesture, 'SKILL.md'), 'utf8'), /return `blocked`/i)
      assert.match(await readFile(join(home, '.claude/skills', gesture, 'SKILL.md'), 'utf8'), /return `blocked`/i)
    }
    assert.match(await readFile(join(home, '.agents/skills/retain-this/SKILL.md'), 'utf8'), /Endroit\nownership|Endroit objects|These states are distinct/)
  } finally {
    await removeTree(temporary, { force: true })
  }
})

test('Home Hygiene composes Doctors read-only and repairs only an exactly approved finding', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'endroit-hygiene-'))
  try {
    const home = join(temporary, 'home')
    await createHome(home)
    const projection = join(home, '.agents/skills/accept-this/SKILL.md')
    await rm(projection)
    const inspection = captureIo()
    assert.equal(await dispatchRuntime(home, 'hygiene', ['maintain', '--json'], inspection.io), 0, inspection.stderr())
    const report = JSON.parse(inspection.stdout())
    assert.equal(report.readOnly, true)
    assert.ok(report.confirmedInconsistencies.some((finding) => finding.id === 'projections-stale'))
    await assert.rejects(readFile(projection), (error) => error.code === 'ENOENT')

    const refused = captureIo()
    assert.equal(await dispatchRuntime(home, 'hygiene', ['repair', '--finding', 'projections-stale', '--json'], refused.io), 6)
    assert.match(refused.stderr(), /repair_approval_required/)
    await assert.rejects(readFile(projection), (error) => error.code === 'ENOENT')

    const launcher = join(home, '.endroit/dev-cli')
    await writeFile(launcher, `#!/usr/bin/env node\nawait import(${JSON.stringify(new URL(`file://${cli}`).href)})\n`)
    await chmod(launcher, 0o755)
    const repaired = captureIo()
    assert.equal(await dispatchRuntime(home, 'hygiene', ['repair', '--finding', 'projections-stale', '--approve', 'projections-stale', '--json'], repaired.io), 0, repaired.stderr())
    const result = JSON.parse(repaired.stdout())
    assert.equal(result.status, 'repaired')
    assert.equal(result.after.confirmedInconsistencies.length, 0)
    assert.match(await readFile(projection, 'utf8'), /# Material lifecycle/)
  } finally {
    await removeTree(temporary, { force: true })
  }
})

async function gitRoot(path) { return realpath(resolve((await exec('git', ['rev-parse', '--show-toplevel'], { cwd: path })).stdout.trim())) }
