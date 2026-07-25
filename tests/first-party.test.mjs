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
import { dispatchRuntime } from '../src/runtime.mjs'
import { captureIo } from './helpers.mjs'

const exec = promisify(execFile)

test('HUD exposes deterministic human, JSON and agent-prompt views without following Desk symlinks', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'hairness-hud-'))
  try {
    const home = join(temporary, 'home')
    await createHome(home)
    const desk = JSON.parse(await readFile(join(home, '.desk/desk.json'), 'utf8'))
    desk.settings = { 'hairness/onboarding': { addressAs: 'Alexis', responseLanguage: 'fr' } }
    await writeFile(join(home, '.desk/desk.json'), `${JSON.stringify(desk, null, 2)}\n`)
    for (let index = 0; index < 7; index += 1) {
      const path = join(home, '.desk', `note-${index}.md`)
      await writeFile(path, `${index}\n`)
      const time = new Date(Date.now() + index * 1000)
      await utimes(path, time, time)
    }
    const outside = join(temporary, 'outside.md')
    await writeFile(outside, 'outside\n')
    await symlink(outside, join(home, '.desk', 'outside-link'))

    const json = captureIo()
    assert.equal(await dispatchRuntime(home, 'hud', ['--json'], json.io), 0)
    const model = JSON.parse(json.stdout())
    assert.equal(model.home.name, 'home')
    assert.equal(model.home.root, await exec('git', ['rev-parse', '--show-toplevel'], { cwd: home }).then((value) => value.stdout.trim()))
    assert.equal(model.kernel.source, 'registry')
    assert.equal(model.kernel.invoke, 'npx --yes @hairness/cli@0.5.0-alpha.0')
    assert.deepEqual(model.desk.preferences, { addressAs: 'Alexis', responseLanguage: 'fr' })
    assert.equal(model.projections.every((entry) => entry.status === 'fresh'), true)
    assert.deepEqual(model.surfaces.assets.map((entry) => entry.id), ['hairness/artifacts', 'hairness/hud', 'hairness/onboarding', 'hairness/targets'])
    assert.deepEqual(model.surfaces.runtimes.map((entry) => entry.namespace), ['artifact', 'hud', 'target'])
    assert.equal(model.recentDesk.length, 5)
    assert.deepEqual(model.recentDesk.map((entry) => entry.path), ['note-6.md', 'note-5.md', 'note-4.md', 'note-3.md', 'note-2.md'])
    assert.equal(model.recentDesk.some((entry) => entry.path === 'outside-link'), false)
    assert.deepEqual(Object.keys(model.attention), ['blocking', 'warning', 'advisory'])

    const prompt = captureIo()
    await dispatchRuntime(home, 'hud', ['--prompt'], prompt.io)
    assert.match(prompt.stdout(), /^<hairness-hud version="1" status="ready" generated-at="[^"]+" event="on-demand">/)
    assert.match(prompt.stdout(), new RegExp(`<home name="home" mode="solo" root="${escapeRegex(model.home.root)}" providers="codex,claude"/>`))
    assert.match(prompt.stdout(), /<kernel runtime="@hairness\/cli@0\.5\.0-alpha\.0" source="registry" invoke="npx --yes @hairness\/cli@0\.5\.0-alpha\.0"\/>/)
    assert.match(prompt.stdout(), /<asset id="hairness\/hud" version="0\.5\.0-alpha\.0" scope="home" overridden="false" runtime="hud"\/>/)
    assert.match(prompt.stdout(), /<runtime owner="hairness\/targets" namespace="target" scope="home">/)
    assert.match(prompt.stdout(), /<instruction owner="hairness\/desk" id="desk" source="DESK\.md">/)
    assert.match(prompt.stdout(), /<advisory>\s+<item subject="home" code="home-dirty">/)
    assert.doesNotMatch(prompt.stdout(), /outside-link/)
    const human = captureIo()
    await dispatchRuntime(home, 'hud', [], human.io)
    assert.equal(human.stdout().split('\n')[0], 'HAIRNESS    home · solo · codex+claude · @hairness/cli@0.5.0-alpha.0 · registry · ready')
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
    const source = join(temporary, 'notes')
    await mkdir(source)
    await writeFile(join(source, 'decision.md'), 'Choose boring primitives.\n')
    const create = captureIo()
    assert.equal(await dispatchRuntime(home, 'artifact', ['create', 'hairness/scratch:scratch', 'demo', '--from', source, '--json'], create.io), 0)
    const created = JSON.parse(create.stdout())
    const path = join(home, created.path, 'artifact.md')
    assert.match(await readFile(path, 'utf8'), /kind: "hairness\/scratch:scratch"/)
    assert.equal(await readFile(join(home, created.path, 'decision.md'), 'utf8'), 'Choose boring primitives.\n')
    assert.equal(await dispatchRuntime(home, 'artifact', ['validate', path], captureIo().io), 0)
    const publish = captureIo()
    assert.equal(await dispatchRuntime(home, 'artifact', ['publish', path, '--to', 'home', '--json'], publish.io), 0, publish.stderr())
    const published = JSON.parse(publish.stdout())
    assert.equal((await lstat(path)).isFile(), true)
    assert.equal((await lstat(join(home, published.path, 'artifact.md'))).isFile(), true)
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
})

test('Targets support named Bindings and map without writing into the Target', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'hairness-targets-'))
  try {
    const home = join(temporary, 'home')
    const target = join(temporary, 'target')
    await createHome(home)
    await exec('git', ['init', '--quiet', '--initial-branch=main', target])
    await writeFile(join(target, 'README.md'), '# Demo\n')
    await writeFile(join(target, 'package.json'), '{\"name\":\"demo\"}\n')
    await exec('git', ['add', '--all'], { cwd: target })
    await exec('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '-m', 'initial'], { cwd: target })
    await exec('git', ['remote', 'add', 'origin', 'https://github.com/example/demo.git'], { cwd: target })
    const added = captureIo()
    assert.equal(await dispatchRuntime(home, 'target', ['add', target, '--id', 'demo'], added.io), 0, added.stderr())
    const second = join(temporary, 'target-worktree')
    await exec('git', ['worktree', 'add', '--quiet', '--detach', second, 'HEAD'], { cwd: target })
    const bound = captureIo()
    assert.equal(await dispatchRuntime(home, 'target', ['bind', 'demo', second, '--binding', 'experiment'], bound.io), 0, bound.stderr())
    const ambiguous = captureIo()
    assert.equal(await dispatchRuntime(home, 'target', ['map', 'demo'], ambiguous.io), 4)
    assert.match(ambiguous.stderr(), /target_binding_ambiguous/)
    const before = await tree(target)
    const mappedOutput = captureIo()
    assert.equal(await dispatchRuntime(home, 'target', ['map', 'demo', '--binding', 'main', '--id', 'demo-main', '--json'], mappedOutput.io), 0, mappedOutput.stderr())
    assert.deepEqual(await tree(target), before)
    const mapped = JSON.parse(mappedOutput.stdout())
    const map = join(home, mapped.artifact, 'artifact.md')
    assert.match(await readFile(map, 'utf8'), /derivedFrom: "target:demo@[a-f0-9]{40}"/)
    for (const name of ['STACK.md', 'INTEGRATIONS.md', 'ARCHITECTURE.md', 'STRUCTURE.md', 'CONVENTIONS.md', 'TESTING.md', 'CONCERNS.md']) {
      assert.equal((await lstat(join(home, mapped.artifact, name))).isFile(), true)
    }
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
