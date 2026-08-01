import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, copyFile, mkdir, writeFile } from 'node:fs/promises'
import { basename, join, posix } from 'node:path'
import { promisify } from 'node:util'
import { gunzipSync } from 'node:zlib'

const exec = promisify(execFile)
const MAX_TARBALL_BYTES = 64 * 1024 * 1024

export async function packEndroit(root, destination) {
  await mkdir(destination, { recursive: true })
  const cli = await pack(root, destination, [])
  return { cli: join(destination, cli.filename) }
}

export async function installPackedRuntime(home, cli) {
  const runtimeRoot = join(home, '.endroit')
  const packageRoot = join(runtimeRoot, 'packages')
  const filename = basename(cli)
  await mkdir(packageRoot, { recursive: true })
  await copyFile(cli, join(packageRoot, filename))

  const launcher = join(runtimeRoot, 'dev-cli')
  await writeFile(launcher, `#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const cli = join(dirname(fileURLToPath(import.meta.url)), 'packages', ${JSON.stringify(filename)})
const result = spawnSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['--yes', '--package', cli, 'endroit', ...process.argv.slice(2)], { stdio: 'inherit' })
process.exitCode = result.status ?? 1
`)
  await chmod(launcher, 0o755)
  return { launcher, cli: join(packageRoot, filename) }
}

export function comparePackedTrees(left, right) {
  return JSON.stringify(readPackedTree(left)) === JSON.stringify(readPackedTree(right))
}

function readPackedTree(tarball) {
  if (tarball.length > MAX_TARBALL_BYTES) throw new Error('Package tarball exceeds the 64 MiB verification limit.')
  const archive = gunzipSync(tarball, { maxOutputLength: MAX_TARBALL_BYTES })
  if (archive.length % 512 !== 0) throw new Error('Package tar archive is truncated.')

  const entries = []
  const names = new Set()
  let offset = 0
  let terminated = false
  while (offset < archive.length) {
    const header = archive.subarray(offset, offset + 512)
    if (header.every((value) => value === 0)) {
      if (!archive.subarray(offset).every((value) => value === 0)) throw new Error('Package tar archive has data after its terminator.')
      terminated = true
      break
    }
    if (header.toString('ascii', 257, 262) !== 'ustar') throw new Error('Package tar archive must use the ustar format.')
    if (tarNumber(header.subarray(148, 156)) !== headerChecksum(header)) throw new Error('Package tar header checksum is invalid.')

    const name = [tarText(header.subarray(345, 500)), tarText(header.subarray(0, 100))].filter(Boolean).join('/')
    if (!name.startsWith('package/') || name.includes('\\') || posix.normalize(name) !== name) {
      throw new Error(`Unsafe package tar path: ${name || '<empty>'}.`)
    }
    if (names.has(name)) throw new Error(`Duplicate package tar path: ${name}.`)
    names.add(name)

    const type = header[156] === 0 ? '0' : String.fromCharCode(header[156])
    if (!['0', '5'].includes(type)) throw new Error(`Unsupported package tar entry type ${type} at ${name}.`)
    const mode = tarNumber(header.subarray(100, 108)) & 0o777
    const size = tarNumber(header.subarray(124, 136))
    const contentStart = offset + 512
    const contentEnd = contentStart + size
    if (!Number.isSafeInteger(size) || contentEnd > archive.length) throw new Error(`Invalid package tar size at ${name}.`)
    if (type === '5' && size !== 0) throw new Error(`Package directory ${name} contains unexpected data.`)
    const content = archive.subarray(contentStart, contentEnd)
    entries.push({ name, type, mode, size, sha256: createHash('sha256').update(content).digest('hex') })
    if (entries.length > 10_000) throw new Error('Package tar archive contains too many entries.')
    offset = contentStart + Math.ceil(size / 512) * 512
  }
  if (!terminated) throw new Error('Package tar archive has no terminator.')
  return entries.sort((left, right) => left.name.localeCompare(right.name))
}

function tarText(field) {
  return field.toString('utf8').replace(/\0.*$/s, '')
}

function tarNumber(field) {
  if (field[0] & 0x80) throw new Error('Base-256 package tar numbers are not supported.')
  const value = tarText(field).trim()
  if (!/^[0-7]+$/.test(value)) throw new Error(`Invalid package tar number: ${value || '<empty>'}.`)
  return Number.parseInt(value, 8)
}

function headerChecksum(header) {
  let checksum = 0
  for (let index = 0; index < header.length; index += 1) checksum += index >= 148 && index < 156 ? 32 : header[index]
  return checksum
}

async function pack(root, destination, room) {
  const { stdout } = await exec('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', destination, ...room], {
    cwd: root,
    maxBuffer: 20 * 1024 * 1024,
  })
  return JSON.parse(stdout)[0]
}
