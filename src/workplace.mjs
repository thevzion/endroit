import { lstat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { EndroitError } from './lib/errors.mjs'
import { extractSection, inspectDocumentDeclaration, readDocument, validateDocumentV9 } from './documents.mjs'
import { loadLegacyWorkplace } from './legacy/workplace.mjs'

const requiredSections = ['Purpose', 'Constitution', 'Boundaries', 'Limits']

export async function findWorkplace(start = process.env.ENDROIT_WORKPLACE_PATH ?? process.env.ENDROIT_HOME_PATH ?? process.cwd()) {
  let current = resolve(start)
  while (true) {
    const candidate = await inspectCandidate(current)
    if (candidate === 'v9') {
      await loadWorkplace(current)
      return current
    }
    if (candidate === 'legacy') {
      await loadLegacyWorkplace(current)
      return current
    }
    const parent = dirname(current)
    if (parent === current) throw new EndroitError('workplace_not_found', 'No marked WORKPLACE.md or legacy endroit.json found from the current directory.')
    current = parent
  }
}

export async function loadWorkplace(root) {
  root = resolve(root ?? await findWorkplace())
  const candidate = await inspectCandidate(root)
  if (candidate === 'legacy') return loadLegacyWorkplace(root)
  if (candidate !== 'v9') throw new EndroitError('workplace_not_found', `${root} does not declare an Endroit Workplace.`)

  const path = join(root, 'WORKPLACE.md')
  const document = await readDocument(path)
  await validateDocumentV9(document.metadata, 'workplace')
  for (const heading of requiredSections) {
    const section = extractSection(document, heading)
    if (!section?.body.trim()) throw new EndroitError('workplace_section_missing', `${path} requires a non-empty ${heading} section.`)
  }
  await resolveOwner(root, document.metadata.owner)
  return {
    ...document.metadata,
    status: 'resolved',
    format: 'v9',
    legacy: false,
    root,
    path: 'WORKPLACE.md',
    metadata: document.metadata,
    body: document.body,
    sections: document.sections,
    fragments: document.fragments,
    source_digest: document.source_digest,
  }
}

export const resolveWorkplaceDeclaration = loadWorkplace

async function inspectCandidate(root) {
  const workplacePath = join(root, 'WORKPLACE.md')
  const legacyPath = join(root, 'endroit.json')
  const workplaceInfo = await safeLstat(workplacePath)
  const legacyInfo = await safeLstat(legacyPath)

  if (workplaceInfo?.isSymbolicLink()) throw new EndroitError('document_symlink', `${workplacePath} must not be a symbolic link.`)
  if (legacyInfo?.isSymbolicLink()) throw new EndroitError('document_symlink', `${legacyPath} must not be a symbolic link.`)
  if (legacyInfo && !legacyInfo.isFile()) throw new EndroitError('document_type', `${legacyPath} must be a regular file.`)

  const marked = Boolean(await inspectDocumentDeclaration(workplacePath, 'workplace'))
  if (marked && legacyInfo) throw new EndroitError('ambiguous_sources', `${root} contains both WORKPLACE.md and legacy endroit.json declarations.`)
  if (marked) return 'v9'
  if (legacyInfo) return 'legacy'
  return null
}

async function resolveOwner(root, owner) {
  const match = String(owner).match(/^member:([a-z0-9][a-z0-9._-]{0,127})$/)
  if (!match) throw new EndroitError('workplace_owner_invalid', `${owner} must reference one Member.`)
  const path = join(root, 'members', match[1], 'MEMBER.md')
  let document
  try { document = await readDocument(path) }
  catch (error) {
    if (error.code === 'document_missing') throw new EndroitError('workplace_owner_missing', `${owner} does not resolve to ${path}.`)
    throw error
  }
  await validateDocumentV9(document.metadata, 'member')
  if (document.metadata.id !== match[1] || document.metadata.owner !== owner) {
    throw new EndroitError('workplace_owner_mismatch', `${path} does not identify ${owner}.`)
  }
  if (!document.body.trim()) throw new EndroitError('member_invalid', `${path} must contain collaboration context.`)
  return document
}

async function safeLstat(path) {
  try { return await lstat(path) }
  catch (error) { if (error.code === 'ENOENT') return null; throw error }
}
