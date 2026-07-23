import { mkdir, readFile, readdir } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { applyTransaction } from './assets.mjs'
import { validateAgainstSchema, validateDocument } from './contracts.mjs'
import { listTargets, targetBinding } from './targets.mjs'
import { HairnessError } from './lib/errors.mjs'
import { assertId, assertInside, exists, resolvePackageFile, treeFiles, writeFileAtomic } from './lib/io.mjs'
import { resolveHome } from './resolved.mjs'

export async function createArtifact(root, kindId, id, options = {}) {
  const plan = await resolveHome(root)
  const kind = findKind(plan, kindId)
  const owner = options.owner ?? 'desk'
  assertOwner(kind, owner)
  id = assertId(id, 'Artifact id')
  const { path: directory } = await artifactDestination(root, kind, id, owner, options.target)
  if (await exists(directory)) throw new HairnessError('artifact_exists', `${relative(root, directory)} already exists.`)
  const state = options.state ?? kind.states?.[0] ?? 'draft'
  if (kind.states && !kind.states.includes(state)) throw new HairnessError('artifact_state_invalid', `${state} is not valid for ${kind.id}.`)
  const metadata = {
    $schema: 'https://hairness.dev/schema/artifact.json',
    id,
    kind: kind.id,
    owner: owner === 'target' ? `target:${required(options.target, 'Target id')}` : owner,
    state,
    createdBy: options.createdBy ?? 'human',
    ...(options.derivedFrom ? { derivedFrom: options.derivedFrom } : {}),
    ...(options.target ? { targets: [options.target] } : {}),
  }
  const body = kind.template
    ? await readFile(await resolvePackageFile(kind.root, kind.template, `${kind.id} template`), 'utf8')
    : `# ${id}\n`
  await validateMetadata(kind, metadata)
  await mkdir(directory, { recursive: true })
  await writeFileAtomic(join(directory, 'artifact.md'), renderArtifact(metadata, body), 0o644)
  return { status: 'created', id, kind: kind.id, owner: metadata.owner, path: directory }
}

export async function listArtifacts(root) {
  const plan = await resolveHome(root)
  const roots = [
    { scope: 'home', path: join(root, 'artifacts') },
    ...(plan.desk ? [{ scope: 'desk', path: join(root, '.desk', 'artifacts') }] : []),
  ]
  const targets = await listTargets(root)
  const targetRoots = new Map()
  for (const target of targets.filter((entry) => entry.binding)) {
    for (const kind of plan.artifactKinds.filter((entry) => entry.owners.includes('target') && entry.targetPath)) {
      const path = assertInside(target.binding, join(target.binding, kind.targetPath), 'Target Artifact root')
      targetRoots.set(`${target.id}:${path}`, { scope: `target:${target.id}`, path })
    }
  }
  roots.push(...targetRoots.values())
  const values = []
  for (const entry of roots) {
    for (const path of await findArtifactFiles(entry.path)) {
      try {
        const artifact = await readArtifact(path)
        values.push({ ...artifact.metadata, scope: entry.scope, path: dirname(path) })
      } catch (error) {
        values.push({ scope: entry.scope, path: dirname(path), invalid: error.message })
      }
    }
  }
  return values.sort((left, right) => String(left.path).localeCompare(String(right.path)))
}

export async function inspectArtifact(root, selector) {
  const matches = (await listArtifacts(root)).filter((entry) => entry.id === selector || entry.path === selector)
  if (!matches.length) throw new HairnessError('artifact_missing', `${selector} was not found.`)
  if (matches.length > 1) throw new HairnessError('artifact_ambiguous', `${selector} matches multiple Artifacts.`)
  const entry = matches[0]
  if (entry.invalid) throw new HairnessError('artifact_invalid', entry.invalid)
  const document = await readArtifact(join(entry.path, 'artifact.md'))
  return { ...entry, body: document.body }
}

export async function validateArtifact(root, selector) {
  const plan = await resolveHome(root)
  const entry = await inspectArtifact(root, selector)
  const kind = findKind(plan, entry.kind)
  assertLocation(entry)
  await validateMetadata(kind, entry)
  if (kind.states && !kind.states.includes(entry.state)) throw new HairnessError('artifact_state_invalid', `${entry.state} is not valid for ${kind.id}.`)
  return { status: 'valid', id: entry.id, kind: entry.kind, owner: entry.owner, path: entry.path }
}

function assertLocation(entry) {
  const expected = entry.scope === 'desk' ? 'desk' : entry.scope === 'home' ? 'home' : entry.scope
  if (entry.owner !== expected) {
    throw new HairnessError('artifact_owner_mismatch', `${entry.path} is stored in ${entry.scope} but declares owner ${entry.owner}.`)
  }
  if (entry.scope.startsWith('target:')) {
    const target = entry.scope.slice('target:'.length)
    if (!(entry.targets ?? []).includes(target)) {
      throw new HairnessError('artifact_target_mismatch', `${entry.path} does not declare its owning Target ${target}.`)
    }
  }
}

export async function publishArtifact(root, selector, options = {}) {
  const plan = await resolveHome(root)
  const entry = await inspectArtifact(root, selector)
  if (entry.scope !== 'desk') throw new HairnessError('artifact_scope_invalid', 'Only a Desk Artifact can be published.')
  const kind = findKind(plan, entry.kind)
  const owner = options.owner ?? 'home'
  if (owner === 'desk') throw new HairnessError('artifact_scope_invalid', 'Publish destination must be Home or Target.')
  assertOwner(kind, owner)
  const destination = await artifactDestination(root, kind, entry.id, owner, options.target)
  if (await exists(destination.path)) throw new HairnessError('artifact_exists', `${relative(root, destination.path)} already exists.`)
  const files = await treeFiles(entry.path)
  const writes = files.map((file) => ({ path: assertInside(destination.path, join(destination.path, file.path), 'Artifact destination'), content: file.content }))
  const index = writes.findIndex((file) => file.path === join(destination.path, 'artifact.md'))
  const document = await readArtifact(join(entry.path, 'artifact.md'))
  const metadata = {
    ...document.metadata,
    owner: owner === 'target' ? `target:${required(options.target, 'Target id')}` : owner,
    derivedFrom: document.metadata.derivedFrom ?? `desk:${relative(join(root, '.desk'), entry.path)}`,
    ...(options.target ? { targets: [...new Set([...(document.metadata.targets ?? []), options.target])] } : {}),
  }
  await validateMetadata(kind, metadata)
  writes[index].content = Buffer.from(renderArtifact(metadata, document.body))
  await applyTransaction(destination.transactionRoot, writes, [])
  return { status: 'published', id: entry.id, kind: entry.kind, from: entry.path, to: destination.path, owner: metadata.owner }
}

async function validateMetadata(kind, metadata) {
  await validateDocument(metadata, 'artifact')
  if (!kind.schema) return
  const path = await resolvePackageFile(kind.root, kind.schema, `${kind.id} Artifact schema`)
  let schema
  try { schema = JSON.parse(await readFile(path, 'utf8')) }
  catch (error) { throw new HairnessError('artifact_schema_invalid', `${kind.schema} is not valid JSON.`, { cause: error }) }
  await validateAgainstSchema(metadata, schema, `${kind.id} Artifact`)
}

async function artifactDestination(root, kind, id, owner, targetId) {
  const kindPath = kind.id.replace(':', '/')
  if (owner === 'desk') return { path: join(root, '.desk', 'artifacts', kindPath, id), transactionRoot: root }
  if (owner === 'home') return { path: join(root, 'artifacts', kindPath, id), transactionRoot: root }
  const binding = await targetBinding(root, required(targetId, 'Target id'))
  if (!binding?.path) throw new HairnessError('target_unbound', `Target ${targetId} is not bound.`)
  if (!kind.targetPath) throw new HairnessError('artifact_target_path_missing', `${kind.id} does not declare a Target destination.`)
  return {
    path: assertInside(binding.path, join(binding.path, kind.targetPath, id), 'Target Artifact destination'),
    transactionRoot: binding.path,
  }
}

function findKind(plan, selector) {
  const matches = plan.artifactKinds.filter((kind) => kind.id === selector || kind.localId === selector)
  if (!matches.length) throw new HairnessError('artifact_kind_missing', `${selector} is not a declared Artifact kind.`)
  if (matches.length > 1) throw new HairnessError('artifact_kind_ambiguous', `${selector} matches multiple Artifact kinds.`)
  return matches[0]
}

function assertOwner(kind, owner) {
  if (!kind.owners.includes(owner)) throw new HairnessError('artifact_owner_invalid', `${kind.id} cannot be owned by ${owner}.`)
  if (owner === 'target' && !kind.targetPath) throw new HairnessError('artifact_target_path_missing', `${kind.id} allows Target ownership but declares no targetPath.`)
}

async function readArtifact(path) {
  const content = await readFile(path, 'utf8')
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!match) throw new HairnessError('artifact_invalid', `${path} must start with YAML frontmatter.`)
  return { metadata: parseFrontmatter(match[1]), body: match[2] }
}

function parseFrontmatter(value) {
  const metadata = {}
  for (const line of value.split(/\r?\n/)) {
    if (!line.trim()) continue
    const separator = line.indexOf(':')
    if (separator < 1) throw new HairnessError('artifact_invalid', `Invalid frontmatter line: ${line}`)
    const key = line.slice(0, separator).trim()
    const raw = line.slice(separator + 1).trim()
    metadata[key] = raw.startsWith('[') && raw.endsWith(']')
      ? raw.slice(1, -1).split(',').map((item) => scalar(item.trim())).filter((item) => item !== '')
      : scalar(raw)
  }
  return metadata
}

function scalar(value) {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) return value.slice(1, -1)
  if (value === 'true') return true
  if (value === 'false') return false
  return value
}

function renderArtifact(metadata, body) {
  const lines = Object.entries(metadata).map(([key, value]) => `${key}: ${Array.isArray(value) ? `[${value.map(quote).join(', ')}]` : quote(value)}`)
  return `---\n${lines.join('\n')}\n---\n\n${body.trimStart()}`
}

function quote(value) {
  const text = String(value)
  return /^[a-zA-Z0-9_./:@-]+$/.test(text) ? text : JSON.stringify(text)
}

async function findArtifactFiles(root) {
  if (!await exists(root)) return []
  const files = []
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isSymbolicLink()) throw new HairnessError('symlink_forbidden', `${path} is a symbolic link.`)
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile() && entry.name === 'artifact.md') files.push(path)
    }
  }
  await visit(root)
  return files.sort()
}

function required(value, label) {
  if (!value) throw new HairnessError('usage', `${label} is required.`)
  return value
}
