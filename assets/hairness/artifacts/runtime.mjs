#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'

const HELP = {
  create: {
    usage: 'hairness artifact create <kind> <id> --workspace <home/id|desk/id> [--status <status>] [--field <key=value>] [--derived-from <ref>] [--from <directory>] [--json]',
    effect: 'mutating — creates one new Artifact inside its owning Workspace',
    summary: 'Create a Workspace-owned Artifact, optionally importing a bounded directory.',
  },
  list: {
    usage: 'hairness artifact list [--json]',
    effect: 'read-only',
    summary: 'List Workspace Artifacts, legacy roots and Target projections.',
  },
  inspect: {
    usage: 'hairness artifact inspect <selector> [--json]',
    effect: 'read-only',
    summary: 'Inspect one Artifact selected by ref, id, kind and id, or path.',
  },
  validate: {
    usage: 'hairness artifact validate <selector> [--json]',
    effect: 'read-only',
    summary: 'Validate one Artifact against its owning kind.',
  },
  promote: {
    usage: 'hairness artifact promote <selector> --to <workspace:home/id|target:id> [--binding <id>] [--json]',
    effect: 'mutating — copies one validated source to an explicit broader authority',
    summary: 'Promote a Workspace or legacy Artifact while preserving source lineage.',
  },
  publish: {
    usage: 'hairness artifact publish <selector> --to <home|target> [--target <id>] [--binding <id>] [--json]',
    effect: 'deprecated alias — use artifact promote',
    summary: 'Deprecated compatibility alias for Artifact promotion.',
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
  process.stderr.write(`${error.code ?? 'artifact_failed'}: ${error.message}\n`)
  process.exitCode = error.exitCode ?? 4
}

async function route(input, command, args, flags) {
  if (command === 'create') return createArtifact(input, required(args[0], 'Artifact kind'), required(args[1], 'Artifact id'), flags)
  if (command === 'list') return { status: 'listed', artifacts: await listArtifacts(input) }
  if (command === 'inspect') return inspectArtifact(input, required(args[0], 'Artifact selector'))
  if (command === 'validate') return validateArtifact(input, required(args[0], 'Artifact selector'))
  if (command === 'promote') return promoteArtifact(input, required(args[0], 'Artifact selector'), flags)
  if (command === 'publish') {
    const translated = { ...flags, to: legacyDestination(flags) }
    return {
      ...await promoteArtifact(input, required(args[0], 'Artifact selector'), translated),
      deprecated: 'artifact publish is deprecated; use artifact promote.',
    }
  }
  throw failure('usage', 'hairness artifact create|list|inspect|validate|promote', 2)
}

async function createArtifact(input, kindSelector, id, flags) {
  assertId(id)
  const kind = selectKind(input.resolvedHome, kindSelector)
  if (!kind.workspaceNamespace) throw failure('artifact_workspace_namespace_missing', `${kind.id} does not declare a Workspace namespace.`)
  const workspace = selectWorkspace(input, required(flags.workspace, 'Workspace'))
  assertSourceScope(kind, workspace.scope)
  const destination = workspaceDestination(input, kind, id, workspace)
  if (await exists(destination)) throw failure('artifact_exists', `${relative(input.homeRoot, destination)} already exists.`)
  const timestamp = new Date().toISOString()
  const metadata = {
    ...extraFields(flags.field),
    $schema: 'https://hairness.dev/schema/artifact.json',
    id,
    kind: kind.id,
    status: flags.status ?? flags.state ?? kind.states?.[0] ?? 'draft',
    owner: workspace.ref,
    created_at: timestamp,
    updated_at: timestamp,
    derived_from: values(flags['derived-from']),
  }
  const body = await readFile(join(kind.root, kind.template), 'utf8')
  await mkdir(dirname(destination), { recursive: true })
  const stage = await mkdtemp(join(dirname(destination), '.hairness-artifact-'))
  try {
    if (flags.from) await copyInput(flags.from, stage)
    await writeFile(join(stage, 'artifact.md'), renderArtifact(metadata, body), { mode: 0o644 })
    await installRequiredFiles(stage, kind)
    await validateDirectory(stage, metadata, kind, workspace.scope, false)
    await rename(stage, destination)
  } catch (error) {
    await rm(stage, { recursive: true, force: true })
    throw error
  }
  return {
    status: 'created',
    id,
    kind: kind.id,
    owner: workspace.ref,
    ref: artifactRef(workspace, kind, id),
    path: relative(input.homeRoot, destination),
  }
}

function extraFields(entries) {
  const reserved = new Set(['$schema', 'id', 'kind', 'status', 'owner', 'created_at', 'updated_at', 'derived_from', 'source_digest'])
  const fields = {}
  for (const entry of values(entries)) {
    const separator = String(entry).indexOf('=')
    if (separator < 1) throw failure('artifact_field_invalid', `Invalid Artifact field ${entry}; use key=value.`, 2)
    const key = String(entry).slice(0, separator)
    const raw = String(entry).slice(separator + 1)
    if (!/^[a-z][a-z0-9_]{0,127}$/.test(key) || reserved.has(key)) {
      throw failure('artifact_field_invalid', `Artifact field ${key} is reserved or invalid.`, 2)
    }
    try { fields[key] = JSON.parse(raw) } catch { fields[key] = raw }
  }
  return fields
}

async function listArtifacts(input) {
  const roots = []
  for (const workspace of input.resolvedHome.workspaces ?? []) {
    roots.push({
      scope: workspace.scope,
      workspace,
      path: dirname(join(input.homeRoot, workspace.path)),
      legacy: false,
    })
  }
  roots.push(
    { scope: 'home', path: join(input.homeRoot, 'artifacts'), legacy: true },
    ...(input.deskRoot ? [{ scope: 'desk', path: join(input.deskRoot, 'artifacts'), legacy: true }] : []),
  )
  for (const target of input.resolvedHome.home.settings?.['hairness/targets']?.targets ?? []) {
    for (const binding of await bindings(input, target.id)) {
      for (const kind of input.resolvedHome.artifactKinds.filter((entry) => entry.owners.includes('target') && entry.targetPath)) {
        roots.push({
          scope: `target:${target.id}`,
          binding: binding.id,
          target: target.id,
          path: join(binding.path, kind.targetPath),
          legacy: false,
        })
      }
    }
  }
  const found = []
  const seen = new Set()
  for (const root of roots) {
    for (const path of await findNamed(root.path, 'artifact.md')) {
      const key = await realpath(path).catch(() => path)
      if (seen.has(key)) continue
      seen.add(key)
      const directory = await realpath(dirname(path)).catch(() => dirname(path))
      try {
        const parsed = parseArtifact(await readFile(path, 'utf8'))
        const metadata = normalizeMetadata(parsed.metadata)
        const kind = selectKind(input.resolvedHome, metadata.kind)
        const workspace = root.workspace ?? workspaceFromOwner(metadata.owner, input.resolvedHome.workspaces)
        found.push({
          ...metadata,
          scope: root.scope,
          ...(workspace ? { workspace: workspace.id } : {}),
          ...(root.target ? { target: root.target } : {}),
          ...(root.binding ? { binding: root.binding } : {}),
          ref: workspace ? artifactRef(workspace, kind, metadata.id) : legacyRef(metadata, root),
          path: directory,
          legacy: root.legacy || isLegacyMetadata(parsed.metadata),
        })
      } catch (error) {
        found.push({ scope: root.scope, path: directory, legacy: root.legacy, invalid: error.message })
      }
    }
  }
  return found.sort((left, right) => `${left.kind}:${left.id}:${left.scope}`.localeCompare(`${right.kind}:${right.id}:${right.scope}`))
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
  const metadata = normalizeMetadata(document.metadata)
  const ownerScope = artifact.scope.startsWith('target:') ? 'target' : artifact.scope
  await validateDirectory(artifact.path, metadata, kind, ownerScope, artifact.legacy)
  return { status: 'valid', id: artifact.id, kind: artifact.kind, scope: artifact.scope, legacy: artifact.legacy }
}

async function promoteArtifact(input, selector, flags) {
  const artifact = await selectArtifact(input, selector)
  if (artifact.scope.startsWith('target:')) throw failure('artifact_scope_invalid', 'A Target projection cannot be promoted.')
  await validateArtifact(input, selector)
  const destination = parseDestination(required(flags.to, 'Promotion destination'))
  if (destination.kind === 'workspace' && artifact.scope !== 'desk') {
    throw failure('artifact_direction_invalid', 'Only a Desk Artifact can be promoted to a Home Workspace.')
  }
  const kind = selectKind(input.resolvedHome, artifact.kind)
  let targetPath
  let owner
  let destinationRef
  if (destination.kind === 'workspace') {
    const workspace = selectWorkspace(input, `home/${destination.id}`)
    assertSourceScope(kind, 'home')
    targetPath = workspaceDestination(input, kind, artifact.id, workspace)
    owner = workspace.ref
    destinationRef = artifactRef(workspace, kind, artifact.id)
  } else {
    if (!kind.owners.includes('target') || !kind.targetPath) {
      throw failure('artifact_target_path_missing', `${kind.id} has no Target destination.`)
    }
    const binding = await selectBinding(input, destination.id, flags.binding)
    targetPath = join(binding.path, kind.targetPath, artifact.id)
    owner = `target:${destination.id}`
    destinationRef = `artifact:target/${destination.id}/${kind.workspaceNamespace ?? kind.owner}/${kind.localId}/${artifact.id}`
  }
  if (await exists(targetPath)) throw failure('artifact_exists', `${relative(input.homeRoot, targetPath)} already exists.`)
  const source = parseArtifact(await readFile(join(artifact.path, 'artifact.md'), 'utf8'))
  const metadata = {
    ...normalizeMetadata(source.metadata),
    owner,
    updated_at: new Date().toISOString(),
    derived_from: [...new Set([...normalizeMetadata(source.metadata).derived_from, artifact.ref])],
    source_digest: await treeDigest(artifact.path),
    ...(destination.kind === 'target' ? { targets: [...new Set([...(source.metadata.targets ?? []), destination.id])] } : {}),
  }
  await mkdir(dirname(targetPath), { recursive: true })
  const stage = await mkdtemp(join(dirname(targetPath), '.hairness-artifact-'))
  try {
    await assertTree(artifact.path)
    for (const entry of await readdir(artifact.path, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw failure('symlink_forbidden', `Artifact contains symbolic link ${entry.name}.`)
      if (entry.name === 'artifact.md') continue
      await cp(join(artifact.path, entry.name), join(stage, entry.name), { recursive: true, errorOnExist: true })
    }
    await writeFile(join(stage, 'artifact.md'), renderArtifact(metadata, source.body), { mode: 0o644 })
    await validateDirectory(stage, metadata, kind, destination.kind === 'target' ? 'target' : 'home', false)
    await rename(stage, targetPath)
  } catch (error) {
    await rm(stage, { recursive: true, force: true })
    throw error
  }
  return {
    status: 'promoted',
    id: artifact.id,
    kind: artifact.kind,
    owner,
    source: artifact.ref,
    ref: destinationRef,
    path: relative(input.homeRoot, targetPath),
  }
}

async function validateDirectory(directory, metadata, kind, ownerScope, legacy) {
  for (const key of ['$schema', 'id', 'kind', 'owner', 'status', 'created_at', 'updated_at', 'derived_from']) {
    if (metadata[key] === undefined || metadata[key] === '') throw failure('artifact_invalid', `Artifact metadata requires ${key}.`)
  }
  if (metadata.$schema !== 'https://hairness.dev/schema/artifact.json') throw failure('artifact_invalid', 'Artifact schema is invalid.')
  if (metadata.kind !== kind.id) throw failure('artifact_invalid', `Artifact kind ${metadata.kind} does not match ${kind.id}.`)
  if (!Array.isArray(metadata.derived_from)) throw failure('artifact_invalid', 'derived_from must be an array.')
  if (kind.states?.length && !kind.states.includes(metadata.status)) throw failure('artifact_invalid', `${metadata.status} is not valid for ${kind.id}.`)
  if (!legacy) assertSourceScope(kind, ownerScope)
  for (const source of kind.requiredFiles ?? []) {
    const path = join(directory, basename(source))
    if (!await exists(path)) throw failure('artifact_invalid', `${kind.id} requires ${basename(source)}.`)
    if ((await lstat(path)).isSymbolicLink()) throw failure('symlink_forbidden', `${basename(source)} must not be a symbolic link.`)
  }
  const schema = JSON.parse(await readFile(join(kind.root, kind.schema), 'utf8'))
  validateMetadataSchema(metadata, schema)
}

function selectKind(plan, selector) {
  const matches = plan.artifactKinds.filter((kind) => kind.id === selector || kind.localId === selector)
  if (!matches.length) throw failure('artifact_kind_missing', `${selector} is not a declared Artifact kind.`)
  if (matches.length > 1) throw failure('artifact_kind_ambiguous', `${selector} matches multiple Artifact kinds.`)
  return matches[0]
}

function selectWorkspace(input, selector) {
  const normalized = String(selector).replace(/^workspace:/, '')
  const match = normalized.match(/^(home|desk)\/([a-z0-9][a-z0-9._-]{0,127})$/)
  if (!match) throw failure('workspace_selector_invalid', `Invalid Workspace selector ${selector}.`, 2)
  const workspace = (input.resolvedHome.workspaces ?? []).find((entry) => entry.scope === match[1] && entry.id === match[2])
  if (!workspace) throw failure('workspace_missing', `${selector} was not found.`)
  return workspace
}

function workspaceDestination(input, kind, id, workspace) {
  const root = workspace.scope === 'home'
    ? join(input.homeRoot, 'workspaces', workspace.id)
    : join(input.deskRoot, 'workspaces', workspace.id)
  return join(root, kind.workspaceNamespace, kind.localId, id)
}

function workspaceFromOwner(owner, workspaces = []) {
  const match = String(owner).match(/^workspace:(home|desk)\/(.+)$/)
  return match ? workspaces.find((entry) => entry.scope === match[1] && entry.id === match[2]) : null
}

async function selectArtifact(input, selector) {
  const selectedPath = resolve(selector)
  const candidate = basename(selectedPath) === 'artifact.md' ? dirname(selectedPath) : selectedPath
  const selectedDirectory = await realpath(candidate).catch(() => candidate)
  const matches = (await listArtifacts(input)).filter((entry) =>
    entry.id === selector
    || `${entry.kind}:${entry.id}` === selector
    || entry.ref === selector
    || entry.path === selectedDirectory)
  if (!matches.length) throw failure('artifact_missing', `${selector} was not found.`)
  if (matches.length > 1) throw failure('artifact_ambiguous', `${selector} matches multiple Artifacts.`)
  return matches[0]
}

function artifactRef(workspace, kind, id) {
  return `artifact:${workspace.scope}/${workspace.id}/${kind.workspaceNamespace}/${kind.localId}/${id}`
}

function legacyRef(metadata, root) {
  return `artifact:${root.scope}/${metadata.kind}/${metadata.id}@${metadata.created_at}`
}

function parseDestination(value) {
  const workspace = String(value).match(/^workspace:home\/([a-z0-9][a-z0-9._-]{0,127})$/)
  if (workspace) return { kind: 'workspace', id: workspace[1] }
  const target = String(value).match(/^target:([a-z0-9][a-z0-9._-]{0,127})$/)
  if (target) return { kind: 'target', id: target[1] }
  throw failure('artifact_destination_invalid', 'Use --to workspace:home/<id> or --to target:<id>.', 2)
}

function legacyDestination(flags) {
  if (flags.to === 'home') return 'workspace:home/home'
  if (flags.to === 'target') return `target:${required(flags.target, 'Target id')}`
  throw failure('artifact_destination_invalid', 'Legacy publish requires --to home or --to target.', 2)
}

function normalizeMetadata(raw) {
  const createdAt = raw.created_at ?? raw.createdAt
  return {
    ...raw,
    status: raw.status ?? raw.state,
    created_by: raw.created_by ?? raw.createdBy,
    created_at: createdAt,
    updated_at: raw.updated_at ?? createdAt,
    derived_from: values(raw.derived_from ?? raw.derivedFrom),
  }
}

function isLegacyMetadata(raw) {
  return raw.state !== undefined || raw.createdAt !== undefined || raw.derivedFrom !== undefined
}

async function installRequiredFiles(stage, kind) {
  for (const source of kind.requiredFiles ?? []) {
    const target = join(stage, basename(source))
    if (!await exists(target)) await cp(join(kind.root, source), target, { errorOnExist: true })
  }
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

async function treeDigest(root) {
  const hash = createHash('sha256')
  async function visit(directory, prefix = '') {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.isSymbolicLink()) throw failure('symlink_forbidden', `Artifact source contains symbolic link ${entry.name}.`)
      const path = join(directory, entry.name)
      const name = join(prefix, entry.name)
      if (entry.isDirectory()) await visit(path, name)
      else {
        hash.update(`${name}\0`)
        hash.update(await readFile(path))
      }
    }
  }
  await visit(root)
  return `sha256:${hash.digest('hex')}`
}

function validateMetadataSchema(metadata, schema) {
  for (const key of schema.required ?? []) if (metadata[key] === undefined) throw failure('artifact_schema_invalid', `${key} is required by the Artifact kind.`)
  for (const [key, rule] of Object.entries(schema.properties ?? {})) {
    if (metadata[key] === undefined) continue
    if (rule.const !== undefined && metadata[key] !== rule.const) throw failure('artifact_schema_invalid', `${key} must equal ${rule.const}.`)
    if (rule.enum && !rule.enum.includes(metadata[key])) throw failure('artifact_schema_invalid', `${key} must be one of ${rule.enum.join(', ')}.`)
    if (rule.type === 'array' && !Array.isArray(metadata[key])) throw failure('artifact_schema_invalid', `${key} must be an array.`)
    if (rule.type === 'string' && typeof metadata[key] !== 'string') throw failure('artifact_schema_invalid', `${key} must be a string.`)
  }
}

function assertSourceScope(kind, scope) {
  if (!kind.owners.includes(scope)) throw failure('artifact_owner_invalid', `${kind.id} cannot be owned by ${scope}.`)
}

async function bindings(input, targetId) {
  if (!input.deskRoot) return []
  const root = join(input.deskRoot, 'targets', targetId)
  const found = []
  for (const entry of await safeReadDir(root)) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    const path = await realpath(join(root, entry.name)).catch(() => null)
    if (path) found.push({ id: entry.name, path })
  }
  return found
}

async function selectBinding(input, targetId, bindingId) {
  const found = await bindings(input, targetId)
  if (bindingId) {
    const selected = found.find((entry) => entry.id === bindingId)
    if (!selected) throw failure('target_binding_missing', `${targetId} has no Binding ${bindingId}.`)
    return selected
  }
  if (!found.length) throw failure('target_unbound', `${targetId} has no usable Binding.`)
  if (found.length > 1) throw failure('target_binding_ambiguous', `${targetId} has multiple Bindings; pass --binding.`)
  return found[0]
}

function renderArtifact(metadata, body) {
  const clean = Object.fromEntries(Object.entries(metadata).filter(([key, value]) =>
    value !== undefined && !['state', 'createdBy', 'createdAt', 'derivedFrom'].includes(key)))
  const lines = Object.entries(clean).map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
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

async function findNamed(root, name) {
  const found = []
  async function visit(directory) {
    for (const entry of await safeReadDir(directory)) {
      const path = join(directory, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile() && entry.name === name) found.push(path)
    }
  }
  await visit(root)
  return found
}

async function safeReadDir(path) {
  try { return await readdir(path, { withFileTypes: true }) }
  catch (error) { if (error.code === 'ENOENT') return []; throw error }
}

async function exists(path) {
  try { await lstat(path); return true }
  catch (error) { if (error.code === 'ENOENT') return false; throw error }
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

function values(value) {
  if (value === undefined || value === null || value === '') return []
  return Array.isArray(value) ? value : [value]
}

function assertId(value) {
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(value)) throw failure('artifact_id_invalid', `Invalid Artifact id ${value}.`, 2)
}

function human(value) {
  if (value.status === 'listed') return value.artifacts.length
    ? value.artifacts.map((entry) => `${entry.ref ?? entry.path} · ${entry.status ?? 'invalid'}${entry.legacy ? ' · legacy' : ''}`).join('\n')
    : 'No Artifacts.'
  if (value.status === 'inspected') return `${value.ref}\n${value.path}\n${value.body}`.trim()
  return `${value.status}: ${value.ref ?? `${value.kind}:${value.id}`}`
}

function helpFor(command) {
  if (!command) {
    return [
      'Usage: hairness artifact <command> [options]',
      '',
      'Commands:',
      ...Object.entries(HELP).map(([name, entry]) => `  ${name.padEnd(9)} ${entry.summary}`),
    ].join('\n')
  }
  const entry = HELP[command]
  if (!entry) throw failure('usage', `Unknown Artifact command ${command}.`, 2)
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
