#!/usr/bin/env node
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative } from 'node:path'

const HELP = {
  create: 'hairness workspace create <id> --scope <home|desk> [--summary <text>] [--json]',
  list: 'hairness workspace list [--json]',
  inspect: 'hairness workspace inspect <home/id|desk/id|id> [--json]',
  doctor: 'hairness workspace doctor [--json]',
}

try {
  const input = JSON.parse(await stdin())
  const { positionals, flags } = args(input.argv)
  const [command, ...rest] = positionals
  if (flags.help) process.stdout.write(`${help(command)}\n`)
  else {
    const value = await route(input, command, rest, flags)
    process.stdout.write(flags.json ? `${JSON.stringify(value, null, 2)}\n` : `${human(value)}\n`)
  }
} catch (error) {
  process.stderr.write(`${error.code ?? 'workspace_failed'}: ${error.message}\n`)
  process.exitCode = error.exitCode ?? 4
}

async function route(input, command, rest, flags) {
  if (command === 'create') return createWorkspace(input, required(rest[0], 'Workspace id'), flags)
  if (command === 'list') return { status: 'listed', workspaces: await listWorkspaces(input) }
  if (command === 'inspect') return inspectWorkspace(input, required(rest[0], 'Workspace selector'))
  if (command === 'doctor') return doctorWorkspaces(input)
  throw failure('usage', 'hairness workspace create|list|inspect|doctor', 2)
}

async function createWorkspace(input, id, flags) {
  assertId(id)
  const scope = required(flags.scope, 'Workspace scope')
  if (!['home', 'desk'].includes(scope)) throw failure('workspace_scope_invalid', 'Workspace scope must be home or desk.', 2)
  if (id === 'home' && scope !== 'home') throw failure('workspace_id_reserved', 'Workspace id home is reserved for Home scope.')
  const current = await listWorkspaces(input)
  if (current.some((entry) => entry.id === id)) throw failure('workspace_exists', `Workspace ${id} already exists in the Resolved Home.`)
  const root = workspaceRoot(input, scope)
  if (!root) throw failure('desk_missing', 'A configured Desk is required for a Desk Workspace.')
  const destination = join(root, id)
  const timestamp = new Date().toISOString()
  const title = titleOf(id)
  const values = {
    id,
    scope,
    timestamp,
    title,
    summary: flags.summary ?? `Durable work owned by the ${title} Workspace.`,
  }
  await mkdir(root, { recursive: true })
  const stage = await mkdtemp(join(dirname(destination), '.hairness-workspace-'))
  try {
    await writeFile(join(stage, 'workspace.md'), render(await template(input, 'workspace.md'), values), { mode: 0o644 })
    await writeFile(join(stage, 'inbox.md'), render(await template(input, 'inbox.md'), values), { mode: 0o644 })
    await validateDirectory(stage, scope, id)
    await rename(stage, destination)
  } catch (error) {
    await rm(stage, { recursive: true, force: true })
    throw error
  }
  return { status: 'created', id, scope, ref: `workspace:${scope}/${id}`, path: relative(input.homeRoot, destination) }
}

async function listWorkspaces(input) {
  const values = []
  for (const scope of ['home', 'desk']) {
    const root = workspaceRoot(input, scope)
    if (!root) continue
    for (const entry of await safeReadDir(root)) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue
      const path = join(root, entry.name)
      try {
        const document = await validateDirectory(path, scope, entry.name)
        values.push({
          id: entry.name,
          scope,
          ref: `workspace:${scope}/${entry.name}`,
          path: relative(input.homeRoot, path),
          status: document.status,
          summary: document.summary ?? null,
        })
      } catch (error) {
        values.push({
          id: entry.name,
          scope,
          ref: `workspace:${scope}/${entry.name}`,
          path: relative(input.homeRoot, path),
          invalid: error.message,
        })
      }
    }
  }
  return values.sort((left, right) => left.id.localeCompare(right.id) || left.scope.localeCompare(right.scope))
}

async function inspectWorkspace(input, selector) {
  const matches = await select(input, selector)
  const workspace = matches[0]
  const root = join(input.homeRoot, workspace.path)
  const document = frontmatter(await readRegular(join(root, 'workspace.md'), 'workspace.md'))
  const inbox = frontmatter(await readRegular(join(root, 'inbox.md'), 'inbox.md'))
  return { status: 'inspected', ...workspace, document, inbox }
}

async function doctorWorkspaces(input) {
  const workspaces = await listWorkspaces(input)
  const issues = []
  const ids = new Map()
  for (const workspace of workspaces) {
    const previous = ids.get(workspace.id)
    if (previous) issues.push({ code: 'workspace_id_duplicate', workspace: workspace.id, scopes: [previous, workspace.scope] })
    else ids.set(workspace.id, workspace.scope)
    if (workspace.invalid) issues.push({ code: 'workspace_invalid', workspace: workspace.ref, message: workspace.invalid })
  }
  if (!workspaces.some((entry) => entry.scope === 'home' && entry.id === 'home')) {
    issues.push({ code: 'home_workspace_missing', workspace: 'workspace:home/home' })
  }
  for (const path of [join(input.homeRoot, 'artifacts'), input.deskRoot && join(input.deskRoot, 'artifacts')].filter(Boolean)) {
    if (await exists(path)) issues.push({ code: 'legacy_artifacts_root', path: relative(input.homeRoot, path) })
  }
  return { status: issues.length ? 'partial' : 'ready', workspaces, issues }
}

async function validateDirectory(root, scope, id) {
  const workspace = frontmatter(await readRegular(join(root, 'workspace.md'), 'workspace.md'))
  const inbox = frontmatter(await readRegular(join(root, 'inbox.md'), 'inbox.md'))
  const owner = `workspace:${scope}/${id}`
  if (workspace.id !== id || workspace.kind !== 'workspace' || workspace.owner !== owner) {
    throw failure('workspace_invalid', `workspace.md must identify ${owner}.`)
  }
  if (inbox.kind !== 'inbox' || inbox.owner !== owner) throw failure('workspace_invalid', `inbox.md must be owned by ${owner}.`)
  for (const value of [workspace, inbox]) {
    for (const key of ['id', 'kind', 'status', 'owner', 'created_at', 'updated_at', 'derived_from']) {
      if (value[key] === undefined || value[key] === '') throw failure('workspace_invalid', `${basename(root)} requires ${key}.`)
    }
    if (!Array.isArray(value.derived_from)) throw failure('workspace_invalid', `${basename(root)} derived_from must be an array.`)
  }
  return workspace
}

async function select(input, selector) {
  const workspaces = await listWorkspaces(input)
  const scoped = String(selector).match(/^(home|desk)\/(.+)$/)
  const matches = workspaces.filter((entry) => scoped
    ? entry.scope === scoped[1] && entry.id === scoped[2]
    : entry.id === selector || entry.ref === selector)
  if (!matches.length) throw failure('workspace_missing', `${selector} was not found.`)
  if (matches.length > 1) throw failure('workspace_ambiguous', `${selector} matches multiple scoped Workspaces.`)
  return matches
}

function workspaceRoot(input, scope) {
  return scope === 'home' ? join(input.homeRoot, 'workspaces') : input.deskRoot ? join(input.deskRoot, 'workspaces') : null
}

async function template(input, name) {
  return readFile(join(input.assetRoot, 'templates', name), 'utf8')
}

function render(content, values) {
  return content.replace(/\{\{([a-z_]+)\}\}/g, (_match, key) => {
    if (!(key in values)) throw failure('workspace_template_invalid', `Unknown template value ${key}.`)
    return String(values[key]).replaceAll('"', '\\"')
  })
}

function frontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!match) throw failure('workspace_invalid', 'Managed document must start with frontmatter.')
  const value = {}
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(':')
    if (separator < 1) continue
    const key = line.slice(0, separator).trim()
    const raw = line.slice(separator + 1).trim()
    try { value[key] = JSON.parse(raw) } catch { value[key] = raw.replace(/^"|"$/g, '') }
  }
  return value
}

async function readRegular(path, label) {
  const info = await lstat(path)
  if (info.isSymbolicLink() || !info.isFile()) throw failure('workspace_invalid', `${label} must be a regular file.`)
  return readFile(path, 'utf8')
}

async function safeReadDir(path) {
  try { return await readdir(path, { withFileTypes: true }) }
  catch (error) { if (error.code === 'ENOENT') return []; throw error }
}

async function exists(path) {
  try { await lstat(path); return true }
  catch (error) { if (error.code === 'ENOENT') return false; throw error }
}

function args(argv) {
  const flags = {}
  const positionals = []
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (!value.startsWith('--')) positionals.push(value)
    else {
      const [name, inline] = value.slice(2).split('=', 2)
      flags[name] = inline ?? (argv[index + 1] && !argv[index + 1].startsWith('-') ? argv[++index] : true)
    }
  }
  return { positionals, flags }
}

function titleOf(id) {
  return id.split(/[-_.]+/).filter(Boolean).map((part) => part[0].toUpperCase() + part.slice(1)).join(' ')
}

function assertId(value) {
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(value)) throw failure('workspace_id_invalid', `Invalid Workspace id ${value}.`, 2)
}

function help(command) {
  if (!command) return [
    'Usage: hairness workspace <create|list|inspect|doctor>',
    '',
    ...Object.entries(HELP).map(([name, usage]) => `  ${name}  ${usage.replace(`hairness workspace ${name}`, '').trim()}`),
  ].join('\n')
  if (!HELP[command]) throw failure('usage', `Unknown workspace command ${command}.`, 2)
  return `Usage: ${HELP[command]}\nEffect: ${command === 'create' ? 'mutating' : 'read-only'}`
}

function human(value) {
  if (value.status === 'listed') return value.workspaces.length
    ? value.workspaces.map((entry) => `${entry.ref} · ${entry.invalid ? `invalid: ${entry.invalid}` : entry.status}`).join('\n')
    : 'No Workspaces.'
  if (value.status === 'inspected') return `${value.ref}\n${value.path}\n${value.document.summary ?? ''}`.trim()
  if (value.status === 'ready' || value.status === 'partial') return `Workspace doctor — ${value.status}\n${value.issues.map((entry) => `- ${entry.code}: ${entry.workspace ?? entry.path}`).join('\n')}`.trim()
  return `${value.status}: ${value.ref} at ${value.path}`
}

function required(value, label) {
  if (value === undefined || value === true || value === '') throw failure('usage', `${label} is required.`, 2)
  return value
}

function failure(code, message, exitCode = 4) {
  const error = new Error(message)
  error.code = code
  error.exitCode = exitCode
  return error
}

function stdin() {
  return new Promise((resolvePromise, reject) => {
    const chunks = []
    process.stdin.on('data', (chunk) => chunks.push(chunk))
    process.stdin.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8')))
    process.stdin.on('error', reject)
  })
}
