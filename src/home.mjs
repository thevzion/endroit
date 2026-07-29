import { readFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { API, validateDocument } from './contracts.mjs'
import { HairnessError } from './lib/errors.mjs'
import { assertId, digest, readJson } from './lib/io.mjs'

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
  home.settings ??= {}
  return home
}

export async function assertRuntime(root) {
  const home = await loadHome(root)
  if (home.runtime !== RUNTIME) {
    throw new HairnessError('runtime_mismatch', `This Home requires ${home.runtime}; run node ./hairness.mjs instead.`, { exitCode: 3 })
  }
  return home
}

export function homeId(destination) {
  const name = basename(resolve(destination)).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-|-$/g, '')
  return assertId(name || `home-${digest(resolve(destination)).slice(7, 15)}`, 'Home id')
}

export function homeDocument(options = {}) {
  const settings = options.settings ?? {}
  const budgets = options.budgets ?? {}
  return {
    $schema: API.home,
    name: assertId(options.name ?? homeId(options.destination ?? process.cwd()), 'Home name'),
    ...(options.emoji ? { emoji: options.emoji } : {}),
    runtime: RUNTIME,
    mode: options.mode ?? 'solo',
    providers: [...new Set(options.providers ?? ['codex', 'claude'])],
    ...(options.prefix ? { prefix: assertId(options.prefix, 'Home prefix') } : {}),
    ...(options.frontDoor ? { frontDoor: options.frontDoor } : {}),
    ...(Object.keys(budgets).length ? { budgets } : {}),
    ...(Object.keys(settings).length ? { settings } : {}),
  }
}
