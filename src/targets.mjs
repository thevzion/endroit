import { lstat, mkdir, readFile, readdir, readlink, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative } from 'node:path'
import { createArtifact, listArtifacts } from './artifacts.mjs'
import { git, inspectRepository, normalizeRepository } from './git.mjs'
import { loadDesk, loadHome, saveHome, settingsFor, updateSettings } from './home.mjs'
import { HairnessError } from './lib/errors.mjs'
import { assertId, exists } from './lib/io.mjs'

const MAP_FILES = ['STACK.md', 'INTEGRATIONS.md', 'ARCHITECTURE.md', 'STRUCTURE.md', 'CONVENTIONS.md', 'TESTING.md', 'CONCERNS.md']

export async function targetBindings(root, id) {
  const directory = join(root, '.desk', 'targets', id)
  let entries
  try {
    const info = await lstat(directory)
    if (info.isSymbolicLink()) throw new HairnessError('legacy_target_binding', `${directory} uses the unsupported single-binding layout.`)
    if (!info.isDirectory()) throw new HairnessError('target_binding_invalid', `${directory} is not a directory.`)
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
  const values = []
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(directory, entry.name)
    if (entry.isSymbolicLink()) {
      const raw = await readlink(path)
      try {
        values.push({ id: entry.name, type: 'bound', link: path, raw, path: await realpath(path), broken: false })
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
        values.push({ id: entry.name, type: 'bound', link: path, raw, path: null, broken: true })
      }
    } else if (entry.isDirectory()) {
      values.push({ id: entry.name, type: 'managed', path: await realpath(path), broken: false })
    } else {
      throw new HairnessError('target_binding_invalid', `${path} is not a checkout or symbolic link.`)
    }
  }
  return values
}

export async function targetBinding(root, id, bindingId) {
  const bindings = await targetBindings(root, id)
  if (bindingId) {
    const binding = bindings.find((entry) => entry.id === bindingId)
    if (!binding) throw new HairnessError('target_binding_missing', `Target ${id} has no Binding ${bindingId}.`)
    return binding
  }
  if (bindings.length > 1) throw new HairnessError('target_binding_ambiguous', `Target ${id} has multiple Bindings; pass --binding.`)
  return bindings[0] ?? null
}

export async function listTargets(root) {
  const home = await loadHome(root)
  const targets = settingsFor(home, 'hairness/targets').targets ?? []
  return Promise.all(targets.map(async (target) => {
    const bindings = await Promise.all((await targetBindings(root, target.id)).map(async (binding) => {
      const evidence = binding.path
        ? await inspectRepository(binding.path).catch((error) => ({ error: error.message }))
        : null
      const matches = evidence?.remotes?.some((remote) => remote.repository === normalizeRepository(target.repository)) ?? false
      return { ...binding, matches, evidence }
    }))
    const state = !bindings.length ? 'declared' : bindings.every((entry) => entry.type === 'managed') ? 'managed' : 'bound'
    return {
      ...target,
      state,
      bindings,
      matches: bindings.length ? bindings.every((entry) => entry.matches) : null,
    }
  }))
}

export async function addTarget(root, repository, options = {}) {
  const home = await loadHome(root)
  const settings = structuredClone(settingsFor(home, 'hairness/targets'))
  settings.targets ??= []
  let path = null
  let source = safeRepositorySource(repository)
  let normalized = normalizeRepository(repository)
  if (await exists(repository)) {
    const evidence = await inspectRepository(repository)
    if (!evidence.remotes.length) throw new HairnessError('target_remote_missing', 'A Target must have at least one Git remote.')
    path = evidence.root
    normalized = evidence.remotes[0].repository
    source = safeRepositorySource(evidence.remotes[0].url)
  }
  const id = assertId(options.id ?? slug(path ? basename(path) : normalized.split('/').at(-1)), 'Target id')
  if (settings.targets.some((target) => target.id === id)) throw new HairnessError('target_exists', `Target ${id} already exists.`)
  settings.targets.push({ id, repository: normalized, source, ...(options.summary ? { summary: options.summary } : {}) })
  updateSettings(home, 'hairness/targets', settings)
  await saveHome(root, home)
  if (path) await bindTarget(root, id, path, { binding: options.binding })
  return (await listTargets(root)).find((target) => target.id === id)
}

export async function bindTarget(root, id, repositoryPath, options = {}) {
  const target = await declaredTarget(root, id)
  await loadDesk(root, { required: true })
  const evidence = await inspectRepository(repositoryPath)
  if (!evidence.remotes.some((remote) => remote.repository === target.repository)) {
    throw new HairnessError('target_remote_mismatch', `${evidence.root} does not match ${target.repository}.`)
  }
  const bindingId = assertId(options.binding ?? slug(basename(evidence.root)), 'Binding id')
  const link = join(root, '.desk', 'targets', id, bindingId)
  if (await exists(link)) throw new HairnessError('target_binding_exists', `Binding ${id}/${bindingId} already exists.`)
  await mkdir(dirname(link), { recursive: true })
  await symlink(evidence.root, link, 'dir')
  return { id, binding: bindingId, type: 'bound', path: await realpath(link), repository: target.repository }
}

export async function cloneTarget(root, id, options = {}) {
  const target = await declaredTarget(root, id)
  await loadDesk(root, { required: true })
  const bindingId = assertId(options.binding ?? 'main', 'Binding id')
  const destination = join(root, '.desk', 'targets', id, bindingId)
  if (await exists(destination)) throw new HairnessError('target_binding_exists', `Binding ${id}/${bindingId} already exists.`)
  await mkdir(dirname(destination), { recursive: true })
  try {
    await git(['clone', '--quiet', '--', target.source, destination], { cwd: root })
    const evidence = await inspectRepository(destination)
    if (!evidence.remotes.some((remote) => remote.repository === target.repository)) {
      throw new HairnessError('target_remote_mismatch', `${evidence.root} does not match ${target.repository}.`, {
        details: { expected: target.repository, remotes: evidence.remotes },
      })
    }
    return { id, binding: bindingId, type: 'managed', path: evidence.root, repository: target.repository }
  } catch (error) {
    await rm(destination, { recursive: true, force: true })
    throw error
  }
}

export async function unbindTarget(root, id, bindingId, options = {}) {
  const binding = await targetBinding(root, id, bindingId)
  if (!binding) return { id, status: 'unbound' }
  if (binding.type === 'managed') {
    if (!options.delete) throw new HairnessError('target_managed_delete_required', `Binding ${id}/${binding.id} is a managed clone; pass --delete to remove it.`)
    const evidence = await inspectRepository(binding.path)
    if (!evidence.clean) throw new HairnessError('target_binding_dirty', `Managed Binding ${id}/${binding.id} has local changes.`)
    await rm(binding.path, { recursive: true, force: true })
  } else {
    await unlink(binding.link)
  }
  await removeEmptyParents(join(root, '.desk', 'targets', id), join(root, '.desk', 'targets'))
  return { id, binding: binding.id, status: 'unbound' }
}

export async function removeTarget(root, id) {
  const bindings = await targetBindings(root, id)
  if (bindings.length) throw new HairnessError('target_has_bindings', `Target ${id} still has ${bindings.length} Binding(s).`)
  const home = await loadHome(root)
  const settings = structuredClone(settingsFor(home, 'hairness/targets'))
  settings.targets ??= []
  if (!settings.targets.some((target) => target.id === id)) throw new HairnessError('target_missing', `Target ${id} is not declared.`)
  settings.targets = settings.targets.filter((target) => target.id !== id)
  updateSettings(home, 'hairness/targets', settings)
  await saveHome(root, home)
  return { id, status: 'removed' }
}

export async function doctorTargets(root) {
  const targets = await listTargets(root)
  const limits = targets.flatMap((target) => target.bindings.flatMap((binding) => binding.broken
    ? [`target-binding-broken:${target.id}:${binding.id}`]
    : !binding.matches
      ? [`target-remote-mismatch:${target.id}:${binding.id}`]
      : binding.evidence?.conflicts
        ? [`target-conflicts:${target.id}:${binding.id}`]
        : []))
  return { status: limits.length ? 'partial' : 'ready', targets, limits }
}

export async function mapTarget(root, id, options = {}) {
  const target = await declaredTarget(root, id)
  const binding = await targetBinding(root, id, options.binding)
  if (!binding?.path) throw new HairnessError('target_unbound', `Target ${id} has no usable Binding.`)
  const evidence = await inspectRepository(binding.path)
  const files = await git(['ls-files'], { cwd: binding.path, trim: false }).then((value) => value.split('\n').filter(Boolean).sort())
  const packageInfo = await packageSummary(binding.path, files)
  const assetVersion = await targetsAssetVersion(root)
  const mappedAt = new Date().toISOString()
  const short = evidence.head.slice(0, 12)
  const artifactId = options.id ?? `${id}-${short}`
  const stage = join(root, '.hairness', 'staging', `target-map-${artifactId}`)
  if (await exists(stage)) throw new HairnessError('target_map_stage_exists', `${relative(root, stage)} already exists.`)
  await mkdir(stage, { recursive: true })
  const documents = targetMapDocuments({ target, binding, evidence, files, packageInfo, mappedAt, assetVersion })
  for (const [name, content] of Object.entries(documents)) await writeFile(join(stage, name), content)
  assertNoSecrets(documents)
  const created = await createArtifact(root, 'hairness/targets:target-map', artifactId, {
    owner: 'desk',
    target: id,
    createdBy: 'hairness/targets',
    derivedFrom: `target:${id}@${evidence.head}`,
    from: stage,
  })
  return { ...created, target: id, binding: binding.id, head: evidence.head, mappedAt }
}

export async function discoverTargets(directory, options = {}) {
  const root = await realpath(directory)
  const ignored = new Set(options.ignored ?? ['.git', '.hg', '.svn', 'node_modules', 'dist', 'build', 'coverage', '.cache', '.next', 'tmp'])
  const repositories = []
  const limits = []
  async function visit(path) {
    let entries
    try {
      entries = await readdir(path, { withFileTypes: true })
    } catch (error) {
      limits.push({ path, code: error.code ?? 'read_failed', message: error.message })
      return
    }
    if (entries.some((entry) => entry.name === '.git')) {
      try {
        repositories.push(await inspectRepository(path))
      } catch (error) {
        limits.push({ path, code: error.code ?? 'git_failed', message: error.message })
      }
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || ignored.has(entry.name)) continue
      await visit(join(path, entry.name))
    }
  }
  await visit(root)
  return { root, repositories, limits }
}

export async function targetMapFreshness(root, targets) {
  const artifacts = await listArtifacts(root)
  const maps = artifacts.filter((entry) => entry.kind === 'hairness/targets:target-map' && !entry.invalid)
  return Object.fromEntries(await Promise.all(targets.map(async (target) => {
    const heads = target.bindings.map((binding) => binding.evidence?.head).filter(Boolean)
    const current = maps.filter((map) => (map.targets ?? []).includes(target.id)).some((map) => heads.some((head) => map.derivedFrom === `target:${target.id}@${head}`))
    return [target.id, { maps: maps.filter((map) => (map.targets ?? []).includes(target.id)).length, current }]
  })))
}

async function declaredTarget(root, id) {
  const home = await loadHome(root)
  const target = (settingsFor(home, 'hairness/targets').targets ?? []).find((entry) => entry.id === id)
  if (!target) throw new HairnessError('target_missing', `Target ${id} is not declared.`)
  return target
}

async function packageSummary(root, files) {
  if (!files.includes('package.json')) return null
  try {
    const value = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
    return {
      packageManager: value.packageManager ?? null,
      dependencies: Object.keys(value.dependencies ?? {}).sort(),
      devDependencies: Object.keys(value.devDependencies ?? {}).sort(),
      scripts: Object.keys(value.scripts ?? {}).sort(),
    }
  } catch {
    return null
  }
}

function targetMapDocuments({ target, binding, evidence, files, packageInfo, mappedAt, assetVersion }) {
  const extensions = new Map()
  for (const path of files) {
    const extension = path.includes('.') ? path.split('.').at(-1).toLowerCase() : '(none)'
    extensions.set(extension, (extensions.get(extension) ?? 0) + 1)
  }
  const top = [...new Set(files.map((path) => path.split('/')[0]))].sort()
  const configs = files.filter((path) => /(^|\/)(?:package\.json|[^/]*(?:config|rc)\.[^/]+|Dockerfile|Makefile|Cargo\.toml|pyproject\.toml|go\.mod)$/.test(path))
  const tests = files.filter((path) => /(^|\/)(?:test|tests|__tests__)(\/|$)|\.(?:test|spec)\.[^.]+$/.test(path))
  const header = `> Target: \`${target.id}\` · Binding: \`${binding.id}\` · HEAD: \`${evidence.head}\` · Mapped: ${mappedAt} · Mapper: \`hairness/targets@${assetVersion}\`\n`
  return {
    'STACK.md': `${header}\n# Stack\n\n## File signals\n\n${[...extensions.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([extension, count]) => `- \`.${extension}\`: ${count}`).join('\n') || '- No tracked files.'}\n\n## Package metadata\n\n${packageInfo ? `- Package manager: ${packageInfo.packageManager ?? 'not declared'}\n- Dependencies: ${packageInfo.dependencies.join(', ') || 'none'}\n- Development dependencies: ${packageInfo.devDependencies.join(', ') || 'none'}` : '- No readable package.json.'}\n`,
    'INTEGRATIONS.md': `${header}\n# Integrations\n\n## Git remotes\n\n${evidence.remotes.map((remote) => `- ${remote.name}: ${remote.repository}`).join('\n') || '- None declared.'}\n\n## Configuration signals\n\n${configs.map((path) => `- \`${path}\``).join('\n') || '- No conventional integration files detected.'}\n`,
    'ARCHITECTURE.md': `${header}\n# Architecture\n\n## Top-level areas\n\n${top.map((path) => `- \`${path}\``).join('\n') || '- Empty repository.'}\n\n## Evidence boundary\n\nThis map is derived from tracked paths and declared package metadata. Runtime relationships still require human or agent review.\n`,
    'STRUCTURE.md': `${header}\n# Structure\n\n${files.slice(0, 120).map((path) => `- \`${path}\``).join('\n') || '- Empty repository.'}\n${files.length > 120 ? `\n- … ${files.length - 120} additional tracked paths omitted.\n` : ''}`,
    'CONVENTIONS.md': `${header}\n# Conventions\n\n## Configuration files\n\n${configs.map((path) => `- \`${path}\``).join('\n') || '- No conventional configuration files detected.'}\n\n## Uncertainties\n\n- Naming and review conventions require confirmation from owned documentation or maintainers.\n`,
    'TESTING.md': `${header}\n# Testing\n\n## Test files\n\n${tests.slice(0, 80).map((path) => `- \`${path}\``).join('\n') || '- No conventional test paths detected.'}\n\n## Package scripts\n\n${packageInfo?.scripts.map((name) => `- \`${name}\``).join('\n') || '- No readable package scripts.'}\n`,
    'CONCERNS.md': `${header}\n# Concerns\n\n- Worktree: ${evidence.clean ? 'clean' : `${evidence.changes.length} local change(s)`}\n- Conflicts: ${evidence.conflicts}\n- Git operation: ${evidence.operation ?? 'none'}\n- Ahead/behind: +${evidence.ahead}/-${evidence.behind}\n- Tracked files: ${files.length}\n\n## Uncertainties\n\n- This deterministic map does not infer business intent, runtime health or undocumented ownership.\n`,
  }
}

function assertNoSecrets(documents) {
  const content = Object.values(documents).join('\n')
  const patterns = [
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
    /\b(?:api[_-]?key|password|secret|token)\s*[:=]\s*[^\s]+/i,
    /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
    /\bAKIA[0-9A-Z]{16}\b/,
  ]
  if (patterns.some((pattern) => pattern.test(content))) throw new HairnessError('target_map_secret', 'Target Map output resembles a secret and was not promoted from staging.')
}

async function targetsAssetVersion(root) {
  for (const path of [
    join(root, '.desk', 'assets', 'hairness', 'targets', 'asset.json'),
    join(root, 'assets', 'hairness', 'targets', 'asset.json'),
  ]) {
    try { return JSON.parse(await readFile(path, 'utf8')).version }
    catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  throw new HairnessError('asset_not_installed', 'hairness/targets is not installed.')
}

async function removeEmptyParents(path, stop) {
  let current = path
  while (current !== stop) {
    try { await rm(current, { recursive: false }) } catch { break }
    current = dirname(current)
  }
}

function slug(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-|-$/g, '').slice(0, 80)
}

function safeRepositorySource(value) {
  const source = String(value).trim()
  if (/^https?:\/\//.test(source)) {
    const url = new URL(source)
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
      throw new HairnessError('target_source_insecure', 'Target HTTPS sources must not contain credentials, query parameters or fragments.')
    }
  }
  return source
}
