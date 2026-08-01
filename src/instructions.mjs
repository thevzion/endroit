import { lstat, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { EndroitError } from './lib/errors.mjs'

export const HOME_INSTRUCTION = 'HOME.md'
export const DESK_INSTRUCTION = 'DESK.md'

const decoder = new TextDecoder('utf-8', { fatal: true })
const templates = {
  home: {
    path: fileURLToPath(new URL('../templates/HOME.md', import.meta.url)),
    variables: ['home.name'],
  },
  desk: {
    path: fileURLToPath(new URL('../templates/DESK.md', import.meta.url)),
    variables: ['desk.id', 'desk.member', 'home.name'],
  },
}

export async function renderInstructionTemplate(name, values) {
  const template = templates[name]
  if (!template) throw new EndroitError('template_unsupported', `Unsupported instruction template ${name}.`)
  const content = await readFile(template.path, 'utf8')
  const unknown = [...content.matchAll(/\{\{([^{}]+)\}\}/g)]
    .map((match) => match[1])
    .filter((key) => !template.variables.includes(key))
  if (unknown.length) throw new EndroitError('template_variable_unknown', `Unknown ${name} template variable ${unknown[0]}.`)
  const rendered = content.replace(/\{\{([^{}]+)\}\}/g, (_match, key) => {
    if (!(key in values)) throw new EndroitError('template_variable_missing', `Missing ${name} template variable ${key}.`)
    return String(values[key])
  })
  if (/\{\{[^{}]+\}\}/.test(rendered)) throw new EndroitError('template_variable_unknown', `${name} template contains an unresolved variable.`)
  return rendered
}

export async function readInstructionFile(path, label) {
  let info
  try {
    info = await lstat(path)
  } catch (error) {
    if (error.code === 'ENOENT') throw new EndroitError(`${label}_missing`, `${path} is required.`)
    throw error
  }
  if (info.isSymbolicLink()) throw new EndroitError(`${label}_symlink`, `${path} must not be a symbolic link.`)
  if (!info.isFile()) throw new EndroitError(`${label}_type`, `${path} must be a regular file.`)
  let content
  try {
    content = decoder.decode(await readFile(path))
  } catch (error) {
    throw new EndroitError(`${label}_encoding`, `${path} must be valid UTF-8.`, { cause: error })
  }
  if (!content.trim()) throw new EndroitError(`${label}_empty`, `${path} must not be empty.`)
  return content
}
