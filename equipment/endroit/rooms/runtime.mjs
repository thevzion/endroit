#!/usr/bin/env node
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative } from 'node:path'

const HELP = {
  create: 'endroit room create <id|parent/child> --scope <home|desk> [--summary <text>] [--json]',
  list: 'endroit room list [--json]',
  inspect: 'endroit room inspect <home/id|desk/id|id> [--json]',
  doctor: 'endroit room doctor [--json]',
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
  process.stderr.write(`${error.code ?? 'room_failed'}: ${error.message}\n`)
  process.exitCode = error.exitCode ?? 4
}

async function route(input, command, rest, flags) {
  if (command === 'create') return createRoom(input, required(rest[0], 'Room id'), flags)
  if (command === 'list') return { status: 'listed', rooms: await listRooms(input) }
  if (command === 'inspect') return inspectRoom(input, required(rest[0], 'Room selector'))
  if (command === 'doctor') return doctorRooms(input)
  throw failure('usage', 'endroit room create|list|inspect|doctor', 2)
}

async function createRoom(input, id, flags) {
  assertRoomId(id)
  const scope = required(flags.scope, 'Room scope')
  if (!['home', 'desk'].includes(scope)) throw failure('room_scope_invalid', 'Room scope must be home or desk.', 2)
  if (id === 'home' && scope !== 'home') throw failure('room_id_reserved', 'Room id home is reserved for Home scope.')
  const current = await listRooms(input)
  if (current.some((entry) => entry.id === id)) throw failure('room_exists', `Room ${id} already exists in the Resolved Workplace.`)
  const root = roomRoot(input, scope)
  if (!root) throw failure('desk_missing', 'A configured Desk is required for a Desk Room.')
  const segments = id.split('/')
  const destination = join(root, ...segments)
  if (segments.length > 1) {
    const parent = segments.slice(0, -1).join('/')
    if (!current.some((entry) => entry.scope === scope && entry.id === parent && !entry.invalid)) {
      throw failure('room_parent_missing', `Parent Room ${scope}/${parent} does not exist.`)
    }
  }
  const timestamp = new Date().toISOString()
  const title = titleOf(id)
  const values = {
    id,
    tag: segments.at(-1),
    scope,
    timestamp,
    title,
    summary: flags.summary ?? `Durable work owned by the ${title} Room.`,
  }
  await mkdir(dirname(destination), { recursive: true })
  const stage = await mkdtemp(join(dirname(destination), '.endroit-room-'))
  try {
    await writeFile(join(stage, 'ROOM.md'), render(await template(input, 'ROOM.md'), values), { mode: 0o644 })
    await writeFile(join(stage, 'inbox.md'), render(await template(input, 'inbox.md'), values), { mode: 0o644 })
    await validateDirectory(stage, scope, id)
    await rename(stage, destination)
  } catch (error) {
    await rm(stage, { recursive: true, force: true })
    throw error
  }
  return { status: 'created', id, scope, ref: `room:${scope}/${id}`, path: relative(input.homeRoot, destination) }
}

async function listRooms(input) {
  const values = []
  for (const scope of ['home', 'desk']) {
    const root = roomRoot(input, scope)
    if (!root) continue
    for (const entry of await roomDirectories(root)) {
      const { id, path } = entry
      try {
        const document = await validateDirectory(path, scope, id)
        values.push({
          id,
          scope,
          ref: `room:${scope}/${id}`,
          path: relative(input.homeRoot, path),
          status: document.status,
          summary: document.summary ?? null,
        })
      } catch (error) {
        values.push({
          id,
          scope,
          ref: `room:${scope}/${id}`,
          path: relative(input.homeRoot, path),
          invalid: error.message,
        })
      }
    }
  }
  return values.sort((left, right) => left.id.localeCompare(right.id) || left.scope.localeCompare(right.scope))
}

async function inspectRoom(input, selector) {
  const matches = await select(input, selector)
  const room = matches[0]
  const root = join(input.homeRoot, room.path)
  const document = frontmatter(await readRegular(join(root, 'ROOM.md'), 'ROOM.md'))
  const inbox = frontmatter(await readRegular(join(root, 'inbox.md'), 'inbox.md'))
  return { status: 'inspected', ...room, document, inbox }
}

async function doctorRooms(input) {
  const rooms = await listRooms(input)
  const issues = []
  const ids = new Map()
  for (const room of rooms) {
    const previous = ids.get(room.id)
    if (previous) issues.push({ code: 'room_id_duplicate', room: room.id, scopes: [previous, room.scope] })
    else ids.set(room.id, room.scope)
    if (room.invalid) issues.push({ code: 'room_invalid', room: room.ref, message: room.invalid })
  }
  if (!rooms.some((entry) => entry.scope === 'home' && entry.id === 'home')) {
    issues.push({ code: 'home_room_missing', room: 'room:home/home' })
  }
  for (const path of [join(input.homeRoot, 'artifacts'), input.deskRoot && join(input.deskRoot, 'artifacts')].filter(Boolean)) {
    if (await exists(path)) issues.push({ code: 'legacy_artifacts_root', path: relative(input.homeRoot, path) })
  }
  return { status: issues.length ? 'partial' : 'ready', rooms, issues }
}

async function validateDirectory(root, scope, id) {
  const room = frontmatter(await readRegular(join(root, 'ROOM.md'), 'ROOM.md'))
  const inbox = frontmatter(await readRegular(join(root, 'inbox.md'), 'inbox.md'))
  const owner = `room:${scope}/${id}`
  if (room.id !== id || room.kind !== 'room' || room.owner !== owner) {
    throw failure('room_invalid', `ROOM.md must identify ${owner}.`)
  }
  if (inbox.kind !== 'inbox' || inbox.owner !== owner) throw failure('room_invalid', `inbox.md must be owned by ${owner}.`)
  for (const value of [room, inbox]) {
    for (const key of ['id', 'kind', 'status', 'owner', 'created_at', 'updated_at', 'derived_from']) {
      if (value[key] === undefined || value[key] === '') throw failure('room_invalid', `${basename(root)} requires ${key}.`)
    }
    if (!Array.isArray(value.derived_from)) throw failure('room_invalid', `${basename(root)} derived_from must be an array.`)
  }
  return room
}

async function select(input, selector) {
  const rooms = await listRooms(input)
  const normalized = String(selector).replace(/^room:/, '')
  const scoped = normalized.match(/^(home|desk)\/(.+)$/)
  const matches = rooms.filter((entry) => scoped
    ? entry.scope === scoped[1] && entry.id === scoped[2]
    : entry.id === normalized || entry.ref === selector)
  if (!matches.length) throw failure('room_missing', `${selector} was not found.`)
  if (matches.length > 1) throw failure('room_ambiguous', `${selector} matches multiple scoped Rooms.`)
  return matches
}

function roomRoot(input, scope) {
  return scope === 'home' ? join(input.homeRoot, 'rooms') : input.deskRoot ? join(input.deskRoot, 'rooms') : null
}

async function template(input, name) {
  return readFile(join(input.equipmentRoot, 'templates', name), 'utf8')
}

function render(content, values) {
  return content.replace(/\{\{([a-z_]+)\}\}/g, (_match, key) => {
    if (!(key in values)) throw failure('room_template_invalid', `Unknown template value ${key}.`)
    return String(values[key]).replaceAll('"', '\\"')
  })
}

function frontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!match) throw failure('room_invalid', 'Managed document must start with frontmatter.')
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
  if (info.isSymbolicLink() || !info.isFile()) throw failure('room_invalid', `${label} must be a regular file.`)
  return readFile(path, 'utf8')
}

async function safeReadDir(path) {
  try { return await readdir(path, { withFileTypes: true }) }
  catch (error) { if (error.code === 'ENOENT') return []; throw error }
}

async function roomDirectories(root) {
  const rooms = []
  const visit = async (path, parent = '') => {
    for (const entry of await safeReadDir(path)) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue
      const id = parent ? `${parent}/${entry.name}` : entry.name
      const destination = join(path, entry.name)
      if (!parent || await isRegular(join(destination, 'ROOM.md'))) {
        rooms.push({ id, path: destination })
        if (await isRegular(join(destination, 'ROOM.md'))) await visit(destination, id)
      }
    }
  }
  await visit(root)
  return rooms
}

async function isRegular(path) {
  try { const info = await lstat(path); return info.isFile() && !info.isSymbolicLink() }
  catch (error) { if (error.code === 'ENOENT') return false; throw error }
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
  return id.split('/').at(-1).split(/[-_.]+/).filter(Boolean).map((part) => part[0].toUpperCase() + part.slice(1)).join(' ')
}

function assertRoomId(value) {
  if (!String(value).split('/').every((segment) => /^[a-z0-9][a-z0-9._-]{0,127}$/.test(segment))) {
    throw failure('room_id_invalid', `Invalid Room id ${value}.`, 2)
  }
}

function help(command) {
  if (!command) return [
    'Usage: endroit room <create|list|inspect|doctor>',
    '',
    ...Object.entries(HELP).map(([name, usage]) => `  ${name}  ${usage.replace(`endroit room ${name}`, '').trim()}`),
  ].join('\n')
  if (!HELP[command]) throw failure('usage', `Unknown room command ${command}.`, 2)
  return `Usage: ${HELP[command]}\nEffect: ${command === 'create' ? 'mutating' : 'read-only'}`
}

function human(value) {
  if (value.status === 'listed') return value.rooms.length
    ? value.rooms.map((entry) => `${entry.ref} · ${entry.invalid ? `invalid: ${entry.invalid}` : entry.status}`).join('\n')
    : 'No Rooms.'
  if (value.status === 'inspected') return `${value.ref}\n${value.path}\n${value.document.summary ?? ''}`.trim()
  if (value.status === 'ready' || value.status === 'partial') return `Room doctor — ${value.status}\n${value.issues.map((entry) => `- ${entry.code}: ${entry.room ?? entry.path}`).join('\n')}`.trim()
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
