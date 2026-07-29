import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { API, validateDocument } from './contracts.mjs'
import { git } from './git.mjs'
import { loadHome } from './home.mjs'
import { DESK_INSTRUCTION, readInstructionFile, renderInstructionTemplate } from './instructions.mjs'
import { HairnessError } from './lib/errors.mjs'
import { assertId, exists, readJson, removeTree, writeFileAtomic, writeJsonAtomic } from './lib/io.mjs'

export async function loadDesk(root) {
  const path = join(root, '.desk', 'desk.json')
  if (!await exists(path)) return null
  const desk = await validateDocument(await readJson(path), 'desk')
  desk.settings ??= {}
  return desk
}

export async function initDesk(root, options = {}) {
  const home = await loadHome(root)
  const directory = join(root, '.desk')
  if (await exists(directory)) throw new HairnessError('desk_exists', 'This Home already has a Desk directory.')
  await mkdir(directory, { recursive: true })
  try {
    if (home.mode === 'team' && options.git !== false) await git(['init', '--quiet', '--initial-branch=main'], { cwd: directory })
    const document = deskDocument(options.id)
    await writeJsonAtomic(join(directory, 'desk.json'), document, 0o600)
    await writeFileAtomic(join(directory, DESK_INSTRUCTION), await renderInstructionTemplate('desk', {
      'desk.id': document.id,
      'home.name': home.name,
    }), 0o644)
    await writeFileAtomic(join(directory, '.gitignore'), '/targets/\n/.DS_Store\n', 0o644)
    return { status: 'initialized', id: options.id, repository: home.mode === 'team' && options.git !== false }
  } catch (error) {
    await removeTree(directory, { force: true })
    throw error
  }
}

export async function cloneDesk(root, repository) {
  const home = await loadHome(root)
  if (home.mode !== 'team') throw new HairnessError('desk_mode_invalid', 'A separate Desk repository is supported only by team Homes.')
  const directory = join(root, '.desk')
  if (await exists(directory)) throw new HairnessError('desk_exists', 'Remove or move the existing .desk before cloning.')
  await git(['clone', '--quiet', '--', repository, directory], { cwd: root })
  try {
    const desk = await loadDesk(root)
    if (!desk) throw new HairnessError('desk_invalid', 'The cloned repository does not contain desk.json.')
    await readInstructionFile(join(directory, DESK_INSTRUCTION), 'desk_instruction')
    return { status: 'cloned', id: desk.id, repository }
  } catch (error) {
    await removeTree(directory, { force: true })
    throw error
  }
}

export function deskDocument(id = 'local') {
  return {
    $schema: API.desk,
    id: assertId(id, 'Desk id'),
  }
}
