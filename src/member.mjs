import { lstat, mkdir, mkdtemp, readFile, readdir, rename } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { V9_API, readDocument, validateDocumentV9 } from './documents.mjs'
import { loadLegacyMember } from './legacy/workplace.mjs'
import { EndroitError } from './lib/errors.mjs'
import { assertId, exists, removeTree, writeFileAtomic } from './lib/io.mjs'

const templatePath = new URL('../templates/MEMBER.md', import.meta.url)

export async function createMember(root, id, options = {}) {
  id = assertId(id, 'Member id')
  const membersRoot = join(root, 'members')
  const directory = join(membersRoot, id)
  if (await exists(directory)) throw new EndroitError('member_exists', `Member ${id} already exists.`)
  if (await exists(membersRoot)) {
    const info = await lstat(membersRoot)
    if (info.isSymbolicLink() || !info.isDirectory()) throw new EndroitError('members_root_invalid', `${membersRoot} must be a regular directory.`)
  } else await mkdir(membersRoot, { recursive: true })
  const member = {
    $schema: V9_API.member,
    kind: 'endroit/member',
    id,
    owner: `member:${id}`,
    name: String(options.name ?? title(id)).trim(),
    membership_state: options.membership_state ?? options.status ?? 'active',
    accounts: options.accounts ?? [],
  }
  await validateDocumentV9(member, 'member')
  const template = await readFile(templatePath, 'utf8')
  const values = {
    'member.id': JSON.stringify(member.id),
    'member.owner': JSON.stringify(member.owner),
    'member.name': JSON.stringify(member.name),
    'member.status': JSON.stringify(member.membership_state),
    'member.accounts': JSON.stringify(member.accounts),
  }
  const content = template.replace(/\{\{([^{}]+)\}\}/g, (_match, key) => {
    if (!(key in values)) throw new EndroitError('member_template_invalid', `Unknown Member template value ${key}.`)
    return values[key]
  })
  const stage = await mkdtemp(join(membersRoot, '.endroit-member-'))
  try {
    await writeFileAtomic(join(stage, 'MEMBER.md'), content, 0o644)
    await rename(stage, directory)
  } catch (error) {
    await removeTree(stage, { force: true })
    throw error
  }
  return { status: 'created', ...member, path: relative(root, join(directory, 'MEMBER.md')) }
}

export async function loadMember(root, id) {
  id = assertId(id, 'Member id')
  const path = join(root, 'members', id, 'MEMBER.md')
  let document
  try { document = await readDocument(path) }
  catch (error) {
    if (error.code === 'document_missing') throw new EndroitError('member_missing', `Member ${id} does not exist in this Workplace.`)
    throw error
  }
  if (document.metadata.$schema !== V9_API.member) return loadLegacyMember(root, id)
  await validateDocumentV9(document.metadata, 'member')
  if (document.metadata.id !== id) throw new EndroitError('member_identity_mismatch', `${path} declares Member ${document.metadata.id}, expected ${id}.`)
  if (document.metadata.owner !== `member:${id}`) throw new EndroitError('member_owner_mismatch', `${path} must be owned by member:${id}.`)
  if (!document.body.trim()) throw new EndroitError('member_invalid', `${path} must contain collaboration context.`)
  return {
    ...document.metadata,
    body: document.body,
    sections: document.sections,
    fragments: document.fragments,
    source_digest: document.source_digest,
    path: relative(root, path),
    legacy: false,
  }
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

function withoutBody({ body, sections, fragments, ...member }) { return member }
function title(id) { return id.split(/[-_.]+/).map((part) => part ? part[0].toUpperCase() + part.slice(1) : part).join(' ') }
