#!/usr/bin/env node
import { pathToFileURL } from 'node:url'
import {
  addAssets,
  catalogAssets,
  overrideAsset,
  promoteAsset,
  removeAsset,
  statusAssets,
  syncAssets,
  validateAssetSource,
} from './assets.mjs'
import { buildHome } from './build.mjs'
import { bootstrapAssets, createHome } from './create.mjs'
import { runCreateWizard } from './create-wizard.mjs'
import { cloneDesk, initDesk } from './desk.mjs'
import { doctorHome } from './doctor.mjs'
import { assertRuntime, findHome } from './home.mjs'
import { asHairnessError, HairnessError } from './lib/errors.mjs'
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
    const error = asHairnessError(caught)
    write(io.stderr, flags.json
      ? JSON.stringify({ error: { code: error.code, message: error.message, details: error.details } }, null, 2)
      : `${error.code}: ${error.message}`)
    return error.exitCode
  }
}

async function route(command, action, rest, flags, argv, io, dependencies) {
  if (!command) return help()
  if (command === 'create') return createRoute(required(action, 'destination'), flags, io, dependencies.prompts)
  if (command === 'asset' && action === 'validate') {
    return validateAssetSource(flags.home ?? process.cwd(), required(rest[0], 'Asset source'))
  }
  const root = await findHome(flags.home ?? process.cwd())
  await assertRuntime(root)
  if (command === 'desk') return deskRoute(root, action, rest, flags)
  if (command === 'asset') return assetRoute(root, action, rest, flags, io)
  if (command === 'validate') return publicPlan(await resolveHome(root))
  if (command === 'build') return buildHome(root, { check: booleanFlag(flags.check) })
  if (command === 'doctor') return doctorHome(root)
  const runtimeArgs = withoutHomeFlag(argv.slice(argv.indexOf(command) + 1))
  return { passthrough: true, exitCode: await dispatchRuntime(root, command, runtimeArgs, io) }
}

const optionalCreateAssets = ['research', 'planning', 'publishing', 'scratch']

async function createRoute(destination, flags, io, prompts) {
  const interactive = !booleanFlag(flags['no-interactive'])
    && !booleanFlag(flags.json)
    && io.stdin?.isTTY
    && io.stdout?.isTTY
  const selected = createAssetSelection(flags.with)
  const providers = csv(flags.providers) ?? ['codex', 'claude']
  const create = ({ mode = flags.mode, selected: chosen = selected } = {}) => createHome(destination, {
    providers,
    name: flags.name,
    mode,
    deskId: flags.desk,
    prefix: flags.prefix,
    assets: chosen.map((id) => `@hairness/${id}`),
  })
  if (!interactive) return create()
  return runCreateWizard({
    destination,
    mode: flags.mode,
    selected,
    selectionProvided: flags.with !== undefined,
    yes: booleanFlag(flags.yes),
    providers,
    foundation: bootstrapAssetNames(),
    io,
    prompts,
    create,
  })
}

function createAssetSelection(value) {
  if (value === undefined || value === true || String(value).trim() === '' || value === 'none') return []
  const selected = csv(value)
  if (selected.includes('all')) {
    if (selected.length !== 1) throw usage('--with all cannot be combined with another Asset.')
    return optionalCreateAssets
  }
  const unknown = selected.filter((id) => !optionalCreateAssets.includes(id))
  if (unknown.length) throw usage(`Unknown optional Asset: ${unknown.join(', ')}.`)
  return [...new Set(selected)]
}

function bootstrapAssetNames() {
  return bootstrapAssets.map((id) => id.replace('@hairness/', ''))
}

async function deskRoute(root, action, rest, flags) {
  if (action === 'init') return initDesk(root, { id: flags.id ?? rest[0], git: !booleanFlag(flags['no-git']) })
  if (action === 'clone') return cloneDesk(root, required(rest[0], 'Desk repository'))
  throw usage('hairness desk init|clone')
}

async function assetRoute(root, action, rest, flags, io) {
  const scope = booleanFlag(flags.desk) ? 'desk' : flags.scope
  if (action === 'add') {
    if (!rest.length) throw usage('At least one Asset is required.')
    const overwrite = booleanFlag(flags.overwrite)
    const preview = await addAssets(root, rest, { dryRun: true, overwrite, scope })
    if (booleanFlag(flags['dry-run']) || booleanFlag(flags.diff)) return preview
    if (!booleanFlag(flags.yes) && !await confirm(io, preview)) throw new HairnessError('confirmation_required', 'Installation cancelled. Pass -y for non-interactive use.')
    return addAssets(root, rest, { overwrite, scope })
  }
  if (action === 'status') return statusAssets(root, rest[0], { scope })
  if (action === 'sync') {
    if (!rest[0] && !booleanFlag(flags.all)) throw usage('An Asset or --all is required.')
    return syncAssets(root, rest[0], {
      all: booleanFlag(flags.all),
      check: booleanFlag(flags.check),
      to: flags.to,
      overwrite: booleanFlag(flags.overwrite),
      scope,
    })
  }
  if (action === 'remove') return removeAsset(root, required(rest[0], 'Asset'), { overwrite: booleanFlag(flags.overwrite), scope })
  if (action === 'override') return overrideAsset(root, required(rest[0], 'Asset'))
  if (action === 'catalog') return { status: 'catalogued', assets: await catalogAssets(root) }
  if (action === 'promote' || action === 'publish') {
    if (flags.to !== 'home') throw usage(`hairness asset ${action} <id> --to home`)
    const result = await promoteAsset(root, required(rest[0], 'Asset'))
    return action === 'publish'
      ? { ...result, deprecated: 'asset publish is deprecated; use asset promote.' }
      : result
  }
  if (action === 'trust') return runtimeTrust(root, required(rest[0], 'Asset'), { digest: flags.digest, revoke: booleanFlag(flags.revoke) })
  throw usage('hairness asset validate|add|status|sync|remove|override|promote|catalog|trust')
}

function help() {
  return {
    summary: 'Hairness gives agents a provider-agnostic Home you own.',
    next: ['hairness create <home>', 'open an agent in <home>', 'invoke hairness-onboarding'],
    commands: [
      'create <home>', 'desk init|clone',
      'asset validate|add|status|sync|remove|override|promote|catalog|trust',
      'validate', 'build [--check]', 'doctor',
      '<Asset runtime namespace> <command...>',
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
  if (value?.summary && value?.commands) return [value.summary, '', 'Next:', ...value.next.map((item) => `  ${item}`), '', 'Commands:', ...value.commands.map((item) => `  hairness ${item}`)].join('\n')
  if (value?.status === 'created') return ['Hairness Home created', value.home, `Mode: ${value.mode}`, `Assets: ${value.assets.join(', ')}`, '', ...value.launch.flatMap((entry) => [`${entry.provider}: ${entry.command}`, `Then invoke ${entry.onboarding}.`])].join('\n')
  if (value?.status === 'catalogued') return value.assets.map((entry) => `- ${entry.id}${entry.installed.length ? ` [${entry.installed.join(',')}]` : ''}: ${entry.description}`).join('\n')
  if (value?.home?.name && value?.limits) return [`Hairness doctor — ${value.status}`, `Home: ${value.home.name}`, `Desk: ${value.desk.configured ? value.desk.id : 'not configured'}`, `Assets: ${value.assets.length}`, `Build: ${value.build}`, ...(value.limits.length ? ['', 'Limits:', ...value.limits.map((item) => `  - ${item}`)] : []), ...(value.warnings?.length ? ['', 'Warnings:', ...value.warnings.map((item) => `  - ${item}`)] : [])].join('\n')
  if (Array.isArray(value)) return value.length ? value.map((entry) => `- ${entry.name ?? entry.id ?? JSON.stringify(entry)}${entry.state ? `: ${entry.state}` : ''}`).join('\n') : 'No entries.'
  return Object.entries(value ?? {}).map(([key, entry]) => `${key}: ${typeof entry === 'object' ? JSON.stringify(entry) : entry}`).join('\n')
}

async function confirm(io, preview) {
  if (!io.stdin?.isTTY || !io.stdout?.isTTY) return false
  io.stdout.write(`Install ${preview.assets.join(', ')} and write ${preview.writes.length} files? [y/N] `)
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
function usage(message) { return new HairnessError('usage', message, { exitCode: 2 }) }
function write(stream, value) { stream.write(`${value}\n`); return 0 }

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) process.exitCode = await runCli()
