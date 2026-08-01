import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFile, readdir } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { compileSchemas, validateDocument } from '../src/contracts.mjs'

const root = new URL('../', import.meta.url).pathname
const legacyBrand = new RegExp(['hair', 'ness'].join(''), 'i')
const schemaNames = ['home', 'desk', 'member', 'equipment', 'site', 'route', 'runtime', 'artifact']
const legacySchemaDigests = {
  'asset.schema.json': '9951c9992ee21066161d24ac4342d058f7b68a1754da42d30a26bc574783f2aa',
  'artifact.schema.json': '331fd94dd5ed5bc159c6c8b2bf286eff580b30f957bf7a9e3beb0c5732121995',
  'desk.schema.json': 'f7a4b92ba01c82c5e186feeb77aa2a5dc38c1aa23622d9a7481f9f5308acc87e',
  'home.schema.json': '57bfae48f1288a684b60a56a73a82b79d6907c5ead7f968da316850e8bfa109b',
  'runtime.schema.json': 'c5dc6f9f772650cc645434d85f659b9874a47eb2bb51584326d1c757d3b6b251',
}

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

assert.deepEqual(await compileSchemas(), schemaNames)
assert.deepEqual(
  (await readdir(join(root, 'schemas/v7'))).sort(),
  schemaNames.map((name) => `${name}.schema.json`).sort(),
)
const schemaIds = []
for (const name of schemaNames) {
  const schema = JSON.parse(await readFile(join(root, 'schemas', 'v7', `${name}.schema.json`), 'utf8'))
  const id = `https://endroit.org/schema/v7/${name}.json`
  assert.equal(schema.$id, id)
  if (name !== 'runtime') assert.equal(schema.properties.$schema.const, id)
  schemaIds.push(schema.$id)
}
assert.equal(new Set(schemaIds).size, schemaNames.length)
assert.equal(JSON.parse(await readFile(join(root, 'schemas/v7/runtime.schema.json'), 'utf8')).properties.protocol.const, 'endroit.org/runtime/v2alpha1')
assert.equal(
  await readFile(join(root, 'schemas/v7/artifact.schema.json'), 'utf8'),
  await readFile(join(root, 'equipment/endroit/artifacts/schemas/artifact.schema.json'), 'utf8'),
)
for (const [name, digest] of Object.entries(legacySchemaDigests)) {
  assert.equal(createHash('sha256').update(await readFile(join(root, 'schemas/v6', name))).digest('hex'), digest, `${name} changed`)
}
for (const name of ['onboarding', 'hud', 'artifacts', 'sites', 'rooms', 'workplace', 'hygiene', 'research', 'planning', 'publishing', 'scratch', 'project']) {
  await validateDocument(JSON.parse(await readFile(join(root, 'equipment', 'endroit', name, 'equipment.json'), 'utf8')), 'equipment')
}
await validateDocument({
  $schema: 'https://endroit.org/schema/v7/home.json',
  name: 'check',
  runtime: '@endroit/cli@0.8.0-alpha.1',
  providers: ['codex'],
  frontDoor: { wakeUp: 'endroit/hud:prompt' },
}, 'home')
const packageDocument = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
assert.equal(packageDocument.publishConfig.tag, 'next')
assert.match(await readFile(join(root, 'scripts/release-packages.mjs'), 'utf8'), /tag: 'next'/)
const providersDocument = await readFile(join(root, 'docs/providers.md'), 'utf8')
assert.match(providersDocument, /\| Codex \| L1 \| Projection-qualified \|/)
assert.match(providersDocument, /\| Claude \| L1 \| Projection-qualified \|/)
assert.doesNotMatch(providersDocument, /\| (?:Codex|Claude) \| L[234] \| Qualified \|/)
const releaseWorkflow = await readFile(join(root, '.github/workflows/release.yml'), 'utf8')
assert.match(releaseWorkflow, /RELEASE_ARTIFACT: endroit-0\.8-release-candidate/)
assert.match(releaseWorkflow, /smoke-next:/)
const installDocument = await readFile(join(root, 'INSTALL.md'), 'utf8')
assert.match(installDocument, /@endroit\/cli@0\.8\.0-alpha\.1/)
assert.match(installDocument, /The agent guides\. The CLI applies\. The human approves\./)
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
  if (!['CHANGELOG.md', 'docs/releases/0.7.0-alpha.0.md', 'docs/releases/0.7.0-alpha.1.md', 'docs/releases/0.8.0-alpha.0.md', 'docs/releases/0.8.0-alpha.1.md'].includes(name)) {
    assert.doesNotMatch(body, legacyBrand, `${name} contains a legacy brand contract`)
  }
}
console.log(`check passed (${all.length} files)`)
