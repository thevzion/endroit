#!/usr/bin/env node
import { randomUUID } from 'node:crypto'
import { lstat, readFile, rename, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

const KIND = 'endroit/work:item'
const REVIEW_STATES = ['accepted', 'changes-requested', 'blocked']

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
    effect: 'mutating — atomically records one review outcome in WORK.json',
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
  const { artifact, document } = await loadWork(input, selector)
  return {
    status: 'inspected',
    ref: artifact.ref,
    owner: artifact.owner,
    lifecycle: artifact.status,
    path: artifact.path,
    work: document,
  }
}

async function resolveWork(input, selector) {
  const { artifact, document } = await loadWork(input, selector)
  return resolution(artifact, document)
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
  const { artifact, document, workPath, schema } = await loadWork(input, selector)
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
  const temporary = join(dirname(workPath), `.WORK.${process.pid}.${randomUUID()}.tmp`)
  await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o644 })
  await rename(temporary, workPath)
  return {
    status: 'recorded',
    ref: artifact.ref,
    item: document.review[index],
    lifecycleChanged: false,
    externalAuthorityInferred: false,
  }
}

async function loadWork(input, selector) {
  const artifact = selectWorkArtifact(input, selector)
  if (artifact.invalid) throw failure('artifact_invalid', artifact.invalid)
  const workPath = join(artifact.path, 'WORK.json')
  const stat = await lstat(workPath).catch((error) => {
    if (error.code === 'ENOENT') throw failure('work_missing', `${artifact.ref} has no WORK.json.`)
    throw error
  })
  if (stat.isSymbolicLink() || !stat.isFile()) throw failure('symlink_forbidden', 'WORK.json must be a regular file.')
  let document
  try { document = JSON.parse(await readFile(workPath, 'utf8')) }
  catch (error) { throw failure('work_invalid', `Invalid WORK.json: ${error.message}`, 3) }
  const schema = JSON.parse(await readFile(join(input.equipmentRoot, 'schemas/work.schema.json'), 'utf8'))
  const errors = schemaErrors(document, schema)
  if (errors.length) throw failure('work_invalid', errors.join('; '), 3)
  return { artifact, document, workPath, schema }
}

function selectWorkArtifact(input, selector) {
  const candidates = (input.artifacts ?? []).filter((entry) => entry.kind === KIND)
  if (selector === undefined) {
    if (!candidates.length) throw failure('work_missing', 'No Work Items were found.')
    if (candidates.length > 1) throw failure('work_ambiguous', 'Several Work Items exist; pass an explicit selector.', 2)
    return candidates[0]
  }
  const selectedPath = resolve(selector)
  const selectedDirectory = basename(selectedPath) === 'artifact.md' || basename(selectedPath) === 'WORK.json'
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

function resolution(artifact, work) {
  const missing = []
  const add = (frontier, code, message) => missing.push({ frontier, code, message })
  const sourceRefs = new Set(work.sources.map((entry) => entry.ref))
  const verificationIds = new Set(work.verification.map((entry) => entry.id))
  const authorities = work.sources.filter((entry) => entry.role === 'authority')

  if (!work.objective.trim()) add('object', 'objective_missing', 'Objective is empty.')
  if (!work.workType?.trim()) add('contract', 'work_type_missing', 'Work type is unresolved.')
  if (!work.expectedEffect?.trim()) add('contract', 'expected_effect_missing', 'Expected effect is unresolved.')
  if (!authorities.length) add('contract', 'authority_missing', 'No authority source is declared.')
  if (!work.obligations.length) add('contract', 'obligations_missing', 'No obligations are declared.')

  for (const claim of work.claims) {
    if (['current', 'verified'].includes(claim.status) && !claim.evidence.length) {
      add('execution-ready', 'claim_evidence_missing', `Claim ${claim.id} is ${claim.status} without evidence.`)
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
    if (!assignment.expectedEffect?.trim()) add('execution-ready', 'assignment_effect_missing', `Assignment ${assignment.id} has no expected effect.`)
    if (!assignment.verification.length) add('execution-ready', 'assignment_verification_missing', `Assignment ${assignment.id} has no verification.`)
    for (const id of assignment.verification.filter((entry) => !verificationIds.has(entry))) {
      add('execution-ready', 'assignment_verification_unknown', `Assignment ${assignment.id} references unknown verification ${id}.`)
    }
    if (!['returned', 'blocked'].includes(assignment.status)) {
      add('closure-ready', 'assignment_open', `Assignment ${assignment.id} is ${assignment.status}.`)
    }
  }
  if (!work.observedResult) add('closure-ready', 'observed_result_missing', 'No observed result is recorded.')
  for (const verification of work.verification.filter((entry) => entry.status === 'not-run')) {
    add('closure-ready', 'verification_not_run', `Verification ${verification.id} has not run.`)
  }
  for (const review of work.review.filter((entry) => ['pending', 'changes-requested'].includes(entry.status))) {
    add('closure-ready', 'review_pending', `Review ${review.id} is ${review.status}.`)
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
  }
}

async function targetAvailability(input, entry) {
  if (entry.kind === 'url') {
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
