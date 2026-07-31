#!/usr/bin/env node
import { pathToFileURL } from 'node:url'
import {
  addEquipment,
  catalogEquipment,
  overrideEquipment,
  promoteEquipment,
  removeEquipment,
  statusEquipment,
  syncEquipment,
  validateEquipmentSource,
} from './equipment.mjs'
import { buildHome } from './build.mjs'
import { bootstrapEquipment, createHome, initializeExistingHome } from './create.mjs'
import { runCreateWizard } from './create-wizard.mjs'
import { cloneDesk, initDesk } from './desk.mjs'
import { doctorHome } from './doctor.mjs'
import { assertRuntime, findHome } from './home.mjs'
import { asEndroitError, EndroitError } from './lib/errors.mjs'
import { publicPlan, resolveHome } from './resolved.mjs'
import { dispatchRuntime, runtimeTrust } from './runtime.mjs'

export async function runCli(argv = process.argv.slice(2), io = process, dependencies = {}) {
  const { positionals, flags } = parseArguments(argv)
  const [command, action, ...rest] = positionals
  try {
    const value = await route(command, action, rest, flags, argv, io, dependencies)
    if (value?.rendered) return value.exitCode
    if (value?.passthrough) return value.exitCode
    return write(io.stdout, flags.json ? JSON.stringify(value, null, 2) : renderHuman(value))
  } catch (caught) {
    const error = asEndroitError(caught)
    write(io.stderr, flags.json
      ? JSON.stringify({ error: { code: error.code, message: error.message, details: error.details } }, null, 2)
      : `${error.code}: ${error.message}`)
    return error.exitCode
  }
}

async function route(command, action, rest, flags, argv, io, dependencies) {
  if (!command) return help()
  if (command === 'create') return createRoute(required(action, 'destination'), flags, io, dependencies.prompts)
  if (command === 'init') return initRoute(action ?? flags.home ?? process.cwd(), flags)
  if (command === 'equipment' && action === 'validate') {
    return validateEquipmentSource(flags.home ?? process.cwd(), required(rest[0], 'Equipment source'))
  }
  const root = await findHome(flags.home ?? process.cwd())
  await assertRuntime(root)
  if (command === 'desk') return deskRoute(root, action, rest, flags)
  if (command === 'equipment') return equipmentRoute(root, action, rest, flags, io)
  if (command === 'validate') return publicPlan(await resolveHome(root))
  if (command === 'build') return buildHome(root, { check: booleanFlag(flags.check) })
  if (command === 'doctor') return doctorHome(root)
  if (command === 'route') {
    const runtimeArgs = ['route', ...withoutHomeFlag(argv.slice(argv.indexOf(command) + 1))]
    return { passthrough: true, exitCode: await dispatchRuntime(root, 'site', runtimeArgs, io) }
  }
  const runtimeArgs = withoutHomeFlag(argv.slice(argv.indexOf(command) + 1))
  return { passthrough: true, exitCode: await dispatchRuntime(root, command, runtimeArgs, io) }
}

async function initRoute(destination, flags) {
  const selected = createEquipmentSelection(flags.with)
  return initializeExistingHome(destination, {
    providers: csv(flags.providers) ?? ['codex', 'claude'],
    name: flags.name,
    mode: flags.mode,
    deskId: flags.desk,
    prefix: flags.prefix,
    siteId: flags.site,
    equipment: selected.map((id) => `@endroit/${id}`),
  })
}

const optionalCreateEquipment = ['research', 'planning', 'publishing', 'scratch']

async function createRoute(destination, flags, io, prompts) {
  const interactive = !booleanFlag(flags['no-interactive'])
    && !booleanFlag(flags.json)
    && io.stdin?.isTTY
    && io.stdout?.isTTY
  const selected = createEquipmentSelection(flags.with)
  const providers = csv(flags.providers) ?? ['codex', 'claude']
  const create = ({ mode = flags.mode, selected: chosen = selected } = {}) => createHome(destination, {
    providers,
    name: flags.name,
    mode,
    deskId: flags.desk,
    prefix: flags.prefix,
    equipment: chosen.map((id) => `@endroit/${id}`),
  })
  if (!interactive) return create()
  return runCreateWizard({
    destination,
    mode: flags.mode,
    selected,
    selectionProvided: flags.with !== undefined,
    yes: booleanFlag(flags.yes),
    providers,
    foundation: bootstrapEquipmentNames(),
    io,
    prompts,
    create,
  })
}

function createEquipmentSelection(value) {
  if (value === undefined || value === true || String(value).trim() === '' || value === 'none') return []
  const selected = csv(value)
  if (selected.includes('all')) {
    if (selected.length !== 1) throw usage('--with all cannot be combined with another Equipment.')
    return optionalCreateEquipment
  }
  const unknown = selected.filter((id) => !optionalCreateEquipment.includes(id))
  if (unknown.length) throw usage(`Unknown optional Equipment: ${unknown.join(', ')}.`)
  return [...new Set(selected)]
}

function bootstrapEquipmentNames() {
  return bootstrapEquipment.map((id) => id.replace('@endroit/', ''))
}

async function deskRoute(root, action, rest, flags) {
  if (action === 'init') return initDesk(root, { id: flags.id ?? rest[0], git: !booleanFlag(flags['no-git']) })
  if (action === 'clone') return cloneDesk(root, required(rest[0], 'Desk repository'))
  throw usage('endroit desk init|clone')
}

async function equipmentRoute(root, action, rest, flags, io) {
  const scope = booleanFlag(flags.desk) ? 'desk' : flags.scope
  if (action === 'add') {
    if (!rest.length) throw usage('At least one Equipment is required.')
    const overwrite = booleanFlag(flags.overwrite)
    const preview = await addEquipment(root, rest, { dryRun: true, overwrite, scope })
    if (booleanFlag(flags['dry-run']) || booleanFlag(flags.diff)) return preview
    if (!booleanFlag(flags.yes) && !await confirm(io, preview)) throw new EndroitError('confirmation_required', 'Installation cancelled. Pass -y for non-interactive use.')
    return addEquipment(root, rest, { overwrite, scope })
  }
  if (action === 'status') return statusEquipment(root, rest[0], { scope })
  if (action === 'sync') {
    if (!rest[0] && !booleanFlag(flags.all)) throw usage('An Equipment or --all is required.')
    return syncEquipment(root, rest[0], {
      all: booleanFlag(flags.all),
      check: booleanFlag(flags.check),
      to: flags.to,
      overwrite: booleanFlag(flags.overwrite),
      scope,
    })
  }
  if (action === 'remove') return removeEquipment(root, required(rest[0], 'Equipment'), { overwrite: booleanFlag(flags.overwrite), scope })
  if (action === 'override') return overrideEquipment(root, required(rest[0], 'Equipment'))
  if (action === 'catalog') return { status: 'catalogued', equipment: await catalogEquipment(root) }
  if (action === 'promote' || action === 'publish') {
    if (flags.to !== 'home') throw usage(`endroit equipment ${action} <id> --to home`)
    const result = await promoteEquipment(root, required(rest[0], 'Equipment'))
    return action === 'publish'
      ? { ...result, deprecated: 'equipment publish is deprecated; use equipment promote.' }
      : result
  }
  if (action === 'trust') return runtimeTrust(root, required(rest[0], 'Equipment'), { digest: flags.digest, revoke: booleanFlag(flags.revoke) })
  throw usage('endroit equipment validate|add|status|sync|remove|override|promote|catalog|trust')
}

function help() {
  return {
    summary: 'One Home for the agents, methods, and repositories you already use.',
    next: ['endroit create <home> or endroit init', 'open an agent in the Home', 'invoke endroit-onboarding'],
    commands: [
      'create <home>', 'init [repository]', 'desk init|clone',
      'equipment validate|add|status|sync|remove|override|promote|catalog|trust',
      'room create|list|inspect|doctor', 'site add|list|inspect|doctor|remove',
      'route bind|clone|worktree|list|inspect|remove',
      'validate', 'build [--check]', 'doctor',
      '<Equipment runtime namespace> <command...>',
    ],
  }
}

function parseArguments(argv) {
  const flags = {}
  const positionals = []
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === '-y') { flags.yes = true; continue }
    if (!value.startsWith('--')) { positionals.push(value); continue }
    const [name, inline] = value.slice(2).split('=', 2)
    const next = inline ?? (argv[index + 1] && !argv[index + 1].startsWith('-') ? argv[++index] : true)
    if (flags[name] === undefined) flags[name] = next
    else flags[name] = Array.isArray(flags[name]) ? [...flags[name], next] : [flags[name], next]
  }
  return { flags, positionals }
}

function renderHuman(value) {
  if (value?.summary && value?.commands) return [value.summary, '', 'Next:', ...value.next.map((item) => `  ${item}`), '', 'Commands:', ...value.commands.map((item) => `  endroit ${item}`)].join('\n')
  if ((value?.status === 'created' || value?.status === 'initialized') && value.home) return [
    value.status === 'created' ? 'Endroit Home created' : 'Endroit Home initialized',
    value.home,
    `Mode: ${value.mode}`,
    ...(value.site ? [`Embedded Site: ${value.site}`] : []),
    `Equipment: ${value.equipment.join(', ')}`,
    '',
    ...value.launch.flatMap((entry) => [`${entry.provider}: ${entry.command}`, `Then invoke ${entry.onboarding}.`]),
  ].join('\n')
  if (value?.status === 'catalogued') return value.equipment.map((entry) => `- ${entry.id}${entry.installed.length ? ` [${entry.installed.join(',')}]` : ''}: ${entry.description}`).join('\n')
  if (value?.home?.name && value?.limits) return [`Endroit doctor — ${value.status}`, `Home: ${value.home.name}`, `Desk: ${value.desk.configured ? value.desk.id : 'not configured'}`, `Equipment: ${value.equipment.length}`, `Build: ${value.build}`, ...(value.limits.length ? ['', 'Limits:', ...value.limits.map((item) => `  - ${item}`)] : []), ...(value.warnings?.length ? ['', 'Warnings:', ...value.warnings.map((item) => `  - ${item}`)] : [])].join('\n')
  if (Array.isArray(value)) return value.length ? value.map((entry) => `- ${entry.name ?? entry.id ?? JSON.stringify(entry)}${entry.state ? `: ${entry.state}` : ''}`).join('\n') : 'No entries.'
  return Object.entries(value ?? {}).map(([key, entry]) => `${key}: ${typeof entry === 'object' ? JSON.stringify(entry) : entry}`).join('\n')
}

async function confirm(io, preview) {
  if (!io.stdin?.isTTY || !io.stdout?.isTTY) return false
  io.stdout.write(`Install ${preview.equipment.join(', ')} and write ${preview.writes.length} files? [y/N] `)
  return new Promise((resolvePromise) => {
    io.stdin.once('data', (chunk) => resolvePromise(/^y(?:es)?\s*$/i.test(String(chunk))))
    io.stdin.resume?.()
  })
}

function csv(value) { return value === undefined ? undefined : String(value).split(',').map((entry) => entry.trim()).filter(Boolean) }
function withoutHomeFlag(argv) {
  const values = []
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--home') { index += 1; continue }
    if (argv[index].startsWith('--home=')) continue
    values.push(argv[index])
  }
  return values
}
function booleanFlag(value) { return value === true || value === 'true' || value === 'yes' || value === '1' }
function required(value, label) { if (!value) throw usage(`${label} is required.`); return value }
function usage(message) { return new EndroitError('usage', message, { exitCode: 2 }) }
function write(stream, value) { stream.write(`${value}\n`); return 0 }

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) process.exitCode = await runCli()
