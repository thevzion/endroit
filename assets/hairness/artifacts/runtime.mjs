#!/usr/bin/env node
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'

try {
  const input = JSON.parse(await stdin())
  const { positionals, flags } = argumentsOf(input.argv)
  const [command, ...args] = positionals
  const value = await route(input, command, args, flags)
  process.stdout.write(flags.json ? `${JSON.stringify(value, null, 2)}\n` : `${human(value)}\n`)
} catch (error) {
  process.stderr.write(`${error.code ?? 'artifact_failed'}: ${error.message}\n`)
  process.exitCode = error.exitCode ?? 4
}

async function route(input, command, args, flags) {
  if (command === 'create') return createArtifact(input, required(args[0], 'Artifact kind'), required(args[1], 'Artifact id'), flags)
  if (command === 'list') return { status: 'listed', artifacts: await listArtifacts(input) }
  if (command === 'inspect') return inspectArtifact(input, required(args[0], 'Artifact selector'))
  if (command === 'validate') return validateArtifact(input, required(args[0], 'Artifact selector'))
  if (command === 'publish') return publishArtifact(input, required(args[0], 'Artifact selector'), flags)
  throw failure('usage', 'hairness artifact create|list|inspect|validate|publish', 2)
}

async function createArtifact(input, kindSelector, id, flags) {
  assertId(id)
  const kind = selectKind(input.resolvedHome, kindSelector)
  const owner = flags.owner ?? (input.deskRoot ? 'desk' : 'home')
  assertOwner(kind, owner)
  const destination = await destinationFor(input, kind, id, owner, flags)
  if (await exists(destination)) throw failure('artifact_exists', `${relative(input.homeRoot, destination)} already exists.`)
  const metadata = {
    $schema: 'https://hairness.dev/schema/artifact.json',
    id,
    kind: kind.id,
    owner: owner === 'target' ? `target:${required(flags.target, 'Target id')}` : owner,
    state: flags.state ?? kind.states?.[0] ?? 'draft',
    createdBy: flags['created-by'] ?? kind.owner,
    createdAt: new Date().toISOString(),
    ...(flags['derived-from'] ? { derivedFrom: flags['derived-from'] } : {}),
    ...(flags.target ? { targets: [flags.target] } : {}),
  }
  const body = await readFile(join(kind.root, kind.template), 'utf8')
  await mkdir(dirname(destination), { recursive: true })
  const stage = await mkdtemp(join(dirname(destination), '.hairness-artifact-'))
  try {
    if (flags.from) await copyInput(flags.from, stage)
    await writeFile(join(stage, 'artifact.md'), renderArtifact(metadata, body), { mode: 0o644 })
    for (const source of kind.requiredFiles ?? []) {
      const target = join(stage, basename(source))
      if (!await exists(target)) await cp(join(kind.root, source), target, { errorOnExist: true })
    }
    await validateDirectory(stage, metadata, kind, owner)
    await rename(stage, destination)
  } catch (error) {
    await rm(stage, { recursive: true, force: true })
    throw error
  }
  return { status: 'created', id, kind: kind.id, owner: metadata.owner, path: relative(input.homeRoot, destination) }
}

async function listArtifacts(input) {
  const roots = [
    { scope: 'home', path: join(input.homeRoot, 'artifacts') },
    ...(input.deskRoot ? [{ scope: 'desk', path: join(input.deskRoot, 'artifacts') }] : []),
  ]
  for (const target of input.resolvedHome.home.settings?.['hairness/targets']?.targets ?? []) {
    for (const binding of await bindings(input, target.id)) {
      for (const kind of input.resolvedHome.artifactKinds.filter((entry) => entry.owners.includes('target') && entry.targetPath)) {
        roots.push({ scope: `target:${target.id}`, binding: binding.id, path: join(binding.path, kind.targetPath) })
      }
    }
  }
  const values = []
  const seen = new Set()
  for (const root of roots) {
    for (const path of await findNamed(root.path, 'artifact.md')) {
      const key = await realpath(path).catch(() => path)
      if (seen.has(key)) continue
      seen.add(key)
      const directory = await realpath(dirname(path)).catch(() => dirname(path))
      try {
        const document = parseArtifact(await readFile(path, 'utf8'))
        values.push({ ...document.metadata, scope: root.scope, ...(root.binding ? { binding: root.binding } : {}), path: directory })
      } catch (error) {
        values.push({ scope: root.scope, path: directory, invalid: error.message })
      }
    }
  }
  return values.sort((left, right) => `${left.kind}:${left.id}`.localeCompare(`${right.kind}:${right.id}`))
}

async function inspectArtifact(input, selector) {
  const artifact = await selectArtifact(input, selector)
  const document = parseArtifact(await readFile(join(artifact.path, 'artifact.md'), 'utf8'))
  return { status: 'inspected', ...artifact, body: document.body }
}

async function validateArtifact(input, selector) {
  const artifact = await selectArtifact(input, selector)
  if (artifact.invalid) throw failure('artifact_invalid', artifact.invalid)
  const kind = selectKind(input.resolvedHome, artifact.kind)
  const document = parseArtifact(await readFile(join(artifact.path, 'artifact.md'), 'utf8'))
  await validateDirectory(artifact.path, document.metadata, kind, artifact.scope.startsWith('target:') ? 'target' : artifact.scope)
  return { status: 'valid', id: artifact.id, kind: artifact.kind, scope: artifact.scope }
}

async function publishArtifact(input, selector, flags) {
  const artifact = await selectArtifact(input, selector)
  if (artifact.scope !== 'desk') throw failure('artifact_scope_invalid', 'Only a Desk Artifact can be published.')
  await validateArtifact(input, selector)
  const owner = flags.to ?? flags.owner
  if (!['home', 'target'].includes(owner)) throw failure('usage', 'Publish with --to home or --to target.', 2)
  const kind = selectKind(input.resolvedHome, artifact.kind)
  assertOwner(kind, owner)
  const destination = await destinationFor(input, kind, artifact.id, owner, flags)
  if (await exists(destination)) throw failure('artifact_exists', `${relative(input.homeRoot, destination)} already exists.`)
  const source = parseArtifact(await readFile(join(artifact.path, 'artifact.md'), 'utf8'))
  const metadata = {
    ...source.metadata,
    owner: owner === 'target' ? `target:${required(flags.target, 'Target id')}` : owner,
    derivedFrom: source.metadata.derivedFrom ?? `artifact:${source.metadata.kind}/${source.metadata.id}@${source.metadata.createdAt}`,
    ...(flags.target ? { targets: [...new Set([...(source.metadata.targets ?? []), flags.target])] } : {}),
  }
  await mkdir(dirname(destination), { recursive: true })
  const stage = await mkdtemp(join(dirname(destination), '.hairness-artifact-'))
  try {
    await assertTree(artifact.path)
    for (const entry of await readdir(artifact.path, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw failure('symlink_forbidden', `Artifact contains symbolic link ${entry.name}.`)
      if (entry.name === 'artifact.md') continue
      await cp(join(artifact.path, entry.name), join(stage, entry.name), { recursive: true, errorOnExist: true })
    }
    await writeFile(join(stage, 'artifact.md'), renderArtifact(metadata, source.body), { mode: 0o644 })
    await validateDirectory(stage, metadata, kind, owner)
    await rename(stage, destination)
  } catch (error) {
    await rm(stage, { recursive: true, force: true })
    throw error
  }
  return { status: 'published', id: artifact.id, kind: artifact.kind, owner: metadata.owner, source: artifact.path, path: relative(input.homeRoot, destination) }
}

async function validateDirectory(directory, metadata, kind, owner) {
  const requiredKeys = ['$schema', 'id', 'kind', 'owner', 'state', 'createdBy', 'createdAt']
  for (const key of requiredKeys) if (!metadata[key]) throw failure('artifact_invalid', `Artifact metadata requires ${key}.`)
  if (metadata.$schema !== 'https://hairness.dev/schema/artifact.json') throw failure('artifact_invalid', 'Artifact schema is invalid.')
  if (metadata.kind !== kind.id) throw failure('artifact_invalid', `Artifact kind ${metadata.kind} does not match ${kind.id}.`)
  if (kind.states?.length && !kind.states.includes(metadata.state)) throw failure('artifact_invalid', `${metadata.state} is not valid for ${kind.id}.`)
  assertOwner(kind, owner)
  for (const source of kind.requiredFiles ?? []) {
    const path = join(directory, basename(source))
    if (!await exists(path)) throw failure('artifact_invalid', `${kind.id} requires ${basename(source)}.`)
    if ((await lstat(path)).isSymbolicLink()) throw failure('symlink_forbidden', `${basename(source)} must not be a symbolic link.`)
  }
  const schema = JSON.parse(await readFile(join(kind.root, kind.schema), 'utf8'))
  validateMetadataSchema(metadata, schema)
}

async function destinationFor(input, kind, id, owner, flags) {
  const segment = kind.id.replace(/[/:]+/g, '-')
  if (owner === 'home') return join(input.homeRoot, 'artifacts', segment, id)
  if (owner === 'desk') {
    if (!input.deskRoot) throw failure('desk_missing', 'A Desk is required for Desk Artifacts.')
    return join(input.deskRoot, 'artifacts', segment, id)
  }
  const target = required(flags.target, 'Target id')
  const binding = await selectBinding(input, target, flags.binding)
  if (!kind.targetPath) throw failure('artifact_target_path_missing', `${kind.id} has no Target destination.`)
  return join(binding.path, kind.targetPath, id)
}

function selectKind(plan, selector) {
  const matches = plan.artifactKinds.filter((kind) => kind.id === selector || kind.localId === selector)
  if (!matches.length) throw failure('artifact_kind_missing', `${selector} is not a declared Artifact kind.`)
  if (matches.length > 1) throw failure('artifact_kind_ambiguous', `${selector} matches multiple Artifact kinds.`)
  return matches[0]
}

async function selectArtifact(input, selector) {
  const selectedPath = resolve(selector)
  const candidate = basename(selectedPath) === 'artifact.md' ? dirname(selectedPath) : selectedPath
  const selectedDirectory = await realpath(candidate).catch(() => candidate)
  const matches = (await listArtifacts(input)).filter((entry) => entry.id === selector || `${entry.kind}:${entry.id}` === selector || entry.path === selectedDirectory)
  if (!matches.length) throw failure('artifact_missing', `${selector} was not found.`)
  if (matches.length > 1) throw failure('artifact_ambiguous', `${selector} matches multiple Artifacts.`)
  return matches[0]
}

async function bindings(input, targetId) {
  if (!input.deskRoot) return []
  const root = join(input.deskRoot, 'targets', targetId)
  const values = []
  for (const entry of await safeReadDir(root)) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    const path = await realpath(join(root, entry.name)).catch(() => null)
    if (path) values.push({ id: entry.name, path })
  }
  return values
}

async function selectBinding(input, targetId, bindingId) {
  const values = await bindings(input, targetId)
  if (bindingId) {
    const selected = values.find((entry) => entry.id === bindingId)
    if (!selected) throw failure('target_binding_missing', `${targetId} has no Binding ${bindingId}.`)
    return selected
  }
  if (!values.length) throw failure('target_unbound', `${targetId} has no usable Binding.`)
  if (values.length > 1) throw failure('target_binding_ambiguous', `${targetId} has multiple Bindings; pass --binding.`)
  return values[0]
}

async function copyInput(source, destination) {
  const root = await realpath(resolve(source))
  await assertTree(root)
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.name === 'artifact.md') throw failure('artifact_import_reserved', 'Imported files cannot include artifact.md.')
    if (entry.isSymbolicLink()) throw failure('symlink_forbidden', `Imported source contains symbolic link ${entry.name}.`)
    await cp(join(root, entry.name), join(destination, entry.name), { recursive: true, errorOnExist: true })
  }
}

async function assertTree(root) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw failure('symlink_forbidden', `Artifact source contains symbolic link ${entry.name}.`)
    if (entry.isDirectory()) await assertTree(join(root, entry.name))
  }
}

function validateMetadataSchema(metadata, schema) {
  for (const key of schema.required ?? []) if (metadata[key] === undefined) throw failure('artifact_schema_invalid', `${key} is required by the Artifact kind.`)
  for (const [key, rule] of Object.entries(schema.properties ?? {})) {
    if (metadata[key] === undefined) continue
    if (rule.const !== undefined && metadata[key] !== rule.const) throw failure('artifact_schema_invalid', `${key} must equal ${rule.const}.`)
    if (rule.enum && !rule.enum.includes(metadata[key])) throw failure('artifact_schema_invalid', `${key} must be one of ${rule.enum.join(', ')}.`)
  }
}

function renderArtifact(metadata, body) {
  const lines = Object.entries(metadata).map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
  return `---\n${lines.join('\n')}\n---\n\n${body.trim()}\n`
}

function parseArtifact(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!match) throw failure('artifact_invalid', 'artifact.md must start with frontmatter.')
  const metadata = {}
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(':')
    if (separator < 1) throw failure('artifact_invalid', `Invalid frontmatter line: ${line}`)
    const key = line.slice(0, separator).trim()
    const value = line.slice(separator + 1).trim()
    try { metadata[key] = JSON.parse(value) } catch { metadata[key] = value }
  }
  return { metadata, body: match[2] }
}

function assertOwner(kind, owner) {
  if (!kind.owners.includes(owner)) throw failure('artifact_owner_invalid', `${kind.id} cannot be owned by ${owner}.`)
}

async function findNamed(root, name) {
  const values = []
  async function visit(directory) {
    for (const entry of await safeReadDir(directory)) {
      const path = join(directory, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile() && entry.name === name) values.push(path)
    }
  }
  await visit(root)
  return values
}

async function safeReadDir(path) {
  try { return await readdir(path, { withFileTypes: true }) }
  catch (error) { if (error.code === 'ENOENT') return []; throw error }
}

async function exists(path) {
  try { await lstat(path); return true } catch (error) { if (error.code === 'ENOENT') return false; throw error }
}

function argumentsOf(argv) {
  const flags = {}
  const positionals = []
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (!value.startsWith('--')) { positionals.push(value); continue }
    const [name, inline] = value.slice(2).split('=', 2)
    flags[name] = inline ?? (argv[index + 1] && !argv[index + 1].startsWith('-') ? argv[++index] : true)
  }
  return { flags, positionals }
}

function human(value) {
  if (value.artifacts) return value.artifacts.length ? value.artifacts.map((entry) => `${entry.kind}:${entry.id} · ${entry.scope} · ${entry.state ?? 'invalid'}`).join('\n') : 'No Artifacts.'
  return Object.entries(value).map(([key, entry]) => `${key}: ${typeof entry === 'object' ? JSON.stringify(entry) : entry}`).join('\n')
}

function required(value, label) { if (!value) throw failure('usage', `${label} is required.`, 2); return value }
function assertId(value) { if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(value)) throw failure('artifact_id_invalid', `Invalid Artifact id ${value}.`) }
function failure(code, message, exitCode = 4) { const error = new Error(message); error.code = code; error.exitCode = exitCode; return error }
function stdin() { return new Promise((resolvePromise, reject) => { const chunks = []; process.stdin.on('data', (chunk) => chunks.push(chunk)); process.stdin.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8'))); process.stdin.on('error', reject) }) }
