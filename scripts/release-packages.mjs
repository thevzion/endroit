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
const manifest = {
  commit: commit.trim(),
  tag: 'next',
  packages,
}
await writeFile(join(outputRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`)
