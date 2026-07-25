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
  'bin/hairness.mjs',
  'schemas/v5/home.schema.json',
  'schemas/v5/desk.schema.json',
  'schemas/v5/asset.schema.json',
  'schemas/v5/runtime.schema.json',
  'templates/HOME.md',
  'templates/DESK.md',
  'assets/hairness/onboarding/asset.json',
  'assets/hairness/hud/asset.json',
  'assets/hairness/artifacts/asset.json',
  'assets/hairness/targets/asset.json',
  'assets/hairness/scratch/asset.json',
]) assert.ok(paths.includes(required), `${required} missing from tarball`)
assert.equal(paths.some((path) => path.startsWith('assets/hairness/project/')), false)
assert.equal(paths.includes('scripts/development-home.mjs'), false)
assert.equal(pack.name, '@hairness/cli')
console.log(`package contents passed (${paths.length} files)`)
