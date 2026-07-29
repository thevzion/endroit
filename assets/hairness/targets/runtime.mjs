#!/usr/bin/env node
import { execFile } from 'node:child_process'
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)

const TARGET_HELP = {
  list: {
    usage: 'hairness target list [--json]',
    effect: 'read-only',
    summary: 'List declared Targets, their Bindings and current repository evidence.',
  },
  discover: {
    usage: 'hairness target discover <root> [--json]',
    effect: 'read-only',
    summary: 'Discover Git repositories within a bounded directory.',
  },
  doctor: {
    usage: 'hairness target doctor [--json]',
    effect: 'read-only',
    summary: 'Check Target identities and Binding health.',
  },
  add: {
    usage: 'hairness target add <repository-or-path> [--id <id>] [--summary <text>] [--binding <id>] [--json]',
    effect: 'mutating — adds a shared Target declaration and may bind a local checkout',
    summary: 'Declare a Target from a remote identity or existing checkout.',
  },
  bind: {
    usage: 'hairness target bind <target> <repository-path> [--binding <id>] [--json]',
    effect: 'mutating — adds a personal Desk Binding',
    summary: 'Bind an existing checkout after verifying its repository identity.',
  },
  clone: {
    usage: 'hairness target clone <target> [--binding <id>] [--json]',
    effect: 'mutating — clones a managed Binding into the Desk',
    summary: 'Clone the declared Target source as a managed Binding.',
  },
  worktree: {
    usage: 'hairness target worktree <target> --binding <id> [--from-binding <id>] (--branch <existing> | --new-branch <name> [--start-point <ref>]) [--json]',
    effect: 'mutating — creates a managed linked worktree in the Desk',
    summary: 'Create a linked worktree from a usable Binding without fetching or copying local changes.',
  },
  unbind: {
    usage: 'hairness target unbind <target> [--binding <id>] [--delete] [--json]',
    effect: 'mutating — removes a Binding; --delete is required for a clean managed checkout',
    summary: 'Remove one selected local Binding without changing the Target declaration.',
  },
  remove: {
    usage: 'hairness target remove <target> [--json]',
    effect: 'mutating — removes an unbound shared Target declaration',
    summary: 'Remove a Target declaration after all Bindings are gone.',
  },
  inspect: {
    usage: 'hairness target inspect <target> [--binding <id>] [--json]',
    effect: 'read-only',
    summary: 'Collect deterministic evidence from one Target Binding without interpreting files.',
  },
}

try {
  const input = JSON.parse(await stdin())
  const { positionals, flags } = argumentsOf(input.argv)
  const [command, ...args] = positionals
  if (flags.help) {
    process.stdout.write(`${helpFor(command)}\n`)
  } else {
    const value = await route(input, command, args, flags)
    process.stdout.write(flags.json ? `${JSON.stringify(value, null, 2)}\n` : `${human(value)}\n`)
  }
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
  if (command === 'worktree') return createWorktree(input, required(args[0], 'Target id'), flags)
  if (command === 'unbind') return unbindTarget(input, required(args[0], 'Target id'), flags.binding, flags)
  if (command === 'remove') return removeTarget(input, required(args[0], 'Target id'))
  if (command === 'inspect') return inspectTarget(input, required(args[0], 'Target id'), flags)
  throw failure('usage', 'hairness target list|discover|doctor|add|bind|clone|worktree|unbind|remove|inspect', 2)
}

async function listTargets(input) {
  const targets = declarations(input)
  return Promise.all(targets.map(async (target) => {
    const bindings = await targetBindings(input, target.id)
    const inspected = await Promise.all(bindings.map(async (binding) => {
      const evidence = binding.path ? await inspectRepository(binding.path).catch((error) => ({ available: false, error: error.message })) : { available: false, error: 'Broken Binding.' }
      const matches = evidence.available !== false && evidence.remotes.some((remote) => remote.repository === target.repository)
      return { ...binding, matches, evidence }
    }))
    const registered = new Map(inspected.filter((binding) => binding.path).map((binding) => [binding.path, binding.id]))
    const worktrees = new Map()
    for (const binding of inspected.filter((entry) => entry.matches)) {
      for (const worktree of binding.evidence.worktrees) worktrees.set(worktree.path, {
        ...worktree,
        binding: registered.get(worktree.path) ?? null,
        registered: registered.has(worktree.path),
      })
    }
    return {
      ...target,
      state: bindings.length ? 'bound' : 'declared',
      bindings: inspected,
      worktrees: [...worktrees.values()].sort((left, right) => left.path.localeCompare(right.path)),
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
    const unbound = target.worktrees.filter((worktree) => !worktree.registered)
    if (unbound.length) limits.push(`target-worktrees-unbound:${target.id}:${unbound.length}`)
    for (const worktree of target.worktrees) {
      if (worktree.locked) limits.push(`target-worktree-locked:${target.id}:${worktree.path}`)
      if (worktree.prunable) limits.push(`target-worktree-prunable:${target.id}:${worktree.path}`)
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
  return { status: 'bound', id, binding: bindingId, type: 'bound', checkout: evidence.checkout, path: evidence.root }
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
    return { status: 'cloned', id, binding: bindingId, type: 'managed', checkout: evidence.checkout, path: evidence.root }
  } catch (error) {
    await rm(destination, { recursive: true, force: true })
    throw error
  }
}

async function createWorktree(input, id, flags) {
  requireDesk(input)
  const bindingId = required(flags.binding, 'Binding id')
  assertId(bindingId)
  const existingBranch = flags.branch
  const newBranch = flags['new-branch']
  if (Boolean(existingBranch) === Boolean(newBranch)) {
    throw failure('target_worktree_branch_mode', 'Pass exactly one of --branch or --new-branch.', 2)
  }
  if (flags['start-point'] && !newBranch) throw failure('target_worktree_start_point', '--start-point requires --new-branch.', 2)

  const target = declaration(input, id)
  const source = await selectBinding(input, id, flags['from-binding'], '--from-binding')
  const sourceEvidence = await inspectRepository(source.path)
  if (!sourceEvidence.remotes.some((remote) => remote.repository === target.repository)) {
    throw failure('target_remote_mismatch', `${sourceEvidence.root} does not match ${target.repository}.`)
  }

  const branch = String(existingBranch ?? newBranch)
  await validateBranch(source.path, branch)
  const destinationRoot = join(input.deskRoot, 'targets', id)
  const destination = join(destinationRoot, bindingId)
  const nested = relative(destinationRoot, destination)
  if (!nested || nested.startsWith('..') || resolve(destinationRoot, nested) !== destination) {
    throw failure('target_worktree_destination', 'Managed worktree destination must stay below the Target Binding root.')
  }
  if (await exists(destination)) throw failure('target_binding_exists', `Binding ${id}/${bindingId} already exists.`)

  const branchExists = await localBranchExists(source.path, branch)
  let expectedHead
  let command
  if (existingBranch) {
    if (!branchExists) throw failure('target_branch_missing', `Local branch ${branch} does not exist.`)
    if (sourceEvidence.worktrees.some((worktree) => worktree.branch === branch)) {
      throw failure('target_branch_in_use', `Local branch ${branch} is already checked out.`)
    }
    expectedHead = await git(['rev-parse', '--verify', `refs/heads/${branch}^{commit}`], source.path)
    command = ['worktree', 'add', '--', destination, branch]
  } else {
    if (branchExists) throw failure('target_branch_exists', `Local branch ${branch} already exists.`)
    const startPoint = String(flags['start-point'] ?? sourceEvidence.head)
    if (!startPoint || startPoint.startsWith('-') || startPoint.includes('\0')) throw failure('target_start_point_invalid', 'Invalid local start point.')
    expectedHead = await git(['rev-parse', '--verify', `${startPoint}^{commit}`], source.path)
      .catch(() => { throw failure('target_start_point_missing', `Local start point ${startPoint} does not resolve to a commit.`) })
    command = ['worktree', 'add', '-b', branch, '--', destination, expectedHead]
  }

  await mkdir(destinationRoot, { recursive: true })
  await git(command, source.path)
  const created = await inspectRepository(destination)
  if (created.checkout !== 'linked-worktree' || created.commonGitDir !== sourceEvidence.commonGitDir) {
    throw failure('target_worktree_repository_mismatch', 'Created checkout is not a linked worktree of the source repository.')
  }
  if (!created.remotes.some((remote) => remote.repository === target.repository)) {
    throw failure('target_remote_mismatch', `${created.root} does not match ${target.repository}.`)
  }
  if (created.branch !== branch || created.head !== expectedHead) {
    throw failure('target_worktree_revalidation', 'Created worktree branch or HEAD did not match the requested checkout.')
  }
  return {
    status: 'created',
    target: id,
    binding: bindingId,
    path: created.root,
    branch: created.branch,
    head: created.head,
    sourceBinding: source.id,
    type: 'managed',
    checkout: 'linked-worktree',
  }
}

async function unbindTarget(input, id, bindingId, flags) {
  const binding = await selectBinding(input, id, bindingId)
  const info = await lstat(binding.link)
  if (info.isSymbolicLink()) {
    await rm(binding.link)
  } else {
    if (!truthy(flags.delete)) throw failure('target_managed_delete_required', `Binding ${id}/${binding.id} is managed; pass --delete.`)
    const evidence = await inspectRepository(binding.path)
    if (!evidence.clean) throw failure('target_binding_dirty', `Managed Binding ${id}/${binding.id} has local changes.`)
    const current = evidence.worktrees.find((worktree) => worktree.path === evidence.root)
    if (binding.checkout === 'linked-worktree') {
      if (!current) throw failure('target_worktree_metadata_missing', `Linked worktree ${id}/${binding.id} is missing from Git metadata; repair it explicitly.`)
      if (current.locked) throw failure('target_worktree_locked', `Linked worktree ${id}/${binding.id} is locked; unlock it explicitly before deletion.`)
      if (current.prunable) throw failure('target_worktree_prunable', `Linked worktree ${id}/${binding.id} has prunable metadata; repair or prune it explicitly.`)
      const commandRoot = evidence.worktrees.find((worktree) => worktree.path !== evidence.root && !worktree.prunable && !worktree.locked && worktree.available)?.path
      if (!commandRoot) throw failure('target_worktree_source_missing', `No usable sibling checkout can remove ${id}/${binding.id}; repair the repository explicitly.`)
      await git(['worktree', 'remove', '--', evidence.root], commandRoot)
    } else {
      const dependants = evidence.worktrees.filter((worktree) => worktree.path !== evidence.root)
      if (dependants.length) {
        const condition = dependants.some((worktree) => worktree.prunable) ? 'prunable worktree metadata' : 'dependent worktrees'
        throw failure('target_clone_has_worktrees', `Managed clone ${id}/${binding.id} still has ${condition}.`)
      }
      await rm(binding.link, { recursive: true })
    }
  }
  await removeEmpty(join(input.deskRoot, 'targets', id), join(input.deskRoot, 'targets'))
  return { status: 'unbound', id, binding: binding.id, type: binding.type, checkout: binding.checkout }
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

async function inspectTarget(input, id, flags) {
  const target = declaration(input, id)
  const binding = await selectBinding(input, id, flags.binding)
  const evidence = await inspectRepository(binding.path)
  if (!evidence.remotes.some((remote) => remote.repository === target.repository)) {
    throw failure('target_remote_mismatch', `${evidence.root} does not match ${target.repository}.`)
  }
  const trackedFiles = (await git(['ls-files'], binding.path)).split('\n').filter(Boolean).sort()
  const files = trackedFiles.slice(0, 5000)
  const packageInfo = await packageMetadata(binding.path, files)
  const manifests = files.filter((path) => /(^|\/)(package\.json|pyproject\.toml|Cargo\.toml|go\.mod|Gemfile|composer\.json)$/.test(path))
  const tests = files.filter((path) => /(^|\/)(test|tests|spec|__tests__)(\/|$)|\.(test|spec)\.[^.]+$/i.test(path)).slice(0, 100)
  return {
    status: 'inspected',
    target: target.id,
    binding: binding.id,
    type: binding.type,
    checkout: binding.checkout,
    repository: target.repository,
    root: evidence.root,
    head: evidence.head,
    branch: evidence.branch,
    workingTree: {
      clean: evidence.clean,
      changes: evidence.changes.length,
      conflicts: evidence.conflicts,
      operation: evidence.operation,
      worktrees: evidence.worktrees.length,
    },
    observedAt: new Date().toISOString(),
    files,
    manifests,
    scripts: packageInfo.scripts,
    tests,
    limits: [
      ...(trackedFiles.length > 5000 ? [`Tracked files are capped at 5,000 of ${trackedFiles.length}.`] : []),
      'Manifest scripts are read from at most 20 package.json files.',
      'Tests are detected from conventional paths and filenames and capped at 100.',
      'No file content is interpreted by this scanner.',
    ],
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
    const layout = path ? await repositoryLayout(path).catch(() => null) : null
    values.push({ id: entry.name, type: entry.isSymbolicLink() ? 'bound' : 'managed', checkout: layout?.checkout ?? null, link, path })
  }
  return values
}

async function selectBinding(input, id, bindingId, flag = '--binding') {
  const bindings = await targetBindings(input, id)
  if (bindingId) {
    const selected = bindings.find((binding) => binding.id === bindingId)
    if (!selected) throw failure('target_binding_missing', `${id} has no Binding ${bindingId}.`)
    if (!selected.path) throw failure('target_binding_broken', `${id}/${bindingId} is broken.`)
    return selected
  }
  const usable = bindings.filter((binding) => binding.path)
  if (!usable.length) throw failure('target_unbound', `${id} has no usable Binding.`)
  if (usable.length > 1) throw failure('target_binding_ambiguous', `${id} has multiple Bindings; pass ${flag}.`)
  return usable[0]
}

async function inspectRepository(path) {
  const run = (args) => git(args, path)
  const root = await run(['rev-parse', '--show-toplevel'])
  const [head, branch, status, remoteOutput, committedAt, worktreeOutput, layout] = await Promise.all([
    run(['rev-parse', 'HEAD']),
    run(['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => null),
    run(['status', '--porcelain=v2', '--branch', '--untracked-files=all']),
    run(['config', '--get-regexp', '^remote\\..*\\.url$']).catch(() => ''),
    run(['log', '-1', '--format=%cI']).catch(() => null),
    run(['worktree', 'list', '--porcelain', '-z']).catch(() => ''),
    repositoryLayout(path),
  ])
  const remotes = remoteOutput.split('\n').filter(Boolean).map((line) => {
    const separator = line.indexOf(' ')
    const name = line.slice(0, separator).replace(/^remote\./, '').replace(/\.url$/, '')
    const url = line.slice(separator + 1).trim()
    return { name, url, repository: normalizeRepository(url) }
  })
  const changes = status.split('\n').filter((line) => /^(1 |2 |u |\? )/.test(line))
  const worktrees = await Promise.all(parseWorktrees(worktreeOutput).map(async ({ locked, prunable, ...worktree }) => ({
    ...worktree,
    path: await canonicalPath(worktree.path),
    available: await exists(worktree.path),
    locked: Boolean(locked),
    prunable: Boolean(prunable),
    ...(typeof locked === 'string' ? { lockedReason: locked } : {}),
    ...(typeof prunable === 'string' ? { prunableReason: prunable } : {}),
  })))
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
    worktrees,
    ...layout,
    remotes,
  }
}

async function repositoryLayout(path) {
  const [gitDirectory, commonDirectory] = await Promise.all([
    git(['rev-parse', '--git-dir'], path),
    git(['rev-parse', '--git-common-dir'], path),
  ])
  const gitDir = await canonicalPath(resolve(path, gitDirectory))
  const commonGitDir = await canonicalPath(resolve(path, commonDirectory))
  return { gitDir, commonGitDir, checkout: gitDir === commonGitDir ? 'main' : 'linked-worktree' }
}

function parseWorktrees(value) {
  const entries = []
  let current = null
  for (const field of value.split('\0')) {
    if (!field) {
      if (current) entries.push(current)
      current = null
      continue
    }
    const separator = field.indexOf(' ')
    const key = separator < 0 ? field : field.slice(0, separator)
    const entry = separator < 0 ? true : field.slice(separator + 1)
    if (key === 'worktree') {
      if (current) entries.push(current)
      current = { path: String(entry) }
    } else if (current && key === 'HEAD') current.head = entry
    else if (current && key === 'branch') current.branch = String(entry).replace(/^refs\/heads\//, '')
    else if (current && key === 'detached') current.detached = true
    else if (current && key === 'locked') current.locked = entry
    else if (current && key === 'prunable') current.prunable = entry
    else if (current && key === 'bare') current.bare = true
  }
  if (current) entries.push(current)
  return entries
}

async function validateBranch(root, branch) {
  if (!branch || branch.startsWith('-') || branch.includes('\0')) throw failure('target_branch_invalid', `Invalid branch ${branch}.`)
  await git(['check-ref-format', '--branch', branch], root)
    .catch(() => { throw failure('target_branch_invalid', `Invalid branch ${branch}.`) })
}

async function localBranchExists(root, branch) {
  try {
    await git(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], root)
    return true
  } catch {
    return false
  }
}

async function canonicalPath(path) {
  return realpath(path).catch(() => resolve(path))
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
    ? value.targets.map((target) => `${target.id} · ${target.state} · ${target.bindings?.map((binding) => `${binding.id}:${binding.checkout ?? 'unknown'}:${binding.evidence?.clean ? 'clean' : binding.evidence?.available === false ? 'broken' : 'dirty'}`).join(', ') || 'no bindings'} · ${target.worktrees?.filter((worktree) => !worktree.registered).length ?? 0} unbound worktrees`).join('\n')
    : 'No Targets.'
  return Object.entries(value).map(([key, entry]) => `${key}: ${typeof entry === 'object' ? JSON.stringify(entry) : entry}`).join('\n')
}

function helpFor(command) {
  if (!command) {
    return [
      'Usage: hairness target <command> [options]',
      '',
      'Commands:',
      ...Object.entries(TARGET_HELP).map(([name, entry]) => `  ${name.padEnd(8)} ${entry.summary}`),
      '',
      'Run hairness target <command> --help for command details.',
    ].join('\n')
  }
  const entry = TARGET_HELP[command]
  if (!entry) throw failure('usage', `Unknown target command ${command}.`, 2)
  return [`Usage: ${entry.usage}`, `Effect: ${entry.effect}`, '', entry.summary].join('\n')
}

function requireDesk(input) { if (!input.deskRoot) throw failure('desk_missing', 'Configure a Desk before managing Target Bindings.') }
function required(value, label) { if (!value) throw failure('usage', `${label} is required.`, 2); return value }
function truthy(value) { return value === true || value === 'true' || value === 'yes' || value === '1' }
function slug(value) { return value.toLowerCase().replace(/\.git$/, '').replace(/[^a-z0-9._-]+/g, '-').replace(/^-|-$/g, '') }
function assertId(value) { if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(value)) throw failure('target_id_invalid', `Invalid Target id ${value}.`) }
function failure(code, message, exitCode = 4) { const error = new Error(message); error.code = code; error.exitCode = exitCode; return error }
function stdin() { return new Promise((resolvePromise, reject) => { const chunks = []; process.stdin.on('data', (chunk) => chunks.push(chunk)); process.stdin.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8'))); process.stdin.on('error', reject) }) }
