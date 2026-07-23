import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { access, readFile, readdir } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { compileSchemas, validateDocument } from '../src/contracts.mjs'

const root = new URL('../', import.meta.url).pathname

async function files(directory) {
  const values = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (['.git', 'node_modules'].includes(entry.name)) continue
    const path = join(directory, entry.name)
    if (entry.isDirectory()) values.push(...await files(path))
    else values.push(path)
  }
  return values
}

assert.deepEqual(await compileSchemas(), ['home', 'desk', 'asset', 'artifact', 'hud'])
for (const name of ['home', 'targets', 'integrations', 'scratch', 'project']) {
  await validateDocument(JSON.parse(await readFile(join(root, 'assets', name, 'asset.json'), 'utf8')), 'asset')
}
await validateDocument({
  $schema: 'https://hairness.dev/schema/home.json',
  name: 'check',
  runtime: '@hairness/cli@0.5.0-alpha.0',
  mode: 'solo',
  providers: ['codex'],
}, 'home')
await validateDocument({
  $schema: 'https://hairness.dev/schema/desk.json',
  id: 'check',
}, 'desk')
await validateDocument({
  $schema: 'https://hairness.dev/schema/artifact.json',
  id: 'proof',
  kind: 'hairness/scratch:scratch',
  owner: 'desk',
  state: 'active',
  createdBy: 'check',
}, 'artifact')

const all = await files(root)
for (const forbidden of ['hairness.lock.json', 'schemas/v4', 'src/prologue.mjs', 'extensions']) {
  assert.equal(all.some((path) => relative(root, path) === forbidden || relative(root, path).startsWith(`${forbidden}/`)), false, `${forbidden} survived the clean break`)
}
for (const path of all.filter((path) => path.endsWith('.mjs'))) execFileSync(process.execPath, ['--check', path], { stdio: 'pipe' })
for (const path of all) {
  const name = relative(root, path)
  assert.ok(!/(^|\/)(?:\.overlay|node_modules)(?:\/|$)/.test(name), `tracked legacy/runtime path: ${name}`)
  if (!/\.(?:md|mjs|json|yml|yaml)$/.test(name)) continue
  const body = await readFile(path, 'utf8')
  assert.ok(!/AKIA[0-9A-Z]{16}|-----BEGIN (?:RSA |EC )?PRIVATE KEY/.test(body), `${name} contains secret-like material`)
  if (name.startsWith('src/')) {
    for (const removed of ['HomeLock', 'Distribution', 'package-owned', '@hairness/native', '@hairness/starter', 'registryDependencies']) {
      assert.equal(body.includes(removed), false, `${name} contains removed model ${removed}`)
    }
  }
  if (name.endsWith('.md')) {
    for (const match of body.matchAll(/!?\[[^\]]*]\(([^)]+)\)/g)) {
      const destination = match[1].trim().split(/\s+["']/)[0]
      if (/^(?:https?:|mailto:|#)/.test(destination)) continue
      const local = destination.split('#')[0]
      await access(resolve(dirname(path), local)).catch(() => {
        throw new Error(`${name} links to missing ${destination}`)
      })
    }
  }
}
console.log(`check passed (${all.length} files)`)
