#!/usr/bin/env node
import { join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createArtifact, inspectArtifact, listArtifacts, publishArtifact, validateArtifact } from './artifacts.mjs'
import { addAssets, applyTransaction, diffAsset, overrideAsset, publishAsset, removeAsset, statusAssets, syncAssets, validateAsset } from './assets.mjs'
import { buildHome } from './build.mjs'
import { cloneDesk, createHome, deskStatus, initDesk, initHome } from './create.mjs'
import { doctorHome } from './doctor.mjs'
import { approveExecutable, runExecutable } from './executables.mjs'
import { hudModel, renderHud, renderHudPrompt } from './hud.mjs'
import { assertRuntime, findHome } from './home.mjs'
import { addIntegration, bindIntegration, doctorIntegrations, listIntegrations, parseAccessors, removeIntegration, unbindIntegration } from './integrations.mjs'
import { asHairnessError, HairnessError } from './lib/errors.mjs'
import { addTarget, bindTarget, cloneTarget, discoverTargets, doctorTargets, listTargets, mapTarget, removeTarget, unbindTarget } from './targets.mjs'
import { publicPlan, resolveHome } from './resolved.mjs'

export async function runCli(argv = process.argv.slice(2), io = process) {
  const { positionals, flags } = parseArguments(argv)
  const [command, action, ...rest] = positionals
  try {
    const value = await route(command, action, rest, flags, io)
    if (value?.kind === 'HUD' && !flags.json) {
      if (booleanFlag(flags.prompt)) {
        const root = await findHome(flags.home ?? process.cwd())
        return write(io.stdout, renderHudPrompt(value, await resolveHome(root)))
      }
      return write(io.stdout, renderHud(value, { full: booleanFlag(flags.full) }))
    }
    return write(io.stdout, flags.json ? JSON.stringify(value, null, 2) : renderHuman(value, [command, action]))
  } catch (caught) {
    const error = asHairnessError(caught)
    write(io.stderr, flags.json ? JSON.stringify({ error: { code: error.code, message: error.message, details: error.details } }, null, 2) : `${error.code}: ${error.message}`)
    return error.exitCode
  }
}

async function route(command, action, rest, flags, io) {
  if (!command) return help()
  if (command === 'create') return createHome(required(action, 'destination'), {
    baseAsset: rest[0],
    providers: csv(flags.providers),
    name: flags.name,
    mode: flags.mode,
    deskId: flags.desk,
  })
  if (command === 'init') {
    if (action || rest.length) throw usage('hairness init creates a bare Home; add Assets after initialization.')
    return initHome(flags.home ?? process.cwd(), { providers: csv(flags.providers), name: flags.name, mode: flags.mode, deskId: flags.desk })
  }
  const root = await findHome(flags.home ?? process.cwd())
  await assertRuntime(root)
  if (command === 'asset') return assetRoute(root, action, rest, flags, io)
  if (command === 'validate') return publicPlan(await resolveHome(root))
  if (command === 'build') return buildHome(root, { check: booleanFlag(flags.check), allowExecutables: values(flags['allow-executable']) })
  if (command === 'doctor') return doctorHome(root)
  return contributedRoute(root, command, action, rest, flags)
}

async function assetRoute(root, action, rest, flags, io) {
  const scope = booleanFlag(flags.desk) ? 'desk' : flags.scope
  if (action === 'add') {
    const addresses = rest.filter(Boolean)
    if (!addresses.length) throw usage('At least one Asset is required.')
    const overwrite = booleanFlag(flags.overwrite)
    const preview = await addAssets(root, addresses, { dryRun: true, overwrite, scope })
    if (booleanFlag(flags['dry-run']) || booleanFlag(flags.diff)) return preview
    if (!booleanFlag(flags.yes) && !await confirm(io, preview)) throw new HairnessError('confirmation_required', 'Installation cancelled. Pass -y for non-interactive use.')
    return addAssets(root, addresses, { overwrite, scope })
  }
  if (action === 'status') return statusAssets(root, rest[0], { scope })
  if (action === 'validate') return validateAsset(root, required(rest[0], 'Asset'), { scope })
  if (action === 'diff') return diffAsset(root, required(rest[0], 'Asset'), { to: flags.to, scope })
  if (action === 'sync') {
    if (!rest[0] && !booleanFlag(flags.all)) throw usage('An Asset or --all is required.')
    return syncAssets(root, rest[0], { all: booleanFlag(flags.all), check: booleanFlag(flags.check), to: flags.to, overwrite: booleanFlag(flags.overwrite), scope })
  }
  if (action === 'remove') return removeAsset(root, required(rest[0], 'Asset'), { overwrite: booleanFlag(flags.overwrite), scope })
  if (action === 'override') return overrideAsset(root, required(rest[0], 'Asset'))
  if (action === 'publish') {
    if (flags.to !== 'home') throw usage('hairness asset publish <id> --to home')
    return publishAsset(root, required(rest[0], 'Asset'))
  }
  throw usage('hairness asset add|status|diff|sync|remove|validate|override|publish')
}

async function contributedRoute(root, command, action, rest, flags) {
  const plan = await resolveHome(root)
  const routeName = action ?? 'show'
  const matches = plan.cli.filter((entry) => entry.namespace === command && entry.name === routeName)
  if (!matches.length) throw usage(`Unknown command ${[command, action].filter(Boolean).join(' ')}.`)
  if (matches.length > 1) throw new HairnessError('cli_collision', `${command} ${routeName} is declared more than once.`)
  const route = matches[0]
  if (route.executable) {
    const executable = plan.executables.find((entry) => entry.id === route.executable)
    if (values(flags['allow-executable']).some((id) => id === executable.id || id === executable.localId)) await approveExecutable(root, executable)
    const files = await runExecutable(root, executable, { arguments: rest, defaults: route.defaults ?? {}, home: { id: plan.home.name } })
    const writes = files.map((file) => ({ path: safeExecutablePath(root, file.path), content: file.content }))
    await applyTransaction(root, writes, [])
    return { status: 'executed', id: executable.id, writes: writes.map((entry) => relative(root, entry.path)) }
  }
  return runOperation(root, plan, route, rest, flags)
}

async function runOperation(root, plan, route, args, flags) {
  const options = { ...(route.defaults ?? {}), ...flags }
  switch (route.operation) {
    case 'kernel:hud.show': return hudModel(root)
    case 'kernel:desk.clone': return cloneDesk(root, required(args[0], 'Desk repository'))
    case 'kernel:desk.init': return initDesk(root, { id: options.id ?? args[0], git: !booleanFlag(options['no-git']) })
    case 'kernel:desk.status': return deskStatus(root)
    case 'kernel:artifacts.create': return createArtifact(root, required(options.kind ?? args[0], 'Artifact kind'), required(options.kind ? args[0] : args[1], 'Artifact id'), artifactOptions(options))
    case 'kernel:artifacts.list': return listArtifacts(root)
    case 'kernel:artifacts.inspect': return inspectArtifact(root, required(args[0], 'Artifact'))
    case 'kernel:artifacts.validate': return validateArtifact(root, required(args[0], 'Artifact'))
    case 'kernel:artifacts.publish': return publishArtifact(root, required(args[0], 'Artifact'), { owner: options.owner, target: options.target, binding: options.binding })
    case 'kernel:commands.render': return renderCommand(plan, required(args[0], 'Command'))
    case 'kernel:targets.list': return listTargets(root)
    case 'kernel:targets.discover': return discoverTargets(required(args[0], 'discovery root'))
    case 'kernel:targets.doctor': return doctorTargets(root)
    case 'kernel:targets.add': return addTarget(root, required(args[0], 'repository'), { id: options.id, summary: options.summary, binding: options.binding })
    case 'kernel:targets.bind': return bindTarget(root, required(args[0], 'Target id'), required(args[1], 'repository path'), { binding: options.binding })
    case 'kernel:targets.clone': return cloneTarget(root, required(args[0], 'Target id'), { binding: options.binding })
    case 'kernel:targets.unbind': return unbindTarget(root, required(args[0], 'Target id'), options.binding, { delete: booleanFlag(options.delete) })
    case 'kernel:targets.remove': return removeTarget(root, required(args[0], 'Target id'))
    case 'kernel:targets.map': return mapTarget(root, required(args[0], 'Target id'), { binding: options.binding, id: options.id })
    case 'kernel:integrations.list': return listIntegrations(root)
    case 'kernel:integrations.doctor': return doctorIntegrations(root)
    case 'kernel:integrations.add': return addIntegration(root, required(args[0], 'Integration id'), parseAccessors(options), options.summary)
    case 'kernel:integrations.bind': return bindIntegration(root, required(args[0], 'Integration id'), required(args[1], 'provider'), required(args[2], 'accessor'))
    case 'kernel:integrations.unbind': return unbindIntegration(root, required(args[0], 'Integration id'), required(args[1], 'provider'))
    case 'kernel:integrations.remove': return removeIntegration(root, required(args[0], 'Integration id'))
    case 'kernel:scratch.create': return createArtifact(root, options.kind ?? 'hairness/scratch:scratch', required(args[0], 'Scratch id'), artifactOptions({ owner: 'desk', ...options }))
    default: throw new HairnessError('operation_unsupported', `${route.operation} is not implemented.`)
  }
}

function renderCommand(plan, selector) {
  const matches = plan.commands.filter((entry) => entry.id === selector || entry.localId === selector)
  if (!matches.length) throw new HairnessError('command_missing', `${selector} is not declared.`)
  if (matches.length > 1) throw new HairnessError('command_ambiguous', `${selector} matches multiple Commands.`)
  const command = matches[0]
  const capability = plan.capabilities.find((entry) => entry.id === command.capability)
  return { id: command.id, summary: command.summary, capability: capability.content }
}

function artifactOptions(options) {
  return {
    owner: options.owner,
    target: options.target,
    binding: options.binding,
    state: options.state,
    createdBy: options['created-by'],
    derivedFrom: options['derived-from'],
    from: options.from,
  }
}

function help() {
  return {
    summary: 'Hairness arranges source-owned agentic assets into portable Homes.',
    next: ['hairness create <home>', 'open an agent in <home>', 'invoke hairness-onboarding'],
    commands: [
      'create <home> [base-asset] [--mode solo|team]',
      'init [--mode solo|team]',
      'asset add|status|diff|sync|remove|validate|override|publish',
      'validate [--json]',
      'build [--check] [--allow-executable <id>]',
      'doctor [--json]',
      '<Asset-contributed namespaces: hud, desk, artifact, command, target, integration, scratch>',
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

function renderHuman(value, command) {
  if (value?.summary && value?.commands) return [value.summary, '', 'Next:', ...value.next.map((item) => `  ${item}`), '', 'Commands:', ...value.commands.map((item) => `  hairness ${item}`)].join('\n')
  if (value?.status === 'created' && value?.home && value?.launch) return ['Hairness Home created', value.home, `Mode: ${value.mode}`, `Assets: ${value.assets.join(', ')}`, '', ...value.launch.flatMap((entry) => [`${entry.provider}: ${entry.command}`, `Then invoke ${entry.onboarding}.`])].join('\n')
  if (value?.home?.name && value?.errors) return [`Hairness doctor — ${value.status}`, `Home: ${value.home.name}`, `Desk: ${value.desk?.id ?? 'not configured'}`, `Assets: ${value.assets.length}`, `Build: ${value.build}`, ...(value.errors.length ? ['', 'Errors:', ...value.errors.map((item) => `  - ${item}`)] : []), ...(value.warnings.length ? ['', 'Warnings:', ...value.warnings.map((item) => `  - ${item}`)] : [])].join('\n')
  if (Array.isArray(value)) return value.length ? value.map((entry) => `- ${entry.id ?? entry.name ?? JSON.stringify(entry)}${entry.state ? `: ${entry.state}` : ''}`).join('\n') : 'No entries.'
  if (command[0] === 'build' && value?.outputs) return `Build ready — ${value.outputs.length} generated outputs.`
  if (value?.capability) return `${value.summary}\n\n${value.capability}`
  return Object.entries(value ?? {}).map(([key, entry]) => `${key}: ${typeof entry === 'object' ? JSON.stringify(entry) : entry}`).join('\n')
}

async function confirm(io, preview) {
  if (!io.stdin?.isTTY || !io.stdout?.isTTY) return false
  io.stdout.write(`Install ${preview.assets.join(', ')} into ${preview.scope} and write ${preview.writes.length} files? [y/N] `)
  return new Promise((resolvePromise) => {
    io.stdin.once('data', (chunk) => resolvePromise(/^y(?:es)?\s*$/i.test(String(chunk))))
    io.stdin.resume?.()
  })
}

function safeExecutablePath(root, path) {
  if (['hairness.json', 'AGENTS.md', 'CLAUDE.md', '.hairness', '.codex', '.claude', '.agents'].some((entry) => path === entry || path.startsWith(`${entry}/`))) {
    throw new HairnessError('executable_output_reserved', `Executable cannot write ${path}.`)
  }
  return join(root, path)
}

function csv(value) { return value === undefined ? undefined : values(value).flatMap((entry) => String(entry).split(',')).map((entry) => entry.trim()).filter(Boolean) }
function values(value) { return value === undefined ? [] : Array.isArray(value) ? value : [value] }
function booleanFlag(value) { return value === true || value === 'true' || value === 'yes' || value === '1' }
function required(value, label) { if (!value) throw usage(`${label} is required.`); return value }
function usage(message) { return new HairnessError('usage', message, { exitCode: 2 }) }
function write(stream, value) { stream.write(`${value}\n`); return 0 }

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) process.exitCode = await runCli()
