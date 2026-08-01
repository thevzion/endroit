#!/usr/bin/env node
import { execFile } from 'node:child_process'
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const SITE_HELP = {
  list: 'endroit site list [--json]',
  inspect: 'endroit site inspect <site> [--json]',
  doctor: 'endroit site doctor [--json]',
  add: 'endroit site add <repository-or-path> [--id <id>] [--emoji <emoji>] [--summary <text>] [--when <situation>] [--tag <tag>] [--json]',
  remove: 'endroit site remove <site> [--json]',
}
const ROUTE_HELP = {
  list: 'endroit route list [site] [--json]',
  inspect: 'endroit route inspect <site> [--id <route>] [--json]',
  bind: 'endroit route bind <site> <repository-path> [--id <route>] [--json]',
  clone: 'endroit route clone <site> [--id <route>] [--json]',
  worktree: 'endroit route worktree <site> --id <route> [--from <route>] (--branch <existing> | --new-branch <name> [--start-point <ref>]) [--json]',
  mount: 'endroit route mount <site> [--id <route>] [--json]',
  unmount: 'endroit route unmount <site> [--id <route>] [--json]',
  remove: 'endroit route remove <site> [--id <route>] [--delete] [--json]',
}

try {
  const input = JSON.parse(await stdin())
  const { positionals, flags } = argumentsOf(input.argv)
  const [surface, ...rest] = positionals
  const routeSurface = surface === 'route'
  const command = routeSurface ? rest.shift() : surface
  if (flags.help) process.stdout.write(`${help(routeSurface ? 'route' : 'site', command)}\n`)
  else {
    const value = routeSurface
      ? await routeCommand(input, command, rest, flags)
      : await siteCommand(input, command, rest, flags)
    process.stdout.write(flags.json ? `${JSON.stringify(value, null, 2)}\n` : `${human(value)}\n`)
  }
} catch (error) {
  process.stderr.write(`${error.code ?? 'site_failed'}: ${error.message}\n`)
  process.exitCode = error.exitCode ?? 4
}

async function siteCommand(input, command, args, flags) {
  if (command === 'list') return { status: 'listed', sites: await listSites(input) }
  if (command === 'inspect') return inspectSite(input, required(args[0], 'Site id'))
  if (command === 'doctor') return doctorSites(input)
  if (command === 'add') return addSite(input, required(args[0], 'Repository'), flags)
  if (command === 'remove') return removeSite(input, required(args[0], 'Site id'))
  throw failure('usage', 'endroit site list|inspect|doctor|add|remove', 2)
}

async function routeCommand(input, command, args, flags) {
  if (command === 'list') return { status: 'listed', routes: await listRoutes(input, args[0]) }
  if (command === 'inspect') return inspectRoute(input, required(args[0], 'Site id'), flags.id)
  if (command === 'bind') return bindRoute(input, required(args[0], 'Site id'), required(args[1], 'Repository path'), flags.id)
  if (command === 'clone') return cloneRoute(input, required(args[0], 'Site id'), flags.id)
  if (command === 'worktree') return createWorktree(input, required(args[0], 'Site id'), flags)
  if (command === 'mount') return mountRoute(input, required(args[0], 'Site id'), flags.id)
  if (command === 'unmount') return unmountRoute(input, required(args[0], 'Site id'), flags.id)
  if (command === 'remove') return removeRoute(input, required(args[0], 'Site id'), flags.id, flags)
  throw failure('usage', 'endroit route bind|clone|worktree|mount|unmount|list|inspect|remove', 2)
}

async function listSites(input) {
  return Promise.all(declarations(input).map(async (site) => {
    const routes = await routesFor(input, site.id)
    const inspected = await Promise.all(routes.map(async (route) => {
      const evidence = await inspectRepository(route.path).catch((error) => ({ available: false, error: error.message }))
      return { ...route, mount: await inspectMount(input, route), matches: matchesSite(site, evidence), evidence }
    }))
    const registered = new Map(inspected.filter((route) => route.path).map((route) => [route.path, route.id]))
    const worktrees = new Map()
    for (const route of inspected.filter((entry) => entry.matches && entry.evidence.available)) {
      for (const worktree of route.evidence.worktrees) worktrees.set(worktree.path, {
        ...worktree,
        route: registered.get(worktree.path) ?? null,
        registered: registered.has(worktree.path),
      })
    }
    return {
      ...site,
      state: routes.length ? 'routed' : 'declared',
      routes: inspected,
      worktrees: [...worktrees.values()].sort((left, right) => left.path.localeCompare(right.path)),
    }
  }))
}

async function listRoutes(input, siteId) {
  if (siteId) {
    declaration(input, siteId)
    return routesFor(input, siteId)
  }
  const values = []
  for (const site of declarations(input)) values.push(...await routesFor(input, site.id))
  return values.sort((left, right) => left.site.localeCompare(right.site) || left.id.localeCompare(right.id))
}

async function inspectSite(input, id) {
  const site = declaration(input, id)
  return { status: 'inspected', ...site, routes: await routesFor(input, id) }
}

async function inspectRoute(input, id, routeId) {
  const site = declaration(input, id)
  const route = await selectRoute(input, id, routeId)
  const evidence = await inspectRepository(route.path)
  assertSiteMatches(site, evidence)
  const trackedFiles = (await git(['ls-files'], route.path)).split('\n').filter(Boolean).sort()
  const files = trackedFiles.slice(0, 5000)
  const scripts = []
  for (const path of files.filter((entry) => basename(entry) === 'package.json').slice(0, 20)) {
    try {
      const document = JSON.parse(await readFile(join(route.path, path), 'utf8'))
      for (const name of Object.keys(document.scripts ?? {})) scripts.push(`${path}#${name}`)
    } catch {}
  }
  return {
    status: 'inspected',
    site: id,
    route: route.id,
    mode: route.mode,
    repository: site.repository ?? null,
    root: evidence.root,
    head: evidence.head,
    branch: evidence.branch,
    mount: await inspectMount(input, route),
    workingTree: {
      clean: evidence.clean,
      changes: evidence.changes.length,
      conflicts: evidence.conflicts,
      operation: evidence.operation,
      worktrees: evidence.worktrees.length,
    },
    observedAt: new Date().toISOString(),
    files,
    manifests: files.filter((path) => /(^|\/)(package\.json|pyproject\.toml|Cargo\.toml|go\.mod|Gemfile|composer\.json)$/.test(path)),
    scripts: scripts.sort(),
    tests: files.filter((path) => /(^|\/)(test|tests|spec|__tests__)(\/|$)|\.(test|spec)\.[^.]+$/i.test(path)).slice(0, 100),
    limits: [
      ...(trackedFiles.length > 5000 ? [`Tracked files are capped at 5,000 of ${trackedFiles.length}.`] : []),
      'Manifest scripts are read from at most 20 package.json files.',
      'Tests are detected from conventional paths and filenames and capped at 100.',
      'No file content is interpreted by this scanner.',
    ],
  }
}

async function doctorSites(input) {
  const sites = await listSites(input)
  const limits = []
  for (const site of sites) {
    for (const route of site.routes) {
      if (!route.evidence.available) limits.push(`route-broken:${site.id}:${route.id}`)
      else if (!route.matches) limits.push(`route-site-mismatch:${site.id}:${route.id}`)
      if (route.evidence.conflicts) limits.push(`route-conflicts:${site.id}:${route.id}`)
      if (route.mount && !['ready', 'direct'].includes(route.mount.status)) limits.push(`route-mount-${route.mount.status}:${site.id}:${route.id}`)
    }
    const unregistered = site.worktrees.filter((worktree) => !worktree.registered)
    if (unregistered.length) limits.push(`site-worktrees-unrouted:${site.id}:${unregistered.length}`)
    for (const worktree of site.worktrees) {
      if (worktree.locked) limits.push(`site-worktree-locked:${site.id}:${worktree.path}`)
      if (worktree.prunable) limits.push(`site-worktree-prunable:${site.id}:${worktree.path}`)
    }
  }
  return { status: limits.length ? 'partial' : 'ready', sites, limits }
}

async function addSite(input, repository, flags) {
  let source = repository
  let normalized
  let evidence
  try {
    evidence = await inspectRepository(resolve(repository))
    const remote = evidence.remotes[0]
    source = remote?.url
    normalized = remote?.repository
  } catch (error) {
    if (error.code && error.code !== 'git_failed' && error.code !== 'ENOENT') throw error
    assertRemoteSource(repository)
    normalized = normalizeRepository(repository)
  }
  const id = flags.id ?? slug(basename(normalized ?? evidence?.root ?? repository))
  assertId(id)
  if (declarations(input).some((site) => site.id === id) || await exists(join(input.homeRoot, 'sites', id))) {
    throw failure('site_exists', `Site ${id} already exists.`)
  }
  const when = value(flags.when)
  const tag = value(flags.tag)
  if (flags.when !== undefined && !when) throw failure('usage', '--when requires a non-empty situation.', 2)
  if (flags.tag !== undefined && (!tag || !validId(tag))) throw failure('site_tag_invalid', `Invalid Site tag ${flags.tag}.`)
  const site = {
    $schema: 'https://endroit.org/schema/site.json',
    id,
    kind: 'site',
    status: 'active',
    ...(normalized ? { repository: normalized } : {}),
    ...(source ? { source } : {}),
    ...(flags.emoji ? { emoji: assertEmoji(flags.emoji) } : {}),
    ...(flags.summary ? { summary: String(flags.summary) } : {}),
    ...(when ? { when: [when] } : {}),
    ...(tag ? { tags: [tag] } : {}),
  }
  await writeSite(input, site)
  let bound = null
  if (evidence && input.deskRoot) {
    const routeId = flags.route ?? 'main'
    const existing = (await routesFor(input, id)).find((route) => route.id === routeId)
    if (existing) {
      const current = await inspectRepository(existing.path)
      assertSiteMatches(site, current)
      bound = existing
    } else {
      bound = await bindRoute(input, id, evidence.root, routeId, site)
    }
  }
  return { status: 'added', ...site, ref: `site:${id}`, routes: bound ? [bound] : [] }
}

async function removeSite(input, id) {
  declaration(input, id)
  if ((await routesFor(input, id)).length) throw failure('site_has_routes', `Site ${id} still has local Routes.`)
  const root = join(input.homeRoot, 'sites', id)
  const entries = await safeReadDir(root)
  if (entries.some((entry) => entry.name !== 'SITE.md')) throw failure('site_not_empty', `Site ${id} contains material beyond SITE.md.`)
  await rm(root, { recursive: true })
  await removeEmpty(join(input.homeRoot, 'sites'), input.homeRoot)
  return { status: 'removed', id }
}

async function bindRoute(input, id, repositoryPath, routeId = 'main', declaredSite) {
  requireDesk(input)
  assertId(routeId)
  const site = declaredSite ?? declaration(input, id)
  await assertRouteAvailable(input, id, routeId)
  const evidence = await inspectRepository(resolve(repositoryPath))
  assertSiteMatches(site, evidence)
  const superproject = await git(['rev-parse', '--show-superproject-working-tree'], evidence.root).catch(() => '')
  const mode = evidence.root === input.homeRoot ? 'embedded' : superproject ? 'submodule' : 'existing'
  const route = await writeRoute(input, {
    id: routeId,
    site: id,
    mode,
    path: mode === 'embedded' ? '.' : evidence.root,
    branch: evidence.branch,
  })
  return { ...route, checkout: evidence.checkout }
}

async function cloneRoute(input, id, routeId = 'main') {
  requireDesk(input)
  assertId(routeId)
  const site = declaration(input, id)
  if (!site.source) throw failure('site_source_missing', `Site ${id} has no clone source.`)
  await assertRouteAvailable(input, id, routeId)
  const destination = managedPath(input, id, routeId)
  if (await exists(destination)) throw failure('route_checkout_exists', `${relative(input.homeRoot, destination)} already exists.`)
  await mkdir(dirname(destination), { recursive: true })
  try {
    await git(['clone', '--quiet', '--', site.source, destination], input.homeRoot)
    const evidence = await inspectRepository(destination)
    assertSiteMatches(site, evidence)
    const route = await writeRoute(input, {
      id: routeId,
      site: id,
      mode: 'managed-clone',
      path: relative(input.homeRoot, destination),
      branch: evidence.branch,
    })
    return { ...route, checkout: evidence.checkout }
  } catch (error) {
    await rm(destination, { recursive: true, force: true })
    throw error
  }
}

async function createWorktree(input, id, flags) {
  requireDesk(input)
  const routeId = required(flags.id, 'Route id')
  assertId(routeId)
  await assertRouteAvailable(input, id, routeId)
  const existingBranch = flags.branch
  const newBranch = flags['new-branch']
  if (Boolean(existingBranch) === Boolean(newBranch)) throw failure('site_worktree_branch_mode', 'Pass exactly one of --branch or --new-branch.', 2)
  if (flags['start-point'] && !newBranch) throw failure('site_worktree_start_point', '--start-point requires --new-branch.', 2)
  const site = declaration(input, id)
  const source = await selectRoute(input, id, flags.from, '--from')
  const sourceEvidence = await inspectRepository(source.path)
  assertSiteMatches(site, sourceEvidence)
  const branch = String(existingBranch ?? newBranch)
  await validateBranch(source.path, branch)
  const destination = managedPath(input, id, routeId)
  if (await exists(destination)) throw failure('route_checkout_exists', `${relative(input.homeRoot, destination)} already exists.`)
  const branchExists = await localBranchExists(source.path, branch)
  let expectedHead
  let command
  if (existingBranch) {
    if (!branchExists) throw failure('site_branch_missing', `Local branch ${branch} does not exist.`)
    if (sourceEvidence.worktrees.some((worktree) => worktree.branch === branch)) throw failure('site_branch_in_use', `Local branch ${branch} is already checked out.`)
    expectedHead = await git(['rev-parse', '--verify', `refs/heads/${branch}^{commit}`], source.path)
    command = ['worktree', 'add', '--', destination, branch]
  } else {
    if (branchExists) throw failure('site_branch_exists', `Local branch ${branch} already exists.`)
    const startPoint = String(flags['start-point'] ?? sourceEvidence.head)
    if (!startPoint || startPoint.startsWith('-') || startPoint.includes('\0')) throw failure('site_start_point_invalid', 'Invalid local start point.')
    expectedHead = await git(['rev-parse', '--verify', `${startPoint}^{commit}`], source.path)
      .catch(() => { throw failure('site_start_point_missing', `Local start point ${startPoint} does not resolve to a commit.`) })
    command = ['worktree', 'add', '-b', branch, '--', destination, expectedHead]
  }
  await mkdir(dirname(destination), { recursive: true })
  await git(command, source.path)
  try {
    const created = await inspectRepository(destination)
    if (created.checkout !== 'linked-worktree' || created.commonGitDir !== sourceEvidence.commonGitDir) throw failure('site_worktree_repository_mismatch', 'Created checkout is not a linked worktree of the source repository.')
    assertSiteMatches(site, created)
    if (created.branch !== branch || created.head !== expectedHead) throw failure('site_worktree_revalidation', 'Created worktree branch or HEAD did not match the requested checkout.')
    const route = await writeRoute(input, {
      id: routeId,
      site: id,
      mode: 'managed-worktree',
      path: relative(input.homeRoot, destination),
      branch,
      sourceRoute: source.id,
    })
    return { ...route, head: created.head, checkout: created.checkout }
  } catch (error) {
    await git(['worktree', 'remove', '--force', '--', destination], source.path).catch(() => {})
    throw error
  }
}

async function removeRoute(input, id, routeId, flags) {
  const route = await selectRoute(input, id, routeId)
  const mount = await inspectMount(input, route)
  if (mount && mount.status !== 'direct') throw failure('route_mount_exists', `Route ${id}/${route.id} still has a Mount; unmount it first.`)
  if (route.mode.startsWith('managed-')) {
    if (!truthy(flags.delete)) throw failure('route_managed_delete_required', `Route ${id}/${route.id} is managed; pass --delete.`)
    if (!await exists(route.path)) throw failure('route_broken', `Managed Route ${id}/${route.id} has no checkout.`)
    const evidence = await inspectRepository(route.path)
    if (!evidence.clean) throw failure('route_dirty', `Managed Route ${id}/${route.id} has local changes.`)
    const current = evidence.worktrees.find((worktree) => worktree.path === evidence.root)
    if (route.mode === 'managed-worktree') {
      if (!current) throw failure('site_worktree_metadata_missing', `Linked worktree ${id}/${route.id} is missing from Git metadata.`)
      if (current.locked) throw failure('site_worktree_locked', `Linked worktree ${id}/${route.id} is locked.`)
      if (current.prunable) throw failure('site_worktree_prunable', `Linked worktree ${id}/${route.id} has prunable metadata.`)
      const source = evidence.worktrees.find((entry) => entry.path !== evidence.root && entry.available && !entry.locked && !entry.prunable)?.path
      if (!source) throw failure('site_worktree_source_missing', `No usable sibling checkout can remove ${id}/${route.id}.`)
      await git(['worktree', 'remove', '--', evidence.root], source)
    } else {
      const dependants = evidence.worktrees.filter((worktree) => worktree.path !== evidence.root)
      if (dependants.length) throw failure('site_clone_has_worktrees', `Managed clone ${id}/${route.id} still has dependent worktrees.`)
      await rm(route.path, { recursive: true })
    }
  }
  await rm(route.documentPath)
  await removeEmpty(dirname(route.documentPath), join(input.deskRoot, 'routes'))
  return { status: 'removed', site: id, route: route.id, mode: route.mode }
}

async function mountRoute(input, id, routeId) {
  const route = await selectRoute(input, id, routeId)
  if (route.mode !== 'existing') throw failure('route_mount_mode', `Only an existing Route can be mounted; ${id}/${route.id} is ${route.mode}.`)
  const destination = mountPath(input, id, route.id)
  const current = await inspectMount(input, route)
  if (current?.status === 'ready') return { status: 'mounted', site: id, route: route.id, path: destination, target: route.path }
  if (current?.status === 'direct') return { status: 'already-addressed', site: id, route: route.id, path: destination, target: route.path }
  if (current) throw failure('route_mount_conflict', `Mount ${relative(input.homeRoot, destination)} is ${current.status}; remove it explicitly before rebuilding.`)
  await mkdir(dirname(destination), { recursive: true })
  await symlink(route.path, destination, 'dir')
  return { status: 'mounted', site: id, route: route.id, path: destination, target: route.path }
}

async function unmountRoute(input, id, routeId) {
  const route = await selectRoute(input, id, routeId)
  const destination = mountPath(input, id, route.id)
  let info
  try { info = await lstat(destination) } catch (error) {
    if (error.code === 'ENOENT') return { status: 'unmounted', site: id, route: route.id, path: destination }
    throw error
  }
  if (!info.isSymbolicLink()) throw failure('route_mount_not_symlink', `Refusing to remove non-symlink path ${relative(input.homeRoot, destination)}.`)
  await rm(destination)
  await removeEmpty(dirname(destination), join(input.homeRoot, 'checkouts'))
  return { status: 'unmounted', site: id, route: route.id, path: destination }
}

async function inspectMount(input, route) {
  if (route.mode !== 'existing') return null
  const path = mountPath(input, route.site, route.id)
  let info
  try { info = await lstat(path) } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
  if (!info.isSymbolicLink()) {
    const target = await realpath(path).catch(() => null)
    return { status: target === route.path ? 'direct' : 'invalid', path, ...(target ? { target } : {}) }
  }
  const target = await realpath(path).catch(() => null)
  if (!target) return { status: 'broken', path }
  return { status: target === route.path ? 'ready' : 'mismatch', path, target }
}

async function routesFor(input, id) {
  if (!input.deskRoot) return []
  const root = join(input.deskRoot, 'routes', id)
  const values = []
  for (const entry of await safeReadDir(root)) {
    if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith('.json')) continue
    const documentPath = join(root, entry.name)
    const route = JSON.parse(await readFile(documentPath, 'utf8'))
    validateRoute(route, id, entry.name.slice(0, -5), input)
    const path = isAbsolute(route.path) ? route.path : resolve(input.homeRoot, route.path)
    values.push({ ...route, documentPath, path: await canonicalPath(path) })
  }
  return values.sort((left, right) => left.id.localeCompare(right.id))
}

async function selectRoute(input, id, routeId, flag = '--id') {
  declaration(input, id)
  const routes = await routesFor(input, id)
  if (routeId) {
    const selected = routes.find((route) => route.id === routeId)
    if (!selected) throw failure('route_missing', `${id} has no Route ${routeId}.`)
    return selected
  }
  if (!routes.length) throw failure('site_unrouted', `${id} has no Route.`)
  if (routes.length > 1) throw failure('route_ambiguous', `${id} has multiple Routes; pass ${flag}.`)
  return routes[0]
}

async function writeSite(input, site) {
  const sitesRoot = join(input.homeRoot, 'sites')
  const destination = join(sitesRoot, site.id)
  await mkdir(sitesRoot, { recursive: true })
  await mkdir(destination)
  try {
    const lines = ['---', ...Object.entries(site).map(([key, entry]) => `${key}: ${JSON.stringify(entry)}`), '---', '', `# ${site.id}`, '', site.summary ?? 'A sovereign Site connected to this Home.', '']
    await writeFile(join(destination, 'SITE.md'), lines.join('\n'), { mode: 0o644 })
  } catch (error) {
    await rm(destination, { recursive: true, force: true })
    throw error
  }
}

async function writeRoute(input, route) {
  const root = join(input.deskRoot, 'routes', route.site)
  const path = join(root, `${route.id}.json`)
  await mkdir(root, { recursive: true })
  const document = {
    $schema: 'https://endroit.org/schema/route.json',
    id: route.id,
    site: route.site,
    mode: route.mode,
    path: route.path,
    ...(route.branch ? { branch: route.branch } : {}),
    ...(route.sourceRoute ? { sourceRoute: route.sourceRoute } : {}),
  }
  validateRoute(document, route.site, route.id, input)
  await writeJsonAtomic(path, document)
  return {
    status: route.mode === 'managed-clone' ? 'cloned' : route.mode === 'managed-worktree' ? 'created' : 'bound',
    ...document,
    route: route.id,
    path: await canonicalPath(isAbsolute(route.path) ? route.path : resolve(input.homeRoot, route.path)),
  }
}

async function assertRouteAvailable(input, site, route) {
  if ((await routesFor(input, site)).some((entry) => entry.id === route)) throw failure('route_exists', `Route ${site}/${route} already exists.`)
}

function managedPath(input, site, route) {
  const root = join(input.homeRoot, 'checkouts', site)
  const destination = join(root, route)
  if (relative(root, destination).startsWith('..')) throw failure('route_path_invalid', 'Managed checkout must stay below checkouts/.')
  return destination
}

function mountPath(input, site, route) {
  return managedPath(input, site, route)
}

async function inspectRepository(path) {
  const run = (args) => git(args, path)
  const root = await run(['rev-parse', '--show-toplevel'])
  const [head, branch, status, remoteOutput, worktreeOutput, layout] = await Promise.all([
    run(['rev-parse', 'HEAD']),
    run(['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => null),
    run(['status', '--porcelain=v2', '--branch', '--untracked-files=all']),
    run(['config', '--get-regexp', '^remote\\..*\\.url$']).catch(() => ''),
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
  })))
  return {
    available: true,
    root: await canonicalPath(root),
    head,
    branch,
    clean: changes.length === 0,
    changes,
    conflicts: changes.filter((line) => line.startsWith('u ')).length,
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
    if (!field) { if (current) entries.push(current); current = null; continue }
    const separator = field.indexOf(' ')
    const key = separator < 0 ? field : field.slice(0, separator)
    const entry = separator < 0 ? true : field.slice(separator + 1)
    if (key === 'worktree') { if (current) entries.push(current); current = { path: String(entry) } }
    else if (current && key === 'HEAD') current.head = entry
    else if (current && key === 'branch') current.branch = String(entry).replace(/^refs\/heads\//, '')
    else if (current && key === 'detached') current.detached = true
    else if (current && key === 'locked') current.locked = entry
    else if (current && key === 'prunable') current.prunable = entry
  }
  if (current) entries.push(current)
  return entries
}

function declarations(input) { return input.resolvedHome.sites ?? [] }
function declaration(input, id) {
  const site = declarations(input).find((entry) => entry.id === id)
  if (!site) throw failure('site_missing', `Site ${id} is not declared.`)
  return site
}
function matchesSite(site, evidence) { return evidence.available !== false && (!site.repository || evidence.remotes.some((remote) => remote.repository === site.repository)) }
function assertSiteMatches(site, evidence) { if (!matchesSite(site, evidence)) throw failure('route_site_mismatch', `${evidence.root} does not match ${site.repository}.`) }
function validateRoute(route, site, id, input) {
  if (route.$schema !== 'https://endroit.org/schema/route.json' || route.id !== id || route.site !== site || !['embedded', 'existing', 'managed-clone', 'managed-worktree', 'submodule'].includes(route.mode) || typeof route.path !== 'string' || !route.path) {
    throw failure('route_invalid', `Invalid Route ${site}/${id}.`)
  }
  if (route.mode === 'embedded' && route.path !== '.') throw failure('route_path_invalid', `Embedded Route ${site}/${id} must point to the Home root.`)
  if (route.mode.startsWith('managed-') && resolve(input.homeRoot, route.path) !== managedPath(input, site, id)) {
    throw failure('route_path_invalid', `Managed Route ${site}/${id} must stay below its Desk checkout path.`)
  }
  if (route.mode === 'managed-worktree' && !route.sourceRoute) throw failure('route_invalid', `Managed worktree Route ${site}/${id} requires sourceRoute.`)
}

async function validateBranch(root, branch) {
  if (!branch || branch.startsWith('-') || branch.includes('\0')) throw failure('site_branch_invalid', `Invalid branch ${branch}.`)
  await git(['check-ref-format', '--branch', branch], root).catch(() => { throw failure('site_branch_invalid', `Invalid branch ${branch}.`) })
}
async function localBranchExists(root, branch) {
  try { await git(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], root); return true } catch { return false }
}
async function gitOperation(root) {
  for (const [name, marker] of [['merge', 'MERGE_HEAD'], ['rebase', 'rebase-merge'], ['rebase', 'rebase-apply'], ['cherry-pick', 'CHERRY_PICK_HEAD']]) {
    const path = await git(['rev-parse', '--git-path', marker], root)
    if (await exists(resolve(root, path))) return name
  }
  return null
}
function normalizeRepository(value) {
  let source = String(value).trim()
  const scp = source.match(/^(?:[^@]+@)?([^:/]+):(.+)$/)
  if (scp && !source.includes('://')) source = `ssh://${scp[1]}/${scp[2]}`
  try {
    const url = new URL(source)
    return `${url.hostname.toLowerCase()}/${url.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '').toLowerCase()}`
  } catch { return source.replace(/\.git$/i, '').replace(/^\/+|\/+$/g, '').toLowerCase() }
}
function assertRemoteSource(value) {
  try {
    const url = new URL(value)
    if (url.username || url.password || url.search || url.hash) throw failure('site_source_insecure', 'Site sources must not contain credentials, query parameters or fragments.')
  } catch (error) {
    if (error.code === 'site_source_insecure') throw error
    if (!/^[^@\s]+@[^:\s]+:[^\s]+$/.test(value) && !/^[a-z0-9.-]+\/[^/\s]+\/[^/\s]+$/i.test(value)) throw failure('site_source_invalid', `Invalid Site source ${value}.`)
  }
}
async function git(args, cwd) {
  try { return (await exec('git', args, { cwd, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })).stdout.trim() }
  catch (error) { throw failure('git_failed', error.stderr?.trim() || error.message) }
}
async function writeJsonAtomic(path, document) {
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, path)
}
async function canonicalPath(path) { return realpath(path).catch(() => resolve(path)) }
async function removeEmpty(path, stop) {
  let current = path
  while (current !== stop) { try { await rm(current) } catch { break }; current = dirname(current) }
}
async function safeReadDir(path) {
  try { return (await readdir(path, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name)) }
  catch (error) { if (error.code === 'ENOENT') return []; throw error }
}
async function exists(path) { try { await lstat(path); return true } catch (error) { if (error.code === 'ENOENT') return false; throw error } }
function argumentsOf(argv) {
  const flags = {}; const positionals = []
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (!value.startsWith('--')) positionals.push(value)
    else { const [name, inline] = value.slice(2).split('=', 2); flags[name] = inline ?? (argv[index + 1] && !argv[index + 1].startsWith('-') ? argv[++index] : true) }
  }
  return { flags, positionals }
}
function human(value) {
  if (value.sites) return value.sites.length ? value.sites.map((site) => `${site.id} · ${site.state} · ${site.routes.length} route(s)`).join('\n') : 'No Sites.'
  if (value.routes) return value.routes.length ? value.routes.map((route) => `${route.site}/${route.id} · ${route.mode} · ${route.path}`).join('\n') : 'No Routes.'
  return Object.entries(value).map(([key, entry]) => `${key}: ${typeof entry === 'object' ? JSON.stringify(entry) : entry}`).join('\n')
}
function help(surface, command) {
  const entries = surface === 'route' ? ROUTE_HELP : SITE_HELP
  if (!command) return [`Usage: endroit ${surface} <command> [options]`, '', ...Object.keys(entries).map((name) => `  ${name}`)].join('\n')
  if (!entries[command]) throw failure('usage', `Unknown ${surface} command ${command}.`, 2)
  return `Usage: ${entries[command]}`
}
function requireDesk(input) { if (!input.deskRoot) throw failure('desk_missing', 'Configure a Desk before managing Routes.') }
function required(value, label) { if (!value) throw failure('usage', `${label} is required.`, 2); return value }
function truthy(value) { return value === true || value === 'true' || value === 'yes' || value === '1' }
function value(input) { return input === undefined ? undefined : String(input).trim() }
function validId(input) { return /^[a-z0-9][a-z0-9._-]{0,127}$/.test(input) }
function assertId(input) { if (!validId(input)) throw failure('site_id_invalid', `Invalid id ${input}.`, 2) }
function slug(input) { return String(input).toLowerCase().replace(/\.git$/, '').replace(/[^a-z0-9._-]+/g, '-').replace(/^-|-$/g, '') }
function assertEmoji(input) { if (typeof input !== 'string' || !input.trim() || [...input].length > 16) throw failure('site_emoji_invalid', 'Site emoji must contain 1 to 16 characters.'); return input }
function failure(code, message, exitCode = 4) { const error = new Error(message); error.code = code; error.exitCode = exitCode; return error }
function stdin() { return new Promise((resolvePromise, reject) => { const chunks = []; process.stdin.on('data', (chunk) => chunks.push(chunk)); process.stdin.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8'))); process.stdin.on('error', reject) }) }
