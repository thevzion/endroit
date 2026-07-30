import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFile, readdir } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { compileSchemas, validateDocument } from '../src/contracts.mjs'

const root = new URL('../', import.meta.url).pathname
const legacyBrand = new RegExp(['hair', 'ness'].join(''), 'i')

async function files(directory) {
  const values = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (['.git', '.desk', '.agents', '.claude', '.overlay', 'node_modules'].includes(entry.name)) continue
    const path = join(directory, entry.name)
    if (entry.isDirectory()) values.push(...await files(path))
    else values.push(path)
  }
  return values
}

assert.deepEqual(await compileSchemas(), ['home', 'desk', 'asset', 'runtime'])
for (const name of ['onboarding', 'hud', 'artifacts', 'targets', 'workspaces', 'research', 'planning', 'publishing', 'scratch', 'project']) {
  await validateDocument(JSON.parse(await readFile(join(root, 'assets', 'endroit', name, 'asset.json'), 'utf8')), 'asset')
}
await validateDocument({
  $schema: 'https://endroit.org/schema/home.json',
  name: 'check',
  runtime: '@endroit/cli@0.7.0-alpha.0',
  mode: 'solo',
  providers: ['codex'],
  frontDoor: { wakeUp: 'endroit/hud:prompt' },
}, 'home')
const all = await files(root)
assert.equal(all.some((path) => path.endsWith('endroit.lock.json')), false)
for (const path of all.filter((path) => path.endsWith('.mjs'))) execFileSync(process.execPath, ['--check', path], { stdio: 'pipe' })
for (const path of ['src/build.mjs', 'src/runtime.mjs', 'src/resolved.mjs']) {
  assert.doesNotMatch(await readFile(join(root, path), 'utf8'), /<endroit-hud|hud --prompt|ENDROIT_HUD/, `${path} contains HUD-specific Kernel behavior`)
}
for (const path of all) {
  const name = relative(root, path)
  if (!/\.(?:md|mjs|json|yml|yaml)$/.test(name)) continue
  const body = await readFile(path, 'utf8')
  assert.ok(!/AKIA[0-9A-Z]{16}|-----BEGIN (?:RSA |EC )?PRIVATE KEY/.test(body), `${name} contains secret-like material`)
  if (!['CHANGELOG.md', 'docs/releases/0.7.0-alpha.0.md', 'docs/releases/0.7.0-alpha.1.md'].includes(name)) {
    assert.doesNotMatch(body, legacyBrand, `${name} contains a legacy brand contract`)
  }
}
console.log(`check passed (${all.length} files)`)
