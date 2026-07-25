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
import { exists, writeFileAtomic, writeJsonAtomic } from './lib/io.mjs'

const bootstrapAssets = ['@hairness/onboarding', '@hairness/hud', '@hairness/artifacts', '@hairness/targets']

export async function createHome(destination, options = {}) {
  const target = resolve(destination)
  if (await exists(target)) throw new HairnessError('destination_exists', `Destination already exists: ${target}.`)
  await mkdir(dirname(target), { recursive: true })
  const stage = await mkdtemp(join(dirname(target), '.hairness-create-'))
  try {
    await git(['init', '--quiet', '--initial-branch=main'], { cwd: stage })
    await initHome(stage, { ...options, name: options.name ?? homeId(target) })
    const result = await addAssets(stage, bootstrapAssets)
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
  const instructionPath = join(root, HOME_INSTRUCTION)
  const deskPath = join(root, '.desk')
  const ignoreExisted = await exists(ignorePath)
  const currentIgnore = ignoreExisted ? await readFile(ignorePath, 'utf8') : ''
  if (await exists(instructionPath)) throw new HairnessError('home_instruction_exists', `${instructionPath} already exists.`)
  if (await exists(deskPath)) throw new HairnessError('desk_exists', `${deskPath} already exists.`)
  try {
    const home = homeDocument({ destination: root, name: options.name, providers: options.providers, mode, prefix: options.prefix })
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
    await rm(deskPath, { recursive: true, force: true })
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
