import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { addAssets } from '../src/assets.mjs'
import { buildHome } from '../src/build.mjs'
import { createHome } from '../src/create.mjs'
import { resolveHome } from '../src/resolved.mjs'
import { dispatchRuntime } from '../src/runtime.mjs'
import { captureIo } from './helpers.mjs'

const exec = promisify(execFile)

test('HUD exposes deterministic human, JSON and agent-prompt views without following Desk symlinks', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'hairness-hud-'))
  try {
    const home = join(temporary, 'home')
    await createHome(home, { emoji: '🏠' })
    const desk = JSON.parse(await readFile(join(home, '.desk/desk.json'), 'utf8'))
    desk.settings = { 'hairness/onboarding': { addressAs: 'Alexis', responseLanguage: 'fr' } }
    await writeFile(join(home, '.desk/desk.json'), `${JSON.stringify(desk, null, 2)}\n`)
    for (let index = 0; index < 7; index += 1) {
      const path = join(home, '.desk', `note-${index}.md`)
      await writeFile(path, `${index}\n`)
      const time = new Date(Date.now() + index * 1000)
      await utimes(path, time, time)
    }
    const workspace = join(home, '.desk', 'workspaces', 'demo')
    assert.equal(await dispatchRuntime(home, 'workspace', ['create', 'demo', '--scope', 'desk'], captureIo().io), 0)
    await writeFile(join(workspace, 'workspace.md'), [
      '---',
      'id: "demo"',
      'kind: "workspace"',
      'status: "active"',
      'owner: "workspace:desk/demo"',
      'created_at: "2026-01-01T00:00:00.000Z"',
      'updated_at: "2026-01-01T00:00:00.000Z"',
      'derived_from: []',
      'emoji: "🎛️"',
      'summary: "Demo Workspace."',
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
    assert.equal(model.kernel.invoke, 'node ./hairness.mjs')
    assert.deepEqual(model.desk.preferences, { addressAs: 'Alexis', responseLanguage: 'fr' })
    assert.equal(model.projections.every((entry) => entry.status === 'fresh'), true)
    assert.deepEqual(model.surfaces.assets.map((entry) => entry.id), ['hairness/artifacts', 'hairness/hud', 'hairness/onboarding', 'hairness/targets', 'hairness/workspaces'])
    assert.deepEqual(model.surfaces.runtimes.map((entry) => entry.namespace), ['artifact', 'hud', 'target', 'workspace'])
    assert.deepEqual(
      model.trust.runtimes.map((entry) => [entry.owner, entry.trust]),
      [
        ['hairness/artifacts', 'bundled'],
        ['hairness/hud', 'bundled'],
        ['hairness/targets', 'bundled'],
        ['hairness/workspaces', 'bundled'],
      ],
    )
    assert.deepEqual({ bundled: model.trust.bundled, approved: model.trust.approved, pending: model.trust.pending }, {
      bundled: 4,
      approved: 0,
      pending: 0,
    })
    assert.equal(model.recentDesk.length, 5)
    assert.deepEqual(model.recentDesk.map((entry) => entry.path), ['note-6.md', 'note-5.md', 'note-4.md', 'note-3.md', 'note-2.md'])
    assert.equal(model.recentDesk.some((entry) => entry.path === 'outside-link'), false)
    assert.deepEqual(
      model.items.workspaces.map(({ id, routable }) => [id, routable]),
      [['home', true], ['demo', true]],
    )
    assert.equal(model.items.workspaces[1].emoji, '🎛️')
    assert.ok(model.items.capabilities.some(({ id }) => id === 'hairness-home'))
    assert.deepEqual(Object.keys(model.attention), ['blocking', 'warning', 'advisory'])

    const prompt = captureIo()
    await dispatchRuntime(home, 'hud', ['prompt'], prompt.io)
    assert.match(prompt.stdout(), /^<hairness-hud version="2" status="ready" generated-at="[^"]+" event="command">/)
    assert.match(prompt.stdout(), new RegExp(`<home name="home" emoji="🏠" mode="solo" root="${escapeRegex(model.home.root)}" providers="codex,claude"/>`))
    assert.match(prompt.stdout(), /<kernel runtime="@hairness\/cli@0\.6\.0-alpha\.0" source="npm" invoke="node \.\/hairness\.mjs"\/>/)
    assert.match(prompt.stdout(), /<item id="demo" emoji="🎛️" state="active" access="model,user" summary="Demo Workspace\." tags="demo" when="Working on the demo\." ref="workspace:desk\/demo"/)
    assert.match(prompt.stdout(), /<runtime namespace="target" commands="list,discover,doctor,add,bind,clone,worktree,unbind,remove,inspect"\/>/)
    assert.match(prompt.stdout(), /<instruction owner="hairness\/desk" id="desk" source="DESK\.md">/)
    assert.match(prompt.stdout(), /<advisory>\s+<item subject="home" code="home-dirty">/)
    assert.doesNotMatch(prompt.stdout(), /<assets>|<skills>|<commands>|<recent-desk>/)
    assert.doesNotMatch(prompt.stdout(), /outside-link/)

    const activity = captureIo()
    assert.equal(await dispatchRuntime(home, 'hud', ['activity', '--since', '1d', '--scope', 'workspace:desk/demo', '--json'], activity.io), 0)
    const activityModel = JSON.parse(activity.stdout())
    assert.equal(activityModel.apiVersion, 'hairness.dev/hud/activity/v1alpha1')
    assert.equal(activityModel.scope, 'workspace:desk/demo')
    assert.ok(activityModel.events.some(({ source }) => source.ref.endsWith('workspace.md')))
    assert.equal(activityModel.events.some(({ source }) => source.ref.includes('outside-link')), false)
    const unknown = captureIo()
    assert.equal(await dispatchRuntime(home, 'hud', ['activity', '--scope', 'workspace:unknown'], unknown.io), 5)
    assert.match(unknown.stderr(), /activity_scope_unknown/)
    const invalidSince = captureIo()
    assert.equal(await dispatchRuntime(home, 'hud', ['activity', '--since', `${'9'.repeat(400)}w`], invalidSince.io), 5)
    assert.match(invalidSince.stderr(), /activity_since_invalid/)

    const human = captureIo()
    await dispatchRuntime(home, 'hud', ['show'], human.io)
    assert.equal(human.stdout().split('\n')[0], 'HAIRNESS    home · solo · codex+claude · @hairness/cli@0.6.0-alpha.0 · npm · ready')
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
})

test('the HUD owns its prompt budget through namespaced Home settings', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'hairness-hud-budget-'))
  try {
    const home = join(temporary, 'home')
    await createHome(home)
    const path = join(home, 'hairness.json')
    const document = JSON.parse(await readFile(path, 'utf8'))
    document.settings = { 'hairness/hud': { promptBytes: 1 } }
    await writeFile(path, `${JSON.stringify(document, null, 2)}\n`)
    const output = captureIo()
    assert.equal(await dispatchRuntime(home, 'hud', ['prompt'], output.io), 5)
    assert.match(output.stderr(), /hud_budget_exceeded/)
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
})

test('Workspace runtime enforces scoped identity and Doctor remains read-only', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'hairness-workspaces-'))
  try {
    const home = join(temporary, 'home')
    await createHome(home)
    assert.equal(await dispatchRuntime(home, 'workspace', ['create', 'demo', '--scope', 'desk'], captureIo().io), 0)
    const duplicate = captureIo()
    assert.equal(await dispatchRuntime(home, 'workspace', ['create', 'demo', '--scope', 'home'], duplicate.io), 4)
    assert.match(duplicate.stderr(), /already exists/)
    const before = await tree(join(home, 'workspaces'))
    const doctor = captureIo()
    assert.equal(await dispatchRuntime(home, 'workspace', ['doctor', '--json'], doctor.io), 0)
    assert.equal(JSON.parse(doctor.stdout()).status, 'ready')
    assert.deepEqual(await tree(join(home, 'workspaces')), before)

    const team = join(temporary, 'team')
    await createHome(team, { mode: 'team' })
    const missingDesk = captureIo()
    assert.equal(await dispatchRuntime(team, 'workspace', ['create', 'private', '--scope', 'desk'], missingDesk.io), 4)
    assert.match(missingDesk.stderr(), /configured Desk/)
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
})

test('Artifacts import directories atomically and publish while preserving the Desk source', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'hairness-artifacts-'))
  try {
    const home = join(temporary, 'home')
    await createHome(home)
    await addAssets(home, ['@hairness/scratch'])
    await buildHome(home)
    assert.equal(await dispatchRuntime(home, 'workspace', ['create', 'demo', '--scope', 'desk'], captureIo().io), 0)
    const source = join(temporary, 'notes')
    await mkdir(source)
    await writeFile(join(source, 'decision.md'), 'Choose boring primitives.\n')
    const missingWorkspace = captureIo()
    assert.equal(await dispatchRuntime(home, 'artifact', ['create', 'hairness/scratch:scratch', 'missing'], missingWorkspace.io), 2)
    assert.match(missingWorkspace.stderr(), /Workspace is required/)
    const create = captureIo()
    assert.equal(await dispatchRuntime(home, 'artifact', ['create', 'hairness/scratch:scratch', 'demo', '--workspace', 'desk/demo', '--from', source, '--json'], create.io), 0)
    const created = JSON.parse(create.stdout())
    assert.equal(created.path, '.desk/workspaces/demo/exploring/scratch/demo')
    assert.equal(created.path.includes('hairness-scratch-scratch'), false)
    const path = join(home, created.path, 'artifact.md')
    assert.match(await readFile(path, 'utf8'), /kind: "hairness\/scratch:scratch"/)
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
    assert.equal(await dispatchRuntime(home, 'artifact', ['promote', published.path, '--to', 'workspace:desk/demo'], reverse.io), 2)
    assert.match(reverse.stderr(), /workspace:home/)

    const legacy = join(home, '.desk/artifacts/hairness/scratch/scratch/legacy')
    await mkdir(legacy, { recursive: true })
    await writeFile(join(legacy, 'artifact.md'), [
      '---',
      '$schema: "https://hairness.dev/schema/artifact.json"',
      'id: "legacy"',
      'kind: "hairness/scratch:scratch"',
      'owner: "desk"',
      'state: "active"',
      'createdBy: "hairness/scratch"',
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
    await rm(temporary, { recursive: true, force: true })
  }
})

test('Publishing keeps exact local content and observable Handles instruction-only', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'hairness-publishing-'))
  try {
    const home = join(temporary, 'home')
    await createHome(home, { assets: ['@hairness/publishing'] })
    await dispatchRuntime(home, 'workspace', ['create', 'editorial', '--scope', 'desk'], captureIo().io)
    const created = captureIo()
    assert.equal(await dispatchRuntime(home, 'artifact', [
      'create',
      'hairness/publishing:publication',
      'launch',
      '--workspace',
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
    const contract = await readFile(join(home, 'assets/hairness/publishing/capabilities/publish.md'), 'utf8')
    assert.match(contract, /exact content, assets,\s+links, account, destination/)
    assert.match(contract, /Do not create the Handle/)
    await rm(join(home, publication.path, 'content.md'))
    const invalid = captureIo()
    assert.equal(await dispatchRuntime(home, 'artifact', ['validate', publication.path], invalid.io), 4)
    assert.match(invalid.stderr(), /requires content.md/)
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
})

test('Targets separate deterministic inspection from agent-authored Map Artifacts', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'hairness-targets-'))
  try {
    const home = join(temporary, 'home')
    const target = join(temporary, 'target')
    await createHome(home)
    assert.equal(await dispatchRuntime(home, 'workspace', ['create', 'maps', '--scope', 'desk'], captureIo().io), 0)
    await exec('git', ['init', '--quiet', '--initial-branch=main', target])
    await writeFile(join(target, 'README.md'), '# Demo\n')
    await writeFile(join(target, 'package.json'), '{\"name\":\"demo\"}\n')
    await exec('git', ['add', '--all'], { cwd: target })
    await exec('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '-m', 'initial'], { cwd: target })
    await exec('git', ['remote', 'add', 'origin', 'https://github.com/example/demo.git'], { cwd: target })
    const added = captureIo()
    assert.equal(await dispatchRuntime(home, 'target', ['add', target, '--id', 'demo', '--emoji', '🧪'], added.io), 0, added.stderr())
    assert.equal(
      JSON.parse(await readFile(join(home, 'hairness.json'), 'utf8')).settings['hairness/targets'].targets[0].emoji,
      '🧪',
    )
    const second = join(temporary, 'target-worktree')
    await exec('git', ['worktree', 'add', '--quiet', '--detach', second, 'HEAD'], { cwd: target })
    const bound = captureIo()
    assert.equal(await dispatchRuntime(home, 'target', ['bind', 'demo', second, '--binding', 'experiment'], bound.io), 0, bound.stderr())
    const ambiguous = captureIo()
    assert.equal(await dispatchRuntime(home, 'target', ['inspect', 'demo'], ambiguous.io), 4)
    assert.match(ambiguous.stderr(), /target_binding_ambiguous/)
    const before = await tree(target)
    const inspectedOutput = captureIo()
    assert.equal(await dispatchRuntime(home, 'target', ['inspect', 'demo', '--binding', 'main', '--json'], inspectedOutput.io), 0, inspectedOutput.stderr())
    assert.deepEqual(await tree(target), before)
    const inspected = JSON.parse(inspectedOutput.stdout())
    assert.equal(inspected.status, 'inspected')
    assert.deepEqual(inspected.files, ['README.md', 'package.json'])
    assert.deepEqual(inspected.manifests, ['package.json'])
    assert.deepEqual(inspected.tests, [])

    const mappedOutput = captureIo()
    assert.equal(await dispatchRuntime(home, 'artifact', [
      'create',
      'hairness/targets:target-map',
      'demo-main',
      '--workspace',
      'desk/maps',
      '--status',
      'current',
      '--derived-from',
      `target:demo@${inspected.head}`,
      '--field',
      'targets=["demo"]',
      '--json',
    ], mappedOutput.io), 0, mappedOutput.stderr())
    const mapped = JSON.parse(mappedOutput.stdout())
    const map = join(home, mapped.path, 'artifact.md')
    assert.match(await readFile(map, 'utf8'), /derived_from: \["target:demo@[a-f0-9]{40}"\]/)
    for (const name of ['EVIDENCE.json', 'STACK.md', 'INTEGRATIONS.md', 'ARCHITECTURE.md', 'STRUCTURE.md', 'CONVENTIONS.md', 'TESTING.md', 'CONCERNS.md']) {
      assert.equal((await lstat(join(home, mapped.path, name))).isFile(), true)
    }
    assert.equal(await dispatchRuntime(home, 'artifact', ['validate', mapped.path], captureIo().io), 0)
    assert.deepEqual(await tree(target), before)
  } finally {
    await rm(temporary, { recursive: true, force: true })
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
