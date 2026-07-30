import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'
import { EndroitError } from './errors.mjs'

export function digest(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(typeof value === 'string' ? value : JSON.stringify(value))
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

export async function exists(path) {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

export function removeTree(path, options = {}) {
  return rm(path, { recursive: true, maxRetries: 3, retryDelay: 100, ...options })
}

export async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT' && fallback !== undefined) return fallback
    if (error instanceof SyntaxError) throw new EndroitError('invalid_json', `Invalid JSON at ${path}.`, { cause: error })
    throw error
  }
}

export async function writeJsonAtomic(path, value, mode = 0o600) {
  await writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`, mode)
}

export async function writeFileAtomic(path, value, mode = 0o600) {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(temporary, value, { mode })
  await rename(temporary, path)
}

export function assertId(value, label = 'id') {
  if (!/^[a-z0-9][a-z0-9._/-]{0,127}$/.test(String(value ?? '')) || String(value).includes('..')) {
    throw new EndroitError('invalid_id', `Invalid ${label}: ${value}`)
  }
  return value
}

export function assertInside(root, candidate, label = 'path') {
  const base = resolve(root)
  const target = resolve(candidate)
  const rel = relative(base, target)
  if (rel === '..' || rel.startsWith(`..${sep}`)) throw new EndroitError('path_escape', `${label} escapes ${base}.`)
  return target
}

export async function resolvePackageFile(root, path, label = 'package path') {
  const base = await realpath(root)
  const target = assertInside(base, resolve(base, path), label)
  const stat = await lstat(target)
  if (stat.isSymbolicLink()) throw new EndroitError('symlink_forbidden', `${label} must not be a symbolic link.`)
  const resolved = await realpath(target)
  assertInside(base, resolved, label)
  return resolved
}
