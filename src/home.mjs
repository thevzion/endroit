import { readFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { API, validateDocument } from './contracts.mjs'
import { HairnessError } from './lib/errors.mjs'
import { assertId, digest, readJson, writeJsonAtomic } from './lib/io.mjs'

const packageDocument = JSON.parse(await readFile(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'))
export const RUNTIME = `@hairness/cli@${packageDocument.version}`

export async function findHome(start = process.env.HAIRNESS_HOME_PATH ?? process.cwd()) {
  let current = resolve(start)
  while (true) {
    try {
      await readFile(join(current, 'hairness.json'))
      return current
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    const parent = dirname(current)
    if (parent === current) throw new HairnessError('home_not_found', 'No hairness.json found from the current directory.')
    current = parent
  }
}

export async function loadHome(root) {
  root ??= await findHome()
  const home = await validateDocument(await readJson(join(root, 'hairness.json')), 'home')
  home.projection ??= {}
  home.settings ??= {}
  return home
}

export async function assertRuntime(root) {
  const home = await loadHome(root)
  if (home.runtime !== RUNTIME) {
    throw new HairnessError('runtime_mismatch', `This Home requires ${home.runtime}; run npx --yes ${home.runtime} instead.`, { exitCode: 3 })
  }
  return home
}

export async function loadDesk(root, options = {}) {
  const path = join(root, '.desk', 'desk.json')
  const document = await readJson(path, null)
  if (document === null) {
    if (options.required) throw new HairnessError('desk_missing', 'This operation requires an active .desk/desk.json.')
    return null
  }
  const desk = await validateDocument(document, 'desk')
  desk.settings ??= {}
  return desk
}

export function homeId(destination) {
  const name = basename(resolve(destination)).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-|-$/g, '')
  return assertId(name || `home-${digest(resolve(destination)).slice(7, 15)}`, 'Home id')
}

export function homeDocument(options = {}) {
  const projection = options.projection ?? {}
  const settings = options.settings ?? {}
  return {
    $schema: API.home,
    name: assertId(options.name ?? homeId(options.destination ?? process.cwd()), 'Home name'),
    runtime: RUNTIME,
    mode: options.mode ?? 'solo',
    providers: [...new Set(options.providers ?? ['codex', 'claude'])],
    ...(Object.keys(projection).length ? { projection } : {}),
    ...(Object.keys(settings).length ? { settings } : {}),
  }
}

export async function saveHome(root, home) {
  const document = homeDocument({
    name: home.name,
    mode: home.mode,
    providers: home.providers,
    projection: home.projection,
    settings: home.settings,
  })
  document.runtime = home.runtime
  await writeJsonAtomic(join(root, 'hairness.json'), document, 0o644)
  return document
}

export function deskDocument(options = {}) {
  return {
    $schema: API.desk,
    id: assertId(options.id ?? 'owner', 'Desk id'),
    ...(Object.keys(options.settings ?? {}).length ? { settings: options.settings } : {}),
  }
}

export async function saveDesk(root, desk) {
  await writeJsonAtomic(join(root, '.desk', 'desk.json'), deskDocument(desk), 0o644)
  return desk
}

export function settingsFor(document, asset) {
  return document?.settings?.[asset] ?? {}
}

export function updateSettings(document, asset, value) {
  document.settings ??= {}
  if (Object.keys(value).length) document.settings[asset] = value
  else delete document.settings[asset]
  return document
}
