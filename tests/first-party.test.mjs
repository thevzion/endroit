import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { addEquipment } from '../src/equipment.mjs'
import { buildHome } from '../src/build.mjs'
import { createHome } from '../src/create.mjs'
import { removeTree } from '../src/lib/io.mjs'
import { resolveHome } from '../src/resolved.mjs'
import { dispatchRuntime } from '../src/runtime.mjs'
import { writeSite } from '../src/sites.mjs'
import { captureIo } from './helpers.mjs'

const exec = promisify(execFile)

test('HUD exposes deterministic human, JSON and agent-prompt views without following Desk symlinks', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'endroit-hud-'))
  try {
    const home = join(temporary, 'home')
    await createHome(home, { emoji: '🏠' })
    const desk = JSON.parse(await readFile(join(home, '.desk/desk.json'), 'utf8'))
    desk.settings = { 'endroit/onboarding': { addressAs: 'Alexis', responseLanguage: 'fr' } }
    await writeFile(join(home, '.desk/desk.json'), `${JSON.stringify(desk, null, 2)}\n`)
    for (let index = 0; index < 7; index += 1) {
      const path = join(home, '.desk', `note-${index}.md`)
      await writeFile(path, `${index}\n`)
      const time = new Date(Date.now() + index * 1000)
      await utimes(path, time, time)
    }
    const room = join(home, '.desk', 'rooms', 'demo')
    assert.equal(await dispatchRuntime(home, 'room', ['create', 'demo', '--scope', 'desk'], captureIo().io), 0)
    await writeFile(join(room, 'ROOM.md'), [
      '---',
      'id: "demo"',
      'kind: "room"',
      'status: "active"',
      'owner: "room:desk/demo"',
      'created_at: "2026-01-01T00:00:00.000Z"',
      'updated_at: "2026-01-01T00:00:00.000Z"',
      'derived_from: []',
      'emoji: "🎛️"',
      'summary: "Demo Room."',
      'when: ["Working on the demo."]',
      'tags: ["demo"]',
      '---',
      '',
      '# Demo',
      '',
    ].join('\n'))
    const outside = join(temporary, 'outside.md')
    await writeFile(outside, 'outside\n')
    await symlink(outside, join(home, '.desk', 'outside-link'))

    const json = captureIo()
    assert.equal(await dispatchRuntime(home, 'hud', ['json'], json.io), 0)
    const model = JSON.parse(json.stdout())
    assert.equal(model.home.name, 'home')
    assert.equal(model.home.emoji, '🏠')
    assert.equal(model.home.root, await exec('git', ['rev-parse', '--show-toplevel'], { cwd: home }).then((value) => value.stdout.trim()))
    assert.equal(model.kernel.source, 'npm')
    assert.equal(model.kernel.invoke, 'node ./endroit.mjs')
    assert.deepEqual(model.desk.preferences, { addressAs: 'Alexis', responseLanguage: 'fr' })
    assert.equal(model.projections.every((entry) => entry.status === 'fresh'), true)
    assert.deepEqual(model.surfaces.equipment.map((entry) => entry.id), ['endroit/artifacts', 'endroit/hud', 'endroit/hygiene', 'endroit/onboarding', 'endroit/rooms', 'endroit/sites', 'endroit/workplace'])
    assert.deepEqual(model.surfaces.runtimes.map((entry) => entry.namespace), ['artifact', 'hud', 'hygiene', 'room', 'site'])
    assert.deepEqual(
      model.trust.runtimes.map((entry) => [entry.owner, entry.trust]),
      [
        ['endroit/artifacts', 'bundled'],
        ['endroit/hud', 'bundled'],
        ['endroit/hygiene', 'bundled'],
        ['endroit/rooms', 'bundled'],
        ['endroit/sites', 'bundled'],
      ],
    )
    assert.deepEqual({ bundled: model.trust.bundled, approved: model.trust.approved, pending: model.trust.pending }, {
      bundled: 5,
      approved: 0,
      pending: 0,
    })
    assert.equal(model.recentDesk.length, 5)
    assert.deepEqual(model.recentDesk.map((entry) => entry.path), ['note-6.md', 'note-5.md', 'note-4.md', 'note-3.md', 'note-2.md'])
    assert.equal(model.recentDesk.some((entry) => entry.path === 'outside-link'), false)
    assert.deepEqual(
      model.items.rooms.map(({ id, routable }) => [id, routable]),
      [['home', true], ['demo', true]],
    )
    assert.equal(model.items.rooms[1].emoji, '🎛️')
    assert.ok(model.items.capabilities.some(({ id }) => id === 'endroit-home'))
    assert.deepEqual(Object.keys(model.attention), ['blocking', 'warning', 'advisory'])

    const prompt = captureIo()
    await dispatchRuntime(home, 'hud', ['prompt'], prompt.io)
    assert.match(prompt.stdout(), /^<endroit-hud version="2" status="ready" generated-at="[^"]+" event="command">/)
    assert.match(prompt.stdout(), new RegExp(`<home name="home" emoji="🏠" root="${escapeRegex(model.home.root)}" providers="codex,claude" members="owner"/>`))
    assert.match(prompt.stdout(), /<kernel runtime="@endroit\/cli@0\.8\.0-alpha\.1" source="npm" invoke="node \.\/endroit\.mjs"\/>/)
    assert.match(prompt.stdout(), /<item id="demo" emoji="🎛️" state="active" access="model,user" summary="Demo Room\." tags="demo" when="Working on the demo\." ref="room:desk\/demo"/)
    assert.match(prompt.stdout(), /<runtimes namespaces="artifact,hud,hygiene,room,site"\/>/)
    assert.match(prompt.stdout(), /<instruction owner="endroit\/desk" id="desk" source="DESK\.md">/)
    assert.match(prompt.stdout(), /<advisory>\s+<item subject="home" code="home-dirty">/)
    assert.doesNotMatch(prompt.stdout(), /<equipment>|<skills>|<commands>|<recent-desk>/)
    assert.doesNotMatch(prompt.stdout(), /outside-link/)

    const activity = captureIo()
    assert.equal(await dispatchRuntime(home, 'hud', ['activity', '--since', '1d', '--scope', 'room:desk/demo', '--json'], activity.io), 0)
    const activityModel = JSON.parse(activity.stdout())
    assert.equal(activityModel.apiVersion, 'endroit.org/hud/activity/v1alpha1')
    assert.equal(activityModel.scope, 'room:desk/demo')
    assert.ok(activityModel.events.some(({ source }) => source.ref.endsWith('ROOM.md')))
    assert.equal(activityModel.events.some(({ source }) => source.ref.includes('outside-link')), false)
    const unknown = captureIo()
    assert.equal(await dispatchRuntime(home, 'hud', ['activity', '--scope', 'room:unknown'], unknown.io), 5)
    assert.match(unknown.stderr(), /activity_scope_unknown/)
    const invalidSince = captureIo()
    assert.equal(await dispatchRuntime(home, 'hud', ['activity', '--since', `${'9'.repeat(400)}w`], invalidSince.io), 5)
    assert.match(invalidSince.stderr(), /activity_since_invalid/)

    const human = captureIo()
    await dispatchRuntime(home, 'hud', ['show'], human.io)
    assert.equal(human.stdout().split('\n')[0], 'ENDROIT    home · codex+claude · @endroit/cli@0.8.0-alpha.1 · npm · ready')
  } finally {
    await removeTree(temporary, { force: true })
  }
})

test('the HUD owns its prompt budget through namespaced Home settings', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'endroit-hud-budget-'))
  try {
    const home = join(temporary, 'home')
    await createHome(home)
    const path = join(home, 'endroit.json')
    const document = JSON.parse(await readFile(path, 'utf8'))
    document.settings = { 'endroit/hud': { promptBytes: 1 } }
    await writeFile(path, `${JSON.stringify(document, null, 2)}\n`)
    const output = captureIo()
    assert.equal(await dispatchRuntime(home, 'hud', ['prompt'], output.io), 5)
    assert.match(output.stderr(), /hud_budget_exceeded/)
  } finally {
    await removeTree(temporary, { force: true })
  }
})

test('HUD prompt groups canonical capabilities within fresh and mature budgets', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'endroit-hud-compact-'))
  try {
    const home = join(temporary, 'home')
    await createHome(home)
    const json = captureIo()
    assert.equal(await dispatchRuntime(home, 'hud', ['json'], json.io), 0, json.stderr())
    const model = JSON.parse(json.stdout())
    assert.ok(model.items.capabilities.length > 6)
    assert.equal(model.items.capabilities.every((entry) => entry.entrypoint && !entry.entrypoints), true)

    const first = captureIo()
    const second = captureIo()
    assert.equal(await dispatchRuntime(home, 'hud', ['prompt'], first.io), 0, first.stderr())
    assert.equal(await dispatchRuntime(home, 'hud', ['prompt'], second.io), 0, second.stderr())
    assert.ok(Buffer.byteLength(first.stdout()) <= 6750, `fresh HUD is ${Buffer.byteLength(first.stdout())} B`)
    assert.equal(normalizeGeneratedAt(first.stdout()), normalizeGeneratedAt(second.stdout()))
    const capabilities = first.stdout().match(/<capabilities>([\s\S]*?)<\/capabilities>/)?.[1] ?? ''
    assert.match(capabilities, /ref="capability:endroit\/onboarding:onboard"[^\n]+entrypoints="endroit-onboarding"/)
    assert.match(capabilities, /ref="capability:endroit\/workplace:lifecycle"[^\n]+entrypoints="accept-this,archive-this,deliver-this,retain-this"/)
    for (const summary of new Set(model.items.capabilities.map((entry) => entry.summary))) {
      assert.equal((capabilities.match(new RegExp(`summary="${escapeRegex(summary)}"`, 'g')) ?? []).length, 1, summary)
    }

    for (let index = 1; index <= 8; index += 1) {
      assert.equal(await dispatchRuntime(home, 'room', ['create', `room-${index}`, '--scope', 'desk'], captureIo().io), 0)
    }
    for (let index = 1; index <= 14; index += 1) {
      await writeSite(home, {
        id: `site-${index}`,
        summary: `Site ${index}.`,
        when: [`Working on Site ${index}.`],
        tags: [`site-${index}`],
      })
    }
    await buildHome(home)
    const mature = captureIo()
    assert.equal(await dispatchRuntime(home, 'hud', ['prompt'], mature.io), 0, mature.stderr())
    assert.ok(Buffer.byteLength(mature.stdout()) <= 24955, `mature HUD is ${Buffer.byteLength(mature.stdout())} B`)
  } finally {
    await removeTree(temporary, { force: true })
  }
})

test('HUD prompt reports incomplete orientation instead of crashing', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'endroit-hud-orientation-'))
  try {
    const home = join(temporary, 'home')
    await createHome(home)
    await writeSite(home, {
      id: 'docs',
      summary: 'Documentation truth.',
      when: ['Working on documentation.'],
      tags: ['docs'],
    })
    await writeSite(home, {
      id: 'notes',
      summary: 'Notes truth.',
    })
    await writeFile(join(home, 'rooms', 'home', 'ROOM.md'), [
      '---',
      'id: "home"',
      'kind: "room"',
      'status: "active"',
      'owner: "room:home/home"',
      'created_at: "2026-01-01T00:00:00.000Z"',
      'updated_at: "2026-01-01T00:00:00.000Z"',
      'derived_from: []',
      '---',
      '',
      '# Home',
      '',
    ].join('\n'))

    const prompt = captureIo()
    assert.equal(await dispatchRuntime(home, 'hud', ['prompt'], prompt.io), 0)
    assert.match(prompt.stdout(), /metadata-error="summary must be a non-empty string\."/)
    assert.match(prompt.stdout(), /id="docs" state="declared" routable="false" access="model,user" summary="Documentation truth\." tags="docs" when="Working on documentation\."/)
    assert.doesNotMatch(prompt.stdout(), /subject="site:docs" code="orientation-invalid"/)
    assert.match(prompt.stdout(), /id="notes" state="declared" routable="false" access="model,user" summary="Notes truth\." tags="" ref="site:notes"[^\n]+map="missing"/)
    assert.match(prompt.stdout(), /subject="site:notes" code="site-routing-hint-missing">notes has no routing hint\.<\/item>/)
    assert.doesNotMatch(prompt.stdout(), /subject="site:notes" code="orientation-invalid"/)
    assert.doesNotMatch(prompt.stdout(), /code="site-map-missing"/)
  } finally {
    await removeTree(temporary, { force: true })
  }
})

test('HUD treats a valid separate Desk without a commit as unborn', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'endroit-hud-unborn-'))
  try {
    const home = join(temporary, 'home')
    await createHome(home, { deskStrategy: 'separate' })
    const json = captureIo()
    assert.equal(await dispatchRuntime(home, 'hud', ['json'], json.io), 0, json.stderr())
    const model = JSON.parse(json.stdout())
    assert.equal(model.desk.git.available, true)
    assert.equal(model.desk.git.head, null)
    const prompt = captureIo()
    assert.equal(await dispatchRuntime(home, 'hud', ['prompt'], prompt.io), 0, prompt.stderr())
    assert.match(prompt.stdout(), /<desk-git available="true"[^>]+state="unborn"/)
    assert.doesNotMatch(prompt.stdout(), /<desk-git available="false"/)
  } finally {
    await removeTree(temporary, { force: true })
  }
})

test('a retained Meeting is recoverable from a new inspection without transcript state', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'endroit-hud-recovery-'))
  try {
    const home = join(temporary, 'home')
    await createHome(home)
    assert.equal(await dispatchRuntime(home, 'room', ['create', 'recovery', '--scope', 'desk'], captureIo().io), 0)
    const meeting = join(home, '.desk/rooms/recovery/meetings/checkpoint')
    await mkdir(meeting, { recursive: true })
    await writeFile(join(meeting, 'MEETING.md'), [
      '---',
      'status: "retained"',
      'summary: "Resume the accepted checkpoint."',
      'when: ["Resuming retained checkpoint work."]',
      'tags: ["checkpoint"]',
      '---',
      '',
      '# Retained checkpoint',
      '',
      'Candidate retained; no decision accepted.',
      '',
    ].join('\n'))
    const before = await readdir(meeting)
    const inspect = async () => {
      const output = captureIo()
      assert.equal(await dispatchRuntime(home, 'hud', ['json'], output.io), 0, output.stderr())
      return JSON.parse(output.stdout()).items.meetings.find((entry) => entry.id === 'recovery/checkpoint')
    }
    const first = await inspect()
    const second = await inspect()
    assert.deepEqual(second, first)
    assert.equal(first.state, 'retained')
    assert.equal(first.routable, false)
    assert.deepEqual(await readdir(meeting), before)
    assert.deepEqual(before, ['MEETING.md'])
  } finally {
    await removeTree(temporary, { force: true })
  }
})

test('Room runtime enforces scoped identity and Doctor remains read-only', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'endroit-rooms-'))
  try {
    const home = join(temporary, 'home')
    await createHome(home)
    assert.equal(await dispatchRuntime(home, 'room', ['create', 'demo', '--scope', 'desk'], captureIo().io), 0)
    assert.equal(await dispatchRuntime(home, 'room', ['create', 'demo/hard-reset', '--scope', 'desk'], captureIo().io), 0)
    const nested = captureIo()
    assert.equal(await dispatchRuntime(home, 'room', ['list', '--json'], nested.io), 0, nested.stderr())
    assert.ok(JSON.parse(nested.stdout()).rooms.some((entry) => entry.ref === 'room:desk/demo/hard-reset'))
    const inspected = captureIo()
    assert.equal(await dispatchRuntime(home, 'room', ['inspect', 'desk/demo/hard-reset', '--json'], inspected.io), 0, inspected.stderr())
    assert.equal(JSON.parse(inspected.stdout()).document.owner, 'room:desk/demo/hard-reset')
    assert.ok((await resolveHome(home)).rooms.some((entry) => entry.ref === 'room:desk/demo/hard-reset'))
    const missingParent = captureIo()
    assert.equal(await dispatchRuntime(home, 'room', ['create', 'missing/child', '--scope', 'desk'], missingParent.io), 4)
    assert.match(missingParent.stderr(), /Parent Room/)
    const duplicate = captureIo()
    assert.equal(await dispatchRuntime(home, 'room', ['create', 'demo', '--scope', 'home'], duplicate.io), 4)
    assert.match(duplicate.stderr(), /already exists/)
    const before = await tree(join(home, 'rooms'))
    const doctor = captureIo()
    assert.equal(await dispatchRuntime(home, 'room', ['doctor', '--json'], doctor.io), 0)
    assert.equal(JSON.parse(doctor.stdout()).status, 'ready')
    assert.deepEqual(await tree(join(home, 'rooms')), before)

    const team = join(temporary, 'team')
    await createHome(team, { deskStrategy: 'later' })
    const missingDesk = captureIo()
    assert.equal(await dispatchRuntime(team, 'room', ['create', 'private', '--scope', 'desk'], missingDesk.io), 4)
    assert.match(missingDesk.stderr(), /configured Desk/)
  } finally {
    await removeTree(temporary, { force: true })
  }
})

test('Artifacts import directories atomically and publish while preserving the Desk source', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'endroit-artifacts-'))
  try {
    const home = join(temporary, 'home')
    await createHome(home)
    await addEquipment(home, ['@endroit/scratch'])
    await buildHome(home)
    assert.equal(await dispatchRuntime(home, 'room', ['create', 'demo', '--scope', 'desk'], captureIo().io), 0)
    assert.equal(await dispatchRuntime(home, 'room', ['create', 'demo/nested', '--scope', 'desk'], captureIo().io), 0)
    const source = join(temporary, 'notes')
    await mkdir(source)
    await writeFile(join(source, 'decision.md'), 'Choose boring primitives.\n')
    const missingRoom = captureIo()
    assert.equal(await dispatchRuntime(home, 'artifact', ['create', 'endroit/scratch:scratch', 'missing'], missingRoom.io), 2)
    assert.match(missingRoom.stderr(), /Room is required/)
    const create = captureIo()
    assert.equal(await dispatchRuntime(home, 'artifact', ['create', 'endroit/scratch:scratch', 'demo', '--room', 'desk/demo', '--from', source, '--json'], create.io), 0)
    const created = JSON.parse(create.stdout())
    assert.equal(created.path, '.desk/rooms/demo/exploring/scratch/demo')
    assert.equal(created.path.includes('endroit-scratch-scratch'), false)
    const path = join(home, created.path, 'artifact.md')
    assert.match(await readFile(path, 'utf8'), /kind: "endroit\/scratch:scratch"/)
    assert.equal(await readFile(join(home, created.path, 'decision.md'), 'utf8'), 'Choose boring primitives.\n')
    assert.equal(await dispatchRuntime(home, 'artifact', ['validate', path], captureIo().io), 0)
    const publish = captureIo()
    assert.equal(await dispatchRuntime(home, 'artifact', ['publish', path, '--to', 'home', '--json'], publish.io), 0, publish.stderr())
    const published = JSON.parse(publish.stdout())
    assert.equal(publish.stdout().includes('deprecated'), true)
    assert.equal((await lstat(path)).isFile(), true)
    assert.equal((await lstat(join(home, published.path, 'artifact.md'))).isFile(), true)
    assert.match(await readFile(join(home, published.path, 'artifact.md'), 'utf8'), /source_digest: "sha256:[a-f0-9]{64}"/)
    const reverse = captureIo()
    assert.equal(await dispatchRuntime(home, 'artifact', ['promote', published.path, '--to', 'room:desk/demo'], reverse.io), 2)
    assert.match(reverse.stderr(), /room:home/)

    const nested = captureIo()
    assert.equal(await dispatchRuntime(home, 'artifact', [
      'create',
      'endroit/scratch:scratch',
      'nested',
      '--room',
      'desk/demo/nested',
      '--json',
    ], nested.io), 0, nested.stderr())
    assert.equal(JSON.parse(nested.stdout()).path, '.desk/rooms/demo/nested/exploring/scratch/nested')

    const legacy = join(home, '.desk/artifacts/endroit/scratch/scratch/legacy')
    await mkdir(legacy, { recursive: true })
    await writeFile(join(legacy, 'artifact.md'), [
      '---',
      '$schema: "https://endroit.org/schema/artifact.json"',
      'id: "legacy"',
      'kind: "endroit/scratch:scratch"',
      'owner: "desk"',
      'state: "active"',
      'createdBy: "endroit/scratch"',
      'createdAt: "2026-01-01T00:00:00.000Z"',
      'derivedFrom: ""',
      '---',
      '',
      '# Legacy',
      '',
    ].join('\n'))
    const legacyValidation = captureIo()
    assert.equal(await dispatchRuntime(home, 'artifact', ['validate', legacy, '--json'], legacyValidation.io), 0, legacyValidation.stderr())
    assert.equal(JSON.parse(legacyValidation.stdout()).legacy, true)
  } finally {
    await removeTree(temporary, { force: true })
  }
})

test('Publishing keeps exact local content and observable Handles instruction-only', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'endroit-publishing-'))
  try {
    const home = join(temporary, 'home')
    await createHome(home, { equipment: ['@endroit/publishing'] })
    await dispatchRuntime(home, 'room', ['create', 'editorial', '--scope', 'desk'], captureIo().io)
    const created = captureIo()
    assert.equal(await dispatchRuntime(home, 'artifact', [
      'create',
      'endroit/publishing:publication',
      'launch',
      '--room',
      'desk/editorial',
      '--status',
      'ready',
      '--field',
      'format="post"',
      '--field',
      'title="Launch"',
      '--field',
      'audience="users"',
      '--field',
      'language="en"',
      '--field',
      'channel="web"',
      '--json',
    ], created.io), 0, created.stderr())
    const publication = JSON.parse(created.stdout())
    assert.equal(await readFile(join(home, publication.path, 'content.md'), 'utf8'), '# Draft\n')
    assert.equal((await resolveHome(home)).runtimes.some((entry) => entry.namespace === 'publishing'), false)
    const contract = await readFile(join(home, 'equipment/endroit/publishing/capabilities/publish.md'), 'utf8')
    assert.match(contract, /exact content, equipment,\s+links, account, destination/)
    assert.match(contract, /Do not create the Handle/)
    await rm(join(home, publication.path, 'content.md'))
    const invalid = captureIo()
    assert.equal(await dispatchRuntime(home, 'artifact', ['validate', publication.path], invalid.io), 4)
    assert.match(invalid.stderr(), /requires content.md/)
  } finally {
    await removeTree(temporary, { force: true })
  }
})

test('Sites separate deterministic inspection from agent-authored Map Artifacts', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'endroit-sites-'))
  try {
    const home = join(temporary, 'home')
    const site = join(temporary, 'site')
    await createHome(home)
    assert.equal(await dispatchRuntime(home, 'room', ['create', 'maps', '--scope', 'desk'], captureIo().io), 0)
    await exec('git', ['init', '--quiet', '--initial-branch=main', site])
    await writeFile(join(site, 'README.md'), '# Demo\n')
    await writeFile(join(site, 'package.json'), '{\"name\":\"demo\"}\n')
    await exec('git', ['add', '--all'], { cwd: site })
    await exec('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '-m', 'initial'], { cwd: site })
    await exec('git', ['remote', 'add', 'origin', 'https://github.com/example/demo.git'], { cwd: site })
    const added = captureIo()
    assert.equal(await dispatchRuntime(home, 'site', ['add', site, '--id', 'demo', '--emoji', '🧪'], added.io), 0, added.stderr())
    assert.match(await readFile(join(home, 'sites/demo/SITE.md'), 'utf8'), /emoji: "🧪"/)
    const missingMap = captureIo()
    assert.equal(await dispatchRuntime(home, 'hud', ['prompt'], missingMap.io), 0, missingMap.stderr())
    assert.match(missingMap.stdout(), /id="demo"[^\n]+map="missing"/)
    assert.doesNotMatch(missingMap.stdout(), /code="site-map-missing"/)
    const second = join(temporary, 'site-worktree')
    await exec('git', ['worktree', 'add', '--quiet', '--detach', second, 'HEAD'], { cwd: site })
    const bound = captureIo()
    assert.equal(await dispatchRuntime(home, 'site', ['route', 'bind', 'demo', second, '--id', 'experiment'], bound.io), 0, bound.stderr())
    const ambiguous = captureIo()
    assert.equal(await dispatchRuntime(home, 'site', ['route', 'inspect', 'demo'], ambiguous.io), 4)
    assert.match(ambiguous.stderr(), /route_ambiguous/)
    const before = await tree(site)
    const inspectedOutput = captureIo()
    assert.equal(await dispatchRuntime(home, 'site', ['route', 'inspect', 'demo', '--id', 'main', '--json'], inspectedOutput.io), 0, inspectedOutput.stderr())
    assert.deepEqual(await tree(site), before)
    const inspected = JSON.parse(inspectedOutput.stdout())
    assert.equal(inspected.status, 'inspected')
    assert.deepEqual(inspected.files, ['README.md', 'package.json'])
    assert.deepEqual(inspected.manifests, ['package.json'])
    assert.deepEqual(inspected.tests, [])

    const mappedOutput = captureIo()
    assert.equal(await dispatchRuntime(home, 'artifact', [
      'create',
      'endroit/sites:site-map',
      'demo-main',
      '--room',
      'desk/maps',
      '--status',
      'current',
      '--derived-from',
      `site:demo@${inspected.head}`,
      '--field',
      'sites=["demo"]',
      '--json',
    ], mappedOutput.io), 0, mappedOutput.stderr())
    const mapped = JSON.parse(mappedOutput.stdout())
    assert.equal(mapped.path, '.desk/rooms/maps/site-mapping/site-map/demo-main')
    const map = join(home, mapped.path, 'artifact.md')
    assert.match(await readFile(map, 'utf8'), /derived_from: \["site:demo@[a-f0-9]{40}"\]/)
    for (const name of ['EVIDENCE.json', 'STACK.md', 'INTEGRATIONS.md', 'ARCHITECTURE.md', 'STRUCTURE.md', 'CONVENTIONS.md', 'TESTING.md', 'CONCERNS.md']) {
      assert.equal((await lstat(join(home, mapped.path, name))).isFile(), true)
    }
    assert.equal(await dispatchRuntime(home, 'artifact', ['validate', mapped.path], captureIo().io), 0)
    assert.deepEqual(await tree(site), before)
    await writeFile(join(site, 'README.md'), '# Demo updated\n')
    await exec('git', ['add', 'README.md'], { cwd: site })
    await exec('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '-m', 'update'], { cwd: site })
    await writeFile(join(second, 'README.md'), '# Demo experiment\n')
    await exec('git', ['add', 'README.md'], { cwd: second })
    await exec('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '-m', 'experiment'], { cwd: second })
    const stale = captureIo()
    assert.equal(await dispatchRuntime(home, 'hud', ['prompt'], stale.io), 0, stale.stderr())
    assert.match(stale.stdout(), /subject="site:demo" code="site-map-stale"/)
  } finally {
    await removeTree(temporary, { force: true })
  }
})

async function tree(root) {
  const values = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.name === '.git') continue
    values.push(entry.name)
  }
  return values.sort()
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function normalizeGeneratedAt(value) {
  return value.replace(/generated-at="[^"]+"/, 'generated-at="<time>"')
}
