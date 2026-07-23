import { mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { addAssets } from './assets.mjs'
import { buildHome } from './build.mjs'
import { doctorHome } from './doctor.mjs'
import { git } from './git.mjs'
import { deskDocument, homeDocument, homeId, loadDesk, loadHome } from './home.mjs'
import { HairnessError } from './lib/errors.mjs'
import { exists, writeFileAtomic, writeJsonAtomic } from './lib/io.mjs'

export async function createHome(destination, options = {}) {
  const target = resolve(destination)
  if (await exists(target)) throw new HairnessError('destination_exists', `Destination already exists: ${target}.`)
  await mkdir(dirname(target), { recursive: true })
  const stage = await mkdtemp(join(dirname(target), '.hairness-create-'))
  try {
    await git(['init', '--quiet', '--initial-branch=main'], { cwd: stage })
    await initHome(stage, { ...options, name: options.name ?? homeId(target) })
    const addresses = ['@hairness/home', '@hairness/targets', ...(options.baseAsset ? [options.baseAsset] : [])]
    const result = await addAssets(stage, addresses)
    await buildHome(stage)
    const doctor = await doctorHome(stage)
    const blocking = doctor.errors ?? []
    if (blocking.length) throw new HairnessError('create_qualification_failed', `Created Home is not ready: ${blocking.join(', ')}.`)
    await git(['add', '--all'], { cwd: stage })
    await git(['-c', 'user.name=Hairness', '-c', 'user.email=local@hairness.dev', 'commit', '--quiet', '-m', 'chore: initialize Hairness Home'], { cwd: stage })
    if (await git(['remote'], { cwd: stage })) throw new HairnessError('home_remote_forbidden', 'Home creation must not configure a remote.')
    await rename(stage, target)
    return {
      status: 'created',
      home: target,
      mode: options.mode ?? 'solo',
      assets: result.assets,
      launch: launchInstructions(target, options.providers ?? ['codex', 'claude']),
    }
  } catch (error) {
    await rm(stage, { recursive: true, force: true })
    throw error
  }
}

export async function initHome(root = process.cwd(), options = {}) {
  root = resolve(root)
  await mkdir(root, { recursive: true })
  if (await exists(join(root, 'hairness.json'))) throw new HairnessError('home_exists', `${root} already contains hairness.json.`)
  const mode = options.mode ?? 'solo'
  const ignorePath = join(root, '.gitignore')
  const ignoreExisted = await exists(ignorePath)
  const currentIgnore = ignoreExisted ? await readFile(ignorePath, 'utf8') : ''
  try {
    await writeJsonAtomic(join(root, 'hairness.json'), homeDocument({
      destination: root,
      name: options.name,
      mode,
      providers: options.providers,
      projection: options.projection,
    }), 0o644)
    const required = ['.hairness/', '.DS_Store', ...(mode === 'team' ? ['.desk/'] : [])]
    const missing = required.filter((line) => !currentIgnore.split(/\r?\n/).includes(line))
    if (missing.length) await writeFileAtomic(ignorePath, `${currentIgnore.trimEnd()}${currentIgnore.trim() ? '\n' : ''}${missing.join('\n')}\n`, 0o644)
    if (mode === 'solo') await initDesk(root, { id: options.deskId ?? 'owner' })
    return { status: 'initialized', home: root, mode, providers: options.providers ?? ['codex', 'claude'], assets: [] }
  } catch (error) {
    await rm(join(root, 'hairness.json'), { force: true })
    await rm(join(root, '.desk'), { recursive: true, force: true })
    if (ignoreExisted) await writeFileAtomic(ignorePath, currentIgnore, 0o644)
    else await rm(ignorePath, { force: true })
    throw error
  }
}

export async function initDesk(root, options = {}) {
  const home = await loadHome(root)
  if (await loadDesk(root)) throw new HairnessError('desk_exists', `${root} already has an active Desk.`)
  const directory = join(root, '.desk')
  await mkdir(directory, { recursive: true })
  await writeJsonAtomic(join(directory, 'desk.json'), deskDocument({ id: options.id, settings: options.settings }), 0o644)
  await writeFileAtomic(join(directory, '.gitignore'), '/targets/\n', 0o644)
  if (home.mode === 'team' && options.git !== false) await git(['init', '--quiet', '--initial-branch=main'], { cwd: directory })
  return { status: 'initialized', id: options.id ?? 'owner', mode: home.mode, repository: home.mode === 'team' && options.git !== false }
}

export async function cloneDesk(root, repository) {
  const home = await loadHome(root)
  if (home.mode !== 'team') throw new HairnessError('desk_mode_invalid', 'Only a team Home can clone an independent Desk repository.')
  if (await loadDesk(root)) throw new HairnessError('desk_exists', `${root} already has an active Desk.`)
  const directory = join(root, '.desk')
  try {
    await git(['clone', '--quiet', '--', repository, directory], { cwd: root })
    const desk = await loadDesk(root, { required: true })
    await writeFileAtomic(join(directory, '.gitignore'), ensureLine(await readFile(join(directory, '.gitignore'), 'utf8').catch((error) => error.code === 'ENOENT' ? '' : Promise.reject(error)), '/targets/'), 0o644)
    return { status: 'cloned', id: desk.id, mode: home.mode, repository }
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }
}

export async function deskStatus(root) {
  const home = await loadHome(root)
  const desk = await loadDesk(root)
  return { mode: home.mode, present: Boolean(desk), desk }
}

function ensureLine(content, line) {
  if (content.split(/\r?\n/).includes(line)) return content
  return `${content.trimEnd()}${content.trim() ? '\n' : ''}${line}\n`
}

export function launchInstructions(home, providers, targets = []) {
  const addDirs = targets.map((path) => ` --add-dir ${quote(path)}`).join('')
  return providers.flatMap((provider) => provider === 'codex'
    ? [{ provider, command: `codex -C ${quote(home)}${addDirs}`, onboarding: '$hairness-onboarding' }]
    : [{ provider, command: `cd ${quote(home)} && claude${addDirs}`, onboarding: '/hairness-onboarding' }])
}

function quote(value) {
  return `"${String(value).replaceAll('"', '\\"')}"`
}
