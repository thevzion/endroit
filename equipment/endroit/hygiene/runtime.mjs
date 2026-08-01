#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { lstat, readFile, readdir } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)

try {
  const input = JSON.parse(await stdin())
  const { positionals, flags } = argumentsOf(input.argv)
  const [command] = positionals
  const result = command === 'maintain'
    ? await maintain(input)
    : command === 'repair'
      ? await repair(input, flags)
      : fail('usage', 'endroit hygiene maintain|repair --finding <id> --approve <id>', 2)
  process.stdout.write(flags.json ? `${JSON.stringify(result, null, 2)}\n` : `${human(result)}\n`)
} catch (error) {
  process.stderr.write(`${error.code ?? 'hygiene_failed'}: ${error.message}\n`)
  process.exitCode = error.exitCode ?? 4
}

async function maintain(input) {
  const findings = []
  const add = (category, code, message, path) => findings.push({
    id: `${code}${path ? `:${path}` : ''}`,
    category,
    code,
    message,
    ...(path ? { path } : {}),
  })
  const plan = input.resolvedHome
  const [roomDoctor, siteDoctor, materialInventory] = await Promise.all([
    component(input, 'rooms', ['doctor', '--json']),
    component(input, 'sites', ['doctor', '--json']),
    component(input, 'artifacts', ['list', '--json']),
  ])
  const homeDoctor = input.inspection?.homeDoctor ?? { limits: ['home-doctor-unavailable'], warnings: [] }
  for (const limit of homeDoctor.limits ?? []) {
    if (limit === 'build:build_stale') add('confirmed', 'projections-stale', 'Generated projections are missing or stale relative to the resolved Home build.')
    else if (limit === 'build:generated_output_diverged') add('confirmed', 'projection-diverged', 'A generated projection was edited; inspect the source/diff before replacing it.')
    else add('confirmed', 'home-doctor', limit)
  }
  for (const warning of homeDoctor.warnings ?? []) {
    add(warning.startsWith('legacy-') ? 'legacy' : 'improvements', warning.split(':')[0], warning)
  }
  for (const issue of roomDoctor.issues ?? []) {
    const category = issue.code === 'room_id_duplicate' ? 'ambiguities' : issue.code.startsWith('legacy_') ? 'legacy' : 'confirmed'
    add(category, issue.code, issue.message ?? JSON.stringify(issue), issue.path)
  }
  for (const limit of siteDoctor.limits ?? []) add('confirmed', 'site-doctor', limit)
  for (const artifact of materialInventory.artifacts ?? []) {
    if (artifact.legacy) add('legacy', 'legacy-artifact', 'Material remains in a pre-0.8 read-only location.', relative(input.homeRoot, artifact.path))
    if (artifact.invalid) add('ambiguities', 'material-invalid', artifact.invalid, relative(input.homeRoot, artifact.path))
  }
  if (!plan.desk) add('improvements', 'desk-missing', 'No Desk is configured; add one only when local continuity is needed.')

  for (const room of plan.rooms ?? []) {
    const directory = room.scope === 'home' ? join(input.homeRoot, 'rooms', room.id) : join(input.deskRoot, 'rooms', room.id)
    const files = await filesUnder(directory)
    if (files.length > 100) add('improvements', 'room-too-broad', `${room.ref} contains ${files.length} files; consider a child Room when ownership has split.`, relative(input.homeRoot, directory))
  }

  for (const [label, path] of [['home Artifacts', join(input.homeRoot, 'artifacts')], ['Desk Artifacts', input.deskRoot && join(input.deskRoot, 'artifacts')]]) {
    if (path && await safeLstat(path)) add('legacy', 'legacy-artifacts-root', `${label} use the pre-0.8 root and remain read-only until explicitly migrated.`, relative(input.homeRoot, path))
  }

  const materialRoots = [join(input.homeRoot, 'members'), join(input.homeRoot, 'rooms'), input.deskRoot && join(input.deskRoot, 'rooms')].filter(Boolean)
  const markdown = (await Promise.all(materialRoots.map(filesUnder))).flat().filter((path) => path.endsWith('.md'))
  const digests = new Map()
  const roomRefs = new Set((plan.rooms ?? []).map((room) => room.ref))
  for (const path of markdown) {
    const rel = relative(input.homeRoot, path)
    const content = await readFile(path, 'utf8')
    if (content.length > 64 * 1024) add('improvements', 'document-overloaded', `${rel} exceeds 64 KiB; split it only if readers cannot navigate it reliably.`, rel)
    if (/\/(?:AGENTS|CLAUDE)\.md$/.test(path)) add('ambiguities', 'instruction-misplaced', `${rel} is inside owned Material; canonical instructions belong to Home, Desk or Equipment sources.`, rel)
    const hash = createHash('sha256').update(content.trim()).digest('hex')
    const duplicate = digests.get(hash)
    if (content.trim() && duplicate) add('improvements', 'document-duplicate', `${rel} duplicates ${duplicate}; keep both only when ownership requires it.`, rel)
    else digests.set(hash, rel)
    if (path.endsWith('/artifact.md')) {
      const owner = content.match(/^owner:\s*"?([^"\r\n]+)"?$/m)?.[1]
      if (!owner) add('ambiguities', 'material-owner-ambiguous', `${rel} has no explicit owner.`, rel)
      else if (owner.startsWith('room:') && !roomRefs.has(owner)) add('ambiguities', 'material-owner-missing', `${rel} names missing ${owner}.`, rel)
      const sites = content.match(/^sites:\s*(.+)$/m)?.[1]
      if (sites) {
        try { if (JSON.parse(sites).length > 1) add('ambiguities', 'delivery-destination-ambiguous', `${rel} names multiple Sites; select one before delivery.`, rel) } catch {}
      }
    }
  }

  const legacySkills = await readdir(join(input.homeRoot, '.agents', 'skills'), { withFileTypes: true }).catch((error) => error.code === 'ENOENT' ? [] : Promise.reject(error))
  for (const entry of legacySkills.filter((item) => item.isDirectory() && /^(?:endroit-context-|endroit-routing-refresh)/.test(item.name))) {
    const skill = await safeLstat(join(input.homeRoot, '.agents', 'skills', entry.name, 'SKILL.md'))
    if (!skill?.isFile()) continue
    add('legacy', 'legacy-public-gesture', `${entry.name} uses the superseded pick/refresh grammar.`, `.agents/skills/${entry.name}`)
  }

  const categories = {
    confirmedInconsistencies: findings.filter((finding) => finding.category === 'confirmed'),
    ownershipAmbiguities: findings.filter((finding) => finding.category === 'ambiguities'),
    legacyResidue: findings.filter((finding) => finding.category === 'legacy'),
    optionalImprovements: findings.filter((finding) => finding.category === 'improvements'),
  }
  return { status: findings.length ? 'attention' : 'healthy', readOnly: true, findings, ...categories }
}

async function repair(input, flags) {
  const finding = required(flags.finding, 'Finding')
  if (flags.approve !== finding) fail('repair_approval_required', `Pass --approve ${finding} to approve exactly this repair.`, 6)
  const before = await maintain(input)
  if (!before.findings.some((entry) => entry.id === finding)) fail('finding_missing', `${finding} is not present in the current inspection.`)
  if (finding !== 'projections-stale') fail('repair_unsupported', `${finding} has no automatic repair; use the named existing operation explicitly.`)
  await exec(process.execPath, [join(input.homeRoot, 'endroit.mjs'), 'build'], { cwd: input.homeRoot })
  const { stdout } = await exec(process.execPath, [join(input.homeRoot, 'endroit.mjs'), 'hygiene', 'maintain', '--json'], { cwd: input.homeRoot, maxBuffer: 20 * 1024 * 1024 })
  return { status: 'repaired', finding, operation: 'endroit build', after: JSON.parse(stdout) }
}

async function component(input, id, argv) {
  const entry = join(input.equipmentRoot, '..', id, 'runtime.mjs')
  try {
    const stdout = await runComponent(entry, { ...input, argv }, input.homeRoot)
    return JSON.parse(stdout)
  } catch (error) {
    return { status: 'partial', limits: [`${id}-doctor-unavailable:${error.stderr?.trim() || error.message}`] }
  }
}

function runComponent(entry, input, cwd) {
  return new Promise((resolvePromise, reject) => {
    let stdout = ''; let stderr = ''
    const child = spawn(process.execPath, [entry], { cwd, stdio: ['pipe', 'pipe', 'pipe'] })
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', reject)
    child.on('close', (code) => code === 0 ? resolvePromise(stdout) : reject(Object.assign(new Error(`component exited ${code}`), { stderr })))
    child.stdin.end(JSON.stringify(input))
  })
}

async function filesUnder(root) {
  if (!root) return []
  const files = []
  for (const entry of await readdir(root, { withFileTypes: true }).catch((error) => error.code === 'ENOENT' ? [] : Promise.reject(error))) {
    if (entry.isSymbolicLink()) continue
    const path = join(root, entry.name)
    if (entry.isDirectory()) files.push(...await filesUnder(path))
    else if (entry.isFile()) files.push(path)
  }
  return files
}

async function safeLstat(path) { return lstat(path).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error)) }

function argumentsOf(argv) {
  const flags = {}; const positionals = []
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (!value.startsWith('--')) { positionals.push(value); continue }
    const [name, inline] = value.slice(2).split('=', 2)
    flags[name] = inline ?? (argv[index + 1] && !argv[index + 1].startsWith('-') ? argv[++index] : true)
  }
  return { flags, positionals }
}
function human(value) {
  if (value.status === 'repaired') return `Repaired ${value.finding} with ${value.operation}; Home is ${value.after.status}.`
  const lines = [`Home hygiene — ${value.status}`, 'Inspection was read-only.']
  for (const [label, findings] of [['Confirmed inconsistencies', value.confirmedInconsistencies], ['Ownership ambiguities', value.ownershipAmbiguities], ['Legacy residue', value.legacyResidue], ['Optional improvements', value.optionalImprovements]]) {
    lines.push('', `${label}:`)
    lines.push(...(findings.length ? findings.map((finding) => `  - ${finding.id}: ${finding.message}`) : ['  - none']))
  }
  return lines.join('\n')
}
function required(value, label) { if (!value || value === true) fail('usage', `${label} is required.`, 2); return value }
function fail(code, message, exitCode = 4) { const error = new Error(message); error.code = code; error.exitCode = exitCode; throw error }
async function stdin() { let value = ''; for await (const chunk of process.stdin) value += chunk; return value }
