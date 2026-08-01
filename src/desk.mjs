import { mkdir, readFile, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { API, validateDocument } from './contracts.mjs'
import { git } from './git.mjs'
import { loadHome } from './home.mjs'
import { DESK_INSTRUCTION, readInstructionFile, renderInstructionTemplate } from './instructions.mjs'
import { EndroitError } from './lib/errors.mjs'
import { assertId, exists, readJson, removeTree, writeFileAtomic, writeJsonAtomic } from './lib/io.mjs'
import { loadMember } from './member.mjs'

export async function loadDesk(root) {
  const path = join(root, '.desk', 'desk.json')
  if (!await exists(path)) return null
  const desk = await validateDocument(await readJson(path), 'desk')
  await loadMember(root, desk.member)
  desk.settings ??= {}
  return desk
}

export async function initDesk(root, options = {}) {
  const home = await loadHome(root)
  const directory = join(root, '.desk')
  if (await exists(directory)) throw new EndroitError('desk_exists', 'This Home already has a Desk directory.')
  const member = options.member ?? 'owner'
  await loadMember(root, member)
  const repository = options.repository ?? 'separate'
  if (!['tracked', 'separate'].includes(repository)) throw new EndroitError('desk_strategy_invalid', 'Desk strategy must be tracked or separate.', { exitCode: 2 })
  const previousIgnore = await readFile(join(root, '.gitignore'), 'utf8').catch((error) => error.code === 'ENOENT' ? '' : Promise.reject(error))
  await mkdir(directory, { recursive: true })
  try {
    if (repository === 'separate') await git(['init', '--quiet', '--initial-branch=main'], { cwd: directory })
    const document = deskDocument(options.id, member)
    await writeJsonAtomic(join(directory, 'desk.json'), document, 0o600)
    await writeFileAtomic(join(directory, DESK_INSTRUCTION), await renderInstructionTemplate('desk', {
      'desk.id': document.id,
      'desk.member': document.member,
      'home.name': home.name,
    }), 0o644)
    await writeFileAtomic(join(directory, '.gitignore'), '/routes/\n/sites/\n/.DS_Store\n', 0o644)
    await configureParentIgnore(root, repository, previousIgnore)
    return { status: 'initialized', id: document.id, member, repository: await deskGitBoundary(root) }
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
    if (!desk) throw new EndroitError('desk_invalid', 'The cloned repository does not contain desk.json.')
    await readInstructionFile(join(directory, DESK_INSTRUCTION), 'desk_instruction')
    await configureParentIgnore(root, 'separate')
    return { status: 'cloned', id: desk.id, member: desk.member, source: repository, repository: await deskGitBoundary(root) }
  } catch (error) {
    await removeTree(directory, { force: true })
    await writeFileAtomic(ignorePath, previousIgnore, 0o644)
    throw error
  }
}

export function deskDocument(id = 'local', member = 'owner') {
  return {
    $schema: API.desk,
    id: assertId(id, 'Desk id'),
    member: assertId(member, 'Member id'),
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
  const deskRules = new Set(['/.desk/', '/.desk/routes/', '/.desk/sites/'])
  const lines = content.split(/\r?\n/).filter((line) => !deskRules.has(line))
  const required = strategy === 'separate' ? ['/.desk/'] : ['/.desk/routes/', '/.desk/sites/']
  await writeFileAtomic(path, `${[...lines.filter(Boolean), ...required].join('\n')}\n`, 0o644)
}
