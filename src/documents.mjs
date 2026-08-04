import { lstat, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import Ajv2020 from 'ajv/dist/2020.js'
import { EndroitError } from './lib/errors.mjs'
import { digest } from './lib/io.mjs'

export const V9_API = Object.freeze({
  document: 'https://endroit.org/schema/v9/document.json',
  profile: 'https://endroit.org/schema/v9/profile.json',
  workplace: 'https://endroit.org/schema/v9/workplace.json',
  member: 'https://endroit.org/schema/v9/member.json',
  desk: 'https://endroit.org/schema/v9/desk.json',
  room: 'https://endroit.org/schema/v9/room.json',
  site: 'https://endroit.org/schema/v9/site.json',
  route: 'https://endroit.org/schema/v9/route.json',
  equipment: 'https://endroit.org/schema/v9/equipment.json',
  artifact: 'https://endroit.org/schema/v9/artifact.json',
})

export const CONTRACT_API = Object.freeze({
  work_v1alpha2: 'https://endroit.org/schema/work/v1alpha2.json',
})

const schemaNames = Object.keys(V9_API)
const legacySchemaNames = ['home', 'desk', 'member', 'equipment', 'site', 'route', 'runtime', 'artifact']
const LEGACY_API = Object.freeze({
  home: 'https://endroit.org/schema/v7/home.json',
  equipment: 'https://endroit.org/schema/v7/equipment.json',
  desk: 'https://endroit.org/schema/v7/desk.json',
  member: 'https://endroit.org/schema/v7/member.json',
  site: 'https://endroit.org/schema/v7/site.json',
  route: 'https://endroit.org/schema/v8/route.json',
  route_v7: 'https://endroit.org/schema/v7/route.json',
  artifact: 'https://endroit.org/schema/v7/artifact.json',
  runtime: 'https://endroit.org/schema/v7/runtime.json',
})
const decoder = new TextDecoder('utf-8', { fatal: true })
let validatorsPromise

export async function readDocument(path) {
  const bytes = await readSourceBytes(path)
  return { ...parseDocument(bytes, { path }), path }
}

export async function inspectDocumentDeclaration(path, type) {
  const schema = V9_API[type]
  if (!schema) throw new EndroitError('document_unsupported', `Unsupported v9 document type ${type}.`)
  try {
    const document = await readDocument(path)
    return document.metadata.kind === `endroit/${type}` || document.metadata.$schema === schema ? document : null
  } catch (error) {
    if (error.code === 'document_missing') return null
    if (['document_symlink', 'document_type', 'document_encoding'].includes(error.code)) throw error
    if (await sourceClaimsDeclaration(path, `endroit/${type}`, schema)) throw error
    return null
  }
}

export async function readSourceText(path) {
  return decodeSource(await readSourceBytes(path), path)
}

export function parseDocument(input, options = {}) {
  const path = options.path ?? 'Document'
  const bytes = typeof input === 'string' ? Buffer.from(input) : Buffer.from(input)
  const content = typeof input === 'string' ? input : decodeSource(bytes, path)
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/)
  if (!match) throw new EndroitError('document_frontmatter_missing', `${path} must start with a closed frontmatter block.`)
  const metadata = parseMetadata(match[1], path)
  const body = match[2]
  const sections = parseSections(body, path)
  const fragments = sections.flatMap((section) => section.fragment ? [section.fragment] : [])
  return {
    metadata,
    body,
    sections,
    fragments,
    source_digest: documentDigest(bytes),
  }
}

export function extractSection(document, heading) {
  const expected = normalizeHeading(heading)
  return document.sections.find((section) => normalizeHeading(section.title) === expected) ?? null
}

export function documentDigest(bytes) {
  return digest(typeof bytes === 'string' ? Buffer.from(bytes) : bytes)
}

export function renderFrontmatter(metadata) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new EndroitError('document_metadata_invalid', 'Document metadata must be an object.')
  }
  const preferred = ['$schema', 'kind', 'id', 'owner']
  const keys = [
    ...preferred.filter((key) => Object.hasOwn(metadata, key)),
    ...Object.keys(metadata).filter((key) => !preferred.includes(key)).sort(),
  ]
  return ['---', ...keys.map((key) => `${key}: ${stableJson(metadata[key], key)}`), '---'].join('\n')
}

export function renderDocument(document) {
  const body = String(document.body ?? '').replace(/^\r?\n/, '').trimEnd()
  return `${renderFrontmatter(document.metadata)}\n\n${body}${body ? '\n' : ''}`
}

export async function validateDocumentV9(document, type) {
  const resolvedType = type ?? schemaNames.find((name) => V9_API[name] === document?.$schema)
  if (!resolvedType || !V9_API[resolvedType]) throw new EndroitError('document_unsupported', `Unsupported v9 document type ${resolvedType ?? '(unknown)'}.`)
  if (document?.$schema !== V9_API[resolvedType]) {
    throw new EndroitError(
      'schema_version_mismatch',
      `Unsupported ${resolvedType} schema ${document?.$schema ?? '(missing)'}; Endroit 0.10 requires ${V9_API[resolvedType]}.`,
      { exitCode: 3 },
    )
  }
  return validateWith(document, V9_API[resolvedType], resolvedType)
}

export async function validateLegacyDocument(document, type) {
  if (!legacySchemaNames.includes(type)) throw new EndroitError('document_unsupported', `Unsupported legacy document type ${type}.`)
  const expected = type === 'route'
    ? [LEGACY_API.route_v7, LEGACY_API.route]
    : [LEGACY_API[type]]
  const schema = type === 'runtime' ? LEGACY_API.runtime : document?.$schema
  if (!expected.includes(schema)) {
    throw new EndroitError(
      'schema_version_mismatch',
      `Unsupported ${type} schema ${schema ?? '(missing)'}; the 0.10 compatibility adapter reads ${expected.join(' or ')}.`,
      { exitCode: 3 },
    )
  }
  return validateWith(document, schema, type)
}

export async function compileSchemasV9() {
  await validators()
  return [...schemaNames]
}

export async function validateContract(document, contract = 'work_v1alpha2') {
  const schema = CONTRACT_API[contract]
  if (!schema) throw new EndroitError('contract_unsupported', `Unsupported contract ${contract}.`)
  if (document?.$schema !== schema) {
    throw new EndroitError('schema_version_mismatch', `Unsupported ${contract} schema ${document?.$schema ?? '(missing)'}; expected ${schema}.`, { exitCode: 3 })
  }
  return validateWith(document, schema, contract)
}

async function readSourceBytes(path) {
  let info
  try {
    info = await lstat(path)
  } catch (error) {
    if (error.code === 'ENOENT') throw new EndroitError('document_missing', `${path} does not exist.`)
    throw error
  }
  if (info.isSymbolicLink()) throw new EndroitError('document_symlink', `${path} must not be a symbolic link.`)
  if (!info.isFile()) throw new EndroitError('document_type', `${path} must be a regular file.`)
  return readFile(path)
}

function decodeSource(bytes, path) {
  try {
    return decoder.decode(bytes)
  } catch (error) {
    throw new EndroitError('document_encoding', `${path} must be valid UTF-8.`, { cause: error })
  }
}

async function sourceClaimsDeclaration(path, kind, schema) {
  let content
  try { content = decodeSource(await readFile(path), path) }
  catch { return true }
  const frontmatter = content.match(/^---\r?\n([\s\S]*?)(?:\r?\n---|$)/)?.[1] ?? ''
  return frontmatter.split(/\r?\n/).some((line) => {
    const separator = line.indexOf(':')
    if (separator < 1) return false
    const key = line.slice(0, separator).trim()
    const value = line.slice(separator + 1).trim().replace(/^["']|["']$/g, '')
    return (key === 'kind' && value === kind) || (key === '$schema' && value === schema)
  })
}

function parseMetadata(source, path) {
  const metadata = {}
  for (const [index, line] of source.split(/\r?\n/).entries()) {
    if (!line.trim()) throw new EndroitError('document_frontmatter_line_invalid', `Blank frontmatter line ${index + 1} in ${path}.`)
    const separator = line.indexOf(':')
    if (separator < 1) throw new EndroitError('document_frontmatter_line_invalid', `Invalid frontmatter line ${index + 1} in ${path}: ${line}`)
    const key = line.slice(0, separator).trim()
    const raw = line.slice(separator + 1).trim()
    if (!/^\$schema$|^[a-z][a-z0-9_]*$/.test(key)) {
      throw new EndroitError('document_frontmatter_key_invalid', `Invalid frontmatter key ${key || '(empty)'} in ${path}.`)
    }
    if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new EndroitError('document_frontmatter_key_invalid', `Unsafe frontmatter key ${key} in ${path}.`)
    if (Object.hasOwn(metadata, key)) throw new EndroitError('document_frontmatter_duplicate', `Duplicate frontmatter key ${key} in ${path}.`)
    if (!raw) throw new EndroitError('document_frontmatter_value_invalid', `Frontmatter key ${key} in ${path} must have a value.`)
    metadata[key] = parseInlineValue(raw, key, path)
  }
  return metadata
}

function parseInlineValue(raw, key, path) {
  try {
    return JSON.parse(raw)
  } catch (error) {
    if (/^[\[{"']/.test(raw) || /^[&*!|>]/.test(raw)) {
      throw new EndroitError('document_frontmatter_value_invalid', `Frontmatter key ${key} in ${path} must use valid inline JSON or a bare scalar.`, { cause: error })
    }
    return raw
  }
}

function parseSections(body, path) {
  const lines = body.split(/(?<=\n)/)
  const headings = []
  let offset = 0
  let fence = null
  for (const lineWithBreak of lines) {
    const line = lineWithBreak.replace(/\r?\n$/, '')
    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/)
    if (fenceMatch) {
      const marker = fenceMatch[1][0]
      if (fence === marker) fence = null
      else if (!fence) fence = marker
    } else if (!fence) {
      const heading = line.match(/^(#{1,6})[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/)
      if (heading) headings.push({ level: heading[1].length, title: heading[2].trim(), start: offset, contentStart: offset + lineWithBreak.length })
    }
    offset += lineWithBreak.length
  }
  return headings.map((heading, index) => {
    const next = headings.slice(index + 1).find((candidate) => candidate.level <= heading.level)
    const content = body.slice(heading.contentStart, next?.start ?? body.length).trim()
    const fragment = parseFragment(content, heading, path)
    return {
      heading: `${'#'.repeat(heading.level)} ${heading.title}`,
      title: heading.title,
      level: heading.level,
      body: content,
      ...(fragment ? { fragment } : {}),
    }
  })
}

function parseFragment(content, heading, path) {
  const match = content.match(/(?:^|\n)```endroit[ \t]*\r?\n([\s\S]*?)\r?\n```(?=\r?\n|$)/)
  if (!match) return null
  const metadata = parseMetadata(match[1], `${path}#${heading.title}`)
  const before = content.slice(0, match.index).trim()
  const after = content.slice(match.index + match[0].length).trim()
  return {
    ...metadata,
    heading: heading.title,
    level: heading.level,
    metadata,
    body: [before, after].filter(Boolean).join('\n\n'),
  }
}

async function validators() {
  validatorsPromise ??= (async () => {
    const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false })
    const values = new Map()
    for (const name of legacySchemaNames) {
      const path = fileURLToPath(new URL(`../schemas/v7/${name}.schema.json`, import.meta.url))
      const schema = JSON.parse(await readFile(path, 'utf8'))
      values.set(schema.$id, ajv.compile(schema))
    }
    {
      const path = fileURLToPath(new URL('../schemas/v8/route.schema.json', import.meta.url))
      const schema = JSON.parse(await readFile(path, 'utf8'))
      values.set(schema.$id, ajv.compile(schema))
    }
    {
      const path = fileURLToPath(new URL('../schemas/work/v1alpha2.json', import.meta.url))
      const schema = JSON.parse(await readFile(path, 'utf8'))
      values.set(schema.$id, ajv.compile(schema))
    }
    for (const name of schemaNames) {
      const path = fileURLToPath(new URL(`../schemas/v9/${name}.schema.json`, import.meta.url))
      const schema = JSON.parse(await readFile(path, 'utf8'))
      values.set(schema.$id, ajv.compile(schema))
    }
    return values
  })()
  return validatorsPromise
}

async function validateWith(document, schema, type) {
  const validate = (await validators()).get(schema)
  if (!validate) throw new EndroitError('document_unsupported', `Unsupported schema ${schema}.`)
  if (!validate(document)) {
    const message = validate.errors.map((error) => `${error.instancePath || '/'} ${error.message}`).join('; ')
    throw new EndroitError('document_invalid', `Invalid ${type}: ${message}.`, { details: { errors: validate.errors } })
  }
  return document
}

function normalizeHeading(value) {
  return String(value).replace(/^#{1,6}\s+/, '').trim().toLowerCase()
}

function stableJson(value, key) {
  if (value === undefined) throw new EndroitError('document_metadata_invalid', `Document metadata ${key} must not be undefined.`)
  const rendered = JSON.stringify(sortValue(value))
  if (rendered === undefined) throw new EndroitError('document_metadata_invalid', `Document metadata ${key} is not JSON serializable.`)
  return rendered
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortValue(value[key])]))
}
