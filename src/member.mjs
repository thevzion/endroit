import { lstat, mkdir, readFile, readdir } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { API, validateDocument } from './contracts.mjs'
import { EndroitError } from './lib/errors.mjs'
import { assertId, exists, writeFileAtomic } from './lib/io.mjs'

const templatePath = new URL('../templates/MEMBER.md', import.meta.url)

export async function createMember(root, id, options = {}) {
  id = assertId(id, 'Member id')
  const directory = join(root, 'members', id)
  if (await exists(directory)) throw new EndroitError('member_exists', `Member ${id} already exists.`)
  const member = {
    $schema: API.member,
    id,
    name: String(options.name ?? title(id)).trim(),
    status: options.status ?? 'active',
    accounts: options.accounts ?? [],
  }
  await validateDocument(member, 'member')
  const template = await readFile(templatePath, 'utf8')
  const values = {
    'member.id': member.id,
    'member.name': member.name.replaceAll('"', '\\"'),
    'member.status': member.status,
    'member.accounts': JSON.stringify(member.accounts),
  }
  const content = template.replace(/\{\{([^{}]+)\}\}/g, (_match, key) => {
    if (!(key in values)) throw new EndroitError('member_template_invalid', `Unknown Member template value ${key}.`)
    return values[key]
  })
  await mkdir(directory, { recursive: true })
  await writeFileAtomic(join(directory, 'MEMBER.md'), content, 0o644)
  return { status: 'created', ...member, path: relative(root, join(directory, 'MEMBER.md')) }
}

export async function loadMember(root, id) {
  const path = join(root, 'members', assertId(id, 'Member id'), 'MEMBER.md')
  let info
  try { info = await lstat(path) }
  catch (error) {
    if (error.code === 'ENOENT') throw new EndroitError('member_missing', `Member ${id} does not exist in this Home.`)
    throw error
  }
  if (info.isSymbolicLink() || !info.isFile()) throw new EndroitError('member_invalid', `${path} must be a regular file.`)
  const { metadata, body } = parseMember(await readFile(path, 'utf8'), path)
  await validateDocument(metadata, 'member')
  if (metadata.id !== id) throw new EndroitError('member_identity_mismatch', `${path} declares Member ${metadata.id}, expected ${id}.`)
  if (!body.trim()) throw new EndroitError('member_invalid', `${path} must contain collaboration context.`)
  return { ...metadata, body, path: relative(root, path) }
}

export async function listMembers(root, options = {}) {
  const entries = await readdir(join(root, 'members'), { withFileTypes: true }).catch((error) => error.code === 'ENOENT' ? [] : Promise.reject(error))
  const members = []
  for (const entry of entries.filter((value) => value.isDirectory() && !value.isSymbolicLink()).sort((a, b) => a.name.localeCompare(b.name))) {
    try {
      const member = await loadMember(root, entry.name)
      members.push(options.body ? member : withoutBody(member))
    } catch (error) {
      members.push({ id: entry.name, path: `members/${entry.name}/MEMBER.md`, invalid: error.message })
    }
  }
  return members
}

export async function inspectMember(root, id) {
  return { status: 'inspected', ...await loadMember(root, id) }
}

export async function doctorMembers(root) {
  const members = await listMembers(root)
  const issues = members.filter((member) => member.invalid).map((member) => ({ code: 'member_invalid', member: member.id, message: member.invalid }))
  if (!members.length) issues.push({ code: 'member_missing' })
  return { status: issues.length ? 'partial' : 'ready', members, issues }
}

export function parseAccounts(values = []) {
  return values.map((value) => {
    const [service, scope, identifier, handle, ...extra] = String(value).split(':')
    if (!service || !scope || !identifier || extra.length) throw new EndroitError('account_invalid', `Invalid account ${value}; use service:scope:identifier[:handle].`, { exitCode: 2 })
    return { service, scope, identifier, ...(handle ? { handle } : {}) }
  })
}

function parseMember(content, path) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!match) throw new EndroitError('member_invalid', `${path} must start with frontmatter.`)
  const metadata = {}
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(':')
    if (separator < 1) throw new EndroitError('member_invalid', `Invalid frontmatter line in ${path}: ${line}`)
    const key = line.slice(0, separator).trim()
    const raw = line.slice(separator + 1).trim()
    try { metadata[key] = JSON.parse(raw) } catch { metadata[key] = raw.replace(/^"|"$/g, '') }
  }
  return { metadata, body: match[2] }
}

function withoutBody({ body, ...member }) { return member }
function title(id) { return id.split(/[-_.]+/).map((part) => part ? part[0].toUpperCase() + part.slice(1) : part).join(' ') }
