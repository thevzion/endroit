import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const projectRoot = new URL('../', import.meta.url).pathname
const outputRoot = resolve(process.argv[2] ?? join(projectRoot, 'release'))
const sources = ['.']
const packages = []
const schemaNames = ['home', 'desk', 'member', 'equipment', 'site', 'route', 'runtime', 'artifact']
const legacySchemaNames = ['home', 'desk', 'asset', 'runtime', 'artifact']

const { stdout: status } = await exec('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: projectRoot })
if (status.trim()) throw new Error('Release packaging requires a clean worktree.')
await mkdir(outputRoot, { recursive: true })
for (const source of sources) {
  const cwd = resolve(projectRoot, source)
  const document = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8'))
  const { stdout } = await exec('npm', [
    'pack',
    '--json',
    '--ignore-scripts',
    '--pack-destination',
    outputRoot,
  ], { cwd, maxBuffer: 20 * 1024 * 1024 })
  const [packed] = JSON.parse(stdout)
  const path = join(outputRoot, packed.filename)
  const sha256 = createHash('sha256').update(await readFile(path)).digest('hex')
  packages.push({
    name: document.name,
    version: document.version,
    filename: packed.filename,
    integrity: packed.integrity,
    sha256,
  })
}

const { stdout: commit } = await exec('git', ['rev-parse', 'HEAD'], { cwd: projectRoot })
const schemas = []
for (const name of schemaNames) {
  const source = `schemas/v7/${name}.schema.json`
  const content = await readFile(join(projectRoot, source))
  const url = `https://endroit.org/schema/v7/${name}.json`
  if (JSON.parse(content).$id !== url) throw new Error(`${source} must use $id ${url}.`)
  schemas.push({ name, source, url, sha256: createHash('sha256').update(content).digest('hex') })
}
const legacySchemas = []
for (const name of legacySchemaNames) {
  const source = `schemas/v6/${name}.schema.json`
  const content = await readFile(join(projectRoot, source))
  const url = `https://endroit.org/schema/${name}.json`
  if (JSON.parse(content).$id !== url) throw new Error(`${source} must preserve $id ${url}.`)
  legacySchemas.push({ name, source, url, sha256: createHash('sha256').update(content).digest('hex') })
}
const manifest = {
  commit: commit.trim(),
  tag: 'next',
  packages,
  schemas,
  legacySchemas,
}
await writeFile(join(outputRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`)
