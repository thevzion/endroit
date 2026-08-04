import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'

import { comparePackedTrees } from './lib/pack.mjs'
import { verifyVersionedSchemas, verifyWorkSchemas } from './lib/release-schemas.mjs'

const exec = promisify(execFile)
const projectRoot = new URL('../', import.meta.url).pathname
const dryRun = process.argv.includes('--dry-run')
const manifestArgument = process.argv.find((argument) => argument.endsWith('manifest.json'))
const manifestPath = resolve(manifestArgument ?? join(projectRoot, 'release/manifest.json'))
const releaseRoot = dirname(manifestPath)
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
const expectedOrder = ['@endroit/cli']
const expectedSchemas = ['home', 'desk', 'member', 'equipment', 'site', 'route', 'runtime', 'artifact']
const expectedSchemasV8 = ['route']
const expectedSchemasV9 = ['document', 'profile', 'workplace', 'member', 'desk', 'room', 'site', 'route', 'equipment', 'artifact']
const expectedSchemasWork = ['v1alpha1', 'v1alpha2']
const expectedLegacySchemas = ['home', 'desk', 'asset', 'runtime', 'artifact']

if (JSON.stringify(manifest.packages.map((entry) => entry.name)) !== JSON.stringify(expectedOrder)) {
  throw new Error(`Release order must be ${expectedOrder.join(' → ')}.`)
}
const { stdout: commit } = await exec('git', ['rev-parse', 'HEAD'], { cwd: projectRoot })
if (manifest.commit !== commit.trim()) throw new Error(`Release manifest belongs to ${manifest.commit}, not ${commit.trim()}.`)
await verifyVersionedSchemas(manifest.schemas, 'v7', expectedSchemas, verifyPublicSchema)
await verifyVersionedSchemas(manifest.schemasV8, 'v8', expectedSchemasV8, verifyPublicSchema)
await verifyVersionedSchemas(manifest.schemasV9, 'v9', expectedSchemasV9, verifyPublicSchema)
await verifyWorkSchemas(manifest.schemasWork, expectedSchemasWork, verifyPublicSchema)
await verifyLegacySchemas(manifest.legacySchemas)

for (const entry of manifest.packages) {
  const tarball = join(releaseRoot, entry.filename)
  const sha256 = createHash('sha256').update(await readFile(tarball)).digest('hex')
  if (sha256 !== entry.sha256) throw new Error(`${entry.filename} does not match its qualified SHA-256.`)

  const remote = await remoteDistribution(entry)
  if (remote) {
    await verifyPackedDistribution(entry, tarball, remote)
    await verifyRegistry(entry, manifest.tag, tarball)
    process.stdout.write(`verified ${entry.name}@${entry.version}; publication skipped\n`)
    continue
  }

  const args = ['publish', tarball, '--access', 'public', '--tag', manifest.tag, '--ignore-scripts']
  args.push(dryRun ? '--dry-run' : '--provenance')
  await exec('npm', args, { cwd: projectRoot, maxBuffer: 20 * 1024 * 1024 })
  process.stdout.write(`${dryRun ? 'qualified' : 'published'} ${entry.name}@${entry.version}\n`)
  if (!dryRun) await verifyRegistry(entry, manifest.tag, tarball)
}

async function verifyLegacySchemas(schemas) {
  if (JSON.stringify(schemas?.map((entry) => entry.name)) !== JSON.stringify(expectedLegacySchemas)) {
    throw new Error(`Legacy release schemas must be ${expectedLegacySchemas.join(', ')}.`)
  }
  for (const entry of schemas) {
    const expectedUrl = `https://endroit.org/schema/${entry.name}.json`
    if (entry.url !== expectedUrl) throw new Error(`${entry.name} legacy schema URL must be ${expectedUrl}.`)
    await verifyPublicSchema(entry)
  }
}

async function verifyPublicSchema(entry) {
  const response = await fetch(entry.url, { redirect: 'manual' })
  if (response.status !== 200) throw new Error(`${entry.url} returned HTTP ${response.status}.`)
  if (!response.headers.get('content-type')?.toLowerCase().startsWith('application/schema+json')) {
    throw new Error(`${entry.url} must use application/schema+json.`)
  }
  if (response.headers.get('access-control-allow-origin') !== '*') throw new Error(`${entry.url} must allow CORS from *.`)
  const content = Buffer.from(await response.arrayBuffer())
  if (createHash('sha256').update(content).digest('hex') !== entry.sha256) throw new Error(`${entry.url} does not match its qualified SHA-256.`)
  if (JSON.parse(content).$id !== entry.url) throw new Error(`${entry.url} has a mismatched $id.`)
}

async function remoteDistribution(entry) {
  try {
    const { stdout } = await exec('npm', ['view', `${entry.name}@${entry.version}`, 'dist', '--json'], { cwd: projectRoot })
    return JSON.parse(stdout)
  } catch (error) {
    if (error.stderr?.includes('E404')) return null
    throw error
  }
}

async function verifyPackedDistribution(entry, tarball, distribution) {
  if (distribution.integrity === entry.integrity) return
  const url = new URL(distribution.tarball)
  if (url.protocol !== 'https:' || url.hostname !== 'registry.npmjs.org') {
    throw new Error(`${entry.name}@${entry.version} uses an unexpected registry tarball URL.`)
  }
  const response = await fetch(url, { redirect: 'follow' })
  if (response.status !== 200) throw new Error(`${url} returned HTTP ${response.status}.`)
  const local = await readFile(tarball)
  const remote = Buffer.from(await response.arrayBuffer())
  if (!comparePackedTrees(local, remote)) throw new Error(`${entry.name}@${entry.version} exists with a different package tree.`)
}

async function verifyRegistry(entry, tag, tarball) {
  for (let attempt = 0; attempt < 36; attempt += 1) {
    const distribution = await remoteDistribution(entry)
    const tagged = await exec('npm', ['view', entry.name, `dist-tags.${tag}`, '--json'], { cwd: projectRoot })
      .then(({ stdout }) => JSON.parse(stdout), () => null)
    if (distribution && tagged === entry.version && distribution.attestations) {
      await verifyPackedDistribution(entry, tarball, distribution)
      return
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5000))
  }
  throw new Error(`Registry verification failed for ${entry.name}@${entry.version}.`)
}
