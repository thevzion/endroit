import { mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { addAssets } from './assets.mjs'
import { buildHome } from './build.mjs'
import { initDesk } from './desk.mjs'
import { doctorHome } from './doctor.mjs'
import { git } from './git.mjs'
import { homeDocument, homeId } from './home.mjs'
import { HOME_INSTRUCTION, renderInstructionTemplate } from './instructions.mjs'
import { HairnessError } from './lib/errors.mjs'
import { exists, removeTree, writeFileAtomic, writeJsonAtomic } from './lib/io.mjs'

export const bootstrapAssets = ['@hairness/onboarding', '@hairness/hud', '@hairness/artifacts', '@hairness/targets', '@hairness/workspaces']

export async function createHome(destination, options = {}) {
  const target = resolve(destination)
  if (await exists(target)) throw new HairnessError('destination_exists', `Destination already exists: ${target}.`)
  await mkdir(dirname(target), { recursive: true })
  const stage = await mkdtemp(join(dirname(target), '.hairness-create-'))
  try {
    await git(['init', '--quiet', '--initial-branch=main'], { cwd: stage })
    await initHome(stage, {
      ...options,
      name: options.name ?? homeId(target),
      frontDoor: { wakeUp: 'hairness/hud:prompt' },
    })
    const result = await addAssets(stage, [...bootstrapAssets, ...(options.assets ?? [])])
    await bootstrapHomeWorkspace(stage)
    await buildHome(stage)
    const doctor = await doctorHome(stage)
    if (doctor.status !== 'ready') throw new HairnessError('create_qualification_failed', `Created Home is ${doctor.status}: ${doctor.limits.join(', ')}.`)
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
    await removeTree(stage, { force: true })
    throw error
  }
}

async function bootstrapHomeWorkspace(root) {
  const workspaceRoot = join(root, 'workspaces', 'home')
  const assetRoot = join(root, 'assets', 'hairness', 'workspaces')
  const timestamp = new Date().toISOString()
  const home = JSON.parse(await readFile(join(root, 'hairness.json'), 'utf8'))
  const values = {
    id: 'home',
    scope: 'home',
    timestamp,
    title: 'Home',
    summary: `Improve and maintain ${home.name}.`,
  }
  await mkdir(workspaceRoot, { recursive: true })
  for (const file of ['workspace.md', 'inbox.md']) {
    const template = await readFile(join(assetRoot, 'templates', file), 'utf8')
    const content = template.replace(/\{\{([a-z_]+)\}\}/g, (_match, key) => {
      if (!(key in values)) throw new HairnessError('workspace_template_invalid', `Unknown Workspace template value ${key}.`)
      return String(values[key]).replaceAll('"', '\\"')
    })
    await writeFileAtomic(join(workspaceRoot, file), content, 0o644)
  }
}

export async function initHome(root = process.cwd(), options = {}) {
  root = resolve(root)
  await mkdir(root, { recursive: true })
  if (await exists(join(root, 'hairness.json'))) throw new HairnessError('home_exists', `${root} already contains hairness.json.`)
  const mode = options.mode ?? 'solo'
  const ignorePath = join(root, '.gitignore')
  const instructionPath = join(root, HOME_INSTRUCTION)
  const deskPath = join(root, '.desk')
  const ignoreExisted = await exists(ignorePath)
  const currentIgnore = ignoreExisted ? await readFile(ignorePath, 'utf8') : ''
  if (await exists(instructionPath)) throw new HairnessError('home_instruction_exists', `${instructionPath} already exists.`)
  if (await exists(deskPath)) throw new HairnessError('desk_exists', `${deskPath} already exists.`)
  try {
    const home = homeDocument({
      destination: root,
      name: options.name,
      emoji: options.emoji,
      providers: options.providers,
      mode,
      prefix: options.prefix,
      frontDoor: options.frontDoor,
    })
    await writeJsonAtomic(join(root, 'hairness.json'), home, 0o644)
    await writeFileAtomic(instructionPath, await renderInstructionTemplate('home', {
      'home.name': home.name,
      'home.mode': home.mode,
    }), 0o644)
    const required = ['/.hairness/', mode === 'team' ? '/.desk/' : '/.desk/targets/', '/.DS_Store']
    const lines = currentIgnore.split(/\r?\n/)
    const missing = required.filter((line) => !lines.includes(line))
    if (missing.length) await writeFileAtomic(ignorePath, `${currentIgnore.trimEnd()}${currentIgnore.trim() ? '\n' : ''}${missing.join('\n')}\n`, 0o644)
    if (mode === 'solo') await initDesk(root, { id: options.deskId ?? 'local', git: false })
    return { status: 'initialized', home: root, mode, providers: home.providers, assets: [] }
  } catch (error) {
    await rm(join(root, 'hairness.json'), { force: true })
    await rm(instructionPath, { force: true })
    await removeTree(deskPath, { force: true })
    if (ignoreExisted) await writeFileAtomic(ignorePath, currentIgnore, 0o644)
    else await rm(ignorePath, { force: true })
    throw error
  }
}

export function launchInstructions(home, providers) {
  return providers.map((provider) => provider === 'codex'
    ? { provider, command: `codex -C ${quote(home)}`, onboarding: '$hairness-onboarding' }
    : { provider, command: `cd ${quote(home)} && claude`, onboarding: '/hairness-onboarding' })
}

function quote(value) {
  return `"${String(value).replaceAll('"', '\\"')}"`
}
