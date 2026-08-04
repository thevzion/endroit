#!/usr/bin/env node
import { execFile, spawn } from 'node:child_process'
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { loadDesk } from '../src/desk.mjs'
import { readDocument, renderDocument } from '../src/documents.mjs'
import { removeTree } from '../src/lib/io.mjs'

const exec = promisify(execFile)
const projectRoot = await realpath(new URL('../', import.meta.url).pathname)
const localCli = join(projectRoot, 'bin', 'endroit.mjs')
const defaultHome = resolve(projectRoot, '..', 'endroit-development-home')
const projectEquipment = join(projectRoot, 'equipment', 'endroit', 'project', 'equipment.json')
const devCliSite = pathToFileURL(localCli).href
const projectPackage = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8'))
const developmentRuntime = `${projectPackage.name}@${projectPackage.version}`

export async function ensureDevelopmentHome(options = {}) {
  const home = resolve(options.home ?? defaultHome)
  const document = join(home, 'WORKPLACE.md')
  if (!await exists(document)) {
    if (await exists(join(home, 'endroit.json'))) throw new Error(`${home} uses a legacy declaration and must be migrated before 0.10 development.`)
    if (await exists(home)) throw new Error(`${home} exists but is not an Endroit Home.`)
    await endroit(['create', home, '--desk', 'later', '--providers', 'codex,claude', '--name', 'endroit-development-home', '--with', 'planning'])
  }

  const workplace = await readDocument(document)
  const config = workplace.metadata
  if (!same(config.providers, ['codex', 'claude'])) throw new Error(`${home} must enable codex and claude.`)
  if (config.runtime !== developmentRuntime) {
    config.runtime = developmentRuntime
    await writeFile(document, renderDocument(workplace))
  }

  if (!await loadDesk(home)) {
    if (options.deskRepository) await endroit(['desk', 'clone', options.deskRepository, '--home', home])
    else await endroit(['desk', 'init', '--id', options.deskId ?? process.env.USER ?? 'local', '--member', 'owner', '--home', home])
  }
  if (!await exists(join(home, 'equipment', 'endroit', 'planning', 'equipment.json'))) {
    await endroit(['equipment', 'add', '@endroit/planning', '-y', '--home', home])
  }
  const rooms = await endroitJson(['room', 'list', '--home', home, '--json'])
  if (!rooms.rooms.some((entry) => entry.id === 'endroit')) {
    await endroit(['room', 'create', 'endroit', '--scope', 'desk', '--home', home])
  }

  await endroit(['equipment', 'sync', '--all', '--home', home])
  const site = await siteState(home)
  if (!site) {
    await endroit([
      'site', 'add', projectRoot,
      '--id', 'endroit',
      '--summary', 'Endroit framework under development',
      '--when', 'Developing or releasing Endroit.',
      '--tag', 'endroit',
      '--home', home,
    ])
  } else {
    const route = site.routes.find((entry) => entry.id === 'main')
    if (!route) await endroit(['checkout', 'adopt', 'endroit', projectRoot, '--id', 'main', '--home', home])
    else if (await realpath(route.observed.path) !== projectRoot) throw new Error(`endroit/main points to ${route.observed.path}, expected ${projectRoot}.`)
  }

  if (!await exists(join(home, 'equipment', 'endroit', 'project', 'equipment.json'))) {
    await endroit(['equipment', 'add', projectEquipment, '-y', '--home', home])
  } else {
    await endroit(['equipment', 'sync', 'endroit/project', '--to', projectEquipment, '--home', home])
  }
  await endroit(['equipment', 'sync', '--all', '--home', home])
  await ensureDevelopmentLauncher(home)
  await endroit(['build', '--home', home])
  const doctor = await endroitJson(['doctor', '--home', home, '--json'])
  if (doctor.status !== 'ready') throw new Error(`Development Home is ${doctor.status}: ${doctor.limits.join(', ')}`)
  return { status: 'ready', home, desk: join(home, '.desk'), site: projectRoot, doctor }
}

export async function recreateDevelopmentHome(options = {}) {
  const home = resolve(options.home ?? defaultHome)
  const desk = join(home, '.desk')
  if (!await exists(join(home, 'WORKPLACE.md'))) throw new Error(`Development Home does not exist: ${home}`)
  await assertCleanRepository(home, 'Development Home')
  await assertCleanRepository(desk, 'Development Desk')

  const parent = dirname(home)
  const stageRoot = await mkdtemp(join(parent, '.endroit-development-stage-'))
  const stage = join(stageRoot, basename(home))
  const backup = `${home}.backup-${new Date().toISOString().replace(/[:.]/g, '-')}`
  let deskMoved = false
  let backupCreated = false
  let swapped = false
  try {
    await ensureDevelopmentHome({ home: stage, deskRepository: desk, deskId: options.deskId })
    await verifyHome(stage)

    await removeTree(join(stage, '.desk'), { force: true })
    await rename(desk, join(stage, '.desk'))
    deskMoved = true
    await ensureDevelopmentHome({ home: stage, deskId: options.deskId })
    await verifyHome(stage)

    await rename(home, backup)
    backupCreated = true
    await rename(stage, home)
    swapped = true
    await writeFile(join(home, '.endroit', 'recreate.json'), `${JSON.stringify({ version: 1, backup }, null, 2)}\n`)
    await verifyHome(home)
    await removeTree(stageRoot, { force: true })
    return { status: 'recreated', home, backup, next: 'npm run dev:verify' }
  } catch (error) {
    if (backupCreated && await exists(backup)) {
      const currentDesk = swapped ? join(home, '.desk') : join(stage, '.desk')
      if (await exists(currentDesk)) await rename(currentDesk, join(backup, '.desk'))
      if (swapped) await removeTree(home, { force: true })
      await rename(backup, home)
    } else if (deskMoved && await exists(join(stage, '.desk')) && !await exists(desk)) {
      await rename(join(stage, '.desk'), desk)
    }
    await removeTree(stageRoot, { force: true })
    throw error
  }
}

export async function verifyDevelopmentHome(options = {}) {
  const home = resolve(options.home ?? defaultHome)
  await run(process.execPath, [join(projectRoot, 'scripts', 'check.mjs')], { cwd: projectRoot })
  await run(process.execPath, [join(projectRoot, 'scripts', 'run-tests.mjs')], { cwd: projectRoot })
  await run(process.execPath, [join(projectRoot, 'scripts', 'check-providers.mjs')], { cwd: projectRoot })
  const proof = await verifyHome(home)

  if (options.full) {
    await run('npx', ['-y', 'node@22', 'scripts/run-tests.mjs'], { cwd: projectRoot })
    await run('npx', ['-y', 'node@24', 'scripts/run-tests.mjs'], { cwd: projectRoot })
    for (const script of ['conformance.mjs', 'check-pack.mjs', 'lab-dogfood.mjs']) {
      await run(process.execPath, [join(projectRoot, 'scripts', script)], { cwd: projectRoot })
    }
    await run('npm', ['audit', '--audit-level=high', '--ignore-scripts'], { cwd: projectRoot })
    for (const downstream of options.downstream ?? []) await verifyDownstream(resolve(downstream))
  }

  const statePath = join(home, '.endroit', 'recreate.json')
  if (await exists(statePath)) {
    const state = JSON.parse(await readFile(statePath, 'utf8'))
    const backup = resolve(state.backup)
    if (dirname(backup) !== dirname(home) || !basename(backup).startsWith(`${basename(home)}.backup-`)) {
      throw new Error(`Refusing unexpected recreate backup ${backup}.`)
    }
    await removeTree(backup, { force: true })
    await rm(statePath)
  }
  return { status: 'verified', home, full: Boolean(options.full), proof }
}

export async function openDevelopmentSession(options = {}) {
  const home = resolve(options.home ?? defaultHome)
  await ensureDevelopmentHome({ home, deskId: options.deskId })
  const provider = options.provider ?? 'codex'
  if (!['codex', 'claude'].includes(provider)) throw new Error(`Unsupported provider ${provider}.`)
  const command = provider === 'codex' ? 'codex' : 'claude'
  const args = provider === 'codex' ? ['-C', home] : []
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: home, stdio: 'inherit' })
    child.on('error', reject)
    child.on('exit', (code, signal) => resolvePromise(signal ? 1 : code ?? 1))
  })
}

async function verifyHome(home) {
  await endroit(['build', '--check', '--home', home])
  const doctor = await endroitJson(['doctor', '--home', home, '--json'])
  if (doctor.status !== 'ready') throw new Error(`Development Home is ${doctor.status}: ${doctor.limits.join(', ')}`)
  const hud = JSON.parse((await run(process.execPath, [join(home, 'endroit.mjs'), 'hud', 'json'], { cwd: home })).stdout)
  if (hud.status === 'degraded' || hud.kernel?.source !== 'development') {
    throw new Error('Development Home did not use the local Endroit Site runtime.')
  }
  return { doctor, hud }
}

async function verifyDownstream(home) {
  await endroit(['build', '--check', '--home', home])
  const doctor = await endroitJson(['doctor', '--home', home, '--json'])
  if (doctor.status !== 'ready') throw new Error(`${home} is ${doctor.status}: ${doctor.limits.join(', ')}`)
}

async function siteState(home) {
  const value = await endroitJson(['site', 'list', '--home', home, '--json'])
  return value.sites.find((entry) => entry.id === 'endroit')
}

async function ensureDevelopmentLauncher(home) {
  const directory = join(home, '.endroit')
  const path = join(directory, 'dev-cli')
  await mkdir(directory, { recursive: true })
const content = `#!/usr/bin/env node
await import(${JSON.stringify(devCliSite)})
`
  try {
    const info = await lstat(path)
    if (!info.isFile() && !info.isSymbolicLink()) throw new Error(`${path} exists and is not a file.`)
    if (info.isFile() && await readFile(path, 'utf8') === content) {
      await chmod(path, 0o755)
      return
    }
    await rm(path, { force: true })
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  await writeFile(path, content, { mode: 0o755 })
  await chmod(path, 0o755)
}

async function assertCleanRepository(root, label) {
  const { stdout } = await run('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: root })
  if (stdout.trim()) throw new Error(`${label} must be clean before recreation.`)
}

async function endroit(args) {
  return (await run(process.execPath, [localCli, ...args], { cwd: projectRoot })).stdout.trim()
}

async function endroitJson(args) {
  return JSON.parse(await endroit(args))
}

async function run(command, args, options = {}) {
  return exec(command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    timeout: options.timeout ?? 120_000,
    maxBuffer: 20 * 1024 * 1024,
  })
}

function same(left, right) {
  return [...left].sort().join('\0') === [...right].sort().join('\0')
}

async function exists(path) {
  try { await lstat(path); return true }
  catch (error) { if (error.code === 'ENOENT') return false; throw error }
}

function argumentsOf(argv) {
  const options = { downstream: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === '--full') options.full = true
    else if (value === '--home') options.home = argv[++index]
    else if (value === '--provider') options.provider = argv[++index]
    else if (value === '--desk') options.deskId = argv[++index]
    else if (value === '--desk-repository') options.deskRepository = argv[++index]
    else if (value === '--downstream') options.downstream.push(argv[++index])
    else throw new Error(`Unknown development option ${value}.`)
  }
  return options
}

async function main(argv) {
  const [command = 'ensure', ...args] = argv
  const options = argumentsOf(args)
  if (command === 'ensure') return ensureDevelopmentHome(options)
  if (command === 'recreate') return recreateDevelopmentHome(options)
  if (command === 'verify') return verifyDevelopmentHome(options)
  if (command === 'session') return { status: 'closed', exitCode: await openDevelopmentSession(options) }
  throw new Error('Use ensure, recreate, verify or session.')
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const value = await main(process.argv.slice(2))
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
    if (value.exitCode) process.exitCode = value.exitCode
  } catch (error) {
    process.stderr.write(`development_home_failed: ${error.message}\n`)
    process.exitCode = 1
  }
}
