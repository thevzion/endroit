import { readFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { V9_API, renderDocument, validateDocumentV9 } from './documents.mjs'
import { EndroitError } from './lib/errors.mjs'
import { assertId, digest } from './lib/io.mjs'
import { findWorkplace, loadWorkplace } from './workplace.mjs'

const packageDocument = JSON.parse(await readFile(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'))
const workplaceTemplatePath = fileURLToPath(new URL('../templates/WORKPLACE.md', import.meta.url))

export const RUNTIME = `@endroit/cli@${packageDocument.version}`
export const WORKPLACE_INSTRUCTION = 'WORKPLACE.md'

export const findHome = findWorkplace

export async function loadHome(root) {
  const declaration = await loadWorkplace(root)
  const legacy = declaration.legacy_document ?? {}
  return {
    ...declaration.metadata,
    name: declaration.id,
    ...(declaration.metadata.emoji ?? legacy.emoji ? { emoji: declaration.metadata.emoji ?? legacy.emoji } : {}),
    ...(declaration.metadata.prefix ?? legacy.prefix ? { prefix: declaration.metadata.prefix ?? legacy.prefix } : {}),
    frontDoor: legacy.frontDoor ?? null,
    budgets: legacy.budgets ?? {},
    settings: declaration.metadata.settings ?? legacy.settings ?? {},
    declaration,
    legacy: declaration.legacy,
  }
}

export async function assertRuntime(root) {
  const workplace = await loadHome(root)
  if (workplace.runtime !== RUNTIME) {
    throw new EndroitError('runtime_mismatch', `This Workplace requires ${workplace.runtime}; run node ./endroit.mjs instead.`, { exitCode: 3 })
  }
  return workplace
}

export function workplaceId(destination) {
  const name = basename(resolve(destination)).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-|-$/g, '')
  return assertId(name || `workplace-${digest(resolve(destination)).slice(7, 15)}`, 'Workplace id')
}

export const homeId = workplaceId

export function workplaceDocument(options = {}) {
  const id = assertId(options.id ?? options.name ?? workplaceId(options.destination ?? process.cwd()), 'Workplace id')
  const owner = assertId(options.owner ?? options.memberId ?? 'owner', 'Member id')
  return {
    $schema: V9_API.workplace,
    kind: 'endroit/workplace',
    id,
    owner: `member:${owner}`,
    profile: 'endroit/0.10',
    protocol: 'open-workplace/0.2-draft',
    runtime: RUNTIME,
    providers: [...new Set(options.providers ?? ['codex', 'claude'])],
    ...(options.prefix ? { prefix: assertId(options.prefix, 'Workplace prefix') } : {}),
    ...(options.emoji ? { emoji: options.emoji } : {}),
    ...(options.settings && Object.keys(options.settings).length ? { settings: options.settings } : {}),
  }
}

export const homeDocument = workplaceDocument

export async function renderWorkplaceDocument(metadata, options = {}) {
  await validateDocumentV9(metadata, 'workplace')
  const template = await readFile(workplaceTemplatePath, 'utf8')
  const body = template.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n([\s\S]*)$/)?.[1]
  if (!body) throw new EndroitError('workplace_template_invalid', 'WORKPLACE.md template must contain frontmatter and a body.')
  return renderDocument({
    metadata,
    body: body.replaceAll('{{workplace.title}}', options.title ?? metadata.id),
  })
}
