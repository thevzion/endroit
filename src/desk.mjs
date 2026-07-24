import { mkdir, readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { API, validateDocument } from './contracts.mjs'
import { git, gitEvidence } from './git.mjs'
import { loadHome } from './home.mjs'
import { HairnessError } from './lib/errors.mjs'
import { assertId, exists, readJson, writeFileAtomic, writeJsonAtomic } from './lib/io.mjs'

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
  if (await exists(join(directory, 'desk.json'))) throw new HairnessError('desk_exists', 'This Home already has a Desk.')
  await mkdir(directory, { recursive: true })
  try {
    if (home.mode === 'team' && options.git !== false) await git(['init', '--quiet', '--initial-branch=main'], { cwd: directory })
    await writeJsonAtomic(join(directory, 'desk.json'), deskDocument(options.id), 0o600)
    await writeFileAtomic(join(directory, '.gitignore'), '/targets/\n/.DS_Store\n', 0o644)
    return { status: 'initialized', id: options.id, repository: home.mode === 'team' && options.git !== false }
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
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
    return { status: 'cloned', id: desk.id, repository }
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }
}

export async function deskStatus(root) {
  const home = await loadHome(root)
  const desk = await loadDesk(root)
  if (!desk) return { status: 'missing', mode: home.mode }
  const repository = await exists(join(root, '.desk', '.git'))
  return {
    status: 'ready',
    mode: home.mode,
    id: desk.id,
    repository,
    ...(repository ? { git: await gitEvidence(resolve(root, '.desk')) } : {}),
  }
}

export function deskDocument(id = 'local') {
  return {
    $schema: API.desk,
    id: assertId(id, 'Desk id'),
  }
}
