import { lstat, mkdir, mkdtemp, readFile, rename, rm, rmdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { addEquipment } from './equipment.mjs'
import { buildHome } from './build.mjs'
import { initDesk } from './desk.mjs'
import { doctorHome } from './doctor.mjs'
import { git } from './git.mjs'
import { loadHome, renderWorkplaceDocument, workplaceDocument, workplaceId, WORKPLACE_INSTRUCTION } from './home.mjs'
import { EndroitError } from './lib/errors.mjs'
import { digest, exists, removeTree, writeFileAtomic } from './lib/io.mjs'
import { createMember } from './member.mjs'
import { writeRoute, writeSite } from './sites.mjs'

export const bootstrapEquipment = ['@endroit/onboarding', '@endroit/hud', '@endroit/artifacts', '@endroit/sites', '@endroit/rooms', '@endroit/workplace', '@endroit/work', '@endroit/hygiene']

export async function createHome(destination, options = {}) {
  const site = resolve(destination)
  if (await exists(site)) throw new EndroitError('destination_exists', `Destination already exists: ${site}.`)
  await mkdir(dirname(site), { recursive: true })
  const stage = await mkdtemp(join(dirname(site), '.endroit-create-'))
  try {
    await git(['init', '--quiet', '--initial-branch=main'], { cwd: stage })
    await initHome(stage, {
      ...options,
      name: options.name ?? workplaceId(site),
      deskStrategy: options.deskStrategy ?? 'tracked',
      frontDoor: { wakeUp: 'endroit/hud:prompt' },
    })
    const result = await addEquipment(stage, [...bootstrapEquipment, ...(options.equipment ?? [])])
    await bootstrapHomeRoom(stage)
    await buildHome(stage)
    const doctor = await doctorHome(stage)
    if (doctor.status !== 'ready') throw new EndroitError('create_qualification_failed', `Created Workplace is ${doctor.status}: ${doctor.limits.join(', ')}.`)
    await git(['add', '--all'], { cwd: stage })
    await git(['-c', 'user.name=Endroit', '-c', 'user.email=local@endroit.org', 'commit', '--quiet', '-m', 'chore: initialize Endroit Workplace'], { cwd: stage })
    if (await git(['remote'], { cwd: stage })) throw new EndroitError('workplace_remote_forbidden', 'Workplace creation must not configure a remote.')
    await rename(stage, site)
    return {
      status: 'created',
      workplace: site,
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
  const workplace = await loadHome(root)
  const values = {
    id: 'home',
    tag: 'home',
    scope: 'home',
    timestamp,
    title: 'Home',
    summary: `Improve and maintain ${workplace.name}.`,
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
  const initOptions = {
    ...options,
    name: options.name ?? workplaceId(root),
    deskStrategy,
    frontDoor: { wakeUp: 'endroit/hud:prompt' },
  }
  await preflightEmbeddedProjections(root, initOptions)
  await initHome(root, initOptions)
  try {
    const result = await addEquipment(root, [...bootstrapEquipment, ...(options.equipment ?? [])])
    await bootstrapHomeRoom(root)
    const site = await writeSite(root, {
      id: options.siteId ?? 'self',
      summary: 'The repository that contains this embedded Workplace.',
      when: ['Working on this repository.'],
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
    if (doctor.status !== 'ready') throw new EndroitError('init_qualification_failed', `Initialized Workplace is ${doctor.status}: ${doctor.limits.join(', ')}.`)
    return {
      status: 'initialized',
      workplace: root,
      desk: deskStrategy,
      equipment: result.equipment,
      site: site.id,
      launch: launchInstructions(root, options.providers ?? ['codex', 'claude']),
    }
  } catch (error) {
    throw new EndroitError('init_incomplete', `Workplace initialization stopped after source creation (${error.code ?? 'unknown'}): ${error.message}`)
  }
}

async function preflightEmbeddedProjections(root, options) {
  const stage = await mkdtemp(join(tmpdir(), 'endroit-init-preflight-'))
  try {
    await git(['init', '--quiet', '--initial-branch=main'], { cwd: stage })
    await initHome(stage, options)
    const equipment = (options.equipment ?? []).map((address) => String(address).startsWith('.') ? resolve(root, address) : address)
    await addEquipment(stage, [...bootstrapEquipment, ...equipment])
    await bootstrapHomeRoom(stage)
    const site = await writeSite(stage, {
      id: options.siteId ?? 'self',
      summary: 'The repository that contains this embedded Workplace.',
      when: ['Working on this repository.'],
    })
    if (options.deskStrategy !== 'later') {
      await writeRoute(stage, join(stage, '.desk'), { id: 'embedded', site: site.id, mode: 'embedded', path: '.' })
    }
    const state = await buildHome(stage)
    const collisions = []
    for (const output of state.outputs) {
      const path = join(root, output.path)
      const info = await lstat(path).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error))
      if (!info) continue
      if (info.isSymbolicLink() || !info.isFile() || digest(await readFile(path)) !== output.digest) collisions.push(output.path)
    }
    if (collisions.length) {
      throw new EndroitError('generated_output_collision', `Generated outputs already exist and Endroit does not own them: ${collisions.join(', ')}.`, { exitCode: 5 })
    }
  } finally {
    await removeTree(stage, { force: true })
  }
}

export async function initHome(root = process.cwd(), options = {}) {
  root = resolve(root)
  if (Object.hasOwn(options, 'mode')) throw new EndroitError('legacy_mode_unsupported', 'Endroit 0.8 removed mode: solo|team. Use deskStrategy tracked|separate|later.', { exitCode: 3 })
  await mkdir(root, { recursive: true })
  if (await exists(join(root, WORKPLACE_INSTRUCTION)) || await exists(join(root, 'endroit.json'))) {
    throw new EndroitError('workplace_exists', `${root} already contains a current or legacy Endroit declaration.`)
  }
  const deskStrategy = options.deskStrategy ?? 'later'
  if (!['tracked', 'separate', 'later'].includes(deskStrategy)) {
    throw new EndroitError('desk_strategy_invalid', 'Desk strategy must be tracked, separate or later.', { exitCode: 2 })
  }
  const ignorePath = join(root, '.gitignore')
  const instructionPath = join(root, WORKPLACE_INSTRUCTION)
  const deskPath = join(root, '.desk')
  const memberId = options.memberId ?? 'owner'
  const membersPath = join(root, 'members')
  const memberPath = join(membersPath, memberId)
  const membersExisted = await exists(membersPath)
  let memberCreated = false
  const ignoreExisted = await exists(ignorePath)
  const currentIgnore = ignoreExisted ? await readFile(ignorePath, 'utf8') : ''
  if (await exists(instructionPath)) throw new EndroitError('workplace_declaration_exists', `${instructionPath} already exists.`)
  if (await exists(deskPath)) throw new EndroitError('desk_exists', `${deskPath} already exists.`)
  try {
    const workplace = workplaceDocument({
      destination: root,
      name: options.name,
      memberId,
      emoji: options.emoji,
      providers: options.providers,
      prefix: options.prefix,
    })
    await writeFileAtomic(instructionPath, await renderWorkplaceDocument(workplace, { title: options.title ?? options.name ?? workplace.id }), 0o644)
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
    return { status: 'initialized', workplace: root, desk: deskStrategy, member: memberId, providers: workplace.providers, equipment: [] }
  } catch (error) {
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
