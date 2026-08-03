import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { buildHome } from '../src/build.mjs'
import { runCli } from '../src/cli.mjs'
import { createHome, initializeExistingHome, initHome } from '../src/create.mjs'
import { initDesk } from '../src/desk.mjs'
import { doctorHome } from '../src/doctor.mjs'
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
      $schema: 'https://endroit.org/schema/v7/desk.json', id: 'local', member: 'alexis',
    })
    assert.equal(await gitRoot(join(tracked, '.desk')), await realpath(tracked))
    assert.match((await exec('git', ['ls-files'], { cwd: tracked })).stdout, /^members\/alexis\/MEMBER\.md$/m)
    assert.match(await readFile(join(tracked, '.gitignore'), 'utf8'), /^\/checkouts\/$/m)
    assert.match(await readFile(join(tracked, 'AGENTS.md'), 'utf8'), /Local Checkout index and managed worktrees: `checkouts\/`/)

    const embedded = join(temporary, 'embedded')
    await exec('git', ['init', '--quiet', '--initial-branch=main', embedded])
    await initializeExistingHome(embedded, { memberId: 'alexis', memberName: 'Alexis' })
    assert.equal(await gitRoot(join(embedded, '.desk')), await realpath(join(embedded, '.desk')))
    assert.equal((await exec('git', ['check-ignore', '.desk/desk.json'], { cwd: embedded })).stdout.trim(), '.desk/desk.json')
    assert.match(await readFile(join(embedded, '.gitignore'), 'utf8'), /^\/checkouts\/$/m)
    assert.equal(await readFile(join(embedded, '.agents/skills/work-on-self/SKILL.md'), 'utf8').then(Boolean), true)
    assert.equal(await readFile(join(embedded, '.claude/skills/deliver-this-to-self/SKILL.md'), 'utf8').then(Boolean), true)
    assert.match(await readFile(join(embedded, 'sites/self/SITE.md'), 'utf8'), /when: \["Working on this repository\."\]/)

    const later = join(temporary, 'later')
    await createHome(later, { deskStrategy: 'later' })
    await assert.rejects(readFile(join(later, '.desk/desk.json')), (error) => error.code === 'ENOENT')
    assert.equal((await resolveHome(later)).members[0].id, 'owner')
    assert.equal((await initDesk(later, { id: 'later', member: 'owner', repository: 'tracked' })).id, 'later')

    const deferred = join(temporary, 'deferred-embedded')
    await exec('git', ['init', '--quiet', '--initial-branch=main', deferred])
    await writeFile(join(deferred, 'README.md'), '# Existing repository\n')
    await exec('git', ['add', 'README.md'], { cwd: deferred })
    await exec('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '-m', 'initial'], { cwd: deferred })
    const initialized = captureIo()
    assert.equal(await runCli(['init', deferred, '--desk', 'later', '--json'], initialized.io), 0, initialized.stderr())
    await assert.rejects(readFile(join(deferred, '.desk/routes/self/embedded.json')), (error) => error.code === 'ENOENT')
    assert.equal((await resolveHome(deferred)).sites[0].id, 'self')
    const desk = captureIo()
    assert.equal(await runCli(['desk', 'init', '--id', 'later', '--home', deferred, '--json'], desk.io), 0, desk.stderr())
    assert.equal(JSON.parse(desk.stdout()).repository, 'separate')
    const resumed = captureIo()
    assert.equal(await runCli(['checkout', 'adopt', 'self', deferred, '--id', 'embedded', '--home', deferred, '--json'], resumed.io), 0, resumed.stderr())
    assert.equal(JSON.parse(resumed.stdout()).mode, 'embedded')
    const embeddedRoute = JSON.parse(await readFile(join(deferred, '.desk/routes/self/embedded.json'), 'utf8'))
    assert.equal(embeddedRoute.$schema, 'https://endroit.org/schema/v8/route.json')
    assert.equal(embeddedRoute.status, 'active')
    assert.deepEqual(embeddedRoute.checkout, { mode: 'embedded' })
    assert.equal('path' in embeddedRoute, false)
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

test('failed initialization preserves a pre-existing product members directory', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'endroit-member-rollback-'))
  try {
    const root = join(temporary, 'product')
    await mkdir(join(root, 'members'), { recursive: true })
    await writeFile(join(root, 'members/product.txt'), 'product-owned\n')
    await assert.rejects(() => initHome(root, { deskStrategy: 'tracked' }), (error) => error.code === 'git_failed')
    assert.equal(await readFile(join(root, 'members/product.txt'), 'utf8'), 'product-owned\n')
    await assert.rejects(readFile(join(root, 'members/owner/MEMBER.md')), (error) => error.code === 'ENOENT')
    await assert.rejects(readFile(join(root, 'endroit.json')), (error) => error.code === 'ENOENT')
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
      'work-as-an-engineer', 'use-research', 'advance-this', 'resolve-work', 'click-and-review', 'retain-this', 'accept-this',
      'deliver-this', 'archive-this', 'maintain-the-home',
    ]
    for (const providerRoot of ['.agents/skills', '.claude/skills']) {
      for (const gesture of gestures) assert.equal(await readFile(join(home, providerRoot, gesture, 'SKILL.md'), 'utf8').then(Boolean), true)
    }
    const agents = await readFile(join(home, 'AGENTS.md'), 'utf8')
    const claude = await readFile(join(home, 'CLAUDE.md'), 'utf8')
    for (const contract of [agents, claude]) {
      assert.equal((contract.match(/## endroit\/workplace:profile/g) ?? []).length, 1)
      assert.equal((contract.match(/# Endroit Workplace Profile/g) ?? []).length, 1)
      assert.match(contract, /Target protocol:\*\* `open-workplace\/0\.1`/)
      assert.match(contract, /Canonical profile address:\*\* `endroit\/0\.8`/)
      assert.match(contract, /Status:\*\* alpha release candidate/)
      assert.match(contract, /The center of gravity is the Workplace, not the agent\./)
      assert.match(contract, /An agent is present, not resident\./)
    }
    assert.equal(agents, claude)
    for (const gesture of ['call-the-researcher', 'work-as-an-engineer']) {
      assert.match(await readFile(join(home, '.agents/skills', gesture, 'SKILL.md'), 'utf8'), /return `blocked`/i)
      assert.match(await readFile(join(home, '.claude/skills', gesture, 'SKILL.md'), 'utf8'), /return `blocked`/i)
    }
    assert.match(await readFile(join(home, '.agents/skills/retain-this/SKILL.md'), 'utf8'), /Endroit\nownership|Endroit objects|These states are distinct/)
    const lifecycle = await readFile(join(home, '.agents/skills/retain-this/SKILL.md'), 'utf8')
    assert.match(lifecycle, /adds\s+one relative link under `Active retained Material`/)
    assert.match(lifecycle, /updates `Current truth`/)
    assert.match(lifecycle, /does not update Room truth/)
    assert.match(lifecycle, /removes its active link from `ROOM\.md`/)
    assert.match(lifecycle, /Never create a candidate-notes section or file/)
    const advance = await readFile(join(home, '.agents/skills/advance-this/SKILL.md'), 'utf8')
    assert.match(advance, /Normal conversation[\s\S]*implement this plan/i)
    assert.match(advance, /revalidate every Route immediately before its\s+mutation/i)
    assert.match(advance, /never infer retain, accept, archive, deliver, commit, push/i)
  } finally {
    await removeTree(temporary, { force: true })
  }
})

test('the Endroit Profile and adoption guide disclose separate responsibilities and release status', async () => {
  const profile = await readFile(new URL('../WORKPLACE.md', import.meta.url), 'utf8')
  const adoption = await readFile(new URL('../ADOPT.md', import.meta.url), 'utf8')
  const install = await readFile(new URL('../INSTALL.md', import.meta.url), 'utf8')
  const packageDocument = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  const workplace = JSON.parse(await readFile(new URL('../equipment/endroit/workplace/equipment.json', import.meta.url), 'utf8'))
  const onboardingManifest = JSON.parse(await readFile(new URL('../equipment/endroit/onboarding/equipment.json', import.meta.url), 'utf8'))
  const onboarding = await readFile(new URL('../equipment/endroit/onboarding/capabilities/onboard.md', import.meta.url), 'utf8')
  const cli = await readFile(new URL('../src/cli.mjs', import.meta.url), 'utf8')

  assert.equal(packageDocument.files.includes('WORKPLACE.md'), true)
  assert.equal(packageDocument.files.includes('ADOPT.md'), true)
  assert.equal(packageDocument.files.includes('INSTALL.md'), true)
  assert.match(profile, /Profile identifier:\*\* `endroit`/)
  assert.match(profile, /Profile version:\*\* `0\.8`/)
  assert.match(profile, /Canonical profile address:\*\* `endroit\/0\.8`/)
  assert.match(profile, /Publisher:\*\* The VZion/)
  assert.match(profile, /Target protocol:\*\* `open-workplace\/0\.1`/)
  assert.match(profile, /Status:\*\* alpha release candidate/)
  assert.match(profile, /included in the local\s+`@endroit\/cli@0\.9\.0-alpha\.0` candidate/)
  assert.match(profile, /self-contained Endroit Profile specializes the Open Workplace protocol/)
  assert.match(profile, /directory containing it is the Home root; the Home declarations\s+define its trust boundary\. Colocated Site files remain Site-owned/)
  assert.equal((profile.match(/https:\/\/endroit\.org\/adopt\.md/g) ?? []).length, 2)
  for (const section of [
    'Discovery', 'Instance identity', 'Object and relationship mapping',
    'Authority and composition', 'Material lifecycle', 'Sites and Routes',
    'Projections', 'Degraded mode', 'Validation', 'Limits and extensions',
  ]) assert.match(profile, new RegExp(`## ${section}`), section)
  for (const object of [
    'Workplace', 'Home', 'Member', 'Desk', 'Room', 'Meeting', 'Occupant',
    'Role', 'Equipment', 'Material', 'Site', 'Route',
  ]) assert.match(profile, new RegExp(`\\| ${object} \\|`), object)
  assert.match(profile, /Relationships remain source-backed/)
  assert.match(profile, /duplicate Room[\s\S]*projection surface collisions[\s\S]*reports `ambiguous`/)
  assert.match(profile, /provider projection names\s+its source or owner/)
  assert.match(profile, /If the tracked Console or matching runtime is unavailable[\s\S]*report `ambiguous`/)
  assert.match(profile, /does not represent a durable Occupant registry, durable Role\s+assignment or canonical live Meeting/)
  assert.match(profile, /Endroit extensions are explicitly implementation-owned/)
  assert.match(profile, /center of gravity is the Workplace, not the agent/i)
  assert.match(profile, /Never infer retain, accept, archive, deliver, commit, push,\s+publication or deployment/)
  assert.doesNotMatch(profile, /name the exact local roots|Apply this map/)
  assert.match(adoption, /Start fresh/)
  assert.match(adoption, /Bring what you have/)
  assert.match(adoption, /portable, pre-Home adoption guide/)
  assert.doesNotMatch(adoption, /adoption protocol|stop this protocol|This protocol/)
  assert.match(adoption, /name the exact local roots/)
  assert.match(adoption, /candidate selection authorizes deeper analysis[\s\S]*does not authorize mutation/i)
  assert.match(adoption, /Apply this map/)
  assert.match(adoption, /Do not scan the user's home directory by default/)
  assert.match(adoption, /Do not follow symlinks\s+outside the approved roots/)
  assert.match(adoption, /Existing product files and checkouts stay where they are/)
  assert.match(onboarding, /two\s+separate consent boundaries/)
  assert.match(onboarding, /source-owned `ADOPT\.md` release-candidate\s+guide/)
  assert.match(install, /\[ADOPT\.md\]\(https:\/\/endroit\.org\/adopt\.md\)/)
  assert.match(install, /\[Endroit Workplace\s+Profile\]\(https:\/\/endroit\.org\/WORKPLACE\.md\)/)
  assert.match(install, /commands below target the local `@endroit\/cli@0\.9\.0-alpha\.0` release\s+candidate/)
  assert.match(install, /last\s+observed published release is `0\.8\.0-alpha\.1`/)
  assert.equal('runtime' in workplace, false)
  assert.equal('runtime' in onboardingManifest, false)
  assert.doesNotMatch(cli, /command === ['"]adopt['"]/)
  assert.deepEqual(workplace.instructions.map(({ id, path }) => ({ id, path })), [{ id: 'profile', path: 'instructions/profile.md' }])
  assert.deepEqual(onboardingManifest.references.map(({ id, path }) => ({ id, path })), [{ id: 'adopt', path: 'references/adopt.md' }])
  assert.equal(workplace.files.includes('capabilities/advance.md'), true)
  assert.equal(workplace.capabilities.some(({ id }) => id === 'advance'), true)
  assert.equal(workplace.skills.some(({ projectedName }) => projectedName === 'advance-this'), true)
  assert.equal(workplace.commands.some(({ projectedName }) => projectedName === 'advance-this'), true)
  assert.match(profile, /### Work Resolution extension/)
  assert.match(profile, /execution-ready` and `closure-ready` describe the Work Item, not external\s+authority/)
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

test('a Home without a Desk stays usable and reports one identical desk-missing finding', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'endroit-no-desk-'))
  try {
    const home = join(temporary, 'home')
    await createHome(home, { deskStrategy: 'later' })
    const before = (await exec('git', ['status', '--porcelain'], { cwd: home })).stdout
    const doctor = await doctorHome(home)
    assert.equal(doctor.status, 'ready')
    const doctorWarnings = doctor.warnings.filter((warning) => warning.startsWith('desk-missing:'))
    assert.equal(doctorWarnings.length, 1)
    const expected = doctorWarnings[0].replace(/^desk-missing:\s*/, '')

    const hudOutput = captureIo()
    assert.equal(await dispatchRuntime(home, 'hud', ['json'], hudOutput.io), 0, hudOutput.stderr())
    const hud = JSON.parse(hudOutput.stdout())
    assert.equal(hud.status, 'ready')
    assert.equal(hud.artifacts.count, 0)
    const hudFindings = hud.attention.advisory.filter((finding) => finding.code === 'desk-missing')
    assert.equal(hudFindings.length, 1)
    assert.equal(hudFindings[0].message, expected)

    const hygieneOutput = captureIo()
    assert.equal(await dispatchRuntime(home, 'hygiene', ['maintain', '--json'], hygieneOutput.io), 0, hygieneOutput.stderr())
    const hygiene = JSON.parse(hygieneOutput.stdout())
    assert.equal(hygiene.readOnly, true)
    const hygieneFindings = hygiene.findings.filter((finding) => finding.id === 'desk-missing')
    assert.equal(hygieneFindings.length, 1)
    assert.equal(hygieneFindings[0].message, expected)
    assert.equal((await exec('git', ['status', '--porcelain'], { cwd: home })).stdout, before)
  } finally {
    await removeTree(temporary, { force: true })
  }
})

test('Home Hygiene ignores empty legacy projection directories but reports real Skills', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'endroit-hygiene-legacy-'))
  try {
    const home = join(temporary, 'home')
    await createHome(home)
    const skills = join(home, '.agents', 'skills')
    const empty = join(skills, 'endroit-context-empty')
    const real = join(skills, 'endroit-routing-refresh-real')
    await mkdir(empty, { recursive: true })
    await mkdir(real, { recursive: true })
    await writeFile(join(real, 'SKILL.md'), '# Superseded projection\n')

    const inspection = captureIo()
    assert.equal(await dispatchRuntime(home, 'hygiene', ['maintain', '--json'], inspection.io), 0, inspection.stderr())
    const legacy = JSON.parse(inspection.stdout()).legacyResidue.filter((finding) => finding.code === 'legacy-public-gesture')
    assert.equal(legacy.some((finding) => finding.path === '.agents/skills/endroit-context-empty'), false)
    assert.equal(legacy.some((finding) => finding.path === '.agents/skills/endroit-routing-refresh-real'), true)
    assert.equal(await readFile(join(real, 'SKILL.md'), 'utf8'), '# Superseded projection\n')
  } finally {
    await removeTree(temporary, { force: true })
  }
})

async function gitRoot(path) { return realpath(resolve((await exec('git', ['rev-parse', '--show-toplevel'], { cwd: path })).stdout.trim())) }
