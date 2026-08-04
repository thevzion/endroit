import { lstat, mkdir, readFile, realpath } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { V9_API, inspectDocumentDeclaration, parseDocument, renderDocument, validateDocumentV9 } from './documents.mjs'
import { git } from './git.mjs'
import { loadHome } from './home.mjs'
import { DESK_INSTRUCTION, renderInstructionTemplate } from './instructions.mjs'
import { loadLegacyDesk } from './legacy/workplace.mjs'
import { EndroitError } from './lib/errors.mjs'
import { assertId, exists, removeTree, writeFileAtomic } from './lib/io.mjs'
import { loadMember } from './member.mjs'

export async function loadDesk(root) {
  const path = join(root, '.desk', DESK_INSTRUCTION)
  const legacyPath = join(root, '.desk', 'desk.json')
  const current = await inspectDocumentDeclaration(path, 'desk')
  const legacy = await exists(legacyPath)
  if (current && legacy) throw new EndroitError('ambiguous_sources', `${root}/.desk contains both DESK.md and legacy desk.json declarations.`)
  if (!current && !legacy) return null
  if (legacy) {
    const desk = await loadLegacyDesk(root)
    await loadMember(root, desk.member)
    return desk
  }
  await validateDocumentV9(current.metadata, 'desk')
  const member = current.metadata.owner.replace(/^member:/, '')
  await loadMember(root, member)
  if (!current.body.trim()) throw new EndroitError('desk_invalid', `${path} must contain collaboration context.`)
  return {
    ...current.metadata,
    member,
    settings: current.metadata.settings ?? {},
    body: current.body,
    sections: current.sections,
    fragments: current.fragments,
    source_digest: current.source_digest,
    path: relative(root, path),
    legacy: false,
  }
}

export async function initDesk(root, options = {}) {
  const workplace = await loadHome(root)
  if (workplace.legacy) {
    throw new EndroitError('legacy_source_read_only', 'Legacy Workplace declarations are read-only; migrate to WORKPLACE.md before initializing a v9 Desk.', { exitCode: 3 })
  }
  const directory = join(root, '.desk')
  if (await exists(directory)) throw new EndroitError('desk_exists', 'This Workplace already has a Desk directory.')
  const member = options.member ?? 'owner'
  await loadMember(root, member)
  const repository = options.repository ?? 'separate'
  if (!['tracked', 'separate'].includes(repository)) throw new EndroitError('desk_strategy_invalid', 'Desk strategy must be tracked or separate.', { exitCode: 2 })
  const previousIgnore = await readFile(join(root, '.gitignore'), 'utf8').catch((error) => error.code === 'ENOENT' ? '' : Promise.reject(error))
  await mkdir(directory, { recursive: true })
  try {
    if (repository === 'separate') await git(['init', '--quiet', '--initial-branch=main'], { cwd: directory })
    const document = deskDocument(options.id, member, options)
    await validateDocumentV9(document, 'desk')
    const template = parseDocument(await renderInstructionTemplate('desk', {
      'desk.id': document.id,
      'desk.member': member,
      'home.name': workplace.name,
    }), { path: 'templates/DESK.md' })
    await writeFileAtomic(join(directory, DESK_INSTRUCTION), renderDocument({ metadata: document, body: template.body }), 0o644)
    await writeFileAtomic(join(directory, '.gitignore'), '/routes/\n/.DS_Store\n', 0o644)
    await configureParentIgnore(root, repository, previousIgnore)
    return { status: 'initialized', ...document, member, repository: await deskGitBoundary(root) }
  } catch (error) {
    await removeTree(directory, { force: true })
    await writeFileAtomic(join(root, '.gitignore'), previousIgnore, 0o644)
    throw error
  }
}

export async function cloneDesk(root, repository) {
  await loadHome(root)
  const directory = join(root, '.desk')
  if (await exists(directory)) throw new EndroitError('desk_exists', 'Remove or move the existing .desk before cloning.')
  const ignorePath = join(root, '.gitignore')
  const previousIgnore = await readFile(ignorePath, 'utf8').catch((error) => error.code === 'ENOENT' ? '' : Promise.reject(error))
  await git(['clone', '--quiet', '--', repository, directory], { cwd: root })
  try {
    const desk = await loadDesk(root)
    if (!desk) throw new EndroitError('desk_invalid', 'The cloned repository does not contain DESK.md or a compatible legacy desk.json.')
    await configureParentIgnore(root, 'separate')
    return { status: 'cloned', id: desk.id, member: desk.member, source: repository, repository: await deskGitBoundary(root) }
  } catch (error) {
    await removeTree(directory, { force: true })
    await writeFileAtomic(ignorePath, previousIgnore, 0o644)
    throw error
  }
}

export function deskDocument(id = 'local', member = 'owner', options = {}) {
  return {
    $schema: V9_API.desk,
    kind: 'endroit/desk',
    id: assertId(id, 'Desk id'),
    owner: `member:${assertId(member, 'Member id')}`,
    desk_state: 'active',
    ...(options.address_as ? { address_as: options.address_as } : {}),
    ...(options.response_language ? { response_language: options.response_language } : {}),
    ...(options.settings && Object.keys(options.settings).length ? { settings: options.settings } : {}),
  }
}

export async function deskGitBoundary(root) {
  const deskRoot = await realpath(resolve(root, '.desk'))
  const gitRoot = await realpath(resolve(await git(['rev-parse', '--show-toplevel'], { cwd: deskRoot })))
  return gitRoot === deskRoot ? 'separate' : 'tracked'
}

async function configureParentIgnore(root, strategy, content) {
  const path = join(root, '.gitignore')
  content ??= await readFile(path, 'utf8').catch((error) => error.code === 'ENOENT' ? '' : Promise.reject(error))
  const deskRules = new Set(['/.desk/', '/.desk/routes/'])
  const lines = content.split(/\r?\n/).filter((line) => !deskRules.has(line))
  const required = strategy === 'separate' ? ['/.desk/'] : ['/.desk/routes/']
  const base = lines.join('\n').trimEnd()
  await writeFileAtomic(path, `${base}${base ? '\n' : ''}${required.join('\n')}\n`, 0o644)
}
