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
import { renderFloorPlan, sessionWrapper } from '../src/front-door.mjs'
import { assertRuntime } from '../src/home.mjs'
import { resolveHome } from '../src/resolved.mjs'
import { addEquipment } from '../src/equipment.mjs'
import { equipment, captureIo, writeEquipment } from './helpers.mjs'

const exec = promisify(execFile)

test('create supports a TTY preview and explicit optional native Equipment', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'endroit-create-wizard-'))
  try {
    const home = join(temporary, 'home')
    const io = captureTtyIo()
    const ui = promptHarness({
      mode: 'team',
      selected: ['research', 'publishing'],
      accepted: true,
    })
    assert.equal(await runCli(['create', home], io.io, { prompts: ui.prompts }), 0, io.stderr())
    assert.deepEqual(ui.calls.filter(({ type }) => ['select', 'multiselect', 'confirm'].includes(type)).map(({ type }) => type), [
      'select',
      'multiselect',
      'confirm',
    ])
    assert.ok(CREATE_WORDMARK.split('\n').every((line) => line.length < 64))
    assert.equal(JSON.parse(await readFile(join(home, 'endroit.json'), 'utf8')).mode, 'team')
    assert.equal(await readFile(join(home, 'rooms/home/ROOM.md'), 'utf8').then((value) => value.includes('room:home/home')), true)
    assert.equal(await readFile(join(home, 'equipment/endroit/research/equipment.json'), 'utf8').then(Boolean), true)
    assert.equal(await readFile(join(home, 'equipment/endroit/publishing/equipment.json'), 'utf8').then(Boolean), true)
    await assert.rejects(readFile(join(home, 'equipment/endroit/planning/equipment.json')), (error) => error.code === 'ENOENT')
    const catalog = captureIo()
    assert.equal(await runCli(['equipment', 'catalog', '--home', home, '--json'], catalog.io), 0, catalog.stderr())
    const native = JSON.parse(catalog.stdout()).equipment
    assert.equal(native.find((entry) => entry.id === 'endroit/research').installed.includes('home'), true)
    assert.equal(native.find((entry) => entry.id === 'endroit/planning').installed.length, 0)

    const automatic = join(temporary, 'automatic')
    const captured = captureIo()
    assert.equal(await runCli(['create', automatic, '--with', 'all', '--no-interactive', '--yes'], captured.io), 0, captured.stderr())
    assert.doesNotMatch(captured.stdout(), /\u001b\[/)
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
        '--mode', 'team',
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
    assert.equal(JSON.parse(await readFile(join(flagged, 'endroit.json'), 'utf8')).mode, 'team')
    assert.equal(await readFile(join(flagged, 'equipment/endroit/scratch/equipment.json'), 'utf8').then(Boolean), true)

    const structured = join(temporary, 'structured')
    const structuredIo = captureTtyIo()
    assert.equal(await runCli(['create', structured, '--json'], structuredIo.io, {
      prompts: promptHarness({ failOnPrompt: true }).prompts,
    }), 0, structuredIo.stderr())
    assert.equal(JSON.parse(structuredIo.stdout()).status, 'created')
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
      { name: 'interrupted', cancelAt: 'select' },
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
      $schema: 'https://endroit.org/schema/route.json',
      id: 'embedded',
      site: 'self',
      mode: 'embedded',
      path: '.',
    })
    assert.equal((await exec('git', ['check-ignore', '.desk/routes/self/embedded.json'], { cwd: repository })).stdout.trim(), '.desk/routes/self/embedded.json')
    assert.equal((await resolveHome(repository)).sites[0].id, 'self')
    assert.equal((await doctorHome(repository)).status, 'ready')

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
  assert.deepEqual(await compileSchemas(), ['home', 'desk', 'equipment', 'site', 'route', 'runtime'])
  await assert.rejects(
    () => validateDocument({ $schema: 'https://example.invalid/schema/home.json' }, 'home'),
    (error) => error.code === 'schema_version_mismatch' && /Endroit 0\.8 requires https:\/\/endroit\.org\/schema\/home\.json/.test(error.message),
  )
  const help = captureIo()
  assert.equal(await runCli([], help.io), 0)
  const temporary = await mkdtemp(join(tmpdir(), 'endroit-kernel-'))
  try {
    const home = join(temporary, 'home')
    await createHome(home, { providers: ['codex', 'claude'], prefix: 'acme', emoji: '🏠' })
    const document = JSON.parse(await readFile(join(home, 'endroit.json'), 'utf8'))
    await validateDocument(document, 'home')
    assert.deepEqual(document, {
      $schema: 'https://endroit.org/schema/home.json',
      name: 'home',
      emoji: '🏠',
      runtime: '@endroit/cli@0.8.0-alpha.0',
      mode: 'solo',
      providers: ['codex', 'claude'],
      prefix: 'acme',
      frontDoor: { wakeUp: 'endroit/hud:prompt' },
    })
    for (const name of ['artifacts', 'hud', 'onboarding', 'sites']) {
      const manifest = JSON.parse(await readFile(join(home, `equipment/endroit/${name}/equipment.json`), 'utf8'))
      assert.equal(manifest.origin.source, `@endroit/${name}`)
      assert.match(manifest.origin.baseManifestDigest, /^sha256:[a-f0-9]{64}$/)
    }
    await assert.rejects(readFile(join(home, 'equipment/endroit/scratch/equipment.json')), (error) => error.code === 'ENOENT')
    const tracked = (await exec('git', ['ls-files'], { cwd: home })).stdout
    for (const path of [
      'HOME.md',
      '.desk/DESK.md',
      'AGENTS.md',
      'CLAUDE.md',
      '.agents/skills/acme-endroit-onboarding/SKILL.md',
      '.agents/skills/acme-endroit-artifacts/SKILL.md',
      '.agents/skills/acme-endroit-site-manage/SKILL.md',
      '.claude/settings.json',
      '.claude/hooks/endroit-session-start.mjs',
      '.codex/hooks.json',
      '.codex/hooks/endroit-session-start.mjs',
      'endroit.mjs',
      'equipment/endroit/hud/runtime.mjs',
    ]) assert.match(tracked, new RegExp(`^${escape(path)}$`, 'm'))
    assert.match(await readFile(join(home, 'HOME.md'), 'utf8'), /^# home$/m)
    assert.match(await readFile(join(home, '.desk/DESK.md'), 'utf8'), /^# local's Desk$/m)
    const agents = await readFile(join(home, 'AGENTS.md'), 'utf8')
    assert.match(agents, /<!-- source: HOME\.md -->/)
    assert.match(agents, /## Endroit Floor Plan/)
    assert.match(agents, /node \.\/endroit\.mjs <namespace> <command>/)
    assert.match(agents, /## endroit\/hud:orientation/)
    assert.doesNotMatch(agents, /If no Endroit HUD was injected/)
    assert.doesNotMatch(agents, /## endroit\/onboarding:home/)
    assert.doesNotMatch(tracked, /^\.endroit\//m)
    assert.equal((await doctorHome(home)).status, 'ready')
    await buildHome(home, { check: true })
    const plan = await resolveHome(home)
    assert.deepEqual(plan.runtimes.map((entry) => entry.namespace), ['artifact', 'hud', 'room', 'site'])
    assert.deepEqual(plan.frontDoor, {
      route: 'endroit/hud:prompt',
      owner: 'endroit/hud',
      namespace: 'hud',
      command: 'prompt',
    })
    assert.ok(plan.context.floorPlanBytes > 0)
    const floorPlan = renderFloorPlan(plan)
    assert.equal(floorPlan, renderFloorPlan(plan))
    assert.doesNotMatch(floorPlan, new RegExp(escape(home)))
    assert.doesNotMatch(floorPlan, /\b(?:branch|commit|sha256|generated-at)\b/i)

    document.runtime = '@endroit/cli@9.0.0'
    await writeFile(join(home, 'endroit.json'), `${JSON.stringify(document, null, 2)}\n`)
    await assert.rejects(() => assertRuntime(home), (error) => error.code === 'runtime_mismatch' && /node \.\/endroit\.mjs/.test(error.message))
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
      '$schema: "https://endroit.org/schema/site.json"',
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
    const home = join(temporary, 'home')
    await createHome(home)
    const local = join(home, '.endroit/dev-cli')
    await mkdir(join(home, '.endroit'), { recursive: true })
    await executable(local, `#!/usr/bin/env node
process.stdout.write('<wake-up source="' + process.env.ENDROIT_RUNTIME_SOURCE + '" kind="' + process.env.ENDROIT_INVOCATION_KIND + '"/>\\n')
`)

    const codexPath = join(home, '.codex/hooks/endroit-session-start.mjs')
    const claudePath = join(home, '.claude/hooks/endroit-session-start.mjs')
    const codex = JSON.parse((await exec('node', [codexPath], { cwd: home })).stdout)
    assert.deepEqual(codex, {
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: '<wake-up source="development" kind="wake-up"/>',
      },
    })
    assert.equal((await exec('node', [claudePath], { cwd: home })).stdout, '<wake-up source="development" kind="wake-up"/>\n')

    await executable(local, `#!/usr/bin/env node
process.stderr.write('private-downstream-secret\\n')
process.exitCode = 4
`)
    await assert.rejects(
      () => exec(process.execPath, [join(home, 'endroit.mjs'), 'hud', 'prompt'], { cwd: home }),
      (error) => error.code === 4 && /private-downstream-secret/.test(error.stderr),
    )
    const failed = (await exec('node', [codexPath], { cwd: home })).stdout
    assert.deepEqual(JSON.parse(failed), {
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: '<endroit-front-door version="1" status="degraded" reason="wake-up-unavailable" />',
      },
    })
    assert.doesNotMatch(failed, /private-downstream-secret/)

    await rm(local)
    await symlink('missing-cli', local)
    assert.equal((await exec('node', [claudePath], { cwd: home })).stdout, '<endroit-front-door version="1" status="degraded" reason="wake-up-unavailable" />\n')

    await rm(local)
    const boundedPath = join(home, '.claude/hooks/endroit-session-bounded.mjs')
    await writeFile(boundedPath, sessionWrapper('claude', { namespace: 'hud', command: 'prompt' }, { timeoutMs: 20, maxBytes: 32 }))
    await executable(local, '#!/usr/bin/env node\nsetInterval(() => {}, 1_000)\n')
    assert.equal((await exec('node', [boundedPath], { cwd: home })).stdout, '<endroit-front-door version="1" status="degraded" reason="wake-up-unavailable" />\n')
    await executable(local, "#!/usr/bin/env node\nprocess.stdout.write('x'.repeat(33))\n")
    assert.equal((await exec('node', [boundedPath], { cwd: home })).stdout, '<endroit-front-door version="1" status="degraded" reason="wake-up-unavailable" />\n')
    await rm(local)

    const fakeBin = join(temporary, 'bin')
    const argsPath = join(temporary, 'npx-args.json')
    await mkdir(fakeBin)
    await executable(join(fakeBin, 'npx'), `#!/usr/bin/env node
import { writeFileSync } from 'node:fs'
writeFileSync(process.env.ENDROIT_TEST_ARGS, JSON.stringify(process.argv.slice(2)))
process.stdout.write('<wake-up source="' + process.env.ENDROIT_RUNTIME_SOURCE + '"/>\\n')
`)
    const npm = await exec('node', [claudePath], {
      cwd: home,
      env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, ENDROIT_TEST_ARGS: argsPath },
    })
    assert.equal(npm.stdout, '<wake-up source="npm"/>\n')
    assert.deepEqual(JSON.parse(await readFile(argsPath, 'utf8')), [
      '--yes',
      '@endroit/cli@0.8.0-alpha.0',
      'hud',
      'prompt',
    ])

    const hooks = JSON.parse(await readFile(join(home, '.codex/hooks.json'), 'utf8'))
    hooks.hooks.SessionStart.unshift({
      matcher: 'startup',
      hooks: [
        { type: 'command', command: 'node user-session-hook.mjs' },
        { type: 'command', command: 'node another-user-hook.mjs' },
      ],
    })
    await writeFile(join(home, '.codex/hooks.json'), `${JSON.stringify(hooks, null, 2)}\n`)
    await buildHome(home)
    const rebuilt = JSON.parse(await readFile(join(home, '.codex/hooks.json'), 'utf8'))
    assert.deepEqual(rebuilt.hooks.SessionStart, [
      {
        matcher: 'startup',
        hooks: [
          { type: 'command', command: 'node user-session-hook.mjs' },
          { type: 'command', command: 'node another-user-hook.mjs' },
        ],
      },
      {
        matcher: 'startup|resume|clear|compact',
        hooks: [{ type: 'command', command: 'node .codex/hooks/endroit-session-start.mjs' }],
      },
    ])
  } finally {
    await removeTree(temporary, { force: true })
  }
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

test('team Homes remain usable before a private Desk exists', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'endroit-team-'))
  try {
    const home = join(temporary, 'team-home')
    await mkdir(home)
    await initHome(home, { name: 'team-home', mode: 'team', providers: ['codex'] })
    assert.match(await readFile(join(home, 'HOME.md'), 'utf8'), /team-home/)
    assert.equal(await loadDesk(home), null)
    await buildHome(home)
    assert.equal((await readFile(join(home, 'AGENTS.md'), 'utf8')).includes('Wake-up: not configured.'), true)
    await assert.rejects(readFile(join(home, '.codex/hooks/endroit-session-start.mjs')), (error) => error.code === 'ENOENT')
    assert.equal((await doctorHome(home)).status, 'ready')
    assert.equal((await initDesk(home, { id: 'alexis', git: true })).repository, true)
    assert.match(await readFile(join(home, '.desk/DESK.md'), 'utf8'), /alexis/)

    await exec('git', ['-C', join(home, '.desk'), 'add', '--all'])
    await exec('git', ['-C', join(home, '.desk'), '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '-m', 'desk'])
    const second = join(temporary, 'second-home')
    await mkdir(second)
    await initHome(second, { name: 'second-home', mode: 'team', providers: ['codex'] })
    await cloneDesk(second, join(home, '.desk'))
    assert.equal((await loadDesk(second)).id, 'alexis')
  } finally {
    await removeTree(temporary, { force: true })
  }
})

test('canonical Home and Desk instructions are required, source-owned and fully projected', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'endroit-instructions-'))
  try {
    const home = join(temporary, 'home')
    await createHome(home, { providers: ['codex'] })
    const homePath = join(home, 'HOME.md')
    const agentsPath = join(home, 'AGENTS.md')
    await writeFile(homePath, '# Custom Home\n\nShared constitution for {{home.name}}.\n')
    await assert.rejects(() => buildHome(home, { check: true }), (error) => error.code === 'build_stale')
    await buildHome(home)
    assert.match(await readFile(agentsPath, 'utf8'), /^<!-- source: HOME\.md -->\n\n# Custom Home/m)
    assert.match(await readFile(agentsPath, 'utf8'), /\{\{home\.name\}\}/)
    await writeFile(agentsPath, `${await readFile(agentsPath, 'utf8')}\nProvider-only rule.\n`)
    await assert.rejects(() => buildHome(home), (error) => error.code === 'generated_output_diverged')

    const missing = join(temporary, 'missing')
    await createHome(missing)
    await rm(join(missing, 'HOME.md'))
    const report = await doctorHome(missing)
    assert.equal(report.status, 'partial')
    assert.deepEqual(report.limits, ['home_instruction_missing'])

    const linked = join(temporary, 'linked')
    await createHome(linked)
    await rm(join(linked, 'HOME.md'))
    await symlink(join(home, 'HOME.md'), join(linked, 'HOME.md'))
    await assert.rejects(() => resolveHome(linked), (error) => error.code === 'home_instruction_symlink')

    const empty = join(temporary, 'empty')
    await createHome(empty)
    await writeFile(join(empty, 'HOME.md'), ' \n')
    await assert.rejects(() => resolveHome(empty), (error) => error.code === 'home_instruction_empty')

    const invalid = join(temporary, 'invalid')
    await createHome(invalid)
    await writeFile(join(invalid, 'HOME.md'), Buffer.from([0xc3, 0x28]))
    await assert.rejects(() => resolveHome(invalid), (error) => error.code === 'home_instruction_encoding')

    const directory = join(temporary, 'directory')
    await createHome(directory)
    await rm(join(directory, 'HOME.md'))
    await mkdir(join(directory, 'HOME.md'))
    await assert.rejects(() => resolveHome(directory), (error) => error.code === 'home_instruction_type')

    const emptyDesk = join(temporary, 'empty-desk')
    await mkdir(emptyDesk)
    await initHome(emptyDesk, { mode: 'team' })
    const deskRepository = join(temporary, 'desk-repository')
    await exec('git', ['init', '--quiet', '--initial-branch=main', deskRepository])
    await writeFile(join(deskRepository, 'desk.json'), '{"$schema":"https://endroit.org/schema/desk.json","id":"alexis"}\n')
    await exec('git', ['add', 'desk.json'], { cwd: deskRepository })
    await exec('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '-m', 'desk'], { cwd: deskRepository })
    await assert.rejects(() => cloneDesk(emptyDesk, deskRepository), (error) => error.code === 'desk_instruction_missing')
    await assert.rejects(readFile(join(emptyDesk, '.desk/desk.json')), (error) => error.code === 'ENOENT')
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

test('team Desk projections remain local while Desk sources stay in the nested repository', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'endroit-team-projection-'))
  try {
    const home = join(temporary, 'home')
    await createHome(home, { mode: 'team', providers: ['codex'] })
    await initDesk(home, { id: 'alexis', git: true })
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
    assert.equal((await exec('git', ['check-ignore', '-q', projection], { cwd: home }).then(() => true, () => false)), true)
    const prompt = captureIo()
    assert.equal(await runCli(['hud', 'prompt', '--home', home], prompt.io), 0, prompt.stderr())
    assert.match(prompt.stdout(), /Reply in French/)
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
