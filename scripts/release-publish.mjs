import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const projectRoot = new URL('../', import.meta.url).pathname
const dryRun = process.argv.includes('--dry-run')
const manifestArgument = process.argv.find((argument) => argument.endsWith('manifest.json'))
const manifestPath = resolve(manifestArgument ?? join(projectRoot, 'release/manifest.json'))
const releaseRoot = dirname(manifestPath)
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
const expectedOrder = ['@endroit/cli']
const expectedSchemas = ['home', 'desk', 'member', 'equipment', 'site', 'route', 'runtime', 'artifact']
const expectedLegacySchemas = ['home', 'desk', 'asset', 'runtime', 'artifact']

if (JSON.stringify(manifest.packages.map((entry) => entry.name)) !== JSON.stringify(expectedOrder)) {
  throw new Error(`Release order must be ${expectedOrder.join(' → ')}.`)
}
const { stdout: commit } = await exec('git', ['rev-parse', 'HEAD'], { cwd: projectRoot })
if (manifest.commit !== commit.trim()) throw new Error(`Release manifest belongs to ${manifest.commit}, not ${commit.trim()}.`)
await verifySchemas(manifest.schemas)
await verifyLegacySchemas(manifest.legacySchemas)

for (const entry of manifest.packages) {
  const tarball = join(releaseRoot, entry.filename)
  const sha256 = createHash('sha256').update(await readFile(tarball)).digest('hex')
  if (sha256 !== entry.sha256) throw new Error(`${entry.filename} does not match its qualified SHA-256.`)

  const remote = await remoteIntegrity(entry)
  if (remote) {
    if (remote !== entry.integrity) throw new Error(`${entry.name}@${entry.version} exists with different integrity.`)
    await verifyRegistry(entry, manifest.tag)
    process.stdout.write(`verified ${entry.name}@${entry.version}; publication skipped\n`)
    continue
  }

  const args = ['publish', tarball, '--access', 'public', '--tag', manifest.tag, '--ignore-scripts']
  args.push(dryRun ? '--dry-run' : '--provenance')
  await exec('npm', args, { cwd: projectRoot, maxBuffer: 20 * 1024 * 1024 })
  process.stdout.write(`${dryRun ? 'qualified' : 'published'} ${entry.name}@${entry.version}\n`)
  if (!dryRun) await verifyRegistry(entry, manifest.tag)
}

async function verifySchemas(schemas) {
  if (JSON.stringify(schemas?.map((entry) => entry.name)) !== JSON.stringify(expectedSchemas)) {
    throw new Error(`Release schemas must be ${expectedSchemas.join(', ')}.`)
  }
  for (const entry of schemas) {
    const expectedUrl = `https://endroit.org/schema/v7/${entry.name}.json`
    if (entry.url !== expectedUrl) throw new Error(`${entry.name} schema URL must be ${expectedUrl}.`)
    await verifyPublicSchema(entry)
  }
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

async function remoteIntegrity(entry) {
  try {
    const { stdout } = await exec('npm', ['view', `${entry.name}@${entry.version}`, 'dist.integrity', '--json'], { cwd: projectRoot })
    return JSON.parse(stdout)
  } catch (error) {
    if (error.stderr?.includes('E404')) return null
    throw error
  }
}

async function verifyRegistry(entry, tag) {
  for (let attempt = 0; attempt < 36; attempt += 1) {
    const integrity = await remoteIntegrity(entry)
    const tagged = await exec('npm', ['view', entry.name, `dist-tags.${tag}`, '--json'], { cwd: projectRoot })
      .then(({ stdout }) => JSON.parse(stdout), () => null)
    const attestations = await exec('npm', ['view', `${entry.name}@${entry.version}`, 'dist.attestations', '--json'], { cwd: projectRoot })
      .then(({ stdout }) => JSON.parse(stdout), () => null)
    if (integrity === entry.integrity && tagged === entry.version && attestations) return
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5000))
  }
  throw new Error(`Registry verification failed for ${entry.name}@${entry.version}.`)
}
