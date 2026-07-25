import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFile, readdir } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { compileSchemas, validateDocument } from '../src/contracts.mjs'

const root = new URL('../', import.meta.url).pathname

async function files(directory) {
  const values = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (['.git', '.desk', 'node_modules'].includes(entry.name)) continue
    const path = join(directory, entry.name)
    if (entry.isDirectory()) values.push(...await files(path))
    else values.push(path)
  }
  return values
}

assert.deepEqual(await compileSchemas(), ['home', 'desk', 'asset', 'runtime'])
for (const name of ['onboarding', 'hud', 'artifacts', 'targets', 'scratch']) {
  await validateDocument(JSON.parse(await readFile(join(root, 'assets', 'hairness', name, 'asset.json'), 'utf8')), 'asset')
}
await validateDocument({
  $schema: 'https://hairness.dev/schema/home.json',
  name: 'check',
  runtime: '@hairness/cli@0.5.0-alpha.0',
  mode: 'solo',
  providers: ['codex'],
  frontDoor: { wakeUp: 'hairness/hud:prompt' },
}, 'home')
const all = await files(root)
assert.equal(all.some((path) => path.endsWith('hairness.lock.json')), false)
assert.equal(all.some((path) => /packages\/(?:native|starter)/.test(path)), false)
for (const path of all.filter((path) => path.endsWith('.mjs'))) execFileSync(process.execPath, ['--check', path], { stdio: 'pipe' })
for (const path of ['src/build.mjs', 'src/runtime.mjs', 'src/resolved.mjs']) {
  assert.doesNotMatch(await readFile(join(root, path), 'utf8'), /<hairness-hud|hud --prompt|HAIRNESS_HUD/, `${path} contains HUD-specific Kernel behavior`)
}
for (const path of all) {
  const name = relative(root, path)
  assert.ok(!/(^|\/)(?:\.overlay|native|node_modules)(?:\/|$)/.test(name), `tracked legacy path: ${name}`)
  if (!/\.(?:md|mjs|json|yml|yaml)$/.test(name)) continue
  const body = await readFile(path, 'utf8')
  assert.ok(!/AKIA[0-9A-Z]{16}|-----BEGIN (?:RSA |EC )?PRIVATE KEY/.test(body), `${name} contains secret-like material`)
  if (name.startsWith('src/')) {
    for (const removed of ['HomeLock', 'Distribution', 'package-owned', '@hairness/native', '@hairness/starter', 'registryDependencies', 'Prologue', 'Adapter']) {
      assert.equal(body.includes(removed), false, `${name} contains removed model ${removed}`)
    }
  }
}
console.log(`check passed (${all.length} files)`)
