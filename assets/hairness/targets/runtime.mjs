#!/usr/bin/env node
import { execFile } from 'node:child_process'
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)

try {
  const input = JSON.parse(await stdin())
  const { positionals, flags } = argumentsOf(input.argv)
  const [command, ...args] = positionals
  const value = await route(input, command, args, flags)
  process.stdout.write(flags.json ? `${JSON.stringify(value, null, 2)}\n` : `${human(value)}\n`)
} catch (error) {
  process.stderr.write(`${error.code ?? 'target_failed'}: ${error.message}\n`)
  process.exitCode = error.exitCode ?? 4
}

async function route(input, command, args, flags) {
  if (command === 'list') return { status: 'listed', targets: await listTargets(input) }
  if (command === 'discover') return { status: 'discovered', targets: await discoverTargets(required(args[0], 'Discovery root')) }
  if (command === 'doctor') return doctorTargets(input)
  if (command === 'add') return addTarget(input, required(args[0], 'Repository'), flags)
  if (command === 'bind') return bindTarget(input, required(args[0], 'Target id'), required(args[1], 'Repository path'), flags.binding)
  if (command === 'clone') return cloneTarget(input, required(args[0], 'Target id'), flags.binding)
  if (command === 'unbind') return unbindTarget(input, required(args[0], 'Target id'), flags.binding, flags)
  if (command === 'remove') return removeTarget(input, required(args[0], 'Target id'))
  if (command === 'map') return mapTarget(input, required(args[0], 'Target id'), flags)
  throw failure('usage', 'hairness target list|discover|doctor|add|bind|clone|unbind|remove|map', 2)
}

async function listTargets(input) {
  const targets = declarations(input)
  return Promise.all(targets.map(async (target) => {
    const bindings = await targetBindings(input, target.id)
    return {
      ...target,
      state: bindings.length ? 'bound' : 'declared',
      bindings: await Promise.all(bindings.map(async (binding) => {
        const evidence = binding.path ? await inspectRepository(binding.path).catch((error) => ({ available: false, error: error.message })) : { available: false, error: 'Broken Binding.' }
        const matches = evidence.available !== false && evidence.remotes.some((remote) => remote.repository === target.repository)
        return { ...binding, matches, evidence }
      })),
    }
  }))
}

async function discoverTargets(root) {
  const base = await realpath(resolve(root))
  const values = []
  async function visit(directory, depth) {
    if (depth > 2) return
    try {
      const evidence = await inspectRepository(directory)
      if (!values.some((entry) => entry.root === evidence.root)) values.push(evidence)
      return
    } catch {}
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || !entry.isDirectory() || ['.git', 'node_modules'].includes(entry.name)) continue
      await visit(join(directory, entry.name), depth + 1)
    }
  }
  await visit(base, 0)
  return values.map((entry) => ({
    path: entry.root,
    branch: entry.branch,
    repository: entry.remotes[0]?.repository ?? null,
    source: entry.remotes[0]?.url ?? null,
  }))
}

async function doctorTargets(input) {
  const targets = await listTargets(input)
  const limits = []
  for (const target of targets) {
    for (const binding of target.bindings) {
      if (binding.evidence.available === false) limits.push(`target-binding-broken:${target.id}:${binding.id}`)
      else if (!binding.matches) limits.push(`target-remote-mismatch:${target.id}:${binding.id}`)
      if (binding.evidence.conflicts) limits.push(`target-conflicts:${target.id}:${binding.id}`)
    }
  }
  return { status: limits.length ? 'partial' : 'ready', targets, limits }
}

async function addTarget(input, repository, flags) {
  const home = await readHome(input)
  const settings = structuredClone(home.settings?.['hairness/targets'] ?? {})
  settings.targets ??= []
  let source = repository
  let normalized
  let evidence
  try {
    evidence = await inspectRepository(resolve(repository))
    const remote = evidence.remotes[0]
    if (!remote) throw failure('target_remote_missing', 'A Target checkout must have a Git remote.')
    source = remote.url
    normalized = remote.repository
  } catch (error) {
    if (error.code && error.code !== 'git_failed' && error.code !== 'ENOENT') throw error
    normalized = normalizeRepository(repository)
    assertRemoteSource(repository)
  }
  const id = flags.id ?? slug(basename(normalized))
  assertId(id)
  if (settings.targets.some((target) => target.id === id)) throw failure('target_exists', `Target ${id} already exists.`)
  settings.targets.push({ id, repository: normalized, source, ...(flags.summary ? { summary: flags.summary } : {}) })
  settings.targets.sort((left, right) => left.id.localeCompare(right.id))
  home.settings ??= {}
  home.settings['hairness/targets'] = settings
  await writeJsonAtomic(join(input.homeRoot, 'hairness.json'), home)
  const target = settings.targets.find((entry) => entry.id === id)
  const binding = evidence && input.deskRoot ? await bindTarget(input, id, evidence.root, flags.binding, target) : null
  return { ...target, state: binding ? 'bound' : 'declared', bindings: binding ? [binding] : [] }
}

async function bindTarget(input, id, repositoryPath, bindingId = 'main', declaredTarget) {
  requireDesk(input)
  assertId(bindingId)
  const target = declaredTarget ?? declaration(input, id)
  const evidence = await inspectRepository(resolve(repositoryPath))
  if (!evidence.remotes.some((remote) => remote.repository === target.repository)) {
    throw failure('target_remote_mismatch', `${evidence.root} does not match ${target.repository}.`)
  }
  const link = join(input.deskRoot, 'targets', id, bindingId)
  if (await exists(link)) throw failure('target_binding_exists', `Binding ${id}/${bindingId} already exists.`)
  await mkdir(dirname(link), { recursive: true })
  await symlink(evidence.root, link)
  return { status: 'bound', id, binding: bindingId, type: 'bound', path: evidence.root }
}

async function cloneTarget(input, id, bindingId = 'main') {
  requireDesk(input)
  assertId(bindingId)
  const target = declaration(input, id)
  const destination = join(input.deskRoot, 'targets', id, bindingId)
  if (await exists(destination)) throw failure('target_binding_exists', `Binding ${id}/${bindingId} already exists.`)
  await mkdir(dirname(destination), { recursive: true })
  try {
    await git(['clone', '--quiet', '--', target.source, destination], input.homeRoot)
    const evidence = await inspectRepository(destination)
    if (!evidence.remotes.some((remote) => remote.repository === target.repository)) throw failure('target_remote_mismatch', `${target.source} does not match ${target.repository}.`)
    return { status: 'cloned', id, binding: bindingId, type: 'managed', path: evidence.root }
  } catch (error) {
    await rm(destination, { recursive: true, force: true })
    throw error
  }
}

async function unbindTarget(input, id, bindingId, flags) {
  const binding = await selectBinding(input, id, bindingId)
  const info = await lstat(binding.link)
  if (!info.isSymbolicLink()) {
    if (!truthy(flags.delete)) throw failure('target_managed_delete_required', `Binding ${id}/${binding.id} is managed; pass --delete.`)
    const evidence = await inspectRepository(binding.path)
    if (!evidence.clean) throw failure('target_binding_dirty', `Managed Binding ${id}/${binding.id} has local changes.`)
  }
  await rm(binding.link, { recursive: true, force: true })
  await removeEmpty(join(input.deskRoot, 'targets', id), join(input.deskRoot, 'targets'))
  return { status: 'unbound', id, binding: binding.id }
}

async function removeTarget(input, id) {
  if ((await targetBindings(input, id)).length) throw failure('target_has_bindings', `Target ${id} still has local Bindings.`)
  const home = await readHome(input)
  const settings = structuredClone(home.settings?.['hairness/targets'] ?? {})
  settings.targets ??= []
  if (!settings.targets.some((target) => target.id === id)) throw failure('target_missing', `Target ${id} is not declared.`)
  settings.targets = settings.targets.filter((target) => target.id !== id)
  home.settings['hairness/targets'] = settings
  await writeJsonAtomic(join(input.homeRoot, 'hairness.json'), home)
  return { status: 'removed', id }
}

async function mapTarget(input, id, flags) {
  requireDesk(input)
  const target = declaration(input, id)
  const binding = await selectBinding(input, id, flags.binding)
  const evidence = await inspectRepository(binding.path)
  if (!evidence.available && evidence.error) throw failure('target_unavailable', evidence.error)
  const files = (await git(['ls-files'], binding.path)).split('\n').filter(Boolean).sort().slice(0, 5000)
  const mappedAt = new Date().toISOString()
  const artifactId = flags.id ?? `${id}-${evidence.head.slice(0, 8)}`
  assertId(artifactId)
  const kind = input.resolvedHome.artifactKinds.find((entry) => entry.id === 'hairness/targets:target-map')
  if (!kind) throw failure('artifact_kind_missing', 'hairness/targets:target-map is not installed.')
  const destination = join(input.deskRoot, 'artifacts', kind.id.replace(/[/:]+/g, '-'), artifactId)
  if (await exists(destination)) throw failure('artifact_exists', `${relative(input.homeRoot, destination)} already exists.`)
  await mkdir(dirname(destination), { recursive: true })
  const packageInfo = await packageMetadata(binding.path, files)
  const values = mapValues(target, binding, evidence, files, packageInfo, mappedAt)
  const metadata = {
    $schema: 'https://hairness.dev/schema/artifact.json',
    id: artifactId,
    kind: kind.id,
    owner: 'desk',
    state: 'current',
    createdBy: 'hairness/targets',
    createdAt: mappedAt,
    derivedFrom: `target:${id}@${evidence.head}`,
    targets: [id],
  }
  const stage = await mkdtemp(join(dirname(destination), '.hairness-target-map-'))
  try {
    const body = substitute(await readFile(join(kind.root, kind.template), 'utf8'), values)
    await writeFile(join(stage, 'artifact.md'), renderArtifact(metadata, body), { mode: 0o644 })
    for (const source of kind.requiredFiles ?? []) {
      const content = substitute(await readFile(join(kind.root, source), 'utf8'), values)
      assertNoSecret(content)
      await writeFile(join(stage, basename(source)), content, { mode: 0o644 })
    }
    await rename(stage, destination)
  } catch (error) {
    await rm(stage, { recursive: true, force: true })
    throw error
  }
  return { status: 'mapped', target: id, binding: binding.id, head: evidence.head, mappedAt, artifact: relative(input.homeRoot, destination) }
}

function mapValues(target, binding, evidence, files, packageInfo, mappedAt) {
  const header = `Target: \`${target.id}\` · Binding: \`${binding.id}\` · HEAD: \`${evidence.head}\` · Mapped: ${mappedAt}`
  const manifests = files.filter((path) => /(^|\/)(package\.json|pyproject\.toml|Cargo\.toml|go\.mod|Gemfile|composer\.json)$/.test(path))
  const configs = files.filter((path) => /(^|\/)(Dockerfile|docker-compose|compose\.ya?ml|\.github|\.gitlab-ci|tsconfig|eslint|vite|next\.config|terraform)/i.test(path)).slice(0, 100)
  const tests = files.filter((path) => /(^|\/)(test|tests|spec|__tests__)(\/|$)|\.(test|spec)\.[^.]+$/i.test(path)).slice(0, 100)
  const docs = files.filter((path) => /(^|\/)(README|CONTRIBUTING|docs\/)/i.test(path)).slice(0, 100)
  const entrypoints = files.filter((path) => /(^|\/)(index|main|app|cli|server)\.[a-z0-9]+$/i.test(path)).slice(0, 50)
  const modules = [...new Set(files.map((path) => path.split('/')[0]))].slice(0, 100)
  const structure = modules.map((path) => `- \`${path}\``).join('\n') || '- No tracked paths.'
  const extensions = new Map()
  for (const path of files) {
    const extension = extname(path).toLowerCase() || '[none]'
    extensions.set(extension, (extensions.get(extension) ?? 0) + 1)
  }
  const languages = [...extensions.entries()].sort((left, right) => right[1] - left[1]).slice(0, 12).map(([extension, count]) => `- \`${extension}\`: ${count} files`).join('\n') || '- Unknown.'
  const uncertainty = files.length >= 5000 ? '- Mapping was capped at 5,000 tracked files.' : '- This map uses paths and bounded manifests; it does not claim semantic completeness.'
  return {
    target: target.id,
    binding: binding.id,
    head: evidence.head,
    header,
    manifests: bullets(manifests, 'No conventional manifests detected.'),
    languages,
    uncertainty,
    remotes: evidence.remotes.map((remote) => `- ${remote.name}: \`${remote.repository}\``).join('\n') || '- No remotes.',
    configs: bullets(configs, 'No conventional configuration signals detected.'),
    entrypoints: bullets(entrypoints, 'No conventional entry points detected.'),
    modules: bullets(modules, 'No module roots detected.'),
    structure,
    documentation: bullets(docs, 'No documentation signals detected.'),
    tests: bullets(tests, 'No conventional test paths detected.'),
    scripts: bullets(packageInfo.scripts, 'No package scripts detected.'),
    workingTree: `- ${evidence.clean ? 'Clean.' : `${evidence.changes.length} local change(s).`}\n- ${evidence.conflicts} conflict(s).`,
    operation: `- Branch: \`${evidence.branch ?? 'detached'}\`\n- Worktrees: ${evidence.worktrees.length}\n- Operation: ${evidence.operation ?? 'none'}`,
  }
}

async function packageMetadata(root, files) {
  const scripts = []
  for (const path of files.filter((entry) => basename(entry) === 'package.json').slice(0, 20)) {
    try {
      const document = JSON.parse(await readFile(join(root, path), 'utf8'))
      for (const name of Object.keys(document.scripts ?? {})) scripts.push(`${path}#${name}`)
    } catch {}
  }
  return { scripts: scripts.sort() }
}

async function targetBindings(input, id) {
  if (!input.deskRoot) return []
  const root = join(input.deskRoot, 'targets', id)
  const values = []
  for (const entry of await safeReadDir(root)) {
    if (!entry.isSymbolicLink() && !entry.isDirectory()) continue
    const link = join(root, entry.name)
    const path = await realpath(link).catch(() => null)
    values.push({ id: entry.name, type: entry.isSymbolicLink() ? 'bound' : 'managed', link, path })
  }
  return values
}

async function selectBinding(input, id, bindingId) {
  const bindings = await targetBindings(input, id)
  if (bindingId) {
    const selected = bindings.find((binding) => binding.id === bindingId)
    if (!selected) throw failure('target_binding_missing', `${id} has no Binding ${bindingId}.`)
    if (!selected.path) throw failure('target_binding_broken', `${id}/${bindingId} is broken.`)
    return selected
  }
  const usable = bindings.filter((binding) => binding.path)
  if (!usable.length) throw failure('target_unbound', `${id} has no usable Binding.`)
  if (usable.length > 1) throw failure('target_binding_ambiguous', `${id} has multiple Bindings; pass --binding.`)
  return usable[0]
}

async function inspectRepository(path) {
  const run = (args) => git(args, path)
  const root = await run(['rev-parse', '--show-toplevel'])
  const [head, branch, status, remoteOutput, committedAt, worktreeOutput] = await Promise.all([
    run(['rev-parse', 'HEAD']),
    run(['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => null),
    run(['status', '--porcelain=v2', '--branch', '--untracked-files=all']),
    run(['config', '--get-regexp', '^remote\\..*\\.url$']).catch(() => ''),
    run(['log', '-1', '--format=%cI']).catch(() => null),
    run(['worktree', 'list', '--porcelain']).catch(() => ''),
  ])
  const remotes = remoteOutput.split('\n').filter(Boolean).map((line) => {
    const separator = line.indexOf(' ')
    const name = line.slice(0, separator).replace(/^remote\./, '').replace(/\.url$/, '')
    const url = line.slice(separator + 1).trim()
    return { name, url, repository: normalizeRepository(url) }
  })
  const changes = status.split('\n').filter((line) => /^(1 |2 |u |\? )/.test(line))
  return {
    available: true,
    root,
    head,
    branch,
    clean: changes.length === 0,
    changes,
    conflicts: changes.filter((line) => line.startsWith('u ')).length,
    committedAt,
    operation: await gitOperation(root),
    worktrees: worktreeOutput.split('\n').filter((line) => line.startsWith('worktree ')),
    remotes,
  }
}

async function gitOperation(root) {
  const markers = [['merge', 'MERGE_HEAD'], ['rebase', 'rebase-merge'], ['rebase', 'rebase-apply'], ['cherry-pick', 'CHERRY_PICK_HEAD']]
  for (const [name, marker] of markers) {
    const path = await git(['rev-parse', '--git-path', marker], root)
    if (await exists(resolve(root, path))) return name
  }
  return null
}

function declarations(input) {
  return input.resolvedHome.home.settings?.['hairness/targets']?.targets ?? []
}

function declaration(input, id) {
  const target = declarations(input).find((entry) => entry.id === id)
  if (!target) throw failure('target_missing', `Target ${id} is not declared.`)
  return target
}

async function readHome(input) {
  return JSON.parse(await readFile(join(input.homeRoot, 'hairness.json'), 'utf8'))
}

async function writeJsonAtomic(path, value) {
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o644 })
  await rename(temporary, path)
}

function normalizeRepository(value) {
  let source = String(value).trim()
  const scp = source.match(/^(?:[^@]+@)?([^:/]+):(.+)$/)
  if (scp && !source.includes('://')) source = `ssh://${scp[1]}/${scp[2]}`
  try {
    const url = new URL(source)
    return `${url.hostname.toLowerCase()}/${url.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '').toLowerCase()}`
  } catch {
    return source.replace(/\.git$/i, '').replace(/^\/+|\/+$/g, '').toLowerCase()
  }
}

function assertRemoteSource(value) {
  try {
    const url = new URL(value)
    if (url.username || url.password || url.search || url.hash) throw failure('target_source_insecure', 'Target sources must not contain credentials, query parameters or fragments.')
  } catch (error) {
    if (error.code === 'target_source_insecure') throw error
    if (!/^[^@\s]+@[^:\s]+:[^\s]+$/.test(value) && !/^[a-z0-9.-]+\/[^/\s]+\/[^/\s]+$/i.test(value)) throw failure('target_source_invalid', `Invalid Target source ${value}.`)
  }
}

async function git(args, cwd) {
  try { return (await exec('git', args, { cwd, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })).stdout.trim() }
  catch (error) { throw failure('git_failed', error.stderr?.trim() || error.message) }
}

function renderArtifact(metadata, body) {
  return `---\n${Object.entries(metadata).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n')}\n---\n\n${body.trim()}\n`
}

function substitute(template, values) {
  return template.replace(/\{\{([A-Za-z0-9]+)\}\}/g, (_match, key) => values[key] ?? `Unknown ${key}.`)
}

function bullets(values, empty) {
  return values.length ? values.map((value) => `- \`${value}\``).join('\n') : `- ${empty}`
}

function assertNoSecret(content) {
  const patterns = [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, /\b(?:ghp|github_pat|sk)-[A-Za-z0-9_-]{20,}\b/, /\bAKIA[0-9A-Z]{16}\b/]
  if (patterns.some((pattern) => pattern.test(content))) throw failure('target_map_secret', 'Target Map output resembles a secret.')
}

async function removeEmpty(path, stop) {
  let current = path
  while (current !== stop) {
    try { await rm(current) } catch { break }
    current = dirname(current)
  }
}

async function safeReadDir(path) {
  try { return (await readdir(path, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name)) }
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
  if (value.targets) return value.targets.length
    ? value.targets.map((target) => `${target.id} · ${target.state} · ${target.bindings?.map((binding) => `${binding.id}:${binding.evidence?.clean ? 'clean' : binding.evidence?.available === false ? 'broken' : 'dirty'}`).join(', ') || 'no bindings'}`).join('\n')
    : 'No Targets.'
  return Object.entries(value).map(([key, entry]) => `${key}: ${typeof entry === 'object' ? JSON.stringify(entry) : entry}`).join('\n')
}

function requireDesk(input) { if (!input.deskRoot) throw failure('desk_missing', 'Configure a Desk before managing Target Bindings.') }
function required(value, label) { if (!value) throw failure('usage', `${label} is required.`, 2); return value }
function truthy(value) { return value === true || value === 'true' || value === 'yes' || value === '1' }
function slug(value) { return value.toLowerCase().replace(/\.git$/, '').replace(/[^a-z0-9._-]+/g, '-').replace(/^-|-$/g, '') }
function assertId(value) { if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(value)) throw failure('target_id_invalid', `Invalid Target id ${value}.`) }
function failure(code, message, exitCode = 4) { const error = new Error(message); error.code = code; error.exitCode = exitCode; return error }
function stdin() { return new Promise((resolvePromise, reject) => { const chunks = []; process.stdin.on('data', (chunk) => chunks.push(chunk)); process.stdin.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8'))); process.stdin.on('error', reject) }) }
