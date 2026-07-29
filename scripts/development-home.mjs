#!/usr/bin/env node
import { execFile, spawn } from 'node:child_process'
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const projectRoot = await realpath(new URL('../', import.meta.url).pathname)
const localCli = join(projectRoot, 'bin', 'hairness.mjs')
const defaultHome = resolve(projectRoot, '..', 'hairness-development-home')
const projectAsset = '.desk/targets/hairness/main/assets/hairness/project/asset.json'
const devCliTarget = '../.desk/targets/hairness/main/bin/hairness.mjs'
const projectPackage = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8'))
const developmentRuntime = `${projectPackage.name}@${projectPackage.version}`

export async function ensureDevelopmentHome(options = {}) {
  const home = resolve(options.home ?? defaultHome)
  const document = join(home, 'hairness.json')
  if (!await exists(document)) {
    if (await exists(home)) throw new Error(`${home} exists but is not a Hairness Home.`)
    await hairness(['create', home, '--mode', 'team', '--providers', 'codex,claude', '--name', 'hairness-development-home', '--with', 'planning'])
  }

  const config = JSON.parse(await readFile(document, 'utf8'))
  if (config.mode !== 'team') throw new Error(`${home} must be recreated as a team Home.`)
  if (!same(config.providers, ['codex', 'claude'])) throw new Error(`${home} must enable codex and claude.`)
  if (config.runtime !== developmentRuntime) {
    config.runtime = developmentRuntime
    await writeFile(document, `${JSON.stringify(config, null, 2)}\n`)
  }

  if (!await exists(join(home, '.desk', 'desk.json'))) {
    if (options.deskRepository) await hairness(['desk', 'clone', options.deskRepository, '--home', home])
    else await hairness(['desk', 'init', '--id', options.deskId ?? process.env.USER ?? 'local', '--home', home])
  }
  if (!await exists(join(home, 'assets', 'hairness', 'planning', 'asset.json'))) {
    await hairness(['asset', 'add', '@hairness/planning', '-y', '--home', home])
  }
  const workspaces = await hairnessJson(['workspace', 'list', '--home', home, '--json'])
  if (!workspaces.workspaces.some((entry) => entry.id === 'hairness')) {
    await hairness(['workspace', 'create', 'hairness', '--scope', 'desk', '--home', home])
  }

  await hairness(['asset', 'sync', '--all', '--home', home])
  const target = await targetState(home)
  if (!target) {
    await hairness([
      'target', 'add', projectRoot,
      '--id', 'hairness',
      '--binding', 'main',
      '--summary', 'Hairness framework under development',
      '--home', home,
    ])
  } else {
    const binding = target.bindings.find((entry) => entry.id === 'main')
    if (!binding) await hairness(['target', 'bind', 'hairness', projectRoot, '--binding', 'main', '--home', home])
    else if (await realpath(binding.path) !== projectRoot) throw new Error(`hairness/main points to ${binding.path}, expected ${projectRoot}.`)
  }

  if (!await exists(join(home, 'assets', 'hairness', 'project', 'asset.json'))) {
    await hairness(['asset', 'add', projectAsset, '-y', '--home', home])
  } else {
    await hairness(['asset', 'sync', 'hairness/project', '--to', projectAsset, '--home', home])
  }
  await hairness(['asset', 'sync', '--all', '--home', home])
  if (config.frontDoor?.wakeUp !== 'hairness/hud:prompt') {
    config.frontDoor = { wakeUp: 'hairness/hud:prompt' }
    await writeFile(document, `${JSON.stringify(config, null, 2)}\n`)
  }
  await ensureDevelopmentLauncher(home)
  await hairness(['build', '--home', home])
  const doctor = await hairnessJson(['doctor', '--home', home, '--json'])
  if (doctor.status !== 'ready') throw new Error(`Development Home is ${doctor.status}: ${doctor.limits.join(', ')}`)
  return { status: 'ready', home, desk: join(home, '.desk'), target: projectRoot, doctor }
}

export async function recreateDevelopmentHome(options = {}) {
  const home = resolve(options.home ?? defaultHome)
  const desk = join(home, '.desk')
  if (!await exists(join(home, 'hairness.json'))) throw new Error(`Development Home does not exist: ${home}`)
  await assertCleanRepository(home, 'Development Home')
  await assertCleanRepository(desk, 'Development Desk')

  const parent = dirname(home)
  const stageRoot = await mkdtemp(join(parent, '.hairness-development-stage-'))
  const stage = join(stageRoot, basename(home))
  const backup = `${home}.backup-${new Date().toISOString().replace(/[:.]/g, '-')}`
  let deskMoved = false
  let backupCreated = false
  let swapped = false
  try {
    await ensureDevelopmentHome({ home: stage, deskRepository: desk, deskId: options.deskId })
    await verifyHome(stage)

    await rm(join(stage, '.desk'), { recursive: true, force: true })
    await rename(desk, join(stage, '.desk'))
    deskMoved = true
    await ensureDevelopmentHome({ home: stage, deskId: options.deskId })
    await verifyHome(stage)

    await rename(home, backup)
    backupCreated = true
    await rename(stage, home)
    swapped = true
    await writeFile(join(home, '.hairness', 'recreate.json'), `${JSON.stringify({ version: 1, backup }, null, 2)}\n`)
    await verifyHome(home)
    await rm(stageRoot, { recursive: true, force: true })
    return { status: 'recreated', home, backup, next: 'npm run dev:verify' }
  } catch (error) {
    if (backupCreated && await exists(backup)) {
      const currentDesk = swapped ? join(home, '.desk') : join(stage, '.desk')
      if (await exists(currentDesk)) await rename(currentDesk, join(backup, '.desk'))
      if (swapped) await rm(home, { recursive: true, force: true })
      await rename(backup, home)
    } else if (deskMoved && await exists(join(stage, '.desk')) && !await exists(desk)) {
      await rename(join(stage, '.desk'), desk)
    }
    await rm(stageRoot, { recursive: true, force: true })
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

  const statePath = join(home, '.hairness', 'recreate.json')
  if (await exists(statePath)) {
    const state = JSON.parse(await readFile(statePath, 'utf8'))
    const backup = resolve(state.backup)
    if (dirname(backup) !== dirname(home) || !basename(backup).startsWith(`${basename(home)}.backup-`)) {
      throw new Error(`Refusing unexpected recreate backup ${backup}.`)
    }
    await rm(backup, { recursive: true, force: true })
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
  await hairness(['build', '--check', '--home', home])
  const doctor = await hairnessJson(['doctor', '--home', home, '--json'])
  if (doctor.status !== 'ready') throw new Error(`Development Home is ${doctor.status}: ${doctor.limits.join(', ')}`)
  const codex = JSON.parse((await run(process.execPath, [join(home, '.codex/hooks/hairness-session-start.mjs')], { cwd: home })).stdout)
  const codexHud = codex.hookSpecificOutput?.additionalContext
  if (!codexHud?.startsWith('<hairness-hud ') || /status="degraded"/.test(codexHud)) throw new Error('Codex Front Door Wake-up is unavailable.')
  const claudeHud = (await run(process.execPath, [join(home, '.claude/hooks/hairness-session-start.mjs')], { cwd: home })).stdout.trim()
  if (!claudeHud.startsWith('<hairness-hud ') || /status="degraded"/.test(claudeHud)) throw new Error('Claude Front Door Wake-up is unavailable.')
  if (!/<kernel [^>]*source="development"/.test(codexHud) || !/<kernel [^>]*source="development"/.test(claudeHud)) {
    throw new Error('Development Home did not use the local Hairness Target runtime.')
  }
  return { doctor, codex: codexHud, claude: claudeHud }
}

async function verifyDownstream(home) {
  await hairness(['build', '--check', '--home', home])
  const doctor = await hairnessJson(['doctor', '--home', home, '--json'])
  if (doctor.status !== 'ready') throw new Error(`${home} is ${doctor.status}: ${doctor.limits.join(', ')}`)
}

async function targetState(home) {
  const value = await hairnessJson(['target', 'list', '--home', home, '--json'])
  return value.targets.find((entry) => entry.id === 'hairness')
}

async function ensureDevelopmentLauncher(home) {
  const directory = join(home, '.hairness')
  const path = join(directory, 'dev-cli')
  await mkdir(directory, { recursive: true })
const content = `#!/usr/bin/env node
await import(new URL(${JSON.stringify(devCliTarget)}, import.meta.url))
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

async function hairness(args) {
  return (await run(process.execPath, [localCli, ...args], { cwd: projectRoot })).stdout.trim()
}

async function hairnessJson(args) {
  return JSON.parse(await hairness(args))
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
