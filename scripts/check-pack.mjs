import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const root = new URL('../', import.meta.url).pathname
const { stdout } = await exec('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: root, maxBuffer: 20 * 1024 * 1024 })
const [pack] = JSON.parse(stdout)
const paths = pack.files.map((entry) => entry.path)
assert.equal(paths.some((path) => /(?:^|\/)(?:node_modules|tests|\.overlay|native|packages)(?:\/|$)/.test(path)), false)
for (const required of [
  'bin/endroit.mjs',
  'schemas/v7/home.schema.json',
  'schemas/v7/desk.schema.json',
  'schemas/v7/member.schema.json',
  'schemas/v7/equipment.schema.json',
  'schemas/v7/site.schema.json',
  'schemas/v7/route.schema.json',
  'schemas/v7/runtime.schema.json',
  'schemas/v7/artifact.schema.json',
  'schemas/v8/route.schema.json',
  'schemas/v9/document.schema.json',
  'schemas/v9/profile.schema.json',
  'schemas/v9/workplace.schema.json',
  'schemas/v9/member.schema.json',
  'schemas/v9/desk.schema.json',
  'schemas/v9/room.schema.json',
  'schemas/v9/site.schema.json',
  'schemas/v9/route.schema.json',
  'schemas/v9/equipment.schema.json',
  'schemas/v9/artifact.schema.json',
  'schemas/work/v1alpha2.json',
  'PROFILE.md',
  'ADOPT.md',
  'INSTALL.md',
  'CHANGELOG.md',
  'ROADMAP.md',
  'SECURITY.md',
  'docs/README.md',
  'docs/concepts.md',
  'docs/architecture.md',
  'docs/lifecycles.md',
  'docs/reference.md',
  'docs/work-resolution.md',
  'docs/migration-0.10.md',
  'docs/migration-route-v8.md',
  'docs/migration-route-v9.md',
  'docs/releases/0.10.0-alpha.0.md',
  'templates/WORKPLACE.md',
  'templates/DESK.md',
  'templates/MEMBER.md',
  'equipment/endroit/onboarding/equipment.json',
  'equipment/endroit/onboarding/references/adopt.md',
  'equipment/endroit/hud/equipment.json',
  'equipment/endroit/artifacts/equipment.json',
  'equipment/endroit/sites/equipment.json',
  'equipment/endroit/rooms/equipment.json',
  'equipment/endroit/workplace/equipment.json',
  'equipment/endroit/work/equipment.json',
  'equipment/endroit/work/runtime.mjs',
  'equipment/endroit/work/schemas/work.schema.json',
  'equipment/endroit/hygiene/equipment.json',
  'equipment/endroit/scratch/equipment.json',
  'docs/providers.md',
]) assert.ok(paths.includes(required), `${required} missing from tarball`)
assert.equal(paths.some((path) => path.startsWith('equipment/endroit/project/')), false)
assert.equal(paths.includes('scripts/development-home.mjs'), false)
assert.equal(pack.name, '@endroit/cli')
assert.equal(pack.version, '0.10.0-alpha.0')
console.log(`package contents passed (${paths.length} files)`)
