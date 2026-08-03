import { lstat, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { EndroitError } from '../lib/errors.mjs'
import { digest } from '../lib/io.mjs'
import { V9_API, readDocument, readSourceText, validateLegacyDocument } from '../documents.mjs'

export async function loadLegacyWorkplace(root) {
  const declarationPath = join(root, 'endroit.json')
  await assertRegularFile(declarationPath)
  const { value: legacy, bytes } = await readLegacyJson(declarationPath)
  if (Object.hasOwn(legacy, 'mode')) {
    throw new EndroitError('legacy_mode_unsupported', 'Endroit 0.10 cannot normalize a solo/team declaration.', { exitCode: 3 })
  }
  await validateLegacyDocument(legacy, 'home')
  const member = await inferOwner(root)
  const homePath = join(root, 'HOME.md')
  const body = await readSourceText(homePath)
  const metadata = {
    $schema: V9_API.workplace,
    kind: 'endroit/workplace',
    id: legacy.name,
    owner: `member:${member}`,
    profile: 'endroit/legacy-v7',
    protocol: 'open-workplace/0.1',
    runtime: legacy.runtime,
    providers: legacy.providers,
  }
  return {
    ...metadata,
    status: 'degraded',
    format: 'legacy-v7',
    legacy: true,
    root,
    path: 'endroit.json',
    metadata,
    body,
    sections: [],
    fragments: [],
    source_digest: digest(Buffer.concat([bytes, Buffer.from(body)])),
    legacy_document: legacy,
  }
}

export async function loadLegacyMember(root, id) {
  const path = join(root, 'members', id, 'MEMBER.md')
  const document = await readDocument(path)
  await validateLegacyDocument(document.metadata, 'member')
  if (document.metadata.id !== id) throw new EndroitError('member_identity_mismatch', `${path} declares Member ${document.metadata.id}, expected ${id}.`)
  return {
    $schema: V9_API.member,
    kind: 'endroit/member',
    id,
    owner: `member:${id}`,
    name: document.metadata.name,
    membership_state: document.metadata.status,
    accounts: document.metadata.accounts,
    body: document.body,
    sections: document.sections,
    fragments: document.fragments,
    source_digest: document.source_digest,
    path: `members/${id}/MEMBER.md`,
    legacy: true,
    legacy_document: document.metadata,
  }
}

export async function loadLegacyDesk(root) {
  const path = join(root, '.desk', 'desk.json')
  const { value } = await readLegacyJson(path)
  await validateLegacyDocument(value, 'desk')
  return {
    $schema: V9_API.desk,
    kind: 'endroit/desk',
    id: value.id,
    owner: `member:${value.member}`,
    member: value.member,
    desk_state: 'active',
    settings: value.settings ?? {},
    path: '.desk/desk.json',
    legacy: true,
    legacy_document: value,
    source_digest: digest(JSON.stringify(value)),
  }
}

async function inferOwner(root) {
  const membersRoot = join(root, 'members')
  const entries = await readdir(membersRoot, { withFileTypes: true }).catch((error) => error.code === 'ENOENT' ? [] : Promise.reject(error))
  const ids = entries.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink()).map((entry) => entry.name).sort()
  if (ids.includes('owner')) return 'owner'
  if (ids.length === 1) return ids[0]
  throw new EndroitError('workplace_owner_ambiguous', `${root}/endroit.json cannot resolve one legacy Member owner.`)
}

async function assertRegularFile(path) {
  let info
  try { info = await lstat(path) }
  catch (error) {
    if (error.code === 'ENOENT') throw new EndroitError('legacy_workplace_missing', `${path} does not exist.`)
    throw error
  }
  if (info.isSymbolicLink()) throw new EndroitError('document_symlink', `${path} must not be a symbolic link.`)
  if (!info.isFile()) throw new EndroitError('document_type', `${path} must be a regular file.`)
}

async function readLegacyJson(path) {
  await assertRegularFile(path)
  const bytes = await readFile(path)
  try {
    return { value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), bytes }
  } catch (error) {
    if (error instanceof SyntaxError) throw new EndroitError('legacy_document_invalid', `Invalid JSON at ${path}.`, { cause: error })
    if (error instanceof TypeError) throw new EndroitError('document_encoding', `${path} must be valid UTF-8.`, { cause: error })
    throw error
  }
}
