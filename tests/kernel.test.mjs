import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { buildHome } from '../src/build.mjs'
import { runCli } from '../src/cli.mjs'
import { CREATE_WORDMARK } from '../src/create-wizard.mjs'
import { compileSchemas, validateDocument } from '../src/contracts.mjs'
import { createHome, initHome } from '../src/create.mjs'
import { cloneDesk, initDesk, loadDesk } from '../src/desk.mjs'
import { doctorHome } from '../src/doctor.mjs'
import { removeTree } from '../src/lib/io.mjs'
import { renderFloorPlan, renderProviderBootstrap, sessionWrapper } from '../src/front-door.mjs'
import { resolveHome } from '../src/resolved.mjs'
import { addEquipment } from '../src/equipment.mjs'
import { equipment, captureIo, writeEquipment } from './helpers.mjs'

const exec = promisify(execFile)

test('create defaults to conversation and keeps optional native Equipment explicit', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'endroit-create-wizard-'))
  try {
    const home = join(temporary, 'home')
    const io = captureTtyIo()
    const ui = promptHarness({ accepted: true })
    assert.equal(await runCli(['create', home], io.io, { prompts: ui.prompts }), 0, io.stderr())
    assert.deepEqual(ui.calls.filter(({ type }) => ['select', 'multiselect', 'confirm'].includes(type)).map(({ type }) => type), [
      'confirm',
    ])
    assert.ok(CREATE_WORDMARK.split('\n').every((line) => line.length < 64))
    const workplace = await readFile(join(home, 'WORKPLACE.md'), 'utf8')
    assert.match(workplace, /kind: "endroit\/workplace"/)
    assert.doesNotMatch(workplace, /^mode:/m)
    assert.equal(await readFile(join(home, 'rooms/home/ROOM.md'), 'utf8').then((value) => value.includes('room:home/home')), true)
    for (const id of ['research', 'planning', 'publishing', 'scratch']) {
      await assert.rejects(readFile(join(home, `equipment/endroit/${id}/equipment.json`)), (error) => error.code === 'ENOENT')
    }
    const openNote = ui.calls.find(({ type, message }) => type === 'note' && message.includes('Optional onboarding shortcut'))
    assert.ok(openNote)
    assert.match(openNote.message, /describe what you are working on in normal language/)
    const catalog = captureIo()
    assert.equal(await runCli(['equipment', 'catalog', '--home', home, '--json'], catalog.io), 0, catalog.stderr())
    const native = JSON.parse(catalog.stdout()).equipment
    assert.equal(native.find((entry) => entry.id === 'endroit/research').installed.length, 0)
    assert.equal(native.find((entry) => entry.id === 'endroit/planning').installed.length, 0)

    const automatic = join(temporary, 'automatic')
    const captured = captureIo()
    assert.equal(await runCli(['create', automatic, '--with', 'all', '--no-interactive', '--yes'], captured.io), 0, captured.stderr())
    assert.doesNotMatch(captured.stdout(), /\u001b\[/)
    assert.match(captured.stdout(), /Then describe what you are working on in normal language\./)
    assert.match(captured.stdout(), /Optional onboarding shortcut: \$endroit-onboarding\./)
    for (const id of ['research', 'planning', 'publishing', 'scratch']) {
      assert.equal(await readFile(join(automatic, `equipment/endroit/${id}/equipment.json`), 'utf8').then(Boolean), true)
    }

    const flagged = join(temporary, 'flagged')
    const flaggedIo = captureTtyIo()
    const flaggedUi = promptHarness()
    const previousNoColor = process.env.NO_COLOR
    const previousForceColor = process.env.FORCE_COLOR
    process.env.NO_COLOR = '1'
    delete process.env.FORCE_COLOR
    try {
      assert.equal(await runCli([
        'create', flagged,
        '--desk', 'later',
        '--with', 'scratch',
        '--yes',
      ], flaggedIo.io, { prompts: flaggedUi.prompts }), 0, flaggedIo.stderr())
      assert.equal(process.env.NO_COLOR, '1')
      assert.equal(process.env.FORCE_COLOR, undefined)
    } finally {
      if (previousNoColor === undefined) delete process.env.NO_COLOR
      else process.env.NO_COLOR = previousNoColor
      if (previousForceColor === undefined) delete process.env.FORCE_COLOR
      else process.env.FORCE_COLOR = previousForceColor
    }
    assert.equal(flaggedUi.calls.some(({ type }) => type === 'select'), false)
    assert.equal(flaggedUi.calls.some(({ type }) => type === 'multiselect'), false)
    assert.equal(flaggedUi.calls.some(({ type }) => type === 'confirm'), false)
    assert.deepEqual(flaggedUi.calls.find(({ type }) => type === 'intro').colorEnvironment, {
      noColor: false,
      forceColor: '0',
    })
    assert.equal(await readFile(join(flagged, 'members/owner/MEMBER.md'), 'utf8').then(Boolean), true)
    await assert.rejects(readFile(join(flagged, '.desk/DESK.md')), (error) => error.code === 'ENOENT')
    assert.equal(await readFile(join(flagged, 'equipment/endroit/scratch/equipment.json'), 'utf8').then(Boolean), true)

    const structured = join(temporary, 'structured')
    const structuredIo = captureTtyIo()
    assert.equal(await runCli(['create', structured, '--json'], structuredIo.io, {
      prompts: promptHarness({ failOnPrompt: true }).prompts,
    }), 0, structuredIo.stderr())
    const structuredResult = JSON.parse(structuredIo.stdout())
    assert.equal(structuredResult.status, 'created')
    assert.deepEqual(structuredResult.launch.map((entry) => Object.keys(entry).sort()), [
      ['command', 'onboarding', 'provider'],
      ['command', 'onboarding', 'provider'],
    ])
    assert.doesNotMatch(structuredIo.stdout(), /\u001b\[/)
  } finally {
    await removeTree(temporary, { force: true })
  }
})

test('create cancellation is friendly and leaves no destination', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'endroit-create-cancel-'))
  try {
    for (const scenario of [
      { name: 'declined', accepted: false },
      { name: 'interrupted', cancelAt: 'confirm' },
    ]) {
      const home = join(temporary, scenario.name)
      const io = captureTtyIo()
      const ui = promptHarness(scenario)
      assert.equal(await runCli(['create', home], io.io, { prompts: ui.prompts }), 0, io.stderr())
      await assert.rejects(readFile(home), (error) => error.code === 'ENOENT')
      assert.equal(ui.calls.some(({ type, message }) => type === 'cancel'
        && message === 'Creation cancelled. No files were written.'), true)
    }
  } finally {
    await removeTree(temporary, { force: true })
  }
})

test('init embeds a Home in an existing repository without merging Site and Home ownership', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'endroit-init-'))
  try {
    const repository = join(temporary, 'repository')
    await exec('git', ['init', '--quiet', '--initial-branch=main', repository])
    await writeFile(join(repository, 'README.md'), '# Existing product\n')
    await exec('git', ['add', 'README.md'], { cwd: repository })
    await exec('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '-m', 'initial'], { cwd: repository })
    const output = captureIo()
    assert.equal(await runCli(['init', repository, '--json'], output.io), 0, output.stderr())
    const initialized = JSON.parse(output.stdout())
    assert.equal(initialized.status, 'initialized')
    assert.equal(await readFile(join(repository, 'README.md'), 'utf8'), '# Existing product\n')
    assert.match(await readFile(join(repository, 'sites/self/SITE.md'), 'utf8'), /kind: "site"/)
    assert.deepEqual(JSON.parse(await readFile(join(repository, '.desk/routes/self/embedded.json'), 'utf8')), {
      $schema: 'https://endroit.org/schema/v8/route.json',
      id: 'embedded',
      site: 'self',
      status: 'active',
      checkout: { mode: 'embedded' },
    })
    assert.equal((await exec('git', ['check-ignore', '.desk/routes/self/embedded.json'], { cwd: repository })).stdout.trim(), '.desk/routes/self/embedded.json')
    assert.equal((await resolveHome(repository)).sites[0].id, 'self')
    assert.equal((await doctorHome(repository)).status, 'ready')

    const brownfield = join(temporary, 'brownfield')
    await exec('git', ['init', '--quiet', '--initial-branch=main', brownfield])
    await mkdir(join(brownfield, 'src'), { recursive: true })
    const preserved = {
      'KEEP.md': '# Keep\n',
      'AGENTS.md': '# Product agents\n',
      'CLAUDE.md': '# Product Claude\n',
      'src/index.js': 'export const ready = true\n',
    }
    for (const [path, content] of Object.entries(preserved)) await writeFile(join(brownfield, path), content)
    await exec('git', ['add', '.'], { cwd: brownfield })
    await exec('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '-m', 'brownfield'], { cwd: brownfield })
    const brownfieldOutput = captureIo()
    assert.notEqual(await runCli(['init', brownfield], brownfieldOutput.io), 0)
    assert.match(brownfieldOutput.stderr(), /generated_output_collision/)
    assert.match(brownfieldOutput.stderr(), /AGENTS\.md, CLAUDE\.md/)
    assert.equal((await exec('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: brownfield })).stdout, '')
    for (const [path, content] of Object.entries(preserved)) assert.equal(await readFile(join(brownfield, path), 'utf8'), content)
    await assert.rejects(readFile(join(brownfield, 'endroit.mjs')), (error) => error.code === 'ENOENT')

    const collision = join(temporary, 'collision')
    await exec('git', ['init', '--quiet', '--initial-branch=main', collision])
    await mkdir(join(collision, 'rooms', 'home'), { recursive: true })
    await writeFile(join(collision, 'rooms', 'home', 'ROOM.md'), 'product-owned\n')
    const refused = captureIo()
    assert.notEqual(await runCli(['init', collision], refused.io), 0)
    assert.match(refused.stderr(), /home_room_exists/)
    assert.equal(await readFile(join(collision, 'rooms', 'home', 'ROOM.md'), 'utf8'), 'product-owned\n')
  } finally {
    await removeTree(temporary, { force: true })
  }
})

test('create builds a source-owned Home and tracks shared provider projections', async () => {
  assert.deepEqual(await compileSchemas(), ['home', 'desk', 'member', 'equipment', 'site', 'route', 'runtime', 'artifact'])
  await assert.rejects(
    () => validateDocument({ $schema: 'https://example.invalid/schema/home.json' }, 'home'),
    (error) => error.code === 'schema_version_mismatch' && /0\.10 compatibility adapter reads https:\/\/endroit\.org\/schema\/v7\/home\.json/.test(error.message),
  )
  await assert.rejects(
    () => validateDocument({ $schema: 'https://endroit.org/schema/home.json' }, 'home'),
    (error) => error.code === 'schema_version_mismatch',
  )
  const help = captureIo()
  assert.equal(await runCli([], help.io), 0)
  const temporary = await mkdtemp(join(tmpdir(), 'endroit-kernel-'))
  try {
    const home = join(temporary, 'home')
    await createHome(home, { providers: ['codex', 'claude'], prefix: 'acme', emoji: '🏠', deskStrategy: 'tracked' })
    const workplace = await readFile(join(home, 'WORKPLACE.md'), 'utf8')
    assert.match(workplace, /\$schema: "https:\/\/endroit\.org\/schema\/v9\/workplace\.json"/)
    assert.match(workplace, /kind: "endroit\/workplace"/)
    assert.match(workplace, /id: "home"/)
    assert.match(workplace, /runtime: "@endroit\/cli@0\.10\.0-alpha\.0"/)
    assert.match(workplace, /providers: \["codex","claude"\]/)
    for (const name of ['artifacts', 'hud', 'onboarding', 'sites']) {
      const manifest = JSON.parse(await readFile(join(home, `equipment/endroit/${name}/equipment.json`), 'utf8'))
      assert.equal(manifest.origin.source, `@endroit/${name}`)
      assert.match(manifest.origin.baseManifestDigest, /^sha256:[a-f0-9]{64}$/)
    }
    await assert.rejects(readFile(join(home, 'equipment/endroit/scratch/equipment.json')), (error) => error.code === 'ENOENT')
    const tracked = (await exec('git', ['ls-files'], { cwd: home })).stdout
    for (const path of [
      'WORKPLACE.md',
      'members/owner/MEMBER.md',
      '.desk/DESK.md',
      'AGENTS.md',
      'CLAUDE.md',
      '.agents/skills/acme-endroit-onboarding/SKILL.md',
      '.agents/skills/acme-endroit-artifacts/SKILL.md',
      '.agents/skills/acme-endroit-site-manage/SKILL.md',
      'endroit.mjs',
      'equipment/endroit/hud/runtime.mjs',
    ]) assert.match(tracked, new RegExp(`^${escape(path)}$`, 'm'))
    for (const path of [
      '.claude/settings.json',
      '.claude/hooks/endroit-session-start.mjs',
      '.codex/hooks.json',
      '.codex/hooks/endroit-session-start.mjs',
    ]) await assert.rejects(readFile(join(home, path)), (error) => error.code === 'ENOENT')
    const hostConfiguration = new Map([
      ['.codex/hooks.json', '{"user":"codex"}\n'],
      ['.claude/settings.json', '{"user":"claude"}\n'],
    ])
    for (const [path, content] of hostConfiguration) {
      await mkdir(join(home, path, '..'), { recursive: true })
      await writeFile(join(home, path), content)
    }
    await buildHome(home)
    for (const [path, content] of hostConfiguration) assert.equal(await readFile(join(home, path), 'utf8'), content)
    const receipt = JSON.parse(await readFile(join(home, '.endroit/build.json'), 'utf8'))
    assert.equal(receipt.outputs.some(({ path }) => /(?:hooks\.json|settings\.json|session-start)/.test(path)), false)
    assert.match(await readFile(join(home, 'WORKPLACE.md'), 'utf8'), /^# home$/m)
    assert.match(await readFile(join(home, '.desk/DESK.md'), 'utf8'), /^# local$/m)
    const room = await readFile(join(home, 'rooms/home/ROOM.md'), 'utf8')
    assert.match(room, /^## Current truth$/m)
    assert.match(room, /^## Active retained Material$/m)
    assert.doesNotMatch(room, /candidate notes/i)
    const agents = await readFile(join(home, 'AGENTS.md'), 'utf8')
    const claude = await readFile(join(home, 'CLAUDE.md'), 'utf8')
    for (const contract of [agents, claude]) {
      assert.ok(Buffer.byteLength(contract) <= 4096)
      assert.match(contract, /# Endroit provider bootstrap/)
      assert.match(contract, /<!-- source revision: sha256:[a-f0-9]{64} -->/)
      assert.match(contract, /## Constitution/)
      assert.match(contract, /Identity: `home`/)
      assert.match(contract, /Profile: `endroit\/0\.10`/)
      assert.match(contract, /Protocol: `open-workplace\/0\.2-draft`/)
      assert.match(contract, /Owned Markdown sources are canonical/)
      assert.match(contract, /explicitly named Room, Site or Route/)
      assert.match(contract, /node \.\/endroit\.mjs <namespace> <command>/)
      assert.match(contract, /report `degraded`/)
      assert.doesNotMatch(contract, /runtime namespaces|artifact inventory|capabilit(?:y|ies):/i)
    }
    for (const root of ['.agents/skills', '.claude/skills']) {
      const onboarding = await readFile(join(home, root, 'acme-endroit-onboarding/SKILL.md'), 'utf8')
      assert.doesNotMatch(onboarding, /disable-model-invocation/)
    }
    assert.doesNotMatch(tracked, /^\.endroit\//m)
    assert.equal((await doctorHome(home)).status, 'ready')
    await buildHome(home, { check: true })
    const plan = await resolveHome(home)
    assert.deepEqual(plan.runtimes.map((entry) => entry.namespace), ['artifact', 'hud', 'hygiene', 'room', 'site', 'work'])
    assert.deepEqual(plan.frontDoor, {
      route: 'endroit/hud:prompt',
      owner: 'endroit/hud',
      namespace: 'hud',
      command: 'prompt',
    })
    assert.deepEqual(plan.skills.filter((entry) => entry.owner === 'endroit/onboarding').map((entry) => entry.projectedId), ['acme-endroit-onboarding'])
    assert.deepEqual(plan.commands.filter((entry) => entry.owner === 'endroit/onboarding').map((entry) => entry.projectedId), ['acme-endroit-onboarding'])
    assert.ok(plan.context.floorPlanBytes > 0)
    const floorPlan = renderFloorPlan(plan)
    assert.equal(floorPlan, renderFloorPlan(plan))
    assert.doesNotMatch(floorPlan, new RegExp(escape(home)))
    assert.doesNotMatch(floorPlan, /\b(?:branch|commit|generated-at)\b/i)
    assert.match(floorPlan, new RegExp(escape(plan.revision)))

  } finally {
    await removeTree(temporary, { force: true })
  }
})

test('forEach accessors bind generated aliases to resolved Home items', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'endroit-accessors-'))
  try {
    const home = join(temporary, 'home')
    await createHome(home)
    const room = join(home, '.desk', 'rooms', 'demo')
    await mkdir(join(room, 'meetings', 'delivery'), { recursive: true })
    await writeFile(join(room, 'ROOM.md'), [
      '---',
      'emoji: "🎛️"',
      'summary: "Demo Room."',
      'when: ["Working on the demo."]',
      'tags: ["demo"]',
      '---',
      '',
    ].join('\n'))
    await writeFile(join(room, 'meetings', 'delivery', 'MEETING.md'), [
      '---',
      'emoji: "🚚"',
      'summary: "Deliver the demo."',
      'when: ["Shipping the demo."]',
      'tags: ["delivery"]',
      '---',
      '',
      '## Status',
      '',
      '`active`',
      '',
    ].join('\n'))
    await mkdir(join(home, 'sites', 'product'), { recursive: true })
    await writeFile(join(home, 'sites', 'product', 'SITE.md'), [
      '---',
      '$schema: "https://endroit.org/schema/v7/site.json"',
      'id: "product"',
      'kind: "site"',
      'status: "active"',
      'emoji: "📦"',
      'repository: "github.com/example/product"',
      'source: "https://github.com/example/product.git"',
      '---',
      '',
      '# product',
      '',
    ].join('\n'))
    const source = await writeEquipment(join(temporary, 'routing'), equipment({
      skills: [],
      commands: [
        { id: 'room', capability: 'review', description: 'Review one Room.', forEach: 'room' },
        { id: 'meeting', capability: 'review', description: 'Review one Meeting.', forEach: 'meeting' },
        { id: 'site', capability: 'review', description: 'Review one Site.', forEach: 'site' },
      ],
    }), {
      'capabilities/review.md': 'Review the bound item.\n',
    })
    await addEquipment(home, [source])
    await buildHome(home)

    const plan = await resolveHome(home)
    assert.deepEqual(
      plan.commands.filter(({ owner }) => owner === 'fixture/review').map(({ projectedId, route }) => [projectedId, route.ref, route.emoji]),
      [
        ['review-room-home', 'room:home/home', null],
        ['review-room-demo', 'room:desk/demo', '🎛️'],
        ['review-meeting-demo-delivery', 'meeting:desk/demo/delivery', '🚚'],
        ['review-site-product', 'site:product', '📦'],
      ],
    )
    assert.match(
      await readFile(join(home, '.agents/skills/review-meeting-demo-delivery/SKILL.md'), 'utf8'),
      /bound to meeting:desk\/demo\/delivery 🚚/,
    )
    assert.match(
      await readFile(join(home, '.claude/skills/review-site-product/SKILL.md'), 'utf8'),
      /bound to site:product 📦/,
    )
    const json = captureIo()
    assert.equal(await runCli(['hud', 'json', '--home', home], json.io), 0, json.stderr())
    assert.ok(JSON.parse(json.stdout()).items.capabilities.some(({ id }) => id === 'review-room-demo'))
    const prompt = captureIo()
    assert.equal(await runCli(['hud', 'prompt', '--home', home], prompt.io), 0, prompt.stderr())
    assert.doesNotMatch(prompt.stdout(), /review-room-demo/)
  } finally {
    await removeTree(temporary, { force: true })
  }
})

test('provider session wrappers inject exact transport and fail closed without leaking stderr', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'endroit-session-'))
  try {
    const home = join(temporary, 'workplace')
    const wrapperRoot = join(home, '.test-provider', 'hooks')
    await mkdir(wrapperRoot, { recursive: true })
    const consolePath = join(home, 'endroit.mjs')
    await executable(consolePath, `#!/usr/bin/env node
process.stdout.write('<wake-up kind="' + process.env.ENDROIT_INVOCATION_KIND + '"/>\\n')
`)
    const codexPath = join(wrapperRoot, 'codex.mjs')
    const claudePath = join(wrapperRoot, 'claude.mjs')
    await writeFile(codexPath, sessionWrapper('codex'))
    await writeFile(claudePath, sessionWrapper('claude'))
    const codex = JSON.parse((await exec('node', [codexPath], { cwd: home })).stdout)
    assert.deepEqual(codex, {
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: '<wake-up kind="wake-up"/>',
      },
    })
    assert.equal((await exec('node', [claudePath], { cwd: home })).stdout, '<wake-up kind="wake-up"/>\n')

    await executable(consolePath, `#!/usr/bin/env node
process.stderr.write('private-downstream-secret\\n')
process.exitCode = 4
`)
    const failed = (await exec('node', [codexPath], { cwd: home })).stdout
    assert.deepEqual(JSON.parse(failed), {
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: '<endroit-front-door version="1" status="degraded" reason="wake-up-unavailable" />',
      },
    })
    assert.doesNotMatch(failed, /private-downstream-secret/)

    const boundedPath = join(wrapperRoot, 'bounded.mjs')
    await writeFile(boundedPath, sessionWrapper('claude', {}, { timeoutMs: 20, maxBytes: 32 }))
    await executable(consolePath, '#!/usr/bin/env node\nsetInterval(() => {}, 1_000)\n')
    assert.equal((await exec('node', [boundedPath], { cwd: home })).stdout, '<endroit-front-door version="1" status="degraded" reason="wake-up-unavailable" />\n')
    await executable(consolePath, "#!/usr/bin/env node\nprocess.stdout.write('x'.repeat(33))\n")
    assert.equal((await exec('node', [boundedPath], { cwd: home })).stdout, '<endroit-front-door version="1" status="degraded" reason="wake-up-unavailable" />\n')
    for (const path of ['.codex/hooks.json', '.claude/settings.json']) {
      await assert.rejects(readFile(join(home, path)), (error) => error.code === 'ENOENT')
    }
  } finally {
    await removeTree(temporary, { force: true })
  }
})

test('provider bootstrap is source-revisioned, bounded and contains no Workplace inventory', () => {
  const plan = {
    revision: 'sha256:resolved-workplace',
    workplace: {
      id: 'studio',
      profile: 'endroit/0.10',
      protocol: 'open-workplace/0.2-draft',
      source_digest: 'sha256:source-fallback',
    },
  }
  const bootstrap = renderProviderBootstrap(plan, '- Human authority remains explicit.')
  assert.ok(Buffer.byteLength(bootstrap) <= 4096)
  assert.match(bootstrap, /source revision: sha256:resolved-workplace/)
  assert.match(bootstrap, /## Constitution\n\n- Human authority remains explicit\./)
  assert.match(bootstrap, /Identity: `studio`/)
  assert.match(bootstrap, /Profile: `endroit\/0\.10`/)
  assert.match(bootstrap, /Protocol: `open-workplace\/0\.2-draft`/)
  assert.match(bootstrap, /Revision: `sha256:resolved-workplace`/)
  assert.match(bootstrap, /Owned Markdown sources are canonical/)
  assert.match(bootstrap, /explicitly named Room, Site or Route/)
  assert.match(bootstrap, /node \.\/endroit\.mjs <namespace> <command>/)
  assert.match(bootstrap, /report `degraded`/)
  assert.doesNotMatch(bootstrap, /Members:|Providers:|Desk:|rooms\/|sites\/|capabilit|runtime namespaces/i)

  const fallback = renderProviderBootstrap({ workplace: plan.workplace }, 'Keep it readable.')
  assert.match(fallback, /source revision: sha256:source-fallback/)
  assert.throws(
    () => renderProviderBootstrap(plan, 'x'.repeat(4096)),
    (error) => error.code === 'context_budget_exceeded',
  )
})

test('the Home Console is a fully owned regular projection', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'endroit-console-'))
  try {
    const home = join(temporary, 'home')
    await createHome(home)
    const path = join(home, 'endroit.mjs')
    await rm(path)
    await assert.rejects(() => buildHome(home, { check: true }), (error) => error.code === 'build_stale')
    await buildHome(home)
    const outside = join(temporary, 'outside.mjs')
    await writeFile(outside, await readFile(path))
    await rm(path)
    await symlink(outside, path)
    await assert.rejects(() => buildHome(home, { check: true }), (error) => error.code === 'generated_output_invalid')
    assert.equal((await doctorHome(home)).status, 'partial')
  } finally {
    await removeTree(temporary, { force: true })
  }
})

test('Homes remain usable before a Desk or Wake-up exists', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'endroit-team-'))
  try {
    const home = join(temporary, 'team-home')
    await mkdir(home)
    await initHome(home, { name: 'team-home', deskStrategy: 'later', providers: ['codex', 'claude'] })
    assert.match(await readFile(join(home, 'WORKPLACE.md'), 'utf8'), /team-home/)
    assert.equal(await loadDesk(home), null)
    await buildHome(home)
    for (const path of ['AGENTS.md', 'CLAUDE.md']) {
      const contract = await readFile(join(home, path), 'utf8')
      assert.ok(Buffer.byteLength(contract) <= 4096)
      assert.match(contract, /# Endroit provider bootstrap/)
      assert.match(contract, /## Constitution/)
      assert.match(contract, /Identity: `team-home`/)
      assert.match(contract, /report `degraded`/)
    }
    await assert.rejects(readFile(join(home, '.codex/hooks/endroit-session-start.mjs')), (error) => error.code === 'ENOENT')
    await assert.rejects(readFile(join(home, '.codex/hooks.json')), (error) => error.code === 'ENOENT')
    assert.equal((await doctorHome(home)).status, 'ready')
    assert.equal((await initDesk(home, { id: 'alexis', member: 'owner', repository: 'separate' })).repository, 'separate')
    assert.match(await readFile(join(home, '.desk/DESK.md'), 'utf8'), /alexis/)

    await exec('git', ['-C', join(home, '.desk'), 'add', '--all'])
    await exec('git', ['-C', join(home, '.desk'), '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '-m', 'desk'])
    const second = join(temporary, 'second-home')
    await mkdir(second)
    await initHome(second, { name: 'second-home', deskStrategy: 'later', providers: ['codex'] })
    await cloneDesk(second, join(home, '.desk'))
    assert.equal((await loadDesk(second)).id, 'alexis')
  } finally {
    await removeTree(temporary, { force: true })
  }
})

test('provider bootstrap projects only the WORKPLACE Constitution', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'endroit-instructions-'))
  try {
    const home = join(temporary, 'home')
    await createHome(home, { providers: ['codex'] })
    const workplacePath = join(home, 'WORKPLACE.md')
    const agentsPath = join(home, 'AGENTS.md')
    const source = await readFile(workplacePath, 'utf8')
    const next = source.replace(
      /(## Constitution\r?\n\r?\n)[\s\S]*?(?=\r?\n## )/,
      '$1Only this constitutional sentence is projected.\n',
    )
    assert.notEqual(next, source)
    await writeFile(workplacePath, next)
    await assert.rejects(() => buildHome(home, { check: true }), (error) => error.code === 'build_stale')
    await buildHome(home)
    const agents = await readFile(agentsPath, 'utf8')
    assert.ok(Buffer.byteLength(agents) <= 4096)
    assert.match(agents, /## Constitution\n\nOnly this constitutional sentence is projected\./)
    assert.doesNotMatch(agents, /Give humans and agents one durable|## Purpose|## Boundaries|## Limits/)
    await writeFile(agentsPath, `${await readFile(agentsPath, 'utf8')}\nProvider-only rule.\n`)
    await assert.rejects(() => buildHome(home), (error) => error.code === 'generated_output_diverged')
  } finally {
    await removeTree(temporary, { force: true })
  }
})

test('a clone is immediately usable from tracked projections without local build state', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'endroit-clone-'))
  try {
    const source = join(temporary, 'source')
    const clone = join(temporary, 'clone')
    await createHome(source)
    await exec('git', ['clone', '--quiet', source, clone])
    await assert.rejects(readFile(join(clone, '.endroit/build.json')), (error) => error.code === 'ENOENT')
    assert.equal((await doctorHome(clone)).status, 'ready')
    await buildHome(clone, { check: true })
  } finally {
    await removeTree(temporary, { force: true })
  }
})

test('doctor reports a missing runtime as a limit instead of crashing', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'endroit-doctor-'))
  try {
    const home = join(temporary, 'home')
    await createHome(home)
    await rm(join(home, 'equipment/endroit/hud/runtime.mjs'))
    const report = await doctorHome(home)
    assert.equal(report.status, 'partial')
    assert.equal(report.runtimes.find((entry) => entry.name === 'endroit/hud').error, 'ENOENT')
    assert.ok(report.limits.includes('runtime-invalid:endroit/hud:ENOENT'))
  } finally {
    await removeTree(temporary, { force: true })
  }
})

test('separate Desk projections remain local while Desk sources stay in the nested repository', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'endroit-team-projection-'))
  try {
    const home = join(temporary, 'home')
    await createHome(home, { deskStrategy: 'later', providers: ['codex'] })
    await initDesk(home, { id: 'alexis', member: 'owner', repository: 'separate' })
    const source = await writeEquipment(join(temporary, 'personal'), equipment({
      name: 'alexis/review',
      files: ['capabilities/review.md', 'instructions/personal.md'],
      instructions: [{ id: 'personal', path: 'instructions/personal.md' }],
    }), {
      'capabilities/review.md': 'Review from my Desk.\n',
      'instructions/personal.md': 'Reply in French.\n',
    })
    await addEquipment(home, [source], { scope: 'desk' })
    await buildHome(home)
    const projection = '.agents/skills/review-review/SKILL.md'
    assert.match(await readFile(join(home, projection), 'utf8'), /my Desk/)
    assert.equal((await exec('git', ['check-ignore', '-q', projection], { cwd: home }).then(() => true, () => false)), false)
    const prompt = captureIo()
    assert.equal(await runCli(['hud', 'prompt', '--workplace', home], prompt.io), 0, prompt.stderr())
    assert.doesNotMatch(prompt.stdout(), /Reply in French|<instruction/)
    assert.ok(Buffer.byteLength(prompt.stdout()) <= 4096)
  } finally {
    await removeTree(temporary, { force: true })
  }
})

async function executable(path, content) {
  await writeFile(path, content)
  await chmod(path, 0o755)
}

function captureTtyIo() {
  const out = []
  const err = []
  return {
    io: {
      stdin: { isTTY: true },
      stdout: { isTTY: true, write: (value) => out.push(String(value)) },
      stderr: { write: (value) => err.push(String(value)) },
    },
    stdout: () => out.join(''),
    stderr: () => err.join(''),
  }
}

function promptHarness(options = {}) {
  const calls = []
  const cancellation = Symbol('cancelled')
  const record = (type, message) => {
    if (options.failOnPrompt) assert.fail(`Unexpected ${type} prompt`)
    calls.push({
      type,
      message,
      colorEnvironment: {
        noColor: Object.hasOwn(process.env, 'NO_COLOR'),
        forceColor: process.env.FORCE_COLOR,
      },
    })
  }
  const answer = (type, value) => options.cancelAt === type ? cancellation : value
  return {
    calls,
    prompts: {
      isCancel: (value) => value === cancellation,
      intro: (message) => record('intro', message),
      note: (message) => record('note', message),
      select: async ({ message }) => {
        record('select', message)
        return answer('select', options.mode ?? 'solo')
      },
      multiselect: async ({ message }) => {
        record('multiselect', message)
        return answer('multiselect', options.selected ?? [])
      },
      confirm: async ({ message }) => {
        record('confirm', message)
        return answer('confirm', options.accepted ?? true)
      },
      spinner: () => {
        record('spinner')
        return {
          start: (message) => record('spinner:start', message),
          stop: (message) => record('spinner:stop', message),
          error: (message) => record('spinner:error', message),
        }
      },
      cancel: (message) => record('cancel', message),
      outro: (message) => record('outro', message),
    },
  }
}

function escape(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
