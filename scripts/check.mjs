import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { compileSchemas, compileSchemasV9, validateDocument, validateDocumentV9 } from '../src/contracts.mjs'
import { readDocument } from '../src/documents.mjs'

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
const frozenV7SchemaDigests = {
  'artifact.schema.json': '560e0d62ac8646cf61488ec88298a0af4e7b87cef42e2cfe24a2c9e3b2c29535',
  'desk.schema.json': '66ce6ab3dc01cb63afad47d14041511ef849336034657a6decb0fb0601bb5af8',
  'equipment.schema.json': 'c2e8378f20ceb1e83b0c2b7d92ca94964f12d142e7a0dd607fc54a8c5c39936a',
  'home.schema.json': '7ae8d40ea516938902695549191388fe2510badf65ded5341227cced2f0a5a55',
  'member.schema.json': 'b12d957ee00a823eae1766e0941d0a3c7da100701e6545d8afb8b7d4769503e1',
  'route.schema.json': '7afec4ac50bc0fe06726e89e0e79f114ad9a9bffdfbbb87ca31e6b041b3535b7',
  'runtime.schema.json': '7f95cf78217d0a94219cb0d9dd6f0b952fb854ac95c8e91ec1dd8367830e8799',
  'site.schema.json': '1b6392fec0b66407739f7537567e74af0c3ba439d85c071b8682897175e336ac',
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
assert.deepEqual(await compileSchemasV9(), ['document', 'profile', 'workplace', 'member', 'desk', 'room', 'site', 'route', 'equipment', 'artifact'])
assert.deepEqual(
  (await readdir(join(root, 'schemas/v7'))).sort(),
  schemaNames.map((name) => `${name}.schema.json`).sort(),
)
assert.deepEqual(await readdir(join(root, 'schemas/v8')), ['route.schema.json'])
const routeV8 = JSON.parse(await readFile(join(root, 'schemas/v8/route.schema.json'), 'utf8'))
assert.equal(routeV8.$id, 'https://endroit.org/schema/v8/route.json')
assert.equal(routeV8.properties.$schema.const, routeV8.$id)
for (const [name, digest] of Object.entries(frozenV7SchemaDigests)) {
  assert.equal(createHash('sha256').update(await readFile(join(root, 'schemas/v7', name))).digest('hex'), digest, `v7 ${name} changed`)
}
const schemaIds = []
for (const name of schemaNames) {
  const schema = JSON.parse(await readFile(join(root, 'schemas', 'v7', `${name}.schema.json`), 'utf8'))
  const id = `https://endroit.org/schema/v7/${name}.json`
  assert.equal(schema.$id, id)
  if (name !== 'runtime') assert.equal(schema.properties.$schema.const, id)
  schemaIds.push(schema.$id)
}
assert.equal(new Set(schemaIds).size, schemaNames.length)
const runtimeV7 = JSON.parse(await readFile(join(root, 'schemas/v7/runtime.schema.json'), 'utf8'))
assert.equal(runtimeV7.properties.protocol.const, 'endroit.org/runtime/v2alpha1')
assert.equal(Object.hasOwn(runtimeV7.properties, 'artifacts'), false)
assert.equal(
  await readFile(join(root, 'schemas/v7/artifact.schema.json'), 'utf8'),
  await readFile(join(root, 'equipment/endroit/artifacts/schemas/artifact.schema.json'), 'utf8'),
)
for (const [name, digest] of Object.entries(legacySchemaDigests)) {
  assert.equal(createHash('sha256').update(await readFile(join(root, 'schemas/v6', name))).digest('hex'), digest, `${name} changed`)
}
for (const name of ['onboarding', 'hud', 'artifacts', 'sites', 'rooms', 'workplace', 'work', 'hygiene', 'research', 'planning', 'publishing', 'scratch', 'project']) {
  await validateDocument(JSON.parse(await readFile(join(root, 'equipment', 'endroit', name, 'equipment.json'), 'utf8')), 'equipment')
}
await validateDocument({
  $schema: 'https://endroit.org/schema/v7/home.json',
  name: 'check',
  runtime: '@endroit/cli@0.10.0-alpha.0',
  providers: ['codex'],
  frontDoor: { wakeUp: 'endroit/hud:prompt' },
}, 'home')
const packageDocument = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
assert.equal(packageDocument.version, '0.10.0-alpha.0')
assert.equal(packageDocument.publishConfig.tag, 'next')
assert.match(await readFile(join(root, 'scripts/release-packages.mjs'), 'utf8'), /tag: 'next'/)
const providersDocument = await readFile(join(root, 'docs/providers.md'), 'utf8')
assert.match(providersDocument, /\| Codex \| L1 \| Projection-qualified \|/)
assert.match(providersDocument, /\| Claude \| L1 \| Projection-qualified \|/)
assert.doesNotMatch(providersDocument, /\| (?:Codex|Claude) \| L[234] \| Qualified \|/)
const releaseWorkflow = await readFile(join(root, '.github/workflows/release.yml'), 'utf8')
assert.match(releaseWorkflow, /RELEASE_ARTIFACT: endroit-0\.10-release-candidate/)
assert.match(releaseWorkflow, /smoke-next:/)
const installDocument = await readFile(join(root, 'INSTALL.md'), 'utf8')
assert.match(installDocument, /@endroit\/cli@0\.10\.0-alpha\.0/)
assert.match(installDocument, /The agent guides\. The CLI applies\. The human approves\./)
const workResolveCapability = await readFile(join(root, 'equipment/endroit/work/capabilities/resolve.md'), 'utf8')
assert.match(workResolveCapability, /declares `kind` plus `id`/)
assert.doesNotMatch(workResolveCapability, /declares `fragment` plus `id`/)
const profileDocument = await readFile(join(root, 'PROFILE.md'), 'utf8')
assert.match(profileDocument, /reads frozen v7 declarations and Route v8/)
assert.match(profileDocument, /unversioned v6 contracts remain published and frozen, but\nare not accepted/)
assert.doesNotMatch(profileDocument, /reads the frozen 0\.7 and 0\.8 source contracts/)
await validateDocumentV9((await readDocument(join(root, 'PROFILE.md'))).metadata, 'profile')
assert.equal(
  await readFile(join(root, 'ADOPT.md'), 'utf8'),
  await readFile(join(root, 'equipment/endroit/onboarding/references/adopt.md'), 'utf8'),
  'ADOPT.md must be byte-identical to the Onboarding Equipment adoption reference',
)
assert.equal(
  await readFile(join(root, 'schemas/work/v1alpha1.json'), 'utf8'),
  await readFile(join(root, 'equipment/endroit/work/schemas/work.schema.json'), 'utf8'),
  'the public Work v1alpha1 schema must be byte-identical to its compatibility source',
)
assert.equal(
  await readFile(join(root, 'schemas/work/v1alpha2.json'), 'utf8'),
  await readFile(join(root, 'equipment/endroit/work/schemas/v1alpha2.schema.json'), 'utf8'),
  'the public Work schema projection must be byte-identical to its Equipment source',
)
const all = await files(root)
const allPaths = new Set(all.map((path) => resolve(path)))
for (const path of all.filter((candidate) => candidate.endsWith('.md'))) {
  const body = await readFile(path, 'utf8')
  for (const match of body.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    const href = match[1]
    if (/^[a-z][a-z0-9+.-]*:/i.test(href)) continue
    const separator = href.indexOf('#')
    const resource = decodeURIComponent(separator < 0 ? href : href.slice(0, separator))
    const fragment = separator < 0 ? '' : decodeURIComponent(href.slice(separator + 1))
    const target = resolve(resource ? dirname(path) : path, resource || '.')
    assert.ok(allPaths.has(target), `${relative(root, path)} links to missing ${href}`)
    if (fragment && target.endsWith('.md')) {
      const anchors = markdownAnchors(await readFile(target, 'utf8'))
      assert.ok(anchors.has(fragment), `${relative(root, path)} links to missing anchor ${href}`)
    }
  }
}
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
  if (!['CHANGELOG.md', 'docs/releases/0.7.0-alpha.0.md', 'docs/releases/0.7.0-alpha.1.md', 'docs/releases/0.8.0-alpha.0.md', 'docs/releases/0.8.0-alpha.1.md', 'docs/releases/0.9.0-alpha.0.md'].includes(name)) {
    assert.doesNotMatch(body, legacyBrand, `${name} contains a legacy brand contract`)
  }
}
console.log(`check passed (${all.length} files)`)

function markdownAnchors(body) {
  const anchors = new Set()
  const counts = new Map()
  for (const match of body.matchAll(/^#{1,6}\s+(.+?)(?:\s+#+)?\s*$/gm)) {
    const base = match[1]
      .replace(/<[^>]+>/g, '')
      .replace(/[`*_~]/g, '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N} _-]/gu, '')
      .replace(/ /g, '-')
    const count = counts.get(base) ?? 0
    anchors.add(count ? `${base}-${count}` : base)
    counts.set(base, count + 1)
  }
  return anchors
}
