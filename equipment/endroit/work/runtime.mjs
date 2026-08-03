#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto'
import { lstat, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

const KIND = 'endroit/work:item'
const REVIEW_STATES = ['accepted', 'changes-requested', 'blocked']
const WORK_CONTRACT = 'endroit/work/v1alpha2'
const LEGACY_CONTRACT = 'endroit/work/v1alpha1'
const decoder = new TextDecoder('utf-8', { fatal: true })

const HELP = {
  inspect: {
    usage: 'endroit work inspect <selector> [--json]',
    effect: 'read-only',
    summary: 'Inspect one Work Item and its typed contract.',
  },
  resolve: {
    usage: 'endroit work resolve <selector> [--json]',
    effect: 'read-only',
    summary: 'Calculate the deterministic Work Resolution Frontier.',
  },
  review: {
    usage: 'endroit work review [<selector>] [--json]',
    effect: 'read-only',
    summary: 'List ordered human review targets and local availability.',
  },
  'record-review': {
    usage: 'endroit work record-review <selector> <item-id|number> --status <accepted|changes-requested|blocked> [--note <text>] [--json]',
    effect: 'mutating — atomically records one review outcome in WORK.md',
    summary: 'Record one explicit review outcome without changing Artifact lifecycle.',
  },
}

try {
  const input = JSON.parse(await stdin())
  const { positionals, flags } = argumentsOf(input.argv)
  const [command, ...rest] = positionals
  if (flags.help) process.stdout.write(`${helpFor(command)}\n`)
  else {
    const value = await route(input, command, rest, flags)
    process.stdout.write(flags.json ? `${JSON.stringify(value, null, 2)}\n` : `${human(value)}\n`)
  }
} catch (error) {
  process.stderr.write(`${error.code ?? 'work_failed'}: ${error.message}\n`)
  process.exitCode = error.exitCode ?? 4
}

async function route(input, command, args, flags) {
  if (command === 'inspect') return inspectWork(input, required(args[0], 'Work selector'))
  if (command === 'resolve') return resolveWork(input, required(args[0], 'Work selector'))
  if (command === 'review') return reviewWork(input, args[0])
  if (command === 'record-review') {
    return recordReview(
      input,
      required(args[0], 'Work selector'),
      required(args[1], 'Review item'),
      required(flags.status, 'Review status'),
      flags.note,
    )
  }
  throw failure('usage', 'endroit work inspect|resolve|review|record-review', 2)
}

async function inspectWork(input, selector) {
  const { artifact, document, source } = await loadWork(input, selector)
  return {
    status: 'inspected',
    ref: artifact.ref,
    owner: artifact.owner,
    lifecycle: artifact.status,
    path: artifact.path,
    work: document,
    source: sourceDescription(source),
  }
}

async function resolveWork(input, selector) {
  const { artifact, document, source } = await loadWork(input, selector)
  return resolution(artifact, document, source)
}

async function reviewWork(input, selector) {
  const { artifact, document } = await loadWork(input, selector)
  const items = []
  for (let index = 0; index < document.review.length; index += 1) {
    const entry = document.review[index]
    items.push({
      index: index + 1,
      ...entry,
      availability: await targetAvailability(input, entry),
      provenance: document.sources.map((source) => source.ref),
    })
  }
  return {
    status: 'reviewed',
    ref: artifact.ref,
    owner: artifact.owner,
    items,
    pending: items.filter((entry) => entry.status === 'pending' || entry.status === 'changes-requested').length,
  }
}

async function recordReview(input, selector, itemSelector, status, note) {
  if (!REVIEW_STATES.includes(status)) {
    throw failure('review_status_invalid', `Review status must be one of ${REVIEW_STATES.join(', ')}.`, 2)
  }
  const { artifact, document, source, schema } = await loadWork(input, selector)
  if (source.format !== 'markdown') {
    throw failure(
      'work_legacy_read_only',
      'WORK.json v1alpha1 is supported for read-only compatibility. Migrate it explicitly to WORK.md before recording review.',
      3,
    )
  }
  const numeric = /^\d+$/.test(itemSelector) ? Number(itemSelector) - 1 : -1
  const index = numeric >= 0 ? numeric : document.review.findIndex((entry) => entry.id === itemSelector)
  if (index < 0 || index >= document.review.length) throw failure('review_item_missing', `${itemSelector} was not found.`)
  document.review[index] = {
    ...document.review[index],
    status,
    note: note === undefined || note === true ? document.review[index].note : String(note),
  }
  const errors = schemaErrors(document, schema)
  if (errors.length) throw failure('work_invalid', errors.join('; '), 3)
  const nextContent = replaceFragmentMetadata(source, document.review[index])
  const currentContent = await readUtf8(source.path)
  if (currentContent !== source.content) {
    throw failure('work_changed', 'WORK.md changed while the review was being recorded; reload and retry.', 3)
  }
  const temporary = join(dirname(source.path), `.WORK.${process.pid}.${randomUUID()}.tmp`)
  try {
    await writeFile(temporary, nextContent, { mode: source.mode })
    await rename(temporary, source.path)
  } finally {
    await rm(temporary, { force: true })
  }
  const completion = resolution(artifact, document, { ...source, content: nextContent }).completion
  return {
    status: 'recorded',
    ref: artifact.ref,
    item: document.review[index],
    lifecycleChanged: false,
    externalAuthorityInferred: false,
    completion,
    revision: digest(nextContent),
  }
}

async function loadWork(input, selector) {
  const artifact = selectWorkArtifact(input, selector)
  if (artifact.invalid) throw failure('artifact_invalid', artifact.invalid)
  const markdownPath = join(artifact.path, 'WORK.md')
  const legacyPath = join(artifact.path, 'WORK.json')
  const markdownStat = await fileStat(markdownPath)
  const legacyStat = await fileStat(legacyPath)
  if (markdownStat && legacyStat) {
    throw failure('work_source_collision', `${artifact.ref} contains both WORK.md and WORK.json; keep exactly one canonical Work source.`, 3)
  }
  if (!markdownStat && !legacyStat) throw failure('work_missing', `${artifact.ref} has no WORK.md or legacy WORK.json.`)

  let document
  let source
  let schemaPath
  if (markdownStat) {
    assertRegular(markdownStat, 'WORK.md')
    const content = await readUtf8(markdownPath)
    try {
      const parsed = parseWorkMarkdown(content)
      document = parsed.document
      source = { ...parsed.source, format: 'markdown', path: markdownPath, content, mode: markdownStat.mode & 0o777 }
    } catch (error) {
      throw failure('work_invalid', `Invalid WORK.md: ${error.message}`, 3)
    }
    schemaPath = join(input.equipmentRoot, 'schemas/v1alpha2.schema.json')
  } else {
    assertRegular(legacyStat, 'WORK.json')
    const content = await readUtf8(legacyPath)
    try { document = JSON.parse(content) }
    catch (error) { throw failure('work_invalid', `Invalid WORK.json: ${error.message}`, 3) }
    source = { format: 'json-v1alpha1', path: legacyPath, content, mode: legacyStat.mode & 0o777 }
    schemaPath = join(input.equipmentRoot, 'schemas/work.schema.json')
  }
  const schema = JSON.parse(await readFile(schemaPath, 'utf8'))
  const errors = schemaErrors(document, schema)
  if (errors.length) throw failure('work_invalid', errors.join('; '), 3)
  assertWorkIdentity(document, artifact)
  return { artifact, document, source, schema }
}

function assertWorkIdentity(document, artifact) {
  for (const [key, expected] of [['id', artifact.id], ['owner', artifact.owner], ['status', artifact.status], ['kind', KIND]]) {
    if (document[key] !== undefined && document[key] !== expected) {
      throw failure('work_identity_mismatch', `WORK source ${key} ${document[key]} does not match Artifact ${expected}.`, 3)
    }
  }
}

function selectWorkArtifact(input, selector) {
  const candidates = (input.inspection?.artifacts ?? []).filter((entry) => entry.kind === KIND)
  if (selector === undefined) {
    if (!candidates.length) throw failure('work_missing', 'No Work Items were found.')
    if (candidates.length > 1) throw failure('work_ambiguous', 'Several Work Items exist; pass an explicit selector.', 2)
    return candidates[0]
  }
  const selectedPath = resolve(selector)
  const selectedDirectory = ['artifact.md', 'WORK.md', 'WORK.json'].includes(basename(selectedPath))
    ? dirname(selectedPath)
    : selectedPath
  const matches = candidates.filter((entry) =>
    entry.id === selector
    || `${entry.kind}:${entry.id}` === selector
    || entry.ref === selector
    || resolve(entry.path) === selectedDirectory)
  if (!matches.length) throw failure('work_missing', `${selector} was not found.`)
  if (matches.length > 1) throw failure('work_ambiguous', `${selector} matches multiple Work Items.`, 2)
  return matches[0]
}

function resolution(artifact, work, source) {
  const missing = []
  const add = (frontier, code, message) => missing.push({ frontier, code, message })
  const sourceRefs = new Set(work.sources.map((entry) => entry.ref))
  const verificationIds = new Set(work.verification.map((entry) => entry.id))
  const authorities = work.sources.filter((entry) => entry.role === 'authority')

  if (!work.objective.trim()) add('object', 'objective_missing', 'Objective is empty.')
  if (!work.work_type?.trim()) add('contract', 'work_type_missing', 'Work type is unresolved.')
  if (!work.expected_effect?.trim()) add('contract', 'expected_effect_missing', 'Expected effect is unresolved.')
  if (!authorities.length) add('contract', 'authority_missing', 'No authority source is declared.')
  if (!work.obligations.length) add('contract', 'obligations_missing', 'No obligations are declared.')

  for (const claim of work.claims) {
    if (['supported', 'demonstrated'].includes(claim.maturity) && !claim.evidence.length) {
      add('execution-ready', 'claim_evidence_missing', `Claim ${claim.id} is ${claim.maturity} without evidence.`)
    }
  }
  for (const obligation of work.obligations.filter((entry) => entry.required)) {
    if (obligation.status !== 'satisfied') add('execution-ready', 'obligation_open', `Required obligation ${obligation.id} is ${obligation.status}.`)
    else if (!obligation.evidence.length) add('execution-ready', 'obligation_evidence_missing', `Required obligation ${obligation.id} has no evidence.`)
  }
  for (const contradiction of work.contradictions.filter((entry) => entry.status === 'open')) {
    add('execution-ready', 'contradiction_open', `Contradiction ${contradiction.id} is open.`)
  }

  for (const assignment of work.assignments) {
    const destination = assignment.destination
    if (!destination.owner?.trim() || (destination.site && !destination.route)) {
      add('placement', 'destination_missing', `Assignment ${assignment.id} has no complete destination.`)
    }
    if (!assignment.sources.length) add('execution-ready', 'assignment_sources_missing', `Assignment ${assignment.id} has no sources.`)
    for (const ref of assignment.sources.filter((entry) => !sourceRefs.has(entry))) {
      add('execution-ready', 'assignment_source_unknown', `Assignment ${assignment.id} references unknown source ${ref}.`)
    }
    if (!assignment.expected_effect?.trim()) add('execution-ready', 'assignment_effect_missing', `Assignment ${assignment.id} has no expected effect.`)
    if (!assignment.verification.length) add('execution-ready', 'assignment_verification_missing', `Assignment ${assignment.id} has no verification.`)
    for (const id of assignment.verification.filter((entry) => !verificationIds.has(entry))) {
      add('execution-ready', 'assignment_verification_unknown', `Assignment ${assignment.id} references unknown verification ${id}.`)
    }
    if (assignment.status === 'blocked') {
      add('closure-ready', 'assignment_blocked', `Assignment ${assignment.id} is blocked.`)
    } else if (assignment.status !== 'returned') {
      add('closure-ready', 'assignment_open', `Assignment ${assignment.id} is ${assignment.status}.`)
    }
  }
  if (!work.observed_result) add('closure-ready', 'observed_result_missing', 'No observed result is recorded.')
  for (const verification of work.verification.filter((entry) => entry.status === 'not-run')) {
    add('closure-ready', 'verification_not_run', `Verification ${verification.id} has not run.`)
  }
  for (const review of work.review.filter((entry) => ['pending', 'changes-requested'].includes(entry.status))) {
    add('closure-ready', 'review_pending', `Review ${review.id} is ${review.status}.`)
  }
  for (const review of work.review.filter((entry) => entry.status === 'blocked')) {
    add('closure-ready', 'review_blocked', `Review ${review.id} is blocked.`)
  }

  const has = (frontier) => missing.some((entry) => entry.frontier === frontier)
  const frontiers = {
    event: true,
    object: !has('object'),
    contract: false,
    placement: false,
    executionReady: false,
    closureReady: false,
  }
  frontiers.contract = frontiers.object && !has('contract')
  frontiers.placement = frontiers.contract && !has('placement')
  frontiers.executionReady = frontiers.placement && !has('execution-ready')
  frontiers.closureReady = frontiers.executionReady && !has('closure-ready')
  const frontier = [
    ['closure-ready', frontiers.closureReady],
    ['execution-ready', frontiers.executionReady],
    ['placement', frontiers.placement],
    ['contract', frontiers.contract],
    ['object', frontiers.object],
    ['event', frontiers.event],
  ].find(([, resolved]) => resolved)[0]

  const blocked = missing.some((entry) => ['contradiction_open', 'assignment_blocked', 'review_blocked'].includes(entry.code))
  return {
    status: 'resolved',
    ref: artifact.ref,
    owner: artifact.owner,
    lifecycle: artifact.status,
    frontier,
    frontiers,
    missing,
    contradictions: work.contradictions.filter((entry) => entry.status === 'open'),
    context: work.sources,
    assignments: work.assignments,
    reviewPending: work.review.filter((entry) => ['pending', 'changes-requested'].includes(entry.status)).length,
    authority: { inferred: false, sources: authorities.map((entry) => entry.ref) },
    completion: {
      contract: work.contract ?? work.version,
      revision: digest(source.content),
      status: frontiers.closureReady ? 'complete' : blocked ? 'blocked' : 'incomplete',
      missing: missing.map((entry) => entry.code),
    },
    source: sourceDescription(source),
  }
}

async function fileStat(path) {
  try { return await lstat(path) }
  catch (error) { if (error.code === 'ENOENT') return null; throw error }
}

async function readUtf8(path) {
  try { return decoder.decode(await readFile(path)) }
  catch (error) {
    if (error instanceof TypeError) throw failure('work_encoding_invalid', `${basename(path)} must be valid UTF-8.`, 3)
    throw error
  }
}

function assertRegular(stat, name) {
  if (stat.isSymbolicLink() || !stat.isFile()) throw failure('symlink_forbidden', `${name} must be a regular file.`)
}

function parseWorkMarkdown(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/)
  if (!match) throw new Error('WORK.md must start with a closed frontmatter block.')
  const metadata = parsePairs(match[1], 'frontmatter')
  const bodyOffset = content.length - match[2].length
  const sections = markdownSections(content, bodyOffset)
  const objectiveSections = sections.filter((entry) => entry.title.toLowerCase() === 'objective')
  const effectSections = sections.filter((entry) => entry.title.toLowerCase() === 'expected effect')
  if (objectiveSections.length !== 1) throw new Error('WORK.md requires exactly one ## Objective section.')
  if (effectSections.length !== 1) throw new Error('WORK.md requires exactly one ## Expected effect section.')

  const document = {
    ...metadata,
    objective: objectiveSections[0].content.trim(),
    expected_effect: effectSections[0].content.trim() || null,
    sources: [],
    claims: [],
    obligations: [],
    contradictions: [],
    assignments: [],
    verification: [],
    observed_result: null,
    review: [],
  }
  const ranges = new Map()
  const ids = new Set()
  for (const section of sections) {
    if ([...objectiveSections, ...effectSections].includes(section)) continue
    const block = parseFragmentBlock(section)
    const fragment = normalizeFragment(block.metadata, block.body)
    if (ids.has(fragment.id)) throw new Error(`Duplicate fragment id ${fragment.id}.`)
    ids.add(fragment.id)
    ranges.set(fragment.id, { start: block.metadataStart, end: block.metadataEnd, metadata: block.metadata })
    if (fragment.kind === 'source') document.sources.push(fragment.value)
    else if (fragment.kind === 'claim') document.claims.push(fragment.value)
    else if (fragment.kind === 'obligation') document.obligations.push(fragment.value)
    else if (fragment.kind === 'contradiction') document.contradictions.push(fragment.value)
    else if (fragment.kind === 'assignment') document.assignments.push(fragment.value)
    else if (fragment.kind === 'verification') document.verification.push(fragment.value)
    else if (fragment.kind === 'review') document.review.push(fragment.value)
    else if (fragment.kind === 'observed_result') {
      if (document.observed_result) throw new Error('WORK.md may contain only one observed_result fragment.')
      document.observed_result = fragment.value
    }
  }
  return { document, source: { ranges } }
}

function markdownSections(content, bodyOffset) {
  const headings = []
  const lines = content.slice(bodyOffset).split(/(?<=\n)/)
  let offset = bodyOffset
  let fence = null
  for (const lineWithBreak of lines) {
    const line = lineWithBreak.replace(/\r?\n$/, '')
    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/)
    if (fenceMatch) {
      const marker = fenceMatch[1][0]
      if (fence === marker) fence = null
      else if (!fence) fence = marker
    } else if (!fence) {
      const heading = line.match(/^##[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/)
      if (heading) headings.push({ title: heading[1].trim(), start: offset, contentStart: offset + lineWithBreak.length })
    }
    offset += lineWithBreak.length
  }
  return headings.map((heading, index) => {
    const end = headings[index + 1]?.start ?? content.length
    return { ...heading, end, content: content.slice(heading.contentStart, end) }
  })
}

function parseFragmentBlock(section) {
  const match = section.content.match(/^\s*```endroit[ \t]*\r?\n([\s\S]*?)\r?\n```(?:\r?\n|$)([\s\S]*)$/)
  if (!match) throw new Error(`## ${section.title} must start with one closed \`\`\`endroit block.`)
  const metadataOffset = match[0].indexOf(match[1])
  return {
    metadata: parsePairs(match[1], `fragment ${section.title}`),
    metadataStart: section.contentStart + metadataOffset,
    metadataEnd: section.contentStart + metadataOffset + match[1].length,
    body: match[2].trim(),
  }
}

function normalizeFragment(raw, body) {
  const metadata = { ...raw }
  const kind = metadata.kind
  delete metadata.kind
  if (!kind || typeof kind !== 'string') throw new Error('Every typed fragment requires a kind.')
  if (!metadata.id || typeof metadata.id !== 'string') throw new Error(`Fragment ${kind} requires an id.`)
  if (kind === 'claim') metadata.statement = body
  else if (kind === 'obligation' || kind === 'contradiction' || kind === 'verification') metadata.description = body
  else if (kind === 'assignment') metadata.objective = body
  else if (kind === 'observed_result') metadata.summary = body
  else if (kind === 'review') metadata.question = body
  else if (kind !== 'source') throw new Error(`Unsupported fragment kind ${kind}.`)
  return { id: metadata.id, kind, value: metadata }
}

function renameKey(value, from, to) {
  if (!Object.hasOwn(value, from)) return
  if (Object.hasOwn(value, to)) throw new Error(`Fragment cannot contain both ${from} and ${to}.`)
  value[to] = value[from]
  delete value[from]
}

function parsePairs(source, label) {
  const values = {}
  for (const [index, line] of source.split(/\r?\n/).entries()) {
    if (!line.trim()) throw new Error(`Blank line ${index + 1} in ${label}.`)
    const separator = line.indexOf(':')
    if (separator < 1) throw new Error(`Invalid line ${index + 1} in ${label}: ${line}`)
    const key = line.slice(0, separator).trim()
    const raw = line.slice(separator + 1).trim()
    if (!/^\$schema$|^[a-z][a-z0-9_]*$/.test(key)) throw new Error(`Invalid key ${key || '(empty)'} in ${label}.`)
    if (Object.hasOwn(values, key)) throw new Error(`Duplicate key ${key} in ${label}.`)
    if (!raw) throw new Error(`${key} in ${label} must have a value.`)
    try { values[key] = JSON.parse(raw) }
    catch (error) {
      if (/^[\[{\"]/.test(raw)) throw new Error(`${key} in ${label} must use valid inline JSON.`)
      values[key] = raw
    }
  }
  return values
}

function replaceFragmentMetadata(source, review) {
  const range = source.ranges.get(review.id)
  if (!range) throw failure('review_fragment_missing', `Review ${review.id} has no addressable fragment in WORK.md.`, 3)
  const metadata = { ...range.metadata, status: review.status, note: review.note }
  const rendered = Object.entries(metadata).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n')
  return `${source.content.slice(0, range.start)}${rendered}${source.content.slice(range.end)}`
}

function sourceDescription(source) {
  if (source.format === 'markdown') {
    return { format: 'WORK.md', contract: WORK_CONTRACT, revision: digest(source.content) }
  }
  return {
    format: 'WORK.json',
    contract: LEGACY_CONTRACT,
    revision: digest(source.content),
    compatibility: {
      status: 'deprecated-read-only',
      removal: 'Remove the v1alpha1 reader after all retained Work Items have been explicitly migrated to WORK.md.',
    },
  }
}

function digest(content) {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`
}

async function targetAvailability(input, entry) {
  if (entry.target_kind === 'url') {
    try {
      const url = new URL(entry.target)
      return { status: ['http:', 'https:'].includes(url.protocol) ? 'addressable' : 'invalid', checked: 'syntax-only' }
    } catch { return { status: 'invalid', checked: 'syntax-only' } }
  }
  const path = isAbsolute(entry.target) ? entry.target : resolve(input.homeRoot, entry.target)
  try {
    const stat = await lstat(path)
    return { status: stat.isSymbolicLink() ? 'invalid' : 'available', path }
  } catch (error) {
    if (error.code === 'ENOENT') return { status: 'missing', path }
    throw error
  }
}

function schemaErrors(value, schema) {
  const errors = []
  const visit = (site, rule, path = '$') => {
    if (rule.$ref) {
      const target = rule.$ref.split('/').slice(1).reduce((current, segment) => current?.[segment.replaceAll('~1', '/').replaceAll('~0', '~')], schema)
      if (!target) errors.push(`${path} references unknown schema ${rule.$ref}`)
      else visit(site, target, path)
      return
    }
    if (rule.anyOf) {
      const branches = rule.anyOf.map((branch) => {
        const before = errors.length
        visit(site, branch, path)
        const branchErrors = errors.splice(before)
        return branchErrors
      })
      if (!branches.some((branch) => branch.length === 0)) errors.push(`${path} does not match any allowed shape`)
      return
    }
    if (rule.const !== undefined && site !== rule.const) errors.push(`${path} must equal ${JSON.stringify(rule.const)}`)
    if (rule.enum && !rule.enum.includes(site)) errors.push(`${path} must be one of ${rule.enum.join(', ')}`)
    if (rule.type && !matchesType(site, rule.type)) {
      errors.push(`${path} must be ${Array.isArray(rule.type) ? rule.type.join(' or ') : rule.type}`)
      return
    }
    if (typeof site === 'string') {
      if (rule.minLength && site.length < rule.minLength) errors.push(`${path} must not be empty`)
      if (rule.maxLength && site.length > rule.maxLength) errors.push(`${path} is too long`)
      if (rule.pattern && !new RegExp(rule.pattern).test(site)) errors.push(`${path} has an invalid format`)
    }
    if (Array.isArray(site)) {
      if (rule.minItems && site.length < rule.minItems) errors.push(`${path} has too few items`)
      if (rule.items) site.forEach((entry, index) => visit(entry, rule.items, `${path}[${index}]`))
    } else if (site && typeof site === 'object') {
      for (const key of rule.required ?? []) if (!(key in site)) errors.push(`${path}.${key} is required`)
      if (rule.additionalProperties === false) {
        for (const key of Object.keys(site)) if (!(key in (rule.properties ?? {}))) errors.push(`${path}.${key} is not allowed`)
      }
      for (const [key, child] of Object.entries(rule.properties ?? {})) if (key in site) visit(site[key], child, `${path}.${key}`)
    }
  }
  visit(value, schema)
  return errors
}

function matchesType(value, expected) {
  const types = Array.isArray(expected) ? expected : [expected]
  return types.some((type) => {
    if (type === 'null') return value === null
    if (type === 'array') return Array.isArray(value)
    if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value)
    return typeof value === type
  })
}

function argumentsOf(argv) {
  const flags = {}
  const positionals = []
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (!value.startsWith('--')) { positionals.push(value); continue }
    const [name, inline] = value.slice(2).split('=', 2)
    const next = inline ?? (argv[index + 1] && !argv[index + 1].startsWith('-') ? argv[++index] : true)
    if (flags[name] === undefined) flags[name] = next
    else flags[name] = Array.isArray(flags[name]) ? [...flags[name], next] : [flags[name], next]
  }
  return { flags, positionals }
}

function human(value) {
  if (value.status === 'inspected') return `${value.ref}\n${JSON.stringify(value.work, null, 2)}`
  if (value.status === 'resolved') {
    const lines = [`${value.ref} · ${value.frontier}`]
    for (const missing of value.missing) lines.push(`- ${missing.code}: ${missing.message}`)
    return lines.join('\n')
  }
  if (value.status === 'reviewed') {
    if (!value.items.length) return `${value.ref}\nNo review items.`
    return [value.ref, ...value.items.map((entry) => `${entry.index}. [${entry.status}] ${entry.label} — ${entry.target}`)].join('\n')
  }
  return `${value.status}: ${value.item?.id ?? value.ref}`
}

function helpFor(command) {
  if (!command) {
    return [
      'Usage: endroit work <command> [options]',
      '',
      'Commands:',
      ...Object.entries(HELP).map(([name, entry]) => `  ${name.padEnd(14)} ${entry.summary}`),
    ].join('\n')
  }
  const entry = HELP[command]
  if (!entry) throw failure('usage', `Unknown Work command ${command}.`, 2)
  return [`Usage: ${entry.usage}`, `Effect: ${entry.effect}`, '', entry.summary].join('\n')
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
