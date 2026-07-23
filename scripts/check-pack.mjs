import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const root = new URL('../', import.meta.url).pathname
const { stdout } = await exec('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: root, maxBuffer: 20 * 1024 * 1024 })
const [pack] = JSON.parse(stdout)
const paths = pack.files.map((entry) => entry.path)
assert.equal(paths.some((path) => /(?:^|\/)(?:node_modules|tests|\.overlay|packages)(?:\/|$)/.test(path)), false)
for (const required of [
  'bin/hairness.mjs',
  'schemas/v5/home.schema.json',
  'schemas/v5/desk.schema.json',
  'schemas/v5/asset.schema.json',
  'schemas/v5/artifact.schema.json',
  'schemas/v5/hud.schema.json',
  'assets/home/asset.json',
  'assets/targets/asset.json',
  'assets/integrations/asset.json',
  'assets/scratch/asset.json',
]) assert.ok(paths.includes(required), `${required} missing from tarball`)
assert.equal(paths.some((path) => path.startsWith('assets/project/')), false)
assert.equal(pack.name, '@hairness/cli')
assert.equal(pack.version, '0.5.0-alpha.0')
console.log(`package contents passed (${paths.length} files)`)
