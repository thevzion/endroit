import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { createArtifact, inspectArtifact, publishArtifact, validateArtifact } from '../src/artifacts.mjs'
import { addAssets } from '../src/assets.mjs'
import { buildHome } from '../src/build.mjs'
import { runCli } from '../src/cli.mjs'
import { cloneDesk, createHome, deskStatus, initDesk, initHome } from '../src/create.mjs'
import { doctorHome } from '../src/doctor.mjs'
import { hudModel, renderHud, renderHudPrompt } from '../src/hud.mjs'
import { assertRuntime } from '../src/home.mjs'
import { publicPlan, resolveHome } from '../src/resolved.mjs'
import { addTarget, bindTarget, cloneTarget, listTargets, mapTarget, unbindTarget } from '../src/targets.mjs'

const exec = promisify(execFile)

test('create produces a source-owned solo Home with tracked shared projections', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hairness-create-'))
  try {
    const home = join(root, 'home')
    await createHome(home, { providers: ['codex', 'claude'] })
    const document = JSON.parse(await readFile(join(home, 'hairness.json'), 'utf8'))
    assert.deepEqual(document, {
      $schema: 'https://hairness.dev/schema/home.json',
      name: 'home',
      runtime: '@hairness/cli@0.5.0-alpha.0',
      mode: 'solo',
      providers: ['codex', 'claude'],
    })
    assert.equal(JSON.parse(await readFile(join(home, '.desk/desk.json'), 'utf8')).id, 'owner')
    const tracked = (await exec('git', ['ls-files'], { cwd: home })).stdout
    for (const path of [
      'assets/hairness/home/asset.json',
      'assets/hairness/targets/asset.json',
      '.agents/skills/hairness-home/SKILL.md',
      '.agents/skills/hairness-onboarding/SKILL.md',
      '.claude/skills/hairness-onboarding/SKILL.md',
      'AGENTS.md',
      'CLAUDE.md',
      '.codex/hooks.json',
      '.claude/settings.json',
      '.desk/desk.json',
    ]) assert.match(tracked, new RegExp(`^${path.replaceAll('.', '\\.')}$`, 'm'))
    assert.doesNotMatch(tracked, /^\.hairness\//m)
    assert.doesNotMatch(tracked, /^assets\/.*\/hairness\.json$/m)
    await buildHome(home, { check: true })
    assert.equal((await doctorHome(home)).status, 'ready')
    const plan = await resolveHome(home)
    assert.match(plan.digest, /^sha256:/)
    assert.equal(publicPlan(plan).assets.length, 2)
    const hud = await hudModel(home)
    assert.match(renderHud(hud), /HOME\s+home · solo/)
    assert.match(renderHud(hud, { full: true }), /hairness\/home:home/)
    const prompt = renderHudPrompt(hud, plan)
    assert.match(prompt, /<hairness-hud/)
    assert.match(prompt, /<home name="home"/)
    assert.match(prompt, /<surfaces assets="2"/)
    assert.match(prompt, /namespaces="artifact,command,desk,hud,target"/)
    document.runtime = '@hairness/cli@9.0.0'
    await writeFile(join(home, 'hairness.json'), `${JSON.stringify(document, null, 2)}\n`)
    await assert.rejects(() => assertRuntime(home), (error) => error.code === 'runtime_mismatch')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('team mode leaves Desk creation to onboarding and initializes an independent Desk repository', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hairness-team-'))
  try {
    await initHome(root, { name: 'team-home', mode: 'team', providers: ['codex'] })
    assert.deepEqual(await deskStatus(root), { mode: 'team', present: false, desk: null })
    assert.match(await readFile(join(root, '.gitignore'), 'utf8'), /^\.desk\/$/m)
    await initDesk(root, { id: 'alexis' })
    assert.equal((await deskStatus(root)).desk.id, 'alexis')
    assert.equal(await readFile(join(root, '.desk/.git/HEAD'), 'utf8'), 'ref: refs/heads/main\n')
    assert.match(await readFile(join(root, '.desk/.gitignore'), 'utf8'), /^\/targets\/$/m)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a cloned team Home is usable before a collaborator creates a Desk', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hairness-team-clone-'))
  try {
    const source = join(root, 'source')
    const clone = join(root, 'clone')
    await createHome(source, { mode: 'team', providers: ['codex', 'claude'] })
    await exec('git', ['clone', '--quiet', source, clone])
    assert.deepEqual(await deskStatus(clone), { mode: 'team', present: false, desk: null })
    await readFile(join(clone, 'AGENTS.md'))
    await readFile(join(clone, 'CLAUDE.md'))
    await readFile(join(clone, '.agents/skills/hairness-onboarding/SKILL.md'))
    assert.equal((await doctorHome(clone)).status, 'ready')
    await initDesk(clone, { id: 'collaborator' })
    assert.equal((await deskStatus(clone)).desk.id, 'collaborator')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('team onboarding can clone an independent private Desk repository', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hairness-team-desk-clone-'))
  try {
    const home = join(root, 'home')
    const source = join(root, 'desk-source')
    await initHome(home, { name: 'team-home', mode: 'team', providers: ['codex'] })
    await mkdir(source)
    await exec('git', ['init', '--quiet', '--initial-branch=main'], { cwd: source })
    await writeFile(join(source, 'desk.json'), `${JSON.stringify({ $schema: 'https://hairness.dev/schema/desk.json', id: 'alexis' }, null, 2)}\n`)
    await exec('git', ['add', 'desk.json'], { cwd: source })
    await exec('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '-m', 'desk'], { cwd: source })
    const cloned = await cloneDesk(home, source)
    assert.equal(cloned.id, 'alexis')
    assert.equal((await deskStatus(home)).desk.id, 'alexis')
    assert.match(await readFile(join(home, '.desk/.gitignore'), 'utf8'), /^\/targets\/$/m)
    assert.equal(await readFile(join(home, '.desk/.git/HEAD'), 'utf8'), 'ref: refs/heads/main\n')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Desk Skills project natively while Git visibility follows solo or team mode', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hairness-desk-projection-'))
  try {
    const source = join(root, 'asset')
    await mkdir(join(source, 'capabilities'), { recursive: true })
    await writeFile(join(source, 'asset.json'), `${JSON.stringify({
      $schema: 'https://hairness.dev/schema/asset.json',
      name: 'personal/focus',
      version: '1.0.0',
      description: 'Personal focus surface.',
      capabilities: [{ id: 'focus', source: 'capabilities/focus.md' }],
      skills: [{ id: 'focus', capability: 'focus', description: 'Use for personal focus.' }],
    }, null, 2)}\n`)
    await writeFile(join(source, 'capabilities/focus.md'), '# Focus\n')

    const team = join(root, 'team')
    await createHome(team, { mode: 'team', providers: ['codex'] })
    await initDesk(team, { id: 'alexis' })
    await addAssets(team, [join(source, 'asset.json')], { scope: 'desk' })
    await buildHome(team)
    const teamProjection = '.agents/skills/hairness-focus/SKILL.md'
    await readFile(join(team, teamProjection))
    await exec('git', ['check-ignore', '--quiet', teamProjection], { cwd: team })
    assert.equal((await exec('git', ['status', '--porcelain'], { cwd: team })).stdout, '')

    const solo = join(root, 'solo')
    await createHome(solo, { mode: 'solo', providers: ['codex'] })
    await addAssets(solo, [join(source, 'asset.json')], { scope: 'desk' })
    await buildHome(solo)
    await readFile(join(solo, teamProjection))
    await assert.rejects(exec('git', ['check-ignore', '--quiet', teamProjection], { cwd: solo }))
    assert.match((await exec('git', ['status', '--porcelain'], { cwd: solo })).stdout, /hairness-focus/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Targets keep shared identity in settings and named machine bindings under the Desk', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hairness-target-'))
  try {
    const home = join(root, 'home')
    const target = join(root, 'target')
    await createHome(home, { providers: ['codex'] })
    await exec('git', ['init', '--quiet', '--initial-branch=main', target])
    await writeFile(join(target, 'README.md'), '# Target\n')
    await exec('git', ['add', 'README.md'], { cwd: target })
    await exec('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '-m', 'initial'], { cwd: target })
    await exec('git', ['remote', 'add', 'origin', 'git@github.com:acme/target.git'], { cwd: target })
    await addTarget(home, target, { id: 'target' })
    const [entry] = await listTargets(home)
    assert.equal(entry.bindings[0].path, await realpath(target))
    assert.equal(entry.bindings[0].id, 'target')
    assert.equal(entry.state, 'bound')
    assert.equal(entry.matches, true)
    const document = JSON.parse(await readFile(join(home, 'hairness.json'), 'utf8'))
    assert.equal(document.settings['hairness/targets'].targets[0].repository, 'github.com/acme/target')
    assert.equal(document.settings['hairness/targets'].targets[0].source, 'git@github.com:acme/target.git')
    assert.doesNotMatch(JSON.stringify(document), new RegExp(target.replaceAll('/', '\\/')))
    const link = await realpath(join(home, '.desk/targets/target/target'))
    assert.equal(link, await realpath(target))
    assert.match(renderHud(await hudModel(home)), /target\s+target:bound\/clean · map:missing/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Targets address multiple Bindings and map one checkout without writing into it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hairness-target-map-'))
  try {
    const home = join(root, 'home')
    const main = join(root, 'main')
    const feature = join(root, 'feature')
    await createHome(home, { providers: ['codex'] })
    for (const path of [main, feature]) {
      await exec('git', ['init', '--quiet', '--initial-branch=main', path])
      await writeFile(join(path, 'package.json'), `${JSON.stringify({ scripts: { test: 'node --test' }, dependencies: { example: '1.0.0' } }, null, 2)}\n`)
      await mkdir(join(path, 'src'))
      await writeFile(join(path, 'src/index.js'), 'export const ready = true\n')
      await exec('git', ['add', '--all'], { cwd: path })
      await exec('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '-m', 'initial'], { cwd: path })
      await exec('git', ['remote', 'add', 'origin', 'git@github.com:acme/target.git'], { cwd: path })
    }
    await addTarget(home, main, { id: 'target', binding: 'main' })
    await bindTarget(home, 'target', feature, { binding: 'feature' })
    assert.equal((await listTargets(home))[0].bindings.length, 2)
    await assert.rejects(() => mapTarget(home, 'target'), (error) => error.code === 'target_binding_ambiguous')
    const before = (await exec('git', ['status', '--porcelain'], { cwd: main })).stdout
    const mapped = await mapTarget(home, 'target', { binding: 'main' })
    assert.equal(mapped.target, 'target')
    assert.equal(mapped.binding, 'main')
    for (const path of ['STACK.md', 'INTEGRATIONS.md', 'ARCHITECTURE.md', 'STRUCTURE.md', 'CONVENTIONS.md', 'TESTING.md', 'CONCERNS.md']) {
      await readFile(join(mapped.path, path))
    }
    assert.equal((await exec('git', ['status', '--porcelain'], { cwd: main })).stdout, before)
    assert.match(renderHud(await hudModel(home)), /2 bindings/)
    assert.match(renderHud(await hudModel(home)), /map:current/)
    await writeFile(join(main, 'src/next.js'), 'export const next = true\n')
    await exec('git', ['add', 'src/next.js'], { cwd: main })
    await exec('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '-m', 'next'], { cwd: main })
    await writeFile(join(feature, 'src/feature.js'), 'export const feature = true\n')
    await exec('git', ['add', 'src/feature.js'], { cwd: feature })
    await exec('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '-m', 'feature'], { cwd: feature })
    assert.match(renderHud(await hudModel(home)), /map:stale/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a managed Target Binding clones into the Desk and requires explicit clean deletion', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hairness-target-clone-'))
  try {
    const home = join(root, 'home')
    const source = join(root, 'source')
    const bare = join(root, 'source.git')
    await createHome(home)
    await exec('git', ['init', '--quiet', '--initial-branch=main', source])
    await writeFile(join(source, 'README.md'), '# Source\n')
    await exec('git', ['add', 'README.md'], { cwd: source })
    await exec('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '-m', 'initial'], { cwd: source })
    await exec('git', ['clone', '--quiet', '--bare', source, bare])
    await addTarget(home, `file://${await realpath(bare)}`, { id: 'managed' })
    const cloned = await cloneTarget(home, 'managed', { binding: 'main' })
    assert.equal(cloned.type, 'managed')
    assert.match(cloned.path, /\.desk\/targets\/managed\/main$/)
    await assert.rejects(() => unbindTarget(home, 'managed', 'main'), (error) => error.code === 'target_managed_delete_required')
    await writeFile(join(cloned.path, 'local.md'), 'dirty\n')
    await assert.rejects(() => unbindTarget(home, 'managed', 'main', { delete: true }), (error) => error.code === 'target_binding_dirty')
    await rm(join(cloned.path, 'local.md'))
    assert.equal((await unbindTarget(home, 'managed', 'main', { delete: true })).status, 'unbound')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Scratch Artifacts validate and publish without deleting the Desk source', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hairness-artifact-'))
  try {
    const home = join(root, 'home')
    await createHome(home)
    await addAssets(home, ['@hairness/scratch'])
    await buildHome(home)
    const created = await createArtifact(home, 'scratch', 'home-model', { owner: 'desk', createdBy: 'alexis' })
    assert.match(created.path, /\.desk\/artifacts\/hairness\/scratch\/scratch\/home-model$/)
    assert.equal((await validateArtifact(home, 'home-model')).status, 'valid')
    const published = await publishArtifact(home, 'home-model', { owner: 'home' })
    assert.match(published.to, /artifacts\/hairness\/scratch\/scratch\/home-model$/)
    assert.equal((await inspectArtifact(home, published.to)).owner, 'home')
    assert.equal((await inspectArtifact(home, created.path)).owner, 'desk')
    const invalid = (await readFile(join(published.to, 'artifact.md'), 'utf8')).replace('owner: home', 'owner: desk')
    await writeFile(join(published.to, 'artifact.md'), invalid)
    await assert.rejects(() => validateArtifact(home, published.to), (error) => error.code === 'artifact_owner_mismatch')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Artifact creation imports a multi-file staging directory atomically', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hairness-artifact-import-'))
  try {
    const home = join(root, 'home')
    await createHome(home)
    await addAssets(home, ['@hairness/scratch'])
    const stage = join(home, '.hairness/staging/import-proof')
    await mkdir(stage, { recursive: true })
    await writeFile(join(stage, 'evidence.md'), '# Evidence\n')
    const created = await createArtifact(home, 'scratch', 'import-proof', { owner: 'desk', from: stage })
    assert.equal(await readFile(join(created.path, 'evidence.md'), 'utf8'), '# Evidence\n')
    await assert.rejects(readFile(stage), (error) => error.code === 'ENOENT')

    const reserved = join(root, 'reserved')
    await mkdir(reserved)
    await writeFile(join(reserved, 'artifact.md'), '# Collision\n')
    await assert.rejects(
      () => createArtifact(home, 'scratch', 'reserved-proof', { owner: 'desk', from: reserved }),
      (error) => error.code === 'artifact_import_reserved',
    )
    await assert.rejects(readFile(join(home, '.desk/artifacts/hairness/scratch/scratch/reserved-proof/artifact.md')), (error) => error.code === 'ENOENT')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Desk Artifacts publish atomically into a bound Target and remain discoverable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hairness-target-artifact-'))
  try {
    const home = join(root, 'home')
    const target = join(root, 'target')
    await createHome(home)
    await addAssets(home, ['@hairness/scratch'])
    await exec('git', ['init', '--quiet', '--initial-branch=main', target])
    await writeFile(join(target, 'README.md'), '# Target\n')
    await exec('git', ['add', 'README.md'], { cwd: target })
    await exec('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '-m', 'initial'], { cwd: target })
    await exec('git', ['remote', 'add', 'origin', 'git@github.com:acme/target.git'], { cwd: target })
    await addTarget(home, target, { id: 'target' })
    const created = await createArtifact(home, 'scratch', 'target-model', { owner: 'desk', createdBy: 'alexis' })
    const published = await publishArtifact(home, 'target-model', { owner: 'target', target: 'target' })
    assert.equal(published.to, join(await realpath(target), 'docs/scratches/target-model'))
    const targetArtifact = await inspectArtifact(home, published.to)
    assert.equal(targetArtifact.owner, 'target:target')
    assert.deepEqual(targetArtifact.targets, ['target'])
    assert.match(targetArtifact.derivedFrom, /^desk:/)
    assert.equal((await inspectArtifact(home, created.path)).owner, 'desk')
    assert.equal((await validateArtifact(home, published.to)).status, 'valid')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('CLI namespaces exist only when their declaring Assets are installed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hairness-cli-'))
  try {
    const home = join(root, 'home')
    await createHome(home)
    const missing = captureIo()
    assert.equal(await runCli(['scratch', 'create', 'idea', '--home', home], missing.io), 2)
    await addAssets(home, ['@hairness/scratch'])
    const ready = captureIo()
    assert.equal(await runCli(['scratch', 'create', 'idea', '--home', home], ready.io), 0)
    assert.match(ready.stdout(), /created/)

    const personal = join(root, 'personal')
    await mkdir(personal)
    await writeFile(join(personal, 'asset.json'), `${JSON.stringify({
      $schema: 'https://hairness.dev/schema/asset.json',
      name: 'fixture/personal',
      version: '1.0.0',
      description: 'Personal Asset fixture.',
    }, null, 2)}\n`)
    await addAssets(home, [join(personal, 'asset.json')], { scope: 'desk' })
    assert.equal(await runCli(['asset', 'publish', 'fixture/personal', '--home', home], captureIo().io), 2)
    assert.equal(await runCli(['asset', 'publish', 'fixture/personal', '--to', 'home', '--home', home], captureIo().io), 0)

    const reserved = join(root, 'reserved')
    await mkdir(reserved)
    await writeFile(join(reserved, 'asset.json'), `${JSON.stringify({
      $schema: 'https://hairness.dev/schema/asset.json',
      name: 'fixture/reserved',
      version: '1.0.0',
      description: 'Reserved CLI fixture.',
      cli: [{ namespace: 'build', routes: [{ name: 'shadow', operation: 'kernel:hud.show' }] }],
    }, null, 2)}\n`)
    await addAssets(home, [join(reserved, 'asset.json')])
    await assert.rejects(() => resolveHome(home), (error) => error.code === 'cli_collision')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Skills and Commands keep distinct invocation semantics across providers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hairness-invocation-'))
  try {
    const home = join(root, 'home')
    await createHome(home)
    const manifest = {
      $schema: 'https://hairness.dev/schema/asset.json',
      name: 'fixture/invocation',
      version: '1.0.0',
      description: 'Invocation policy fixture.',
      capabilities: [
        { id: 'model', source: 'capabilities/model.md' },
        { id: 'user', source: 'capabilities/user.md' },
        { id: 'both', source: 'capabilities/both.md' },
      ],
      skills: [
        { id: 'model', capability: 'model', description: 'Use autonomously for model work.' },
        { id: 'both', capability: 'both', description: 'Use autonomously or manually.' },
      ],
      commands: [
        { id: 'user', capability: 'user', summary: 'Run only when explicitly invoked.' },
        { id: 'both', capability: 'both', summary: 'Run explicitly or through the model.' },
      ],
    }
    const source = join(root, 'asset')
    await mkdir(source)
    await writeFile(join(source, 'asset.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    for (const id of ['model', 'user', 'both']) {
      await mkdir(join(source, 'capabilities'), { recursive: true })
      await writeFile(join(source, `capabilities/${id}.md`), `# ${id}\n`)
    }
    await addAssets(home, [join(source, 'asset.json')])
    const plan = await resolveHome(home)
    assert.ok(plan.warnings.some((entry) => entry.id.includes('command-omitted')))
    const invocationHud = await hudModel(home)
    const userCommand = invocationHud.surfaces.find((entry) => entry.kind === 'command' && entry.id === 'fixture/invocation:user')
    assert.deepEqual(userCommand.projections, [
      { provider: 'codex', name: 'hairness-user', status: 'omitted' },
      { provider: 'claude', name: 'hairness-user', status: 'projected' },
    ])
    await buildHome(home)
    await readFile(join(home, '.agents/skills/hairness-model/SKILL.md'))
    await readFile(join(home, '.agents/skills/hairness-both/SKILL.md'))
    await assert.rejects(readFile(join(home, '.agents/skills/hairness-user/SKILL.md')), (error) => error.code === 'ENOENT')
    assert.match(await readFile(join(home, '.claude/skills/hairness-user/SKILL.md'), 'utf8'), /disable-model-invocation: true/)
    assert.doesNotMatch(await readFile(join(home, '.claude/skills/hairness-both/SKILL.md'), 'utf8'), /disable-model-invocation/)

    const document = JSON.parse(await readFile(join(home, 'hairness.json'), 'utf8'))
    document.settings = { 'hairness/home': { lossyProjection: ['codex:fixture/invocation:user'] } }
    await writeFile(join(home, 'hairness.json'), `${JSON.stringify(document, null, 2)}\n`)
    await buildHome(home)
    await readFile(join(home, '.agents/skills/hairness-user/SKILL.md'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('context budgets fail resolution deterministically when configured', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hairness-budget-'))
  try {
    const home = join(root, 'home')
    await createHome(home)
    const document = JSON.parse(await readFile(join(home, 'hairness.json'), 'utf8'))
    document.projection = { budgets: { instructionsBytes: 1 } }
    await writeFile(join(home, 'hairness.json'), `${JSON.stringify(document, null, 2)}\n`)
    await assert.rejects(() => resolveHome(home), (error) => error.code === 'context_budget_exceeded')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('build validates every managed output before writing any projection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hairness-build-atomic-'))
  try {
    const home = join(root, 'home')
    await createHome(home)
    const source = join(root, 'asset')
    await mkdir(join(source, 'capabilities'), { recursive: true })
    await writeFile(join(source, 'asset.json'), `${JSON.stringify({
      $schema: 'https://hairness.dev/schema/asset.json',
      name: 'fixture/atomic',
      version: '1.0.0',
      description: 'Atomic build fixture.',
      capabilities: [{ id: 'new', source: 'capabilities/new.md' }],
      skills: [{ id: 'new', capability: 'new', description: 'Use for an atomic build proof.' }],
    }, null, 2)}\n`)
    await writeFile(join(source, 'capabilities/new.md'), '# New\n')
    await addAssets(home, [join(source, 'asset.json')])
    await writeFile(join(home, '.codex/hooks.json'), '{invalid\n')
    await assert.rejects(() => buildHome(home))
    await assert.rejects(readFile(join(home, '.agents/skills/hairness-new/SKILL.md')), (error) => error.code === 'ENOENT')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

function captureIo() {
  const out = []
  const err = []
  return {
    io: { stdout: { write: (value) => out.push(value) }, stderr: { write: (value) => err.push(value) } },
    stdout: () => out.join(''),
    stderr: () => err.join(''),
  }
}
