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
import { parseDocument, renderDocument } from '../src/documents.mjs'
import { resolveHome } from '../src/resolved.mjs'
import { dispatchRuntime } from '../src/runtime.mjs'
import { captureIo, equipment, writeEquipment } from './helpers.mjs'

const exec = promisify(execFile)
const cli = new URL('../bin/endroit.mjs', import.meta.url).pathname

test('create and init choose explicit Desk Git boundaries around Workplace-owned Members', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'endroit-members-'))
  try {
    const tracked = join(temporary, 'tracked')
    await createHome(tracked, { memberId: 'alexis', memberName: 'Alexis' })
    assert.match(await readFile(join(tracked, 'members/alexis/MEMBER.md'), 'utf8'), /id: "alexis"/)
    assert.deepEqual(parseDocument(await readFile(join(tracked, '.desk/DESK.md'))).metadata, {
      $schema: 'https://endroit.org/schema/v9/desk.json', kind: 'endroit/desk', id: 'local', owner: 'member:alexis', desk_state: 'active',
    })
    assert.equal(await gitRoot(join(tracked, '.desk')), await realpath(tracked))
    assert.match((await exec('git', ['ls-files'], { cwd: tracked })).stdout, /^members\/alexis\/MEMBER\.md$/m)
    assert.match(await readFile(join(tracked, '.gitignore'), 'utf8'), /^\/checkouts\/$/m)
    assert.match(await readFile(join(tracked, 'AGENTS.md'), 'utf8'), /Profile: `endroit\/0\.10`/)

    const embedded = join(temporary, 'embedded')
    await exec('git', ['init', '--quiet', '--initial-branch=main', embedded])
    await initializeExistingHome(embedded, { memberId: 'alexis', memberName: 'Alexis' })
    assert.equal(await gitRoot(join(embedded, '.desk')), await realpath(join(embedded, '.desk')))
    assert.equal((await exec('git', ['check-ignore', '.desk/DESK.md'], { cwd: embedded })).stdout.trim(), '.desk/DESK.md')
    assert.match(await readFile(join(embedded, '.gitignore'), 'utf8'), /^\/checkouts\/$/m)
    assert.equal(await readFile(join(embedded, '.agents/skills/work-on-site/SKILL.md'), 'utf8').then(Boolean), true)
    assert.equal(await readFile(join(embedded, '.claude/skills/deliver-this/SKILL.md'), 'utf8').then(Boolean), true)
    assert.match(await readFile(join(embedded, 'sites/self/SITE.md'), 'utf8'), /when: \["Working on this repository\."\]/)

    const later = join(temporary, 'later')
    await createHome(later, { deskStrategy: 'later' })
    await assert.rejects(readFile(join(later, '.desk/DESK.md')), (error) => error.code === 'ENOENT')
    assert.equal((await resolveHome(later)).members[0].id, 'owner')
    assert.equal((await initDesk(later, { id: 'later', member: 'owner', repository: 'tracked' })).id, 'later')

    const deferred = join(temporary, 'deferred-embedded')
    await exec('git', ['init', '--quiet', '--initial-branch=main', deferred])
    await writeFile(join(deferred, 'README.md'), '# Existing repository\n')
    await exec('git', ['add', 'README.md'], { cwd: deferred })
    await exec('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '-m', 'initial'], { cwd: deferred })
    const initialized = captureIo()
    assert.equal(await runCli(['init', deferred, '--desk', 'later', '--json'], initialized.io), 0, initialized.stderr())
    await assert.rejects(readFile(join(deferred, '.desk/routes/self/embedded/ROUTE.md')), (error) => error.code === 'ENOENT')
    assert.equal((await resolveHome(deferred)).sites[0].id, 'self')
    const desk = captureIo()
    assert.equal(await runCli(['desk', 'init', '--id', 'later', '--workplace', deferred, '--json'], desk.io), 0, desk.stderr())
    assert.equal(JSON.parse(desk.stdout()).repository, 'separate')
    const resumed = captureIo()
    assert.equal(await runCli(['checkout', 'adopt', 'self', deferred, '--id', 'embedded', '--purpose', 'primary', '--workplace', deferred, '--json'], resumed.io), 0, resumed.stderr())
    assert.equal(JSON.parse(resumed.stdout()).mode, 'embedded')
    const embeddedRoute = parseDocument(await readFile(join(deferred, '.desk/routes/self/embedded/ROUTE.md'))).metadata
    assert.equal(embeddedRoute.$schema, 'https://endroit.org/schema/v9/route.json')
    assert.equal(embeddedRoute.route_state, 'active')
    assert.equal(embeddedRoute.checkout_mode, 'embedded')
    assert.equal('path' in embeddedRoute, false)
  } finally {
    await removeTree(temporary, { force: true })
  }
})

test('Desk init refuses to write v9 from a legacy Workplace declaration', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'endroit-legacy-desk-init-'))
  try {
    const home = join(temporary, 'home')
    await createHome(home, { deskStrategy: 'later' })
    await rm(join(home, 'WORKPLACE.md'))
    await writeFile(join(home, 'endroit.json'), `${JSON.stringify({
      $schema: 'https://endroit.org/schema/v7/home.json',
      name: 'home',
      runtime: '@endroit/cli@0.10.0-alpha.0',
      providers: ['codex', 'claude'],
    }, null, 2)}\n`)
    await writeFile(join(home, 'HOME.md'), '# Legacy Workplace\n\nReadable compatibility source.\n')

    await assert.rejects(
      () => initDesk(home, { id: 'local', member: 'owner', repository: 'tracked' }),
      (error) => error.code === 'legacy_source_read_only',
    )
    await assert.rejects(readFile(join(home, '.desk/DESK.md')), (error) => error.code === 'ENOENT')
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
    assert.equal(await runCli(['member', 'create', 'sam', '--name', 'Sam', '--account', 'github:public:42:sam', '--workplace', home, '--json'], created.io), 0, created.stderr())
    assert.deepEqual(JSON.parse(created.stdout()).accounts, [{ service: 'github', scope: 'public', identifier: '42', handle: 'sam' }])
    const listed = captureIo()
    assert.equal(await runCli(['member', 'list', '--workplace', home, '--json'], listed.io), 0, listed.stderr())
    assert.deepEqual(JSON.parse(listed.stdout()).map((member) => member.id), ['owner', 'sam'])

    const memberPath = join(home, 'members/sam/MEMBER.md')
    await writeFile(memberPath, (await readFile(memberPath, 'utf8')).replace('accounts:', 'token: "secret"\naccounts:'))
    assert.equal((await doctorMembers(home)).issues[0].code, 'member_invalid')

    const deskPath = join(home, '.desk/DESK.md')
    const desk = parseDocument(await readFile(deskPath))
    desk.metadata.owner = 'member:missing'
    await writeFile(deskPath, renderDocument(desk))
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
    const gestures = ['enter-workplace', 'work-on-site', 'retain-this', 'accept-this', 'archive-this', 'deliver-this']
    for (const providerRoot of ['.agents/skills', '.claude/skills']) {
      for (const gesture of gestures) assert.equal(await readFile(join(home, providerRoot, gesture, 'SKILL.md'), 'utf8').then(Boolean), true)
    }
    const agents = await readFile(join(home, 'AGENTS.md'), 'utf8')
    const claude = await readFile(join(home, 'CLAUDE.md'), 'utf8')
    for (const contract of [agents, claude]) {
      assert.ok(Buffer.byteLength(contract) <= 4096)
      assert.match(contract, /Profile: `endroit\/0\.10`/)
      assert.match(contract, /Protocol: `open-workplace\/0\.2-draft`/)
      assert.match(contract, /## Constitution/)
      assert.match(contract, /Owned Markdown sources are canonical/)
      assert.doesNotMatch(contract, /# Endroit Workplace Profile|## Responsibilities|\/(?:Users|private)\//)
    }
    assert.equal(agents, claude)
    await assert.rejects(readFile(join(home, '.agents/skills/work-on-self/SKILL.md')), (error) => error.code === 'ENOENT')
    await assert.rejects(readFile(join(home, '.claude/skills/enter-the-home-room/SKILL.md')), (error) => error.code === 'ENOENT')
    assert.match(await readFile(join(home, '.agents/skills/retain-this/SKILL.md'), 'utf8'), /Endroit\nownership|Endroit objects|These states are distinct/)
    const lifecycle = await readFile(join(home, '.agents/skills/retain-this/SKILL.md'), 'utf8')
    assert.match(lifecycle, /adds\s+one relative link under `Active retained Material`/)
    assert.match(lifecycle, /does not update Room truth/)
    assert.match(lifecycle, /removes its active link from `ROOM\.md`/)
    assert.match(lifecycle, /Never create a candidate-notes section or file/)
    assert.match(await readFile(join(home, '.agents/skills/work-on-site/SKILL.md'), 'utf8'), /revalidate the\s+selected Route immediately before any mutation/i)
  } finally {
    await removeTree(temporary, { force: true })
  }
})

test('the Endroit Profile and adoption guide disclose separate responsibilities and release status', async () => {
  const profile = await readFile(new URL('../PROFILE.md', import.meta.url), 'utf8')
  const adoption = await readFile(new URL('../ADOPT.md', import.meta.url), 'utf8')
  const install = await readFile(new URL('../INSTALL.md', import.meta.url), 'utf8')
  const packageDocument = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  const workplace = JSON.parse(await readFile(new URL('../equipment/endroit/workplace/equipment.json', import.meta.url), 'utf8'))
  const onboardingManifest = JSON.parse(await readFile(new URL('../equipment/endroit/onboarding/equipment.json', import.meta.url), 'utf8'))
  const onboarding = await readFile(new URL('../equipment/endroit/onboarding/capabilities/onboard.md', import.meta.url), 'utf8')
  const cli = await readFile(new URL('../src/cli.mjs', import.meta.url), 'utf8')

  assert.equal(packageDocument.files.includes('PROFILE.md'), true)
  assert.equal(packageDocument.files.includes('WORKPLACE.md'), false)
  assert.equal(packageDocument.files.includes('ADOPT.md'), true)
  assert.equal(packageDocument.files.includes('INSTALL.md'), true)
  assert.match(profile, /kind: "endroit\/profile"/)
  assert.match(profile, /version: "endroit\/0\.10"/)
  assert.match(profile, /protocol: "open-workplace\/0\.2-draft"/)
  assert.match(profile, /local-first implementation of Open Workplace/)
  for (const section of [
    'Responsibilities', 'Source model', 'Resolution', 'Provider projections',
    'Material and work', 'Sites, Routes and Checkouts', 'Compatibility', 'Limits',
  ]) assert.match(profile, new RegExp(`## ${section}`), section)
  assert.match(profile, /Completion is calculated for an exact `\(contract, revision, evidence\)` tuple/)
  assert.match(profile, /defines no\s+`final`, `accepted: true` or `delivered: true` field/)
  assert.match(profile, /`Home` and `Instance` are legacy Endroit 0\.8 terms/)
  assert.match(adoption, /first file\s+whose frontmatter declares `kind: "endroit\/workplace"`/)
  assert.match(adoption, /Do not search children, follow symlinks, inspect unrelated repositories or scan\s+a projects directory/)
  assert.match(adoption, /The agent guides\. The CLI applies\. The human approves\./)
  assert.match(onboarding, /source-owned `ADOPT\.md`/)
  assert.match(install, /package version is\s+`0\.10\.0-alpha\.0`/)
  assert.match(install, /`open-workplace\/0\.2-draft`/)
  assert.match(install, /build[\s\S]*does not install provider hooks/)
  assert.equal('runtime' in workplace, false)
  assert.equal('runtime' in onboardingManifest, false)
  assert.doesNotMatch(cli, /command === ['"]adopt['"]/)
  assert.deepEqual(onboardingManifest.references.map(({ id, path }) => ({ id, path })), [{ id: 'adopt', path: 'references/adopt.md' }])
  assert.deepEqual(workplace.skills.map(({ projectedName }) => projectedName), [
    'enter-workplace', 'work-on-site', 'retain-this', 'accept-this', 'archive-this', 'deliver-this',
  ])
  assert.deepEqual(workplace.commands.map(({ projectedName }) => projectedName), [
    'enter-workplace', 'work-on-site', 'retain-this', 'accept-this', 'archive-this', 'deliver-this',
  ])
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
