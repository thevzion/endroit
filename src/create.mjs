import { mkdir, mkdtemp, readFile, rename, rm, rmdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { addEquipment } from './equipment.mjs'
import { buildHome } from './build.mjs'
import { initDesk } from './desk.mjs'
import { doctorHome } from './doctor.mjs'
import { git } from './git.mjs'
import { homeDocument, homeId } from './home.mjs'
import { HOME_INSTRUCTION, renderInstructionTemplate } from './instructions.mjs'
import { EndroitError } from './lib/errors.mjs'
import { exists, removeTree, writeFileAtomic, writeJsonAtomic } from './lib/io.mjs'
import { createMember } from './member.mjs'
import { writeRoute, writeSite } from './sites.mjs'

export const bootstrapEquipment = ['@endroit/onboarding', '@endroit/hud', '@endroit/artifacts', '@endroit/sites', '@endroit/rooms', '@endroit/workplace', '@endroit/hygiene']

export async function createHome(destination, options = {}) {
  const site = resolve(destination)
  if (await exists(site)) throw new EndroitError('destination_exists', `Destination already exists: ${site}.`)
  await mkdir(dirname(site), { recursive: true })
  const stage = await mkdtemp(join(dirname(site), '.endroit-create-'))
  try {
    await git(['init', '--quiet', '--initial-branch=main'], { cwd: stage })
    await initHome(stage, {
      ...options,
      name: options.name ?? homeId(site),
      deskStrategy: options.deskStrategy ?? 'tracked',
      frontDoor: { wakeUp: 'endroit/hud:prompt' },
    })
    const result = await addEquipment(stage, [...bootstrapEquipment, ...(options.equipment ?? [])])
    await bootstrapHomeRoom(stage)
    await buildHome(stage)
    const doctor = await doctorHome(stage)
    if (doctor.status !== 'ready') throw new EndroitError('create_qualification_failed', `Created Home is ${doctor.status}: ${doctor.limits.join(', ')}.`)
    await git(['add', '--all'], { cwd: stage })
    await git(['-c', 'user.name=Endroit', '-c', 'user.email=local@endroit.org', 'commit', '--quiet', '-m', 'chore: initialize Endroit Home'], { cwd: stage })
    if (await git(['remote'], { cwd: stage })) throw new EndroitError('home_remote_forbidden', 'Home creation must not configure a remote.')
    await rename(stage, site)
    return {
      status: 'created',
      home: site,
      desk: options.deskStrategy ?? 'tracked',
      equipment: result.equipment,
      launch: launchInstructions(site, options.providers ?? ['codex', 'claude']),
    }
  } catch (error) {
    await removeTree(stage, { force: true })
    throw error
  }
}

async function bootstrapHomeRoom(root) {
  const roomRoot = join(root, 'rooms', 'home')
  const equipmentRoot = join(root, 'equipment', 'endroit', 'rooms')
  const timestamp = new Date().toISOString()
  const home = JSON.parse(await readFile(join(root, 'endroit.json'), 'utf8'))
  const values = {
    id: 'home',
    tag: 'home',
    scope: 'home',
    timestamp,
    title: 'Home',
    summary: `Improve and maintain ${home.name}.`,
  }
  if (await exists(roomRoot)) throw new EndroitError('home_room_exists', `${roomRoot} already exists.`)
  await mkdir(roomRoot, { recursive: true })
  for (const [templateName, file] of [['ROOM.md', 'ROOM.md'], ['inbox.md', 'inbox.md']]) {
    const template = await readFile(join(equipmentRoot, 'templates', templateName), 'utf8')
    const content = template.replace(/\{\{([a-z_]+)\}\}/g, (_match, key) => {
      if (!(key in values)) throw new EndroitError('room_template_invalid', `Unknown Room template value ${key}.`)
      return String(values[key]).replaceAll('"', '\\"')
    })
    await writeFileAtomic(join(roomRoot, file), content, 0o644)
  }
}

export async function initializeExistingHome(destination = process.cwd(), options = {}) {
  const root = resolve(destination)
  const deskStrategy = options.deskStrategy ?? 'separate'
  if (!await exists(join(root, '.git'))) throw new EndroitError('git_repository_required', 'endroit init requires an existing Git repository.')
  await initHome(root, {
    ...options,
    name: options.name ?? homeId(root),
    deskStrategy,
    frontDoor: { wakeUp: 'endroit/hud:prompt' },
  })
  try {
    const result = await addEquipment(root, [...bootstrapEquipment, ...(options.equipment ?? [])])
    await bootstrapHomeRoom(root)
    const site = await writeSite(root, {
      id: options.siteId ?? 'self',
      summary: 'The repository that contains this embedded Home.',
    })
    if (deskStrategy !== 'later') {
      await writeRoute(root, join(root, '.desk'), {
        id: 'embedded',
        site: site.id,
        mode: 'embedded',
        path: '.',
      })
    }
    await buildHome(root)
    const doctor = await doctorHome(root)
    if (doctor.status !== 'ready') throw new EndroitError('init_qualification_failed', `Initialized Home is ${doctor.status}: ${doctor.limits.join(', ')}.`)
    return {
      status: 'initialized',
      home: root,
      desk: deskStrategy,
      equipment: result.equipment,
      site: site.id,
      launch: launchInstructions(root, options.providers ?? ['codex', 'claude']),
    }
  } catch (error) {
    throw new EndroitError('init_incomplete', `Home initialization stopped after source creation (${error.code ?? 'unknown'}): ${error.message}`)
  }
}

export async function initHome(root = process.cwd(), options = {}) {
  root = resolve(root)
  if (Object.hasOwn(options, 'mode')) throw new EndroitError('legacy_mode_unsupported', 'Endroit 0.8 removed mode: solo|team. Use deskStrategy tracked|separate|later.', { exitCode: 3 })
  await mkdir(root, { recursive: true })
  if (await exists(join(root, 'endroit.json'))) throw new EndroitError('home_exists', `${root} already contains endroit.json.`)
  const deskStrategy = options.deskStrategy ?? 'later'
  if (!['tracked', 'separate', 'later'].includes(deskStrategy)) {
    throw new EndroitError('desk_strategy_invalid', 'Desk strategy must be tracked, separate or later.', { exitCode: 2 })
  }
  const ignorePath = join(root, '.gitignore')
  const instructionPath = join(root, HOME_INSTRUCTION)
  const deskPath = join(root, '.desk')
  const memberId = options.memberId ?? 'owner'
  const membersPath = join(root, 'members')
  const memberPath = join(membersPath, memberId)
  const membersExisted = await exists(membersPath)
  let memberCreated = false
  const ignoreExisted = await exists(ignorePath)
  const currentIgnore = ignoreExisted ? await readFile(ignorePath, 'utf8') : ''
  if (await exists(instructionPath)) throw new EndroitError('home_instruction_exists', `${instructionPath} already exists.`)
  if (await exists(deskPath)) throw new EndroitError('desk_exists', `${deskPath} already exists.`)
  try {
    const home = homeDocument({
      destination: root,
      name: options.name,
      emoji: options.emoji,
      providers: options.providers,
      prefix: options.prefix,
      frontDoor: options.frontDoor,
    })
    await writeJsonAtomic(join(root, 'endroit.json'), home, 0o644)
    await writeFileAtomic(instructionPath, await renderInstructionTemplate('home', {
      'home.name': home.name,
    }), 0o644)
    const required = ['/.endroit/', '/checkouts/', ...(deskStrategy === 'separate' || deskStrategy === 'later' ? ['/.desk/'] : ['/.desk/routes/']), '/.DS_Store']
    const lines = currentIgnore.split(/\r?\n/)
    const missing = required.filter((line) => !lines.includes(line))
    if (missing.length) await writeFileAtomic(ignorePath, `${currentIgnore.trimEnd()}${currentIgnore.trim() ? '\n' : ''}${missing.join('\n')}\n`, 0o644)
    await createMember(root, memberId, { name: options.memberName, status: 'active', accounts: options.accounts ?? [] })
    memberCreated = true
    if (deskStrategy !== 'later') await initDesk(root, {
      id: options.deskId ?? 'local',
      member: memberId,
      repository: deskStrategy,
    })
    return { status: 'initialized', home: root, desk: deskStrategy, member: memberId, providers: home.providers, equipment: [] }
  } catch (error) {
    await rm(join(root, 'endroit.json'), { force: true })
    await rm(instructionPath, { force: true })
    await removeTree(deskPath, { force: true })
    if (memberCreated) await removeTree(memberPath, { force: true })
    if (!membersExisted) await rmdir(membersPath).catch((failure) => { if (!['ENOENT', 'ENOTEMPTY'].includes(failure.code)) throw failure })
    if (ignoreExisted) await writeFileAtomic(ignorePath, currentIgnore, 0o644)
    else await rm(ignorePath, { force: true })
    throw error
  }
}

export function launchInstructions(home, providers) {
  return providers.map((provider) => provider === 'codex'
    ? { provider, command: `codex -C ${quote(home)}`, onboarding: '$endroit-onboarding' }
    : { provider, command: `cd ${quote(home)} && claude`, onboarding: '/endroit-onboarding' })
}

function quote(value) {
  return `"${String(value).replaceAll('"', '\\"')}"`
}
