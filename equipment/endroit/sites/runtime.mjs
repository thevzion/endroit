#!/usr/bin/env node
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readFile, readlink, readdir, realpath, rename, rm, rmdir, symlink, writeFile } from 'node:fs/promises'
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
  park: 'endroit route park <site> [--id <route>] [--json]',
  activate: 'endroit route activate <site> [--id <route>] [--json]',
  supersede: 'endroit route supersede <site> --id <route> --by <route> [--json]',
  migrate: 'endroit route migrate [site] [--id <route>] [--check | --rollback <run-id>] [--json]',
  remove: 'endroit route remove <site> [--id <route>] [--json]',
}
const CHECKOUT_HELP = {
  list: 'endroit checkout list [site] [--all] [--json]',
  inspect: 'endroit checkout inspect <checkout:<site>/<route>|worktree:<site>/<id>> [--json]',
  resolve: 'endroit checkout resolve <path> [--json]',
  adopt: 'endroit checkout adopt <site> <path> --id <route> [--branch <name> | --commit <sha>] [--json]',
  clone: 'endroit checkout clone <site> --id <route> [--branch <name>] [--json]',
  worktree: 'endroit checkout worktree <site> --id <route> --from <route> (--branch <existing> | --new-branch <name> | --detach <ref>) [--json]',
  reconcile: 'endroit checkout reconcile [--check | --apply] [--json]',
  delete: 'endroit checkout delete <checkout-ref> --approve <checkout-ref> [--json]',
}
let routeWriterLockDepth = 0
const pendingRoutes = new Map()

try {
  const input = JSON.parse(await stdin())
  const { positionals, flags } = argumentsOf(input.argv)
  const [surface, ...rest] = positionals
  const routeSurface = surface === 'route'
  const checkoutSurface = surface === 'checkout'
  const command = routeSurface || checkoutSurface ? rest.shift() : surface
  if (flags.help) process.stdout.write(`${help(routeSurface ? 'route' : checkoutSurface ? 'checkout' : 'site', command)}\n`)
  else {
    const value = routeSurface
      ? await routeCommand(input, command, rest, flags)
      : checkoutSurface ? await checkoutCommand(input, command, rest, flags) : await siteCommand(input, command, rest, flags)
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
  const execute = async () => {
    if (command === 'list') return { status: 'listed', routes: await listRoutes(input, args[0]) }
    if (command === 'inspect') return inspectRoute(input, required(args[0], 'Site id'), flags.id)
    if (command === 'park') return transitionRoute(input, required(args[0], 'Site id'), flags.id, 'parked')
    if (command === 'activate') return transitionRoute(input, required(args[0], 'Site id'), flags.id, 'active')
    if (command === 'supersede') return supersedeRoute(input, required(args[0], 'Site id'), required(flags.id, 'Route id'), required(flags.by, 'Replacement Route id'))
    if (command === 'migrate') {
      if (flags.rollback === true) throw failure('usage', '--rollback requires a migration run id.', 2)
      if (flags.rollback && args.length) throw failure('usage', 'route migrate --rollback does not accept a Site.', 2)
      return flags.rollback ? rollbackRouteMigration(input, flags.rollback, flags) : migrateRoutes(input, args[0], flags)
    }
    if (command === 'remove') return removeRoute(input, required(args[0], 'Site id'), flags.id, flags)
    throw failure('usage', 'endroit route list|inspect|park|activate|supersede|migrate|remove', 2)
  }
  const mutations = ['park', 'activate', 'supersede', 'migrate', 'remove']
  if (!mutations.includes(command) || command === 'migrate' && (truthy(flags.check) && !flags.rollback || flags.rollback === true)) return execute()
  return withRouteWriterLock(input, execute)
}

async function checkoutCommand(input, command, args, flags) {
  const execute = async () => {
    if (command === 'list') return { status: 'listed', checkouts: await listCheckouts(input, args[0], { all: truthy(flags.all) }) }
    if (command === 'inspect') return inspectCheckout(input, required(args[0], 'Checkout ref'))
    if (command === 'resolve') return resolveCheckout(input, required(args[0], 'Path or Checkout reference'))
    if (command === 'adopt') {
      const target = adoptTarget(required(args[0], 'Site/Route'), flags.id)
      return bindRoute(input, target.site, required(args[1], 'Repository path'), target.route, undefined, flags)
    }
    if (command === 'clone') return cloneRoute(input, required(args[0], 'Site id'), required(flags.id, 'Route id'), flags)
    if (command === 'worktree') return createWorktree(input, required(args[0], 'Site id'), flags)
    if (command === 'reconcile') return reconcileCheckouts(input, flags)
    if (command === 'delete') return deleteCheckout(input, required(args[0], 'Checkout ref'), flags)
    throw failure('usage', 'endroit checkout list|inspect|resolve|adopt|clone|worktree|reconcile|delete', 2)
  }
  const mutations = ['adopt', 'clone', 'worktree', 'delete']
  if (command === 'reconcile' && truthy(flags.apply)) return withRouteWriterLock(input, execute)
  if (mutations.includes(command)) return withRouteWriterLock(input, execute)
  return execute()
}

async function listSites(input, siteId, options = {}) {
  const listed = await Promise.all(declarations(input).filter((site) => !siteId || site.id === siteId).map(async (site) => {
    const routes = await routesFor(input, site.id)
    const inspected = await Promise.all(routes.map((route) => observeRoute(input, site, route)))
    const registered = new Map(inspected.filter((route) => route.observed.realpath).map((route) => [route.observed.realpath, route.id]))
    const worktrees = new Map()
    for (const route of inspected.filter((entry) => entry.observed.matches && entry.observed.repository.available)) {
      for (const worktree of route.observed.repository.worktrees) worktrees.set(worktree.path, worktree)
    }
    const observedWorktrees = await Promise.all([...worktrees.values()].map((worktree) => observeWorktree(input, site.id, worktree, registered.get(worktree.path) ?? null)))
    return {
      ...site,
      state: routes.some((route) => route.declared.status === 'active') ? 'routed' : routes.length ? 'unrouted' : 'declared',
      routes: inspected,
      worktrees: observedWorktrees.sort((left, right) => left.path.localeCompare(right.path)),
    }
  }))
  if (!siteId && !options.allowDuplicateGitDirs) assertDistinctGitDirs(listed.flatMap((site) => site.routes))
  return listed
}

async function listRoutes(input, siteId) {
  if (siteId) {
    declaration(input, siteId)
    return (await routesFor(input, siteId)).map((route) => routeDeclaration(input, route))
  }
  const values = []
  for (const site of declarations(input)) values.push(...(await routesFor(input, site.id)).map((route) => routeDeclaration(input, route)))
  return values.sort((left, right) => left.site.localeCompare(right.site) || left.id.localeCompare(right.id))
}

async function inspectSite(input, id) {
  const site = declaration(input, id)
  const [listed] = await listSites(input, id)
  return { status: 'inspected', ...site, routes: listed.routes, worktrees: listed.worktrees }
}

async function inspectRoute(input, id, routeId) {
  const site = declaration(input, id)
  const route = await selectRoute(input, id, routeId, '--id', { allowInactive: true })
  const evidence = await inspectRepository(await routeRepositoryPath(input, route))
  const currentWorktree = evidence.worktrees.find((worktree) => worktree.path === evidence.root)
  assertSiteMatches(site, evidence)
  const trackedFiles = (await git(['ls-files'], evidence.root)).split('\n').filter(Boolean).sort()
  const files = trackedFiles.slice(0, 5000)
  const scripts = []
  for (const path of files.filter((entry) => basename(entry) === 'package.json').slice(0, 20)) {
    try {
      const document = JSON.parse(await readFile(join(evidence.root, path), 'utf8'))
      for (const name of Object.keys(document.scripts ?? {})) scripts.push(`${path}#${name}`)
    } catch {}
  }
  return {
    status: 'inspected',
    site: id,
    route: route.id,
    ref: route.ref,
    declared: route.declared,
    declaration: relative(input.deskRoot, route.documentPath),
    repository: site.repository ?? null,
    observed: {
      address: checkoutAddress(input, route),
      target: route.declaredPath,
      realpath: evidence.root,
      remote: evidence.remotes[0]?.repository ?? null,
      head: evidence.head,
      branch: evidence.branch,
      detached: evidence.detached,
      checkout: evidence.checkout,
      gitDir: evidence.gitDir,
      commonGitDir: evidence.commonGitDir,
      upstream: evidence.upstream,
      divergence: evidence.divergence,
      locked: Boolean(currentWorktree?.locked),
      prunable: Boolean(currentWorktree?.prunable),
      index: (await inspectCheckoutIndex(input, route)).status,
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
    },
  }
}

async function listCheckouts(input, siteId, options = {}) {
  if (siteId) declaration(input, siteId)
  const sites = siteId ? [declaration(input, siteId)] : declarations(input)
  const values = []
  for (const site of sites) {
    const listed = (await listSites(input, site.id))[0]
    values.push(...listed.routes.filter((route) => options.all || route.declared.status === 'active'))
    if (options.all) values.push(...listed.worktrees.filter((worktree) => !worktree.registered).map((worktree) => observedCheckout(site.id, worktree)))
  }
  assertDistinctGitDirs(values)
  return values.sort((left, right) => left.site.localeCompare(right.site) || left.id.localeCompare(right.id))
}

async function inspectCheckout(input, selector) {
  const parsed = parseCheckoutRef(selector)
  if (parsed.kind === 'checkout') {
    const site = declaration(input, parsed.site)
    const route = await selectRoute(input, parsed.site, parsed.id, '--id', { allowInactive: true })
    const checkout = await observeRoute(input, site, route)
    assertDistinctGitDirs(await listCheckouts(input, parsed.site, { all: true }))
    return { status: 'inspected', ...checkout }
  }
  const [site] = await listSites(input, parsed.site)
  const worktree = site.worktrees.find((entry) => entry.ref === selector && !entry.registered)
  if (!worktree) throw failure('checkout_missing', `${selector} does not identify an observed worktree.`)
  return { status: 'inspected', ...observedCheckout(parsed.site, worktree) }
}

async function resolveCheckoutPath(input, path) {
  const target = await canonicalPath(resolve(path))
  const sites = await listSites(input)
  const exact = sites.flatMap((site) => site.routes).filter((route) => route.observed.realpath === target || route.observed.address === target)
  if (exact.length === 1) return { status: 'resolved', selector: exact[0].ref, checkout: exact[0] }
  if (exact.length > 1) throw failure('checkout_origin_ambiguous', `${target} matches multiple Routes.`)
  const observed = sites.flatMap((site) => site.worktrees.map((worktree) => ({ site, worktree }))).find(({ worktree }) => worktree.path === target)
  if (!observed) throw failure('checkout_family_unknown', `${target} is not in a declared Git family.`)
  if (observed.worktree.registered) return { status: 'resolved', selector: `checkout:${observed.site.id}/${observed.worktree.route}` }
  const origins = observed.site.routes.filter((route) => route.declared.status === 'active' && route.observed.repository.commonGitDir === observed.worktree.commonGitDir)
  if (!origins.length) throw failure('checkout_origin_missing', `${observed.worktree.ref} has no active Route of origin.`)
  if (origins.length > 1) throw failure('checkout_origin_ambiguous', `${observed.worktree.ref} has multiple active Routes of origin.`)
  return { status: 'resolved', selector: observed.worktree.ref, source: origins[0].ref, checkout: observedCheckout(observed.site.id, observed.worktree) }
}

async function resolveCheckout(input, value) {
  if (!String(value).startsWith('checkout:')) return resolveCheckoutPath(input, value)
  const match = String(value).match(/^checkout:([a-z0-9][a-z0-9._-]{0,127})\/([a-z0-9][a-z0-9._-]{0,127})(?:#(.*))?$/)
  if (!match) throw failure('checkout_ref_invalid', 'Use checkout:<site>/<route>#<relative-path>.', 2)
  const route = await selectRoute(input, match[1], match[2], '--id')
  const root = await routeRepositoryPath(input, route)
  const relativePath = match[3] ?? ''
  if (isAbsolute(relativePath) || /^[\\/]|^[A-Za-z]:[\\/]/.test(relativePath) || relativePath.split(/[\\/]+/).includes('..')) {
    throw failure('checkout_ref_path_invalid', 'A Checkout reference path must be relative and stay inside its Checkout.', 2)
  }
  const path = resolve(root, relativePath || '.')
  if (path !== root && !inside(root, path)) throw failure('checkout_ref_path_invalid', 'A Checkout reference path must stay inside its Checkout.', 2)
  let existing = path
  while (!await exists(existing) && existing !== root) existing = dirname(existing)
  const observed = await canonicalPath(existing)
  if (observed !== root && !inside(root, observed)) throw failure('checkout_ref_path_escape', 'A Checkout reference resolves outside its Checkout.', 3)
  return {
    status: 'resolved',
    ref: `checkout:${match[1]}/${match[2]}${relativePath ? `#${relativePath}` : ''}`,
    checkout: route.ref,
    relative_path: relativePath,
    path,
  }
}

async function doctorSites(input) {
  const sites = await listSites(input, undefined, { allowDuplicateGitDirs: true })
  const limits = []
  const duplicateGitDirs = findDuplicateGitDirs(sites.flatMap((site) => site.routes))
  for (const duplicate of duplicateGitDirs) limits.push(`duplicate-git-dir:${duplicate.first}:${duplicate.second}`)
  for (const site of sites) {
    for (const route of site.routes) {
      if (route.declared.status === 'active' && !route.observed.repository.available) limits.push(`route-broken:${site.id}:${route.id}`)
      else if (route.declared.status === 'active' && !route.observed.matches) limits.push(`route-site-mismatch:${site.id}:${route.id}`)
      if (route.observed.repository.available && !route.observed.repository.clean) limits.push(`route-dirty:${site.id}:${route.id}`)
      if (route.observed.repository.conflicts) limits.push(`route-conflicts:${site.id}:${route.id}`)
      if (route.declared.status === 'active' && !['direct', 'linked'].includes(route.observed.index)) limits.push(`checkout-index-${route.observed.index}:${site.id}:${route.id}`)
      if (!revisionMatches(route.declared.revision, route.observed.repository)) limits.push(`route-revision-divergent:${site.id}:${route.id}`)
      if (route.observed.repository.branch && !route.observed.repository.upstream) limits.push(`route-upstream-missing:${site.id}:${route.id}`)
    }
    const unregistered = site.worktrees.filter((worktree) => !worktree.registered)
    if (unregistered.length) limits.push(`site-worktrees-unrouted:${site.id}:${unregistered.length}`)
    for (const worktree of site.worktrees) {
      if (worktree.locked) limits.push(`site-worktree-locked:${site.id}:${worktree.path}`)
      if (worktree.prunable) limits.push(`site-worktree-prunable:${site.id}:${worktree.path}`)
      if (!worktree.clean) limits.push(`site-worktree-dirty:${site.id}:${worktree.path}`)
      if (worktree.conflicts) limits.push(`site-worktree-conflicts:${site.id}:${worktree.path}`)
      if (worktree.operation) limits.push(`site-worktree-operation:${site.id}:${worktree.path}:${worktree.operation}`)
    }
    limits.push(...await inspectPinnedSite(input, site))
  }
  const declaredSiteIds = new Set(sites.map((site) => site.id))
  for (const site of siteSettings(input).pinnedSites.filter((id) => !declaredSiteIds.has(id))) limits.push(`site-gitlink-site-missing:${site}`)
  if (!duplicateGitDirs.length && input.deskRoot && (await reconcileCheckouts(input, { check: true })).status === 'stale') limits.push('checkout-index-stale')
  else if (limits.some((limit) => limit.startsWith('checkout-index-') && limit !== 'checkout-index-stale')) limits.push('checkout-index-stale')
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
    $schema: 'https://endroit.org/schema/v7/site.json',
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
  input.resolvedHome.sites.push(site)
  let bound = null
  if (evidence && input.deskRoot) {
    const routeId = flags.route ?? 'main'
    const existing = (await routesFor(input, id)).find((route) => route.id === routeId)
    if (existing) {
      const current = await inspectRepository(await routeRepositoryPath(input, existing))
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

async function bindRoute(input, id, repositoryPath, routeId = 'main', declaredSite, flags = {}) {
  return withRouteWriterLock(input, () => bindRouteUnlocked(input, id, repositoryPath, routeId, declaredSite, flags))
}

async function bindRouteUnlocked(input, id, repositoryPath, routeId = 'main', declaredSite, flags = {}) {
  requireDesk(input)
  assertId(routeId)
  const site = declaredSite ?? declaration(input, id)
  const evidence = await inspectRepository(resolve(repositoryPath))
  assertSiteMatches(site, evidence)
  await assertGitDirAvailable(input, evidence)
  await assertTopologyFamilySafe(input, evidence.commonGitDir)
  const existing = (input.resolvedHome.routes ?? []).find((route) => route.site === id && route.id === routeId)
  if (existing) {
    if (existing.schemaVersion !== 9 || !['existing', 'submodule'].includes(existing.declared.checkout.mode)) {
      throw failure('route_exists', `Route ${id}/${routeId} already exists.`)
    }
    const address = managedPath(input, id, routeId)
    const info = await lstat(address).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error))
    if (info) throw failure('checkout_bound', `${existing.ref} already has a local Checkout address.`)
    await bindCheckoutLink(input, address, evidence.root, existing.ref)
    return { status: 'adopted', site: id, route: routeId, ref: existing.ref, declared: existing.declared, observed: { path: evidence.root }, checkout: evidence.checkout }
  }
  await assertRouteAvailable(input, id, routeId)
  const superproject = await git(['rev-parse', '--show-superproject-working-tree'], evidence.root).catch(() => '')
  const mode = evidence.root === input.homeRoot ? 'embedded' : superproject ? 'submodule' : 'existing'
  const revision = requestedRevision(flags)
  if (mode === 'submodule' && revision) throw failure('route_revision_forbidden', 'A submodule Route is pinned by its parent gitlink.')
  assertObservedRevision(revision, evidence)
  const route = await writeRoute(input, {
    id: routeId,
    site: id,
    mode,
    path: mode === 'embedded' ? '.' : evidence.root,
    revision,
  })
  try {
    const address = managedPath(input, id, routeId)
    if (mode !== 'embedded' && await canonicalPath(address) !== evidence.root) {
      await bindCheckoutLink(input, address, evidence.root, route.ref)
    }
    return { ...route, checkout: evidence.checkout }
  } catch (error) {
    pendingRoutes.delete(`checkout:${id}/${routeId}`)
    const address = managedPath(input, id, routeId)
    const linked = await lstat(address).catch((caught) => caught.code === 'ENOENT' ? null : Promise.reject(caught))
    if (linked?.isSymbolicLink() && await symlinkTarget(address) === evidence.root) await rm(address)
    const routeRoot = join(input.deskRoot, 'routes', id, routeId)
    await rm(join(routeRoot, 'ROUTE.md'), { force: true })
    await removeEmpty(routeRoot, join(input.deskRoot, 'routes'))
    throw error
  }
}

async function transitionRoute(input, siteId, routeId, status) {
  const graph = await scanRouteGraph(input)
  const route = status === 'active'
    ? selectCurrentRouteByStatus(input, graph, siteId, routeId, 'parked')
    : selectCurrentRoute(input, graph, siteId, routeId, '--id', { allowInactive: true })
  requireLifecycleRoute(route)
  if (route.status === status) return { status: status === 'active' ? 'activated' : 'parked', site: siteId, route: route.id, ref: route.ref, declared: route.declared }
  const expected = status === 'parked' ? 'active' : 'parked'
  if (route.status !== expected) throw failure('route_status_invalid', `Route ${siteId}/${route.id} must be ${expected} before becoming ${status}.`)
  await writeRouteLifecycle(route, { status })
  return {
    status: status === 'active' ? 'activated' : 'parked',
    site: siteId,
    route: route.id,
    ref: route.ref,
    declared: { status, checkout: { ...route.declared.checkout }, ...(route.declared.revision ? { revision: { ...route.declared.revision } } : {}) },
  }
}

async function supersedeRoute(input, siteId, routeId, replacementId) {
  if (routeId === replacementId) throw failure('route_supersession_invalid', 'A Route cannot supersede itself.')
  const graph = await scanRouteGraph(input)
  const route = selectCurrentRoute(input, graph, siteId, routeId, '--id', { allowInactive: true })
  const replacement = selectCurrentRoute(input, graph, siteId, replacementId, '--by', { allowInactive: true })
  requireLifecycleRoute(route)
  requireLifecycleRoute(replacement)
  if (route.status !== 'active') throw failure('route_status_invalid', `Route ${siteId}/${route.id} must be active before it can be superseded.`)
  if (replacement.status !== 'active') throw failure('route_replacement_inactive', `Replacement Route ${siteId}/${replacement.id} must be active.`)
  await writeRouteLifecycle(route, { status: 'superseded', supersededBy: replacement.id })
  return {
    status: 'superseded',
    site: siteId,
    route: route.id,
    ref: route.ref,
    declared: { status: 'superseded', supersededBy: replacement.id, checkout: { ...route.declared.checkout }, ...(route.declared.revision ? { revision: { ...route.declared.revision } } : {}) },
  }
}

async function migrateRoutes(input, siteId, flags) {
  requireDesk(input)
  if (flags.rollback) throw failure('usage', '--rollback cannot be combined with migration.', 2)
  if (flags.id && !siteId) throw failure('usage', '--id requires a Site id.', 2)
  if (siteId) declaration(input, siteId)
  if (truthy(flags.check)) {
    const { summary } = await planNextRouteMigration(input, siteId, flags)
    return { status: 'checked', readOnly: true, changes: summary.length, routes: summary }
  }
  return withRouteWriterLock(input, async () => {
    const { planned, summary, target } = await planNextRouteMigration(input, siteId, flags)
    if (!summary.length) return { status: 'current', changes: 0, routes: [] }
    if (target === 9) return applyRouteV9Migration(input, planned, summary)
    const runId = migrationRunId()
    const root = join(migrationRoot(input), runId)
    await ensureSafeDirectories(input.homeRoot, join(root, 'originals'))
    const entries = []
    for (const { route, original, mode, next } of planned) {
      const originalPath = join(root, 'originals', route.site, `${route.id}.json`)
      await ensureSafeDirectories(root, dirname(originalPath))
      await writeBytesAtomic(originalPath, original, 0o600)
      await assertSafeFileUnder(join(root, 'originals'), originalPath, 'route_migration_corrupt')
      entries.push({
        site: route.site,
        id: route.id,
        declaration: relative(input.homeRoot, route.documentPath),
        original: relative(root, originalPath),
        mode,
        beforeSha256: sha256(original),
        afterSha256: sha256(next),
        progress: 'original',
        next,
      })
    }
    let journal = {
      version: 1,
      runId,
      kind: 'checkout-v8-route-migration',
      status: 'prepared',
      createdAt: new Date().toISOString(),
      routes: entries.map(({ next: _next, ...entry }) => entry),
    }
    await writeJournal(input, root, journal)
    journal = { ...journal, status: 'applying', updatedAt: new Date().toISOString() }
    await writeJournal(input, root, journal)
    try {
      for (const entry of entries) {
        const destination = resolve(input.homeRoot, entry.declaration)
        await assertSafeRouteFile(input, destination)
        const current = await routeFileState(destination)
        if (current.sha256 !== entry.beforeSha256 || current.mode !== entry.mode) throw failure('route_migration_drift', `${entry.declaration} changed after migration planning.`)
        await writeBytesAtomic(destination, entry.next, entry.mode)
        await assertSafeRouteFile(input, destination)
        const written = await routeFileState(destination)
        if (written.sha256 !== entry.afterSha256 || written.mode !== entry.mode) throw failure('route_migration_write_failed', `${entry.declaration} did not match its v8 digest and mode.`)
        if (process.env.NODE_ENV === 'test' && process.env.ENDROIT_TEST_FAULT_AFTER_ROUTE_RENAME === `checkout:${entry.site}/${entry.id}`) {
          throw failure('route_migration_fault', `Injected failure after writing ${entry.declaration}.`)
        }
        const progress = journal.routes.map((route) => route.site === entry.site && route.id === entry.id ? { ...route, progress: 'after' } : route)
        journal = { ...journal, routes: progress, updatedAt: new Date().toISOString() }
        await writeJournal(input, root, journal)
      }
    } catch (error) {
      error.message = `${error.message} Migration run ${runId} remains recoverable with route migrate --rollback ${runId}.`
      throw error
    }
    journal = { ...journal, status: 'applied', appliedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
    await writeJournal(input, root, journal)
    return { status: 'migrated', runId, changes: summary.length, routes: summary, rollback: `route migrate --rollback ${runId}` }
  })
}

async function planNextRouteMigration(input, siteId, flags) {
  const legacy = await planRouteMigrations(input, siteId, flags)
  if (legacy.summary.length) return { ...legacy, target: 8 }
  return { ...await planRouteV9Migrations(input, siteId, flags), target: 9 }
}

async function planRouteMigrations(input, siteId, flags) {
  const allRoutes = await scanRouteGraph(input)
  const candidates = allRoutes
    .filter((route) => route.schemaVersion === 7 && (!siteId || route.site === siteId) && (!flags.id || route.id === flags.id))
  if (flags.id && !candidates.length) {
    const selected = allRoutes.find((route) => route.site === siteId && route.id === flags.id)
    if (!selected) throw failure('route_missing', `${siteId} has no Route ${flags.id}.`)
  }
  const planned = []
  for (const route of candidates) {
    await assertSafeRouteFile(input, route.documentPath)
    const original = route.sourceBytes
    const mode = route.fileMode
    let observedRevision
    if (route.mode === 'managed-worktree' && !route.declared.revision) {
      let evidence
      try {
        evidence = await inspectRepository((await validateManagedCheckout(input, route)).resolvedPath)
      } catch (error) {
        throw failure('route_migration_revision_unobservable', `${route.ref} has no observable worktree revision: ${error.message}`)
      }
      if (evidence.checkout !== 'linked-worktree' || !evidence.head) {
        throw failure('route_migration_revision_unobservable', `${route.ref} does not resolve to an observable linked worktree.`)
      }
      observedRevision = evidence.branch
        ? { kind: 'branch', name: evidence.branch }
        : { kind: 'commit', sha: evidence.head }
    }
    const document = migrationDocumentFromV7(input, route, original, { observedRevision, validate: true })
    planned.push({ route, original, mode, next: Buffer.from(`${JSON.stringify(document, null, 2)}\n`) })
  }
  const summary = planned.map(({ route }) => ({
    ref: route.ref,
    declaration: relative(input.homeRoot, route.documentPath),
    from: 7,
    to: 8,
  }))
  return { planned, summary }
}

async function planRouteV9Migrations(input, siteId, flags) {
  const allRoutes = await scanRouteGraph(input)
  const candidates = allRoutes
    .filter((route) => route.schemaVersion === 8 && (!siteId || route.site === siteId) && (!flags.id || route.id === flags.id))
  const manifest = candidates.some((route) => ['existing', 'submodule'].includes(route.mode))
    ? await readIndexManifest(input)
    : { version: 1, links: [] }
  const planned = []
  for (const route of candidates) {
    await assertSafeRouteFile(input, route.documentPath)
    const destination = join(dirname(route.documentPath), route.id, 'ROUTE.md')
    if (await exists(dirname(destination))) throw failure('route_source_collision', `Route ${route.site}/${route.id} already has a v9 declaration directory.`)
    if (['existing', 'submodule'].includes(route.mode)) {
      const address = checkoutAddress(input, route)
      const target = await canonicalPath(route.declaredPath)
      if (address !== target) {
        const local = relative(input.homeRoot, address)
        const entry = manifest.links.find((link) => link.path === local && link.ref === route.ref)
        if (!entry || await canonicalPath(entry.target) !== target) {
          throw failure('route_migration_checkout_unindexed', `${route.ref} requires a current Checkout index before v9 migration.`)
        }
      }
    }
    const document = {
      $schema: 'https://endroit.org/schema/v9/route.json',
      kind: 'endroit/route',
      id: route.id,
      owner: `desk:${input.resolvedHome.desk.id}`,
      site: route.site,
      route_state: route.status,
      checkout_mode: route.mode,
      ...(route.revision ? { revision: { ...route.revision } } : {}),
      ...(route.supersededBy ? { superseded_by: route.supersededBy } : {}),
    }
    validateRouteV9(document, route.site, route.id)
    planned.push({
      route,
      original: route.sourceBytes,
      mode: route.fileMode,
      destination,
      next: Buffer.from(renderRouteMarkdown(document)),
    })
  }
  const summary = planned.map(({ route, destination }) => ({
    ref: route.ref,
    declaration: relative(input.homeRoot, destination),
    from: 8,
    to: 9,
  }))
  return { planned, summary }
}

async function applyRouteV9Migration(input, planned, summary) {
  const runId = migrationRunId()
  const root = join(routeV9MigrationRoot(input), runId)
  await ensureSafeDirectories(input.homeRoot, join(root, 'originals'))
  const entries = []
  for (const { route, original, mode, destination, next } of planned) {
    const originalPath = join(root, 'originals', route.site, `${route.id}.json`)
    await ensureSafeDirectories(root, dirname(originalPath))
    await writeBytesAtomic(originalPath, original, 0o600)
    await assertSafeFileUnder(join(root, 'originals'), originalPath, 'route_migration_corrupt')
    entries.push({
      site: route.site,
      id: route.id,
      sourceDeclaration: relative(input.homeRoot, route.documentPath),
      declaration: relative(input.homeRoot, destination),
      original: relative(root, originalPath),
      mode,
      beforeSha256: sha256(original),
      afterSha256: sha256(next),
      progress: 'original',
      next,
    })
  }
  let journal = {
    version: 1,
    runId,
    kind: 'checkout-v9-route-migration',
    status: 'prepared',
    createdAt: new Date().toISOString(),
    routes: entries.map(({ next: _next, ...entry }) => entry),
  }
  await writeRouteV9Journal(input, root, journal)
  journal = { ...journal, status: 'applying', updatedAt: new Date().toISOString() }
  await writeRouteV9Journal(input, root, journal)
  try {
    for (const entry of entries) {
      const source = resolve(input.homeRoot, entry.sourceDeclaration)
      const destination = resolve(input.homeRoot, entry.declaration)
      await assertSafeRouteFile(input, source)
      const current = await routeFileState(source)
      if (current.sha256 !== entry.beforeSha256 || current.mode !== entry.mode) throw failure('route_migration_drift', `${entry.sourceDeclaration} changed after migration planning.`)
      await rm(source)
      await syncDirectory(dirname(source))
      await mkdir(dirname(destination))
      await writeBytesAtomic(destination, entry.next, entry.mode)
      await assertSafeRouteFile(input, destination)
      const written = await routeFileState(destination)
      if (written.sha256 !== entry.afterSha256 || written.mode !== entry.mode) throw failure('route_migration_write_failed', `${entry.declaration} did not match its v9 digest and mode.`)
      if (process.env.NODE_ENV === 'test' && process.env.ENDROIT_TEST_FAULT_AFTER_ROUTE_V9_WRITE === `checkout:${entry.site}/${entry.id}`) {
        throw failure('route_migration_fault', `Injected failure after writing ${entry.declaration}.`)
      }
      const progress = journal.routes.map((route) => route.site === entry.site && route.id === entry.id ? { ...route, progress: 'after' } : route)
      journal = { ...journal, routes: progress, updatedAt: new Date().toISOString() }
      await writeRouteV9Journal(input, root, journal)
    }
  } catch (error) {
    error.message = `${error.message} Migration run ${runId} remains recoverable with route migrate --rollback ${runId}.`
    throw error
  }
  journal = { ...journal, status: 'applied', appliedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
  await writeRouteV9Journal(input, root, journal)
  return { status: 'migrated', runId, changes: summary.length, routes: summary, rollback: `route migrate --rollback ${runId}` }
}

async function rollbackRouteMigration(input, runId, flags) {
  requireDesk(input)
  if (truthy(flags.check) || flags.id) throw failure('usage', '--rollback cannot be combined with --check or --id.', 2)
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(runId)) throw failure('route_migration_run_invalid', `Invalid migration run ${runId}.`, 2)
  const legacyRun = join(migrationRoot(input), runId, 'journal.json')
  const v9Run = join(routeV9MigrationRoot(input), runId, 'journal.json')
  if (await exists(legacyRun) && await exists(v9Run)) throw failure('route_migration_ambiguous', `Migration run ${runId} exists for both v8 and v9.`)
  if (await exists(v9Run)) return rollbackRouteV9Migration(input, runId)
  return withRouteWriterLock(input, async () => {
    const root = join(migrationRoot(input), runId)
    let journal = await readJournal(input, root, runId)
    if (journal.status === 'rolled-back') return { status: 'current', runId, changes: 0, routes: [] }
    if (!['prepared', 'applying', 'rolling-back', 'applied'].includes(journal.status)) {
      throw failure('route_migration_state_invalid', `Migration run ${runId} cannot be rolled back from ${journal.status}.`)
    }
    const classified = []
    for (const entry of journal.routes) classified.push(await classifyRollbackEntry(input, root, entry))
    journal = { ...journal, status: 'rolling-back', updatedAt: new Date().toISOString() }
    await writeJournal(input, root, journal)
    let changes = 0
    for (const item of classified) {
      await assertSafeRouteFile(input, item.destination)
      const current = await routeFileState(item.destination)
      if (current.mode !== item.entry.mode) throw failure('route_rollback_drift', `${item.entry.declaration} mode changed during rollback.`)
      if (current.sha256 === item.entry.beforeSha256) {
        // A prior rollback attempt completed this Route before interruption.
      } else if (current.sha256 === item.entry.afterSha256) {
        await assertSafeFileUnder(join(root, 'originals'), item.originalPath, 'route_rollback_corrupt')
        const original = await readFile(item.originalPath)
        if (sha256(original) !== item.entry.beforeSha256) throw failure('route_rollback_corrupt', `${item.entry.original} changed during rollback.`)
        await writeBytesAtomic(item.destination, original, item.entry.mode)
        await assertSafeRouteFile(input, item.destination)
        const restored = await routeFileState(item.destination)
        if (restored.sha256 !== item.entry.beforeSha256 || restored.mode !== item.entry.mode) throw failure('route_rollback_write_failed', `${item.entry.declaration} did not restore its v7 digest and mode.`)
        changes += 1
      } else {
        throw failure('route_rollback_drift', `${item.entry.declaration} changed during rollback.`)
      }
      const progress = journal.routes.map((route) => route.site === item.entry.site && route.id === item.entry.id ? { ...route, progress: 'original' } : route)
      journal = { ...journal, routes: progress, updatedAt: new Date().toISOString() }
      await writeJournal(input, root, journal)
    }
    journal = { ...journal, status: 'rolled-back', rolledBackAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
    await writeJournal(input, root, journal)
    return {
      status: 'rolled-back',
      runId,
      changes,
      routes: classified.map(({ entry }) => ({ ref: `checkout:${entry.site}/${entry.id}`, declaration: entry.declaration, from: 8, to: 7 })),
    }
  })
}

async function rollbackRouteV9Migration(input, runId) {
  return withRouteWriterLock(input, async () => {
    const root = join(routeV9MigrationRoot(input), runId)
    let journal = await readRouteV9Journal(input, root, runId)
    if (journal.status === 'rolled-back') return { status: 'current', runId, changes: 0, routes: [] }
    if (!['prepared', 'applying', 'rolling-back', 'applied'].includes(journal.status)) {
      throw failure('route_migration_state_invalid', `Migration run ${runId} cannot be rolled back from ${journal.status}.`)
    }
    const classified = []
    for (const entry of journal.routes) classified.push(await classifyRouteV9RollbackEntry(input, root, entry))
    journal = { ...journal, status: 'rolling-back', updatedAt: new Date().toISOString() }
    await writeRouteV9Journal(input, root, journal)
    let changes = 0
    for (const item of classified) {
      if (!item.source) {
        const original = await readFile(item.originalPath)
        await writeBytesAtomic(item.sourcePath, original, item.entry.mode)
        const restored = await routeFileState(item.sourcePath)
        if (restored.sha256 !== item.entry.beforeSha256 || restored.mode !== item.entry.mode) {
          throw failure('route_rollback_write_failed', `${item.entry.sourceDeclaration} did not restore its v8 digest and mode.`)
        }
        changes += 1
      }
      if (item.destination) {
        await rm(item.destinationPath)
        await removeEmpty(dirname(item.destinationPath), join(input.deskRoot, 'routes'))
        changes += item.source ? 1 : 0
      } else if (item.directory) {
        await removeEmpty(dirname(item.destinationPath), join(input.deskRoot, 'routes'))
      }
      const progress = journal.routes.map((route) => route.site === item.entry.site && route.id === item.entry.id ? { ...route, progress: 'original' } : route)
      journal = { ...journal, routes: progress, updatedAt: new Date().toISOString() }
      await writeRouteV9Journal(input, root, journal)
    }
    journal = { ...journal, status: 'rolled-back', rolledBackAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
    await writeRouteV9Journal(input, root, journal)
    return {
      status: 'rolled-back',
      runId,
      changes,
      routes: classified.map(({ entry }) => ({ ref: `checkout:${entry.site}/${entry.id}`, declaration: entry.sourceDeclaration, from: 9, to: 8 })),
    }
  })
}

async function cloneRoute(input, id, routeId = 'main', flags = {}) {
  requireDesk(input)
  assertId(routeId)
  const site = declaration(input, id)
  if (!site.source) throw failure('site_source_missing', `Site ${id} has no clone source.`)
  await assertRouteAvailable(input, id, routeId)
  const destination = managedPath(input, id, routeId)
  if (await exists(destination)) throw failure('route_checkout_exists', `${relative(input.homeRoot, destination)} already exists.`)
  await mkdir(dirname(destination), { recursive: true })
  try {
    const branch = flags.branch ? String(flags.branch) : null
    if (branch) await validateBranch(input.homeRoot, branch)
    await git(['clone', '--quiet', ...(branch ? ['--branch', branch] : []), '--', site.source, destination], input.homeRoot)
    const evidence = await inspectRepository(destination)
    assertSiteMatches(site, evidence)
    const route = await writeRoute(input, {
      id: routeId,
      site: id,
      mode: 'managed-clone',
      path: relative(input.homeRoot, destination),
      revision: branch ? { kind: 'branch', name: branch } : null,
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
  const detached = flags.detach
  if ([existingBranch, newBranch, detached].filter(Boolean).length !== 1) throw failure('site_worktree_branch_mode', 'Pass exactly one of --branch, --new-branch or --detach.', 2)
  if (flags['start-point'] && !newBranch) throw failure('site_worktree_start_point', '--start-point requires --new-branch.', 2)
  const site = declaration(input, id)
  const source = selectCurrentRoute(input, await scanRouteGraph(input), id, required(flags.from, 'Source Route id'), '--from')
  const sourceEvidence = await inspectRepository(await routeRepositoryPath(input, source))
  assertSiteMatches(site, sourceEvidence)
  await assertTopologyFamilySafe(input, sourceEvidence.commonGitDir)
  const branch = existingBranch || newBranch ? String(existingBranch ?? newBranch) : null
  if (branch) await validateBranch(source.path, branch)
  const destination = managedPath(input, id, routeId)
  if (await exists(destination)) throw failure('route_checkout_exists', `${relative(input.homeRoot, destination)} already exists.`)
  const branchExists = branch ? await localBranchExists(source.path, branch) : false
  let expectedHead
  let command
  if (detached) {
    const reference = String(detached)
    if (!reference || reference.startsWith('-') || reference.includes('\0')) throw failure('site_start_point_invalid', 'Invalid detached ref.')
    expectedHead = await git(['rev-parse', '--verify', `${reference}^{commit}`], source.path)
      .catch(() => { throw failure('site_start_point_missing', `Local ref ${reference} does not resolve to a commit.`) })
    command = ['worktree', 'add', '--detach', '--', destination, expectedHead]
  } else if (existingBranch) {
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
    if (created.branch !== branch || created.head !== expectedHead) throw failure('site_worktree_revalidation', 'Created worktree revision did not match the requested checkout.')
    const route = await writeRoute(input, {
      id: routeId,
      site: id,
      mode: 'managed-worktree',
      path: relative(input.homeRoot, destination),
      revision: branch ? { kind: 'branch', name: branch } : { kind: 'commit', sha: expectedHead },
    })
    return { ...route, head: created.head, branch: created.branch, detached: created.detached, checkout: created.checkout }
  } catch (error) {
    await git(['worktree', 'remove', '--', destination], source.path).catch(() => {})
    throw error
  }
}

async function removeRoute(input, id, routeId, flags) {
  const graph = await scanRouteGraph(input)
  const route = selectCurrentRoute(input, graph, id, routeId, '--id', { allowInactive: Boolean(routeId) })
  const references = graph.filter((entry) => entry.site === id && entry.id !== route.id && entry.supersededBy === route.id)
  if (references.length) throw failure('route_supersession_target', `Route ${id}/${route.id} is still referenced by ${references.map((entry) => entry.ref).join(', ')}.`)
  if (route.mode.startsWith('managed-')) {
    throw failure('checkout_delete_required', `Managed Checkout ${route.ref} must be removed with checkout delete.`)
  }
  await removeGeneratedLink(input, checkoutAddress(input, route), route)
  await rm(route.documentPath)
  await removeEmpty(dirname(route.documentPath), join(input.deskRoot, 'routes'))
  return { status: 'removed', site: id, route: route.id, mode: route.mode }
}

async function routesFor(input, id) {
  const values = (input.resolvedHome.routes ?? []).filter((route) => route.site === id)
  return Promise.all(values.map(async (route) => {
    const mode = route.declared.checkout.mode
    const declaredPath = mode === 'embedded'
      ? input.homeRoot
      : mode.startsWith('managed-') ? managedPath(input, route.site, route.id) : route.declaredPath
    return {
      ...route,
      documentPath: route.documentPath ?? join(input.deskRoot, 'routes', route.site, `${route.id}.json`),
      declaredPath,
      status: route.declared.status,
      supersededBy: route.declared.supersededBy,
      mode,
      revision: route.declared.revision,
      path: await canonicalPath(declaredPath),
    }
  }))
}

async function scanRouteGraph(input) {
  const root = join(input.deskRoot, 'routes')
  const rootEntries = await safeReadDir(root)
  if (rootEntries.length || await exists(root)) await assertDirectory(root, 'route_root_invalid')
  const graph = []
  for (const siteEntry of rootEntries) {
    if (!siteEntry.isDirectory() || siteEntry.isSymbolicLink()) continue
    declaration(input, siteEntry.name)
    const siteRoot = join(root, siteEntry.name)
    await assertDirectory(siteRoot, 'route_root_invalid')
    const identities = new Set()
    for (const entry of await safeReadDir(siteRoot)) {
      if (entry.isSymbolicLink()) throw failure('route_invalid', `${relative(input.homeRoot, join(siteRoot, entry.name))} must not be a symbolic link.`)
      const legacy = entry.name.endsWith('.json')
      const current = entry.isDirectory()
      if (!legacy && !current) continue
      if (legacy && (!entry.isFile() || entry.isSymbolicLink())) throw failure('route_invalid', `${relative(input.homeRoot, join(siteRoot, entry.name))} must be a regular Route document.`)
      const id = legacy ? entry.name.slice(0, -5) : entry.name
      if (identities.has(id)) throw failure('route_source_collision', `Route ${siteEntry.name}/${id} has multiple declarations.`)
      identities.add(id)
      const documentPath = legacy ? join(siteRoot, entry.name) : join(siteRoot, entry.name, 'ROUTE.md')
      await assertSafeRouteFile(input, documentPath)
      const sourceBytes = await readFile(documentPath)
      if (current) {
        const ref = `checkout:${siteEntry.name}/${id}`
        const route = (input.resolvedHome.routes ?? []).find((candidate) => candidate.site === siteEntry.name && candidate.id === id && candidate.schemaVersion === 9)
          ?? pendingRoutes.get(ref)
        if (!route || route.documentPath !== documentPath) throw failure('route_invalid', `${relative(input.homeRoot, documentPath)} is not the resolved Route ${siteEntry.name}/${id}.`)
        const checkout = route.declared.checkout
        const declaredPath = checkout.mode === 'embedded' ? input.homeRoot : managedPath(input, siteEntry.name, id)
        graph.push({
          ...route,
          documentPath,
          declaredPath,
          status: route.declared.status,
          supersededBy: route.declared.supersededBy,
          mode: checkout.mode,
          revision: route.declared.revision,
          path: await canonicalPath(declaredPath),
          sourceBytes,
          fileMode: (await lstat(documentPath)).mode & 0o777,
        })
        continue
      }
      let source
      try { source = JSON.parse(sourceBytes) } catch { throw failure('route_invalid', `${relative(input.homeRoot, documentPath)} is not valid JSON.`) }
      const stub = { id, site: siteEntry.name, documentPath }
      let document
      let schemaVersion
      if (source?.$schema === 'https://endroit.org/schema/v7/route.json') {
        document = migrationDocumentFromV7(input, stub, sourceBytes, { validate: false })
        schemaVersion = 7
      } else {
        validateRoute(source, siteEntry.name, id, input)
        document = source
        schemaVersion = 8
      }
      const checkout = document.checkout
      const declaredPath = checkout.mode === 'embedded'
        ? input.homeRoot
        : checkout.mode.startsWith('managed-') ? managedPath(input, siteEntry.name, id)
          : isAbsolute(checkout.path) ? resolve(checkout.path) : resolve(input.homeRoot, checkout.path)
      graph.push({
        id,
        site: siteEntry.name,
        ref: `checkout:${siteEntry.name}/${id}`,
        schemaVersion,
        declared: {
        status: document.status,
        ...(document.supersededBy ? { supersededBy: document.supersededBy } : {}),
        checkout: { ...checkout },
        ...(document.revision ? { revision: { ...document.revision } } : {}),
        },
        declaredPath,
        documentPath,
        status: document.status,
        supersededBy: document.supersededBy,
        mode: checkout.mode,
        revision: document.revision,
        path: await canonicalPath(declaredPath),
        sourceBytes,
        fileMode: (await lstat(documentPath)).mode & 0o777,
      })
    }
  }
  for (const route of graph.filter((entry) => entry.status === 'superseded')) {
    if (!graph.some((entry) => entry.site === route.site && entry.id === route.supersededBy)) {
      throw failure('route_supersession_invalid', `Route ${route.site}/${route.id} supersedes to missing Route ${route.supersededBy}.`)
    }
  }
  return graph.sort((left, right) => left.site.localeCompare(right.site) || left.id.localeCompare(right.id))
}

function selectCurrentRoute(input, graph, id, routeId, flag = '--id', options = {}) {
  declaration(input, id)
  const routes = graph.filter((route) => route.site === id)
  if (routeId) {
    const selected = routes.find((route) => route.id === routeId)
    if (!selected) throw failure('route_missing', `${id} has no Route ${routeId}.`)
    if (selected.status !== 'active' && !options.allowInactive) throw failure('route_inactive', `Route ${id}/${routeId} is ${selected.status}; activate it before an operational effect.`)
    return selected
  }
  const active = routes.filter((route) => route.status === 'active')
  if (!active.length) throw failure('site_unrouted', `${id} has no active Route.`)
  if (active.length > 1) throw failure('route_ambiguous', `${id} has multiple active Routes; pass ${flag}.`)
  return active[0]
}

function selectCurrentRouteByStatus(input, graph, id, routeId, status) {
  declaration(input, id)
  const routes = graph.filter((route) => route.site === id)
  if (routeId) {
    const selected = routes.find((route) => route.id === routeId)
    if (!selected) throw failure('route_missing', `${id} has no Route ${routeId}.`)
    return selected
  }
  const matching = routes.filter((route) => route.status === status)
  if (!matching.length) throw failure('route_status_missing', `${id} has no ${status} Route.`)
  if (matching.length > 1) throw failure('route_ambiguous', `${id} has multiple ${status} Routes; pass --id.`)
  return matching[0]
}

async function selectRoute(input, id, routeId, flag = '--id', options = {}) {
  declaration(input, id)
  const routes = await routesFor(input, id)
  if (routeId) {
    const selected = routes.find((route) => route.id === routeId)
    if (!selected) throw failure('route_missing', `${id} has no Route ${routeId}.`)
    if (selected.status !== 'active' && !options.allowInactive) throw failure('route_inactive', `Route ${id}/${routeId} is ${selected.status}; activate it before an operational effect.`)
    return selected
  }
  const active = routes.filter((route) => route.status === 'active')
  if (!active.length) throw failure('site_unrouted', `${id} has no active Route.`)
  if (active.length > 1) throw failure('route_ambiguous', `${id} has multiple active Routes; pass ${flag}.`)
  return active[0]
}

async function selectRouteByStatus(input, id, routeId, status) {
  declaration(input, id)
  const routes = await routesFor(input, id)
  if (routeId) {
    const selected = routes.find((route) => route.id === routeId)
    if (!selected) throw failure('route_missing', `${id} has no Route ${routeId}.`)
    return selected
  }
  const matching = routes.filter((route) => route.status === status)
  if (!matching.length) throw failure('route_status_missing', `${id} has no ${status} Route.`)
  if (matching.length > 1) throw failure('route_ambiguous', `${id} has multiple ${status} Routes; pass --id.`)
  return matching[0]
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
  return withRouteWriterLock(input, () => writeRouteUnlocked(input, route))
}

async function writeRouteUnlocked(input, route) {
  const siteRoot = join(input.deskRoot, 'routes', route.site)
  const root = join(siteRoot, route.id)
  const path = join(root, 'ROUTE.md')
  await mkdir(siteRoot, { recursive: true })
  if (await exists(root) || await exists(join(siteRoot, `${route.id}.json`))) throw failure('route_exists', `Route ${route.site}/${route.id} already exists.`)
  const document = {
    $schema: 'https://endroit.org/schema/v9/route.json',
    kind: 'endroit/route',
    id: route.id,
    site: route.site,
    owner: `desk:${input.resolvedHome.desk.id}`,
    route_state: route.status ?? 'active',
    ...(route.supersededBy ? { superseded_by: route.supersededBy } : {}),
    checkout_mode: route.mode,
    ...(route.revision ? { revision: { ...route.revision } } : {}),
  }
  validateRouteV9(document, route.site, route.id)
  await mkdir(root)
  try { await writeBytesAtomic(path, Buffer.from(renderRouteMarkdown(document)), 0o600) } catch (error) {
    await removeEmpty(root, siteRoot)
    throw error
  }
  const address = route.mode === 'embedded' ? input.homeRoot : managedPath(input, route.site, route.id)
  const target = ['existing', 'submodule'].includes(route.mode) ? await canonicalPath(resolve(input.homeRoot, route.path)) : address
  const ref = `checkout:${route.site}/${route.id}`
  pendingRoutes.set(ref, {
    id: route.id,
    site: route.site,
    ref,
    owner: document.owner,
    schemaVersion: 9,
    declared: {
      status: document.route_state,
      checkout: { mode: document.checkout_mode },
      ...(document.revision ? { revision: { ...document.revision } } : {}),
    },
    declaredPath: address,
    documentPath: path,
  })
  return {
    status: route.mode === 'managed-clone' ? 'cloned' : route.mode === 'managed-worktree' ? 'created' : 'bound',
    site: route.site,
    route: route.id,
    ref: `checkout:${route.site}/${route.id}`,
    declared: { status: document.route_state, checkout: { mode: document.checkout_mode }, ...(document.revision ? { revision: document.revision } : {}) },
    observed: { path: await canonicalPath(target) },
    mode: route.mode,
    revision: route.revision ?? null,
    path: await canonicalPath(target),
  }
}

async function assertRouteAvailable(input, site, route) {
  const root = join(input.deskRoot, 'routes', site)
  if (await exists(join(root, `${route}.json`)) || await exists(join(root, route))) throw failure('route_exists', `Route ${site}/${route} already exists.`)
}

function managedPath(input, site, route) {
  const root = join(input.homeRoot, 'checkouts', site)
  const destination = join(root, route)
  if (relative(root, destination).startsWith('..')) throw failure('route_path_invalid', 'Managed checkout must stay below checkouts/.')
  return destination
}

async function routeRepositoryPath(input, route) {
  if (route.schemaVersion === 9 && ['existing', 'submodule'].includes(route.mode)) {
    const target = await checkoutIndexTarget(input, route)
    if (!target) throw failure('checkout_unbound', `${route.ref} has no bound Checkout address; adopt it explicitly.`)
    if (route.mode === 'submodule' && !await exists(join(target, '.git'))) {
      throw failure('checkout_submodule_uninitialized', `Submodule Checkout ${route.site}/${route.id} is not initialized.`)
    }
    return target
  }
  if (route.mode === 'submodule' && !await exists(join(route.path, '.git'))) {
    throw failure('checkout_submodule_uninitialized', `Submodule Checkout ${route.site}/${route.id} is not initialized.`)
  }
  return route.mode.startsWith('managed-') ? (await validateManagedCheckout(input, route)).resolvedPath : route.path
}

async function validateManagedCheckout(input, route, expected) {
  const declaredPath = route.declaredPath
  if (declaredPath !== managedPath(input, route.site, route.id)) {
    throw failure('route_path_invalid', `Managed Route ${route.site}/${route.id} must stay below its Desk checkout path.`)
  }
  let info
  try { info = await lstat(declaredPath) } catch (error) {
    if (error.code === 'ENOENT') throw failure('route_broken', `Managed Route ${route.site}/${route.id} has no checkout.`)
    throw error
  }
  if (info.isSymbolicLink()) throw failure('route_checkout_symlink', `Managed Route ${route.site}/${route.id} checkout must not be a symlink.`)
  if (!info.isDirectory()) throw failure('route_checkout_invalid', `Managed Route ${route.site}/${route.id} checkout must be a directory.`)
  const resolvedPath = await realpath(declaredPath)
  if (resolvedPath !== declaredPath) throw failure('route_checkout_escape', `Managed Route ${route.site}/${route.id} checkout resolves outside its declared path.`)
  const current = { declaredPath, resolvedPath, dev: info.dev, ino: info.ino }
  if (expected && (current.resolvedPath !== expected.resolvedPath || current.dev !== expected.dev || current.ino !== expected.ino)) {
    throw failure('route_checkout_changed', `Managed Route ${route.site}/${route.id} checkout changed during revalidation.`)
  }
  return current
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
  const upstream = status.match(/^# branch\.upstream (.+)$/m)?.[1] ?? null
  const divergenceMatch = status.match(/^# branch\.ab \+(\d+) -(\d+)$/m)
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
    detached: branch === null,
    upstream,
    divergence: divergenceMatch ? { ahead: Number(divergenceMatch[1]), behind: Number(divergenceMatch[2]) } : null,
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
  const checkout = route.checkout
  if (route.$schema !== 'https://endroit.org/schema/v8/route.json' || route.id !== id || route.site !== site || !['active', 'parked', 'superseded'].includes(route.status) || !checkout || !['embedded', 'existing', 'managed-clone', 'managed-worktree', 'submodule'].includes(checkout.mode)) {
    throw failure('route_invalid', `Invalid Route ${site}/${id}.`)
  }
  const pathMode = ['existing', 'submodule'].includes(checkout.mode)
  if (pathMode !== (typeof checkout.path === 'string' && checkout.path.length > 0)) throw failure('route_invalid', `Invalid Checkout path for Route ${site}/${id}.`)
  const revision = route.revision
  if (revision !== undefined && (!revision || typeof revision !== 'object' || Array.isArray(revision)
    || revision.kind === 'branch' && (typeof revision.name !== 'string' || !revision.name || Object.keys(revision).some((key) => !['kind', 'name'].includes(key)))
    || revision.kind === 'commit' && (typeof revision.sha !== 'string' || !/^[a-f0-9]{40,64}$/i.test(revision.sha) || Object.keys(revision).some((key) => !['kind', 'sha'].includes(key)))
    || !['branch', 'commit'].includes(revision.kind))) throw failure('route_invalid', `Invalid revision for Route ${site}/${id}.`)
  if (checkout.mode === 'managed-worktree' && !revision) throw failure('route_invalid', `Managed worktree Route ${site}/${id} requires a revision.`)
  if (checkout.mode === 'submodule' && revision) throw failure('route_invalid', `Submodule Route ${site}/${id} cannot declare a revision.`)
  if (pathMode && !isAbsolute(checkout.path) && checkout.path.split(/[\\/]+/).includes('..')) throw failure('route_path_invalid', `Route ${site}/${id} path must not escape its Home context.`)
  if (route.status === 'superseded' ? !validId(route.supersededBy) || route.supersededBy === id : Boolean(route.supersededBy)) throw failure('route_invalid', `Invalid lifecycle for Route ${site}/${id}.`)
  const rootKeys = Object.keys(route)
  if (rootKeys.some((key) => !['$schema', 'id', 'site', 'status', 'supersededBy', 'checkout', 'revision'].includes(key))) throw failure('route_invalid', `Invalid Route ${site}/${id}.`)
  if (Object.keys(checkout).some((key) => !['mode', 'path'].includes(key))) throw failure('route_invalid', `Invalid Checkout ${site}/${id}.`)
}

function routeDeclaration(input, route) {
  return {
    id: route.id,
    site: route.site,
    ref: route.ref,
    schemaVersion: route.schemaVersion,
    declared: route.declared,
    declaration: relative(input.deskRoot, route.documentPath),
  }
}

async function observeRoute(input, site, route) {
  const repository = await routeRepositoryPath(input, route).then(inspectRepository).catch((error) => ({ available: false, error: error.message, worktrees: [], conflicts: 0 }))
  const currentWorktree = repository.worktrees.find((worktree) => worktree.path === repository.root)
  return {
    ...routeDeclaration(input, route),
    observed: {
      path: repository.root ?? route.path,
      address: checkoutAddress(input, route),
      target: route.declaredPath,
      realpath: repository.root ?? null,
      remote: repository.remotes?.[0]?.repository ?? null,
      gitDir: repository.gitDir ?? null,
      commonGitDir: repository.commonGitDir ?? null,
      checkout: repository.checkout ?? null,
      head: repository.head ?? null,
      branch: repository.branch ?? null,
      detached: repository.detached ?? null,
      clean: repository.clean ?? false,
      changes: repository.changes?.length ?? 0,
      conflicts: repository.conflicts ?? 0,
      operation: repository.operation ?? null,
      locked: Boolean(currentWorktree?.locked),
      prunable: Boolean(currentWorktree?.prunable),
      upstream: repository.upstream ?? null,
      divergence: repository.divergence ?? null,
      repository,
      index: (await inspectCheckoutIndex(input, route)).status,
      matches: matchesSite(site, repository),
      observedAt: new Date().toISOString(),
    },
  }
}

async function observeWorktree(input, site, worktree, route) {
  const evidence = worktree.available ? await inspectRepository(worktree.path).catch(() => null) : null
  const technicalId = evidence ? sha256(`${evidence.commonGitDir}\0${evidence.gitDir}`).slice(0, 12) : sha256(worktree.path).slice(0, 12)
  return {
    ...worktree,
    ...(evidence ? {
      head: evidence.head,
      branch: evidence.branch,
      detached: evidence.detached,
      clean: evidence.clean,
      changes: evidence.changes.length,
      conflicts: evidence.conflicts,
      operation: evidence.operation,
      upstream: evidence.upstream,
      divergence: evidence.divergence,
      gitDir: evidence.gitDir,
      commonGitDir: evidence.commonGitDir,
      checkout: evidence.checkout,
      remote: evidence.remotes[0]?.repository ?? null,
    } : { clean: false, changes: 0, conflicts: 0, operation: null }),
    route,
    registered: Boolean(route),
    ref: route ? `checkout:${site}/${route}` : `worktree:${site}/${technicalId}`,
    address: route ? managedPath(input, site, route) : observedWorktreePath(input, site, worktree.path, technicalId),
  }
}

function observedCheckout(site, worktree) {
  return {
    id: worktree.ref.split('/').at(-1),
    site,
    ref: worktree.ref,
    kind: 'observed-worktree',
    declared: null,
    observed: { ...worktree },
  }
}

function checkoutAddress(input, route) {
  return route.mode === 'embedded' ? input.homeRoot : managedPath(input, route.site, route.id)
}

function observedWorktreePath(input, site, path, id) {
  return join(input.homeRoot, 'checkouts', site, '_observed', `${slug(basename(path)) || 'worktree'}--${id}`)
}

async function inspectCheckoutIndex(input, route) {
  if (route.mode === 'embedded') return { status: 'direct', address: input.homeRoot, target: input.homeRoot }
  const address = checkoutAddress(input, route)
  const target = await checkoutIndexTarget(input, route)
  let info
  try { info = await lstat(address) } catch (error) {
    if (error.code === 'ENOENT') return { status: target ? 'missing' : 'unbound', address, target }
    throw error
  }
  if (!target) return { status: 'unindexed', address, target: null }
  if (!info.isSymbolicLink()) {
    const observed = await realpath(address).catch(() => null)
    return { status: observed === await canonicalPath(target) ? 'direct' : 'conflict', address, target, ...(observed ? { realpath: observed } : {}) }
  }
  const linked = await readlink(address)
  const observed = await realpath(address).catch(() => null)
  if (!observed) return { status: 'broken', address, target, linked }
  return { status: observed === await canonicalPath(target) ? 'linked' : 'divergent', address, target, linked, realpath: observed }
}

function indexManifestPath(input) { return join(input.homeRoot, '.endroit', 'checkout-index.json') }

async function readIndexManifest(input) {
  return (await readIndexSnapshot(input)).document
}

async function readIndexSnapshot(input) {
  const path = indexManifestPath(input)
  let bytes
  let mode
  try {
    const [content, info] = await Promise.all([readFile(path), lstat(path)])
    if (info.isSymbolicLink() || !info.isFile()) throw failure('checkout_index_invalid', `${relative(input.homeRoot, path)} must be a regular file.`)
    bytes = content
    mode = info.mode & 0o777
  } catch (error) {
    if (error.code === 'ENOENT') return { document: { version: 1, links: [] }, bytes: null, mode: 0o600 }
    throw error
  }
  let document
  try { document = JSON.parse(bytes) } catch { throw failure('checkout_index_invalid', `${relative(input.homeRoot, path)} is invalid.`) }
  if (document?.version !== 1 || !Array.isArray(document.links)) throw failure('checkout_index_invalid', `${relative(input.homeRoot, path)} is invalid.`)
  for (const link of document.links) {
    const absolute = resolve(input.homeRoot, link.path ?? '')
    if (!inside(join(input.homeRoot, 'checkouts'), absolute) || typeof link.target !== 'string' || !isAbsolute(link.target)
      || link.digest !== checkoutLinkDigest(link.path, link.target)) throw failure('checkout_index_invalid', `Invalid generated Checkout link ${link.path}.`)
  }
  return { document, bytes, mode }
}

function checkoutLinkDigest(path, target) { return sha256(`${path}\0${target}`) }

async function desiredCheckoutLinks(input) {
  const desired = []
  const manifest = await readIndexManifest(input)
  for (const route of await scanRouteGraph(input)) {
    if (route.mode === 'embedded') continue
    const address = checkoutAddress(input, route)
    const target = await checkoutIndexTarget(input, route, manifest)
    if (!target) continue
    if (address !== target && !route.mode.startsWith('managed-')) desired.push(indexLink(input, address, target, route.ref))
  }
  if (siteSettings(input).observedWorktrees === 'surface') {
    for (const site of await listSites(input)) {
      for (const worktree of site.worktrees.filter((entry) => !entry.registered && entry.available)) {
        desired.push(indexLink(input, worktree.address, worktree.path, worktree.ref))
      }
    }
  }
  return desired.sort((left, right) => left.path.localeCompare(right.path))
}

async function checkoutIndexTarget(input, route, manifest) {
  const address = checkoutAddress(input, route)
  if (route.schemaVersion !== 9) return canonicalPath(route.declaredPath)
  if (route.mode === 'embedded' || route.mode.startsWith('managed-')) return address
  manifest ??= await readIndexManifest(input)
  const local = relative(input.homeRoot, address)
  const entry = manifest.links.find((link) => link.path === local && link.ref === route.ref)
  if (entry) return canonicalPath(entry.target)
  const info = await lstat(address).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error))
  if (!info) return null
  if (info.isSymbolicLink()) return symlinkTarget(address)
  return info.isDirectory() ? canonicalPath(address) : null
}

async function createCheckoutLink(input, address, target) {
  target = await canonicalPath(target)
  await ensureSafeDirectories(input.homeRoot, dirname(address))
  if (await exists(address)) throw failure('checkout_bound', `${relative(input.homeRoot, address)} already exists.`)
  await symlink(target, address, 'dir')
  const [info, linked] = await Promise.all([lstat(address), symlinkTarget(address)])
  if (!info.isSymbolicLink() || linked !== await canonicalPath(target)) {
    await rm(address, { force: true })
    throw failure('checkout_bind_failed', `${relative(input.homeRoot, address)} did not bind to the requested Checkout.`)
  }
}

async function bindCheckoutLink(input, address, target, ref) {
  target = await canonicalPath(target)
  const snapshot = await readIndexSnapshot(input)
  const link = indexLink(input, address, target, ref)
  const previous = snapshot.document.links.find((entry) => entry.path === link.path)
  const links = [...snapshot.document.links.filter((entry) => entry.path !== link.path), link]
    .sort((left, right) => left.path.localeCompare(right.path))
  const info = await lstat(address).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error))
  if (info) {
    if (!previous || previous.ref !== ref || !info.isSymbolicLink() || await symlinkTarget(address) !== previous.target) {
      throw failure('checkout_index_conflict', `${relative(input.homeRoot, address)} already exists.`)
    }
    await rm(address)
  }
  try {
    await createCheckoutLink(input, address, target)
  } catch (error) {
    if (previous && !await exists(address)) await symlink(previous.target, address, 'dir')
    throw error
  }
  try {
    await ensureSafeDirectories(input.homeRoot, dirname(indexManifestPath(input)))
    await writeJsonAtomic(indexManifestPath(input), { version: 1, links }, 0o600)
  } catch (error) {
    const info = await lstat(address).catch(() => null)
    if (info?.isSymbolicLink() && await symlinkTarget(address) === target) await rm(address)
    if (previous && !await exists(address)) await symlink(previous.target, address, 'dir')
    throw error
  }
}

function indexLink(input, path, target, ref) {
  const local = relative(input.homeRoot, path)
  return { path: local, target, ref, digest: checkoutLinkDigest(local, target) }
}

async function reconcileCheckouts(input, flags = {}) {
  requireDesk(input)
  if (truthy(flags.check) && truthy(flags.apply)) throw failure('usage', 'Choose --check or --apply.', 2)
  const [manifestSnapshot, desired] = await Promise.all([readIndexSnapshot(input), desiredCheckoutLinks(input)])
  const manifest = manifestSnapshot.document
  const desiredDocument = { version: 1, links: desired }
  const desiredBytes = Buffer.from(`${JSON.stringify(desiredDocument, null, 2)}\n`)
  const current = new Map(manifest.links.map((link) => [link.path, link]))
  const wanted = new Map(desired.map((link) => [link.path, link]))
  const plan = []
  for (const link of desired) {
    const path = resolve(input.homeRoot, link.path)
    const owned = current.get(link.path)
    const info = await lstat(path).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error))
    if (!info) plan.push({ action: 'create', ...link })
    else if (!info.isSymbolicLink()) plan.push({ action: 'conflict', ...link })
    else {
      const target = await symlinkTarget(path)
      if (target !== link.target && owned?.target === target) plan.push({ action: 'replace', ...link, previousTarget: target })
      else if (target !== link.target) plan.push({ action: 'conflict', ...link, observedTarget: target })
      else if (owned?.digest !== link.digest) plan.push({ action: 'record', ...link })
    }
  }
  for (const link of manifest.links.filter((entry) => !wanted.has(entry.path))) {
    const path = resolve(input.homeRoot, link.path)
    const info = await lstat(path).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error))
    if (!info) plan.push({ action: 'forget', ...link })
    else if (!info.isSymbolicLink() || await symlinkTarget(path) !== link.target) plan.push({ action: 'conflict', ...link })
    else plan.push({ action: 'remove', ...link })
  }
  const conflicts = plan.filter((entry) => entry.action === 'conflict')
  if (!truthy(flags.apply)) return { status: plan.length ? 'stale' : 'current', readOnly: true, changes: plan.length - conflicts.length, conflicts }
  if (conflicts.length) throw failure('checkout_index_conflict', `Checkout index has ${conflicts.length} conflicting path(s).`)
  const created = []
  const removed = []
  try {
    for (const entry of plan) {
      const path = resolve(input.homeRoot, entry.path)
      if (entry.action === 'create') {
        await ensureSafeDirectories(input.homeRoot, dirname(path))
        await symlink(entry.target, path, 'dir')
        created.push(entry)
      } else if (entry.action === 'replace') {
        await rm(path)
        removed.push({ ...entry, target: entry.previousTarget })
        await symlink(entry.target, path, 'dir')
        created.push(entry)
      } else if (entry.action === 'remove') {
        await rm(path)
        removed.push(entry)
        await removeEmpty(dirname(path), join(input.homeRoot, 'checkouts'))
      }
      if (process.env.NODE_ENV === 'test' && process.env.ENDROIT_TEST_FAULT_AFTER_CHECKOUT_INDEX_ACTION === entry.action) {
        if (process.env.ENDROIT_TEST_CHECKOUT_INDEX_FAULT_READY_FILE) {
          await writeFile(process.env.ENDROIT_TEST_CHECKOUT_INDEX_FAULT_READY_FILE, 'ready\n')
          await new Promise((resolvePromise) => setTimeout(resolvePromise, Number(process.env.ENDROIT_TEST_HOLD_CHECKOUT_INDEX_FAULT_MS ?? 100)))
        }
        throw failure('checkout_index_fault', `Injected failure after Checkout index ${entry.action}.`)
      }
    }
    await ensureSafeDirectories(input.homeRoot, dirname(indexManifestPath(input)))
    await writeBytesAtomic(indexManifestPath(input), desiredBytes, 0o600)
  } catch (error) {
    const rollbackFailures = await rollbackCheckoutIndex(input, manifestSnapshot, desiredBytes, created, removed)
    if (rollbackFailures.length) error.message = `${error.message} Checkout index rollback failed: ${rollbackFailures.join('; ')}`
    throw error
  }
  return { status: 'reconciled', changes: plan.length, links: desired.length }
}

async function rollbackCheckoutIndex(input, manifestSnapshot, desiredBytes, created, removed) {
  const failures = []
  let ownership
  try { ownership = await checkoutIndexRollbackOwnership(input, manifestSnapshot, desiredBytes) } catch (error) { return [`manifest: ownership preflight failed: ${error.message}`] }
  if (!ownership.allowed) return [`manifest: ${ownership.message}`]
  for (const entry of created.reverse()) {
    const path = resolve(input.homeRoot, entry.path)
    try {
      const info = await lstat(path).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error))
      if (!info) continue
      if (!info.isSymbolicLink() || await symlinkTarget(path) !== entry.target) throw new Error(`${entry.path} is no longer the generated link`)
      await rm(path)
    } catch (error) { failures.push(`${entry.path}: ${error.message}`) }
  }
  for (const entry of removed.reverse()) {
    const path = resolve(input.homeRoot, entry.path)
    try {
      await ensureSafeDirectories(input.homeRoot, dirname(path))
      const info = await lstat(path).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error))
      if (info) {
        if (!info.isSymbolicLink() || await symlinkTarget(path) !== entry.target) throw new Error(`${entry.path} was replaced during rollback`)
      } else await symlink(entry.target, path, 'dir')
    } catch (error) { failures.push(`${entry.path}: ${error.message}`) }
  }
  if (process.env.NODE_ENV === 'test' && process.env.ENDROIT_TEST_CHECKOUT_INDEX_ROLLBACK_LINKS_READY_FILE) {
    await writeFile(process.env.ENDROIT_TEST_CHECKOUT_INDEX_ROLLBACK_LINKS_READY_FILE, 'ready\n')
    await new Promise((resolvePromise) => setTimeout(resolvePromise, Number(process.env.ENDROIT_TEST_HOLD_CHECKOUT_INDEX_ROLLBACK_MS ?? 100)))
  }
  try { ownership = await checkoutIndexRollbackOwnership(input, manifestSnapshot, desiredBytes) } catch (error) {
    failures.push(`manifest: ownership revalidation failed: ${error.message}`)
    return failures
  }
  if (!ownership.allowed) {
    failures.push(`manifest: ${ownership.message}`)
    return failures
  }
  try {
    const path = indexManifestPath(input)
    if (manifestSnapshot.bytes) {
      if (!ownership.originalMatches) await writeBytesAtomic(path, manifestSnapshot.bytes, manifestSnapshot.mode)
    } else if (ownership.current) {
      await assertRegularFile(path, 'checkout_index_invalid')
      await rm(path)
    }
  } catch (error) { failures.push(`manifest: ${error.message}`) }
  return failures
}

async function checkoutIndexRollbackOwnership(input, manifestSnapshot, desiredBytes) {
  const current = await readFile(indexManifestPath(input)).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error))
  const originalMatches = Boolean(current && manifestSnapshot.bytes && current.equals(manifestSnapshot.bytes))
  const desiredMatches = Boolean(current && current.equals(desiredBytes))
  if (current && !originalMatches && !desiredMatches) {
    return { allowed: false, current, originalMatches, desiredMatches, message: 'manifest changed concurrently; it and the failed apply link state were preserved' }
  }
  return { allowed: true, current, originalMatches, desiredMatches }
}

async function removeGeneratedLink(input, path, route) {
  const manifest = await readIndexManifest(input)
  const local = relative(input.homeRoot, path)
  const entry = manifest.links.find((link) => link.path === local)
  const info = await lstat(path).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error))
  if (!entry) {
    if (!info || !route || route.schemaVersion !== 9 || !info.isSymbolicLink()) return
    const target = await checkoutIndexTarget(input, route, { version: 1, links: [] })
    if (!target || await symlinkTarget(path) !== target) throw failure('checkout_index_conflict', `Refusing to remove unowned Checkout path ${local}.`)
    await rm(path)
    return
  }
  if (info && (!info.isSymbolicLink() || await symlinkTarget(path) !== entry.target)) throw failure('checkout_index_conflict', `Refusing to remove unowned Checkout path ${local}.`)
  if (info) await rm(path)
  await writeJsonAtomic(indexManifestPath(input), { version: 1, links: manifest.links.filter((link) => link.path !== local) }, 0o600)
}

async function deleteCheckout(input, selector, flags) {
  const parsed = parseCheckoutRef(selector)
  if (parsed.kind !== 'checkout' || flags.approve !== selector) throw failure('checkout_delete_approval', `Pass --approve ${selector}.`, 2)
  const graph = await scanRouteGraph(input)
  const route = selectCurrentRoute(input, graph, parsed.site, parsed.id, '--id', { allowInactive: true })
  if (!route.mode.startsWith('managed-')) throw failure('checkout_delete_mode', `Only managed Checkouts can be deleted.`)
  const references = graph.filter((entry) => entry.site === parsed.site && entry.id !== route.id && entry.supersededBy === route.id)
  if (references.length) throw failure('route_supersession_target', `${route.ref} is still referenced by ${references.map((entry) => entry.ref).join(', ')}.`)
  const checkout = await validateManagedCheckout(input, route)
  const evidence = await inspectRepository(checkout.resolvedPath)
  if (!evidence.clean || evidence.conflicts || evidence.operation) throw failure('route_dirty', `${route.ref} is not clean and idle.`)
  await assertTopologyFamilySafe(input, evidence.commonGitDir, route.ref)
  let source
  if (route.mode === 'managed-worktree') {
    const current = evidence.worktrees.find((worktree) => worktree.path === evidence.root)
    if (!current) throw failure('site_worktree_metadata_missing', `${route.ref} is missing from Git metadata.`)
    if (current.locked) throw failure('site_worktree_locked', `${route.ref} is locked.`)
    if (current.prunable) throw failure('site_worktree_prunable', `${route.ref} has prunable metadata.`)
    source = evidence.worktrees.find((entry) => entry.path !== evidence.root && entry.available && !entry.locked && !entry.prunable)?.path
    if (!source) throw failure('site_worktree_source_missing', `No usable sibling checkout can remove ${route.ref}.`)
  } else if (evidence.worktrees.some((worktree) => worktree.path !== evidence.root)) {
    throw failure('site_clone_has_worktrees', `${route.ref} still has dependent worktrees.`)
  }
  if (process.env.NODE_ENV === 'test' && process.env.ENDROIT_TEST_CHECKOUT_DELETE_READY_FILE) {
    await writeFile(process.env.ENDROIT_TEST_CHECKOUT_DELETE_READY_FILE, 'ready\n')
    await new Promise((resolvePromise) => setTimeout(resolvePromise, Number(process.env.ENDROIT_TEST_HOLD_CHECKOUT_DELETE_MS ?? 100)))
  }
  const stagedRoute = await stageRouteDeletion(route)
  let stagedCheckout = null
  let destructive = false
  try {
    if (process.env.NODE_ENV === 'test' && process.env.ENDROIT_TEST_ROUTE_STAGED_READY_FILE) {
      await writeFile(process.env.ENDROIT_TEST_ROUTE_STAGED_READY_FILE, stagedRoute.path)
      await new Promise((resolvePromise) => setTimeout(resolvePromise, Number(process.env.ENDROIT_TEST_HOLD_ROUTE_STAGED_MS ?? 100)))
    }
    await assertRouteDestinationVacant(stagedRoute)
    if (route.mode === 'managed-worktree') {
      await validateManagedCheckout(input, route, checkout)
      destructive = true
      if (process.env.NODE_ENV === 'test' && process.env.ENDROIT_TEST_FAULT_AFTER_DESTRUCTIVE_BOUNDARY === route.ref) {
        throw failure('checkout_delete_fault', `Injected failure after ${route.ref} destructive boundary.`)
      }
      await git(['worktree', 'remove', '--', checkout.declaredPath], source)
    } else {
      await validateManagedCheckout(input, route, checkout)
      stagedCheckout = await stageManagedCloneDeletion(route, checkout)
      if (process.env.NODE_ENV === 'test' && process.env.ENDROIT_TEST_CLONE_STAGED_READY_FILE) {
        await writeFile(process.env.ENDROIT_TEST_CLONE_STAGED_READY_FILE, stagedCheckout.path)
        await new Promise((resolvePromise) => setTimeout(resolvePromise, Number(process.env.ENDROIT_TEST_HOLD_CLONE_STAGED_MS ?? 100)))
      }
      await assertRouteDestinationVacant(stagedRoute)
      await assertStagedManagedClone(route, stagedCheckout)
      destructive = true
      if (process.env.NODE_ENV === 'test' && process.env.ENDROIT_TEST_FAULT_AFTER_DESTRUCTIVE_BOUNDARY === route.ref) {
        throw failure('checkout_delete_fault', `Injected failure after ${route.ref} destructive boundary.`)
      }
      await rm(stagedCheckout.path, { recursive: true })
      stagedCheckout = null
    }
  } catch (error) {
    if (destructive) {
      if (route.mode === 'managed-worktree' && await managedWorktreeIntact(input, route, checkout, evidence)) {
        try {
          await restoreStagedRoute(stagedRoute)
          throw error
        } catch (rollbackError) {
          if (rollbackError === error) throw error
          error.message = `${error.message} Route rollback failed: ${rollbackError.message}`
        }
      }
      throw partialCheckoutDeletion(input, route, stagedRoute, stagedCheckout, checkout, error)
    }
    const rollbackFailures = []
    let checkoutRestored = true
    const checkoutToRestore = stagedCheckout ?? error.stagedCheckout
    if (checkoutToRestore) {
      try { await restoreStagedCheckout(checkoutToRestore) } catch (rollbackError) {
        checkoutRestored = false
        rollbackFailures.push(rollbackError.message)
      }
    }
    if (checkoutRestored) {
      try { await restoreStagedRoute(stagedRoute) } catch (rollbackError) { rollbackFailures.push(rollbackError.message) }
    } else {
      rollbackFailures.push(`Route backup retained at ${stagedRoute.path}`)
    }
    if (rollbackFailures.length) error.message = `${error.message} Checkout deletion rollback failed: ${rollbackFailures.join('; ')}`
    throw error
  }
  const retainedRouteBackup = await rm(stagedRoute.path, { force: true }).then(() => null).catch(() => relative(input.homeRoot, stagedRoute.path))
  const retainedRouteDirectory = await removeEmpty(dirname(route.documentPath), join(input.deskRoot, 'routes')).then(() => null).catch(() => relative(input.homeRoot, dirname(route.documentPath)))
  return {
    status: 'deleted',
    ref: selector,
    branchDeleted: false,
    ...(retainedRouteBackup ? { retainedRouteBackup } : {}),
    ...(retainedRouteDirectory ? { retainedRouteDirectory } : {}),
  }
}

async function stageRouteDeletion(route) {
  const expected = { sha256: sha256(route.sourceBytes), mode: route.fileMode }
  const current = await routeFileState(route.documentPath)
  if (current.sha256 !== expected.sha256 || current.mode !== expected.mode) throw failure('route_delete_drift', `${route.ref} declaration changed before deletion.`)
  const path = `${route.documentPath}.${randomUUID()}.delete`
  await rename(route.documentPath, path)
  const result = { path, destination: route.documentPath, ...expected }
  try {
    const staged = await routeFileState(path)
    if (staged.sha256 !== expected.sha256 || staged.mode !== expected.mode) throw failure('route_delete_drift', `${route.ref} declaration changed during deletion.`)
    return result
  } catch (error) {
    try { await restoreStagedRoute(result) } catch (rollbackError) { error.message = `${error.message} Route staging rollback failed: ${rollbackError.message}` }
    throw error
  }
}

async function restoreStagedRoute(staged) {
  if (!await exists(staged.path)) throw new Error(`${staged.path} is missing while restoring its Route`)
  const current = await routeFileState(staged.path)
  if (current.sha256 !== staged.sha256 || current.mode !== staged.mode) throw new Error(`${staged.path} changed while restoring its Route`)
  const bytes = await readFile(staged.path)
  let handle
  let identity
  try {
    handle = await open(staged.destination, 'wx', staged.mode)
    identity = await handle.stat()
    await handle.writeFile(bytes)
    await handle.chmod(staged.mode)
    await handle.sync()
    await handle.close()
    handle = null
    await syncDirectory(dirname(staged.destination))
    const restored = await routeFileState(staged.destination)
    if (restored.sha256 !== staged.sha256 || restored.mode !== staged.mode) throw new Error(`${staged.destination} did not restore exactly`)
    await rm(staged.path)
  } catch (error) {
    await handle?.close().catch(() => {})
    if (identity) {
      const observed = await lstat(staged.destination).catch(() => null)
      if (observed?.dev === identity.dev && observed.ino === identity.ino) await rm(staged.destination, { force: true }).catch(() => {})
    }
    if (error.code === 'EEXIST') throw new Error(`${staged.destination} was replaced while restoring its Route`)
    throw error
  }
}

async function assertRouteDestinationVacant(staged) {
  if (await exists(staged.destination)) throw failure('route_delete_drift', `${staged.destination} was recreated during deletion.`)
}

async function stageManagedCloneDeletion(route, checkout) {
  const path = join(dirname(checkout.declaredPath), `.${basename(checkout.declaredPath)}.${randomUUID()}.delete`)
  await rename(checkout.declaredPath, path)
  const staged = { path, destination: checkout.declaredPath, dev: checkout.dev, ino: checkout.ino }
  try {
    await assertStagedManagedClone(route, staged)
    return staged
  } catch (error) {
    try { await restoreStagedCheckout(staged) } catch (rollbackError) {
      error.stagedCheckout = staged
      error.message = `${error.message} Checkout staging rollback failed: ${rollbackError.message}`
    }
    throw error
  }
}

async function restoreStagedCheckout(staged) {
  if (!await exists(staged.path)) throw new Error(`${staged.path} is missing while restoring its Checkout`)
  const current = await lstat(staged.path)
  if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== staged.dev || current.ino !== staged.ino) throw new Error(`${staged.path} changed while restoring its Checkout`)
  if (await exists(staged.destination)) throw new Error(`${staged.destination} was replaced while restoring its Checkout`)
  await rename(staged.path, staged.destination)
}

async function assertStagedManagedClone(route, staged) {
  const current = await lstat(staged.path)
  if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== staged.dev || current.ino !== staged.ino) {
    throw failure('route_checkout_changed', `Managed Route ${route.site}/${route.id} checkout changed during deletion.`)
  }
}

async function managedWorktreeIntact(input, route, checkout, before) {
  try {
    await validateManagedCheckout(input, route, checkout)
    const after = await inspectRepository(checkout.resolvedPath)
    return after.root === before.root
      && after.gitDir === before.gitDir
      && after.commonGitDir === before.commonGitDir
      && after.head === before.head
      && after.branch === before.branch
      && after.clean === before.clean
      && after.changes.length === before.changes.length
  } catch { return false }
}

function partialCheckoutDeletion(input, route, stagedRoute, stagedCheckout, checkout, cause) {
  const routeRecovery = relative(input.homeRoot, stagedRoute.path)
  const checkoutRecovery = relative(input.homeRoot, stagedCheckout?.path ?? checkout.declaredPath)
  return failure('checkout_partial_deletion', `${route.ref} deletion crossed its destructive boundary and may be partial (${cause.code ?? 'error'}: ${cause.message}). Route recovery: ${routeRecovery}. Checkout recovery: ${checkoutRecovery}.`)
}

async function assertTopologyFamilySafe(input, commonGitDir, exceptRef = null) {
  for (const site of await listSites(input)) {
    for (const worktree of site.worktrees) {
      if (!worktree.registered && worktree.commonGitDir === commonGitDir && (!worktree.clean || worktree.conflicts || worktree.operation)) {
        if (worktree.ref !== exceptRef) throw failure('checkout_family_blocked', `${worktree.ref} is dirty, conflicted or in a Git operation.`)
      }
    }
  }
}

async function inspectPinnedSite(input, site) {
  if (!siteSettings(input).pinnedSites.includes(site.id)) return []
  const route = (await routesFor(input, site.id)).find((entry) => entry.id === 'main')
  if (!route || route.mode !== 'submodule') return [`site-gitlink-missing:${site.id}`]
  if (route.declaredPath !== managedPath(input, site.id, 'main')) return [`site-gitlink-path-divergent:${site.id}`]
  const evidence = await routeRepositoryPath(input, route).then(inspectRepository).catch(() => null)
  if (!evidence) return [`site-gitlink-uninitialized:${site.id}`]
  if (!matchesSite(site, evidence)) return [`site-gitlink-remote-divergent:${site.id}`]
  const stage = await git(['ls-files', '--stage', '--', relative(input.homeRoot, route.declaredPath)], input.homeRoot).catch(() => '')
  const match = stage.match(/^160000 ([a-f0-9]{40,64}) /i)
  if (!match) return [`site-gitlink-missing:${site.id}`]
  return match[1] === evidence.head ? [] : [`site-gitlink-commit-divergent:${site.id}`]
}

function siteSettings(input) {
  return {
    pinnedSites: input.resolvedHome.home.settings?.['endroit/sites']?.pinnedSites ?? [],
    observedWorktrees: input.resolvedHome.desk?.settings?.['endroit/sites']?.observedWorktrees ?? 'report',
  }
}

function requestedRevision(flags) {
  if (flags.branch && flags.commit) throw failure('usage', 'Choose --branch or --commit.', 2)
  if (flags.branch) return { kind: 'branch', name: String(flags.branch) }
  if (flags.commit) {
    const sha = String(flags.commit)
    if (!/^[a-f0-9]{40,64}$/i.test(sha)) throw failure('route_revision_invalid', `Invalid commit ${sha}.`)
    return { kind: 'commit', sha: sha.toLowerCase() }
  }
  return null
}

function assertObservedRevision(revision, evidence) {
  if (!revision) return
  if (revision.kind === 'branch' && evidence.branch !== revision.name) throw failure('route_revision_divergent', `Observed branch ${evidence.branch ?? 'detached'} does not match ${revision.name}.`)
  if (revision.kind === 'commit' && evidence.head !== revision.sha) throw failure('route_revision_divergent', `Observed commit ${evidence.head} does not match ${revision.sha}.`)
}

function revisionMatches(revision, evidence) {
  if (!revision || evidence.available === false) return true
  return revision.kind === 'branch' ? evidence.branch === revision.name : evidence.head === revision.sha
}

function migrationRoot(input) { return join(input.homeRoot, '.endroit', 'migrations', 'checkout-v8') }
function routeV9MigrationRoot(input) { return join(input.homeRoot, '.endroit', 'migrations', 'checkout-v9') }
function routeWriterRoot(input) { return join(input.homeRoot, '.endroit', 'locks') }

async function withRouteWriterLock(input, operation) {
  requireDesk(input)
  if (routeWriterLockDepth) return operation()
  const root = routeWriterRoot(input)
  await ensureSafeDirectories(input.homeRoot, root)
  const lockPath = join(root, 'routes.lock')
  const lock = await acquireRouteWriterLock(lockPath)
  routeWriterLockDepth += 1
  try {
    if (process.env.NODE_ENV === 'test' && process.env.ENDROIT_TEST_HOLD_ROUTE_WRITER_MS) {
      await new Promise((resolve) => setTimeout(resolve, Number(process.env.ENDROIT_TEST_HOLD_ROUTE_WRITER_MS)))
    }
    return await operation()
  } finally {
    routeWriterLockDepth -= 1
    await lock.handle.close().catch(() => {})
    await releaseOwnedLock(lockPath, lock, root)
  }
}

async function acquireRouteWriterLock(path) {
  try {
    return await createOwnedLock(path)
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
    await assertRegularFile(path, 'route_writer_lock_invalid')
    const observed = await lstat(path)
    if (observed.isSymbolicLink() || !observed.isFile()) throw failure('route_writer_lock_invalid', 'Route writer lock must be a regular file.')
    let owner
    try { owner = JSON.parse(await readFile(path, 'utf8')) } catch {
      if (Date.now() - observed.mtimeMs <= 1_000) throw failure('route_writer_locked', 'Route writer lock is being initialized.')
      throw failure('route_writer_lock_invalid', 'Route writer lock is invalid.')
    }
    assertLockOwner(owner, 'route_writer_lock_invalid')
    const alive = processAlive(owner.pid)
    const code = alive ? 'route_writer_locked' : 'route_writer_lock_stale'
    const detail = alive
      ? `Route mutation is locked by process ${owner.pid}.`
      : `Route writer lock belongs to stopped process ${owner.pid}; inspect and remove ${path} before retrying.`
    throw failure(code, detail)
  }
}

async function createOwnedLock(path) {
  const handle = await open(path, 'wx', 0o600)
  const token = randomUUID()
  try {
    await handle.writeFile(`${JSON.stringify({ token, pid: process.pid, startedAt: new Date().toISOString() })}\n`)
    await handle.sync()
    await syncDirectory(dirname(path))
    const { dev, ino } = await handle.stat()
    return { handle, dev, ino, token }
  } catch (error) {
    await handle.close().catch(() => {})
    await rm(path, { force: true }).catch(() => {})
    throw error
  }
}

async function releaseOwnedLock(path, lock, root) {
  const current = await lstat(path).catch(() => null)
  if (current?.dev !== lock.dev || current.ino !== lock.ino) return
  let owner
  try { owner = JSON.parse(await readFile(path, 'utf8')) } catch { return }
  if (owner.token !== lock.token) return
  await rm(path, { force: true }).catch(() => {})
  await syncDirectory(root).catch(() => {})
}

function assertLockOwner(owner, code) {
  if (!owner || typeof owner.token !== 'string' || !owner.token || !Number.isInteger(owner.pid) || typeof owner.startedAt !== 'string' || Number.isNaN(Date.parse(owner.startedAt))) {
    throw failure(code, 'Route writer lock metadata is invalid.')
  }
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false
  try { process.kill(pid, 0); return true } catch (error) { return error.code === 'EPERM' }
}

async function writeJournal(input, root, journal) {
  await assertSafeDirectoryUnder(migrationRoot(input), root, 'route_migration_corrupt')
  const path = join(root, 'journal.json')
  if (await exists(path)) await assertRegularFile(path, 'route_migration_corrupt')
  await writeJsonAtomic(path, journal)
  await assertRegularFile(path, 'route_migration_corrupt')
}

async function readJournal(input, root, runId) {
  try {
    await assertSafeDirectoryUnder(migrationRoot(input), root, 'route_rollback_corrupt')
  } catch (error) {
    if (error.code === 'ENOENT') throw failure('route_migration_missing', `Migration run ${runId} does not exist.`)
    throw error
  }
  const path = join(root, 'journal.json')
  try { await assertRegularFile(path, 'route_rollback_corrupt') } catch (error) {
    if (error.code === 'ENOENT') throw failure('route_migration_missing', `Migration run ${runId} does not exist.`)
    throw error
  }
  let journal
  try { journal = JSON.parse(await readFile(path, 'utf8')) } catch { throw failure('route_rollback_corrupt', `Migration run ${runId} journal is invalid.`) }
  if (journal.version !== 1 || journal.kind !== 'checkout-v8-route-migration' || journal.runId !== runId || !Array.isArray(journal.routes)) {
    throw failure('route_rollback_corrupt', `Migration run ${runId} journal does not match its identity.`)
  }
  const refs = journal.routes.map((entry) => `${entry?.site}/${entry?.id}`)
  if (new Set(refs).size !== refs.length) throw failure('route_rollback_corrupt', `Migration run ${runId} repeats a Route.`)
  return journal
}

async function writeRouteV9Journal(input, root, journal) {
  await assertSafeDirectoryUnder(routeV9MigrationRoot(input), root, 'route_migration_corrupt')
  const path = join(root, 'journal.json')
  if (await exists(path)) await assertRegularFile(path, 'route_migration_corrupt')
  await writeJsonAtomic(path, journal)
  await assertRegularFile(path, 'route_migration_corrupt')
}

async function readRouteV9Journal(input, root, runId) {
  try {
    await assertSafeDirectoryUnder(routeV9MigrationRoot(input), root, 'route_rollback_corrupt')
  } catch (error) {
    if (error.code === 'ENOENT') throw failure('route_migration_missing', `Migration run ${runId} does not exist.`)
    throw error
  }
  const path = join(root, 'journal.json')
  try { await assertRegularFile(path, 'route_rollback_corrupt') } catch (error) {
    if (error.code === 'ENOENT') throw failure('route_migration_missing', `Migration run ${runId} does not exist.`)
    throw error
  }
  let journal
  try { journal = JSON.parse(await readFile(path, 'utf8')) } catch { throw failure('route_rollback_corrupt', `Migration run ${runId} journal is invalid.`) }
  if (journal.version !== 1 || journal.kind !== 'checkout-v9-route-migration' || journal.runId !== runId || !Array.isArray(journal.routes)) {
    throw failure('route_rollback_corrupt', `Migration run ${runId} journal does not match its identity.`)
  }
  const refs = journal.routes.map((entry) => `${entry?.site}/${entry?.id}`)
  if (new Set(refs).size !== refs.length) throw failure('route_rollback_corrupt', `Migration run ${runId} repeats a Route.`)
  return journal
}

async function classifyRouteV9RollbackEntry(input, root, entry) {
  if (!entry || typeof entry !== 'object' || !validId(entry.site) || !validId(entry.id)
    || typeof entry.sourceDeclaration !== 'string' || typeof entry.declaration !== 'string' || typeof entry.original !== 'string'
    || !['original', 'after'].includes(entry.progress)
    || !Number.isInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777
    || !/^[a-f0-9]{64}$/.test(entry.beforeSha256) || !/^[a-f0-9]{64}$/.test(entry.afterSha256)) {
    throw failure('route_rollback_corrupt', 'Migration journal contains invalid Route metadata.')
  }
  const sourcePath = resolve(input.homeRoot, entry.sourceDeclaration)
  const destinationPath = resolve(input.homeRoot, entry.declaration)
  if (sourcePath !== join(input.deskRoot, 'routes', entry.site, `${entry.id}.json`)
    || destinationPath !== join(input.deskRoot, 'routes', entry.site, entry.id, 'ROUTE.md')) {
    throw failure('route_rollback_corrupt', `Invalid Route declarations for ${entry.site}/${entry.id}.`)
  }
  const originalsRoot = join(root, 'originals')
  const originalPath = resolve(root, entry.original)
  if (originalPath !== join(originalsRoot, entry.site, `${entry.id}.json`)) throw failure('route_rollback_corrupt', `Invalid rollback source ${entry.original}.`)
  await assertSafeFileUnder(originalsRoot, originalPath, 'route_rollback_corrupt')
  const original = await readFile(originalPath)
  if (sha256(original) !== entry.beforeSha256) throw failure('route_rollback_corrupt', `${entry.original} does not match its journal digest.`)
  const sourceInfo = await lstat(sourcePath).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error))
  if (sourceInfo && (sourceInfo.isSymbolicLink() || !sourceInfo.isFile())) throw failure('route_rollback_drift', `${entry.sourceDeclaration} changed after migration.`)
  const source = sourceInfo ? await routeFileState(sourcePath) : null
  if (source && (source.sha256 !== entry.beforeSha256 || source.mode !== entry.mode)) throw failure('route_rollback_drift', `${entry.sourceDeclaration} changed after migration.`)
  const directoryInfo = await lstat(dirname(destinationPath)).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error))
  if (directoryInfo && (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory())) throw failure('route_rollback_drift', `${entry.declaration} changed after migration.`)
  const destinationInfo = await lstat(destinationPath).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error))
  if (destinationInfo && (destinationInfo.isSymbolicLink() || !destinationInfo.isFile())) throw failure('route_rollback_drift', `${entry.declaration} changed after migration.`)
  const destination = destinationInfo ? await routeFileState(destinationPath) : null
  if (destination && (destination.sha256 !== entry.afterSha256 || destination.mode !== entry.mode)) throw failure('route_rollback_drift', `${entry.declaration} changed after migration.`)
  if (!source && !destination) throw failure('route_rollback_drift', `${entry.sourceDeclaration} and ${entry.declaration} are both missing.`)
  return { entry, sourcePath, destinationPath, originalPath, source: Boolean(source), destination: Boolean(destination), directory: Boolean(directoryInfo) }
}

async function classifyRollbackEntry(input, root, entry) {
  if (!entry || typeof entry !== 'object' || !validId(entry.site) || !validId(entry.id)
    || typeof entry.declaration !== 'string' || typeof entry.original !== 'string'
    || !['original', 'after'].includes(entry.progress)
    || !Number.isInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777
    || !/^[a-f0-9]{64}$/.test(entry.beforeSha256) || !/^[a-f0-9]{64}$/.test(entry.afterSha256)) {
    throw failure('route_rollback_corrupt', 'Migration journal contains invalid Route metadata.')
  }
  const destination = resolve(input.homeRoot, entry.declaration)
  if (destination !== join(input.deskRoot, 'routes', entry.site, `${entry.id}.json`)) {
    throw failure('route_rollback_corrupt', `Invalid Route declaration ${entry.declaration}.`)
  }
  await assertSafeRouteFile(input, destination)
  const originalsRoot = join(root, 'originals')
  const originalPath = resolve(root, entry.original)
  if (originalPath !== join(originalsRoot, entry.site, `${entry.id}.json`)) throw failure('route_rollback_corrupt', `Invalid rollback source ${entry.original}.`)
  await assertSafeFileUnder(originalsRoot, originalPath, 'route_rollback_corrupt')
  const original = await readFile(originalPath)
  if (sha256(original) !== entry.beforeSha256) throw failure('route_rollback_corrupt', `${entry.original} does not match its journal digest.`)
  const current = await routeFileState(destination)
  if (current.mode !== entry.mode || ![entry.beforeSha256, entry.afterSha256].includes(current.sha256)) throw failure('route_rollback_drift', `${entry.declaration} changed after migration.`)
  return { entry, destination, originalPath }
}

async function assertSafeRouteFile(input, path) {
  return assertSafeFileUnder(join(input.deskRoot, 'routes'), path, 'route_migration_path_invalid')
}

async function assertSafeFileUnder(root, path, code) {
  if (!inside(root, path)) throw failure(code, `${path} escapes ${root}.`)
  await assertSafeDirectoryUnder(root, dirname(path), code)
  await assertRegularFile(path, code)
}

async function assertSafeDirectoryUnder(root, path, code) {
  if (path !== root && !inside(root, path)) throw failure(code, `${path} escapes ${root}.`)
  await assertDirectory(root, code)
  let current = root
  const remainder = relative(root, path)
  for (const segment of remainder ? remainder.split(/[\\/]+/) : []) {
    current = join(current, segment)
    await assertDirectory(current, code)
  }
}

async function ensureSafeDirectories(root, path) {
  if (path !== root && !inside(root, path)) throw failure('route_migration_path_invalid', `${path} escapes ${root}.`)
  await assertDirectory(root, 'route_migration_path_invalid')
  let current = root
  const remainder = relative(root, path)
  for (const segment of remainder ? remainder.split(/[\\/]+/) : []) {
    current = join(current, segment)
    let created = false
    try {
      await mkdir(current)
      created = true
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
    }
    await assertDirectory(current, 'route_migration_path_invalid')
    if (created) {
      await syncDirectory(dirname(current))
      if (process.env.NODE_ENV === 'test' && process.env.ENDROIT_TEST_FAULT_AFTER_DIRECTORY_FSYNC === relative(root, current)) {
        throw failure('route_directory_fault', `Injected failure after syncing ${relative(root, current)}.`)
      }
    }
  }
}

async function assertDirectory(path, code) {
  const info = await lstat(path)
  if (info.isSymbolicLink() || !info.isDirectory()) throw failure(code, `${path} must be a non-symlink directory.`)
}

async function assertRegularFile(path, code) {
  const info = await lstat(path)
  if (info.isSymbolicLink() || !info.isFile()) throw failure(code, `${path} must be a non-symlink regular file.`)
}

function migrationDocumentFromV7(input, route, bytes, options = {}) {
  let legacy
  try { legacy = JSON.parse(bytes) } catch { throw failure('route_migration_drift', `${relative(input.homeRoot, route.documentPath)} is no longer valid JSON.`) }
  if (!legacy || typeof legacy !== 'object' || Array.isArray(legacy)) {
    throw failure('route_migration_drift', `${relative(input.homeRoot, route.documentPath)} is no longer the planned v7 Route.`)
  }
  const keys = Object.keys(legacy)
  const allowed = ['$schema', 'id', 'site', 'mode', 'path', 'branch', 'sourceRoute']
  const valid = legacy.$schema === 'https://endroit.org/schema/v7/route.json'
    && legacy.id === route.id
    && legacy.site === route.site
    && ['embedded', 'existing', 'managed-clone', 'managed-worktree', 'submodule'].includes(legacy.mode)
    && typeof legacy.path === 'string' && legacy.path.length > 0
    && (legacy.branch === undefined || typeof legacy.branch === 'string' && legacy.branch.length > 0)
    && (legacy.sourceRoute === undefined || validId(legacy.sourceRoute))
    && !keys.some((key) => !allowed.includes(key))
  if (!valid) throw failure('route_migration_drift', `${relative(input.homeRoot, route.documentPath)} is no longer the planned v7 Route.`)
  if (legacy.mode === 'embedded' && legacy.path !== '.') throw failure('route_path_invalid', `Embedded Route ${legacy.site}/${legacy.id} must resolve from its Home context.`)
  if (legacy.mode.startsWith('managed-') && resolve(input.homeRoot, legacy.path) !== managedPath(input, legacy.site, legacy.id)) {
    throw failure('route_path_invalid', `Managed Route ${legacy.site}/${legacy.id} must use its derived checkout path.`)
  }
  if (['existing', 'submodule'].includes(legacy.mode) && !isAbsolute(legacy.path) && legacy.path.split(/[\\/]+/).includes('..')) {
    throw failure('route_path_invalid', `Route ${legacy.site}/${legacy.id} path cannot migrate outside its Home context.`)
  }
  const migrated = {
    $schema: 'https://endroit.org/schema/v8/route.json',
    id: legacy.id,
    site: legacy.site,
    status: 'active',
    checkout: {
      mode: legacy.mode,
      ...(['existing', 'submodule'].includes(legacy.mode) ? { path: legacy.path } : {}),
    },
    ...(legacy.mode === 'managed-worktree' && (legacy.branch || options.observedRevision)
      ? { revision: legacy.branch ? { kind: 'branch', name: legacy.branch } : options.observedRevision }
      : {}),
  }
  if (options.validate !== false) validateRoute(migrated, legacy.site, legacy.id, input)
  return migrated
}

function routeDocument(route, overrides = {}) {
  const status = overrides.status ?? route.status
  const supersededBy = overrides.supersededBy
  return {
    $schema: 'https://endroit.org/schema/v8/route.json',
    id: route.id,
    site: route.site,
    status,
    ...(status === 'superseded' ? { supersededBy } : {}),
    checkout: { ...route.declared.checkout },
    ...(route.declared.revision ? { revision: { ...route.declared.revision } } : {}),
  }
}

async function writeRouteLifecycle(route, overrides) {
  if (route.schemaVersion === 9) {
    await writeBytesAtomic(route.documentPath, updateRouteMarkdown(route.sourceBytes, overrides), route.fileMode)
    return
  }
  await writeJsonAtomic(route.documentPath, routeDocument(route, overrides))
}

function updateRouteMarkdown(sourceBytes, overrides) {
  const source = sourceBytes.toString('utf8')
  const match = source.match(/^(---\r?\n)([\s\S]*?)(\r?\n---(?:\r?\n|$)[\s\S]*)$/)
  if (!match) throw failure('route_invalid', 'ROUTE.md must contain a closed frontmatter block.')
  const newline = match[1].includes('\r\n') ? '\r\n' : '\n'
  const lines = match[2].split(/\r?\n/).filter((line) => !line.startsWith('superseded_by:'))
  const status = lines.findIndex((line) => line.startsWith('route_state:'))
  if (status < 0) throw failure('route_invalid', 'ROUTE.md must declare status.')
  lines[status] = `route_state: ${JSON.stringify(overrides.status)}`
  if (overrides.status === 'superseded') lines.splice(status + 1, 0, `superseded_by: ${JSON.stringify(overrides.supersededBy)}`)
  return Buffer.from(`${match[1]}${lines.join(newline)}${match[3]}`)
}

function renderRouteMarkdown(document) {
  const keys = ['$schema', 'kind', 'id', 'owner', 'site', 'route_state', 'checkout_mode', 'revision', 'superseded_by']
  const metadata = keys.filter((key) => document[key] !== undefined).map((key) => `${key}: ${JSON.stringify(document[key])}`)
  return ['---', ...metadata, '---', '', `# ${document.site} / ${document.id}`, '', `Local address: \`checkout:${document.site}/${document.id}\`.`, ''].join('\n')
}

function validateRouteV9(route, site, id) {
  if (route.$schema !== 'https://endroit.org/schema/v9/route.json' || route.kind !== 'endroit/route' || route.id !== id || route.site !== site
    || !/^desk:[a-z0-9][a-z0-9._-]{0,127}$/.test(route.owner) || !['active', 'parked', 'superseded'].includes(route.route_state)
    || !['embedded', 'existing', 'managed-clone', 'managed-worktree', 'submodule'].includes(route.checkout_mode)) {
    throw failure('route_invalid', `Invalid Route ${site}/${id}.`)
  }
  const revision = route.revision
  if (revision !== undefined && (!revision || typeof revision !== 'object' || Array.isArray(revision)
    || revision.kind === 'branch' && (typeof revision.name !== 'string' || !revision.name || Object.keys(revision).some((key) => !['kind', 'name'].includes(key)))
    || revision.kind === 'commit' && (typeof revision.sha !== 'string' || !/^[a-f0-9]{40,64}$/i.test(revision.sha) || Object.keys(revision).some((key) => !['kind', 'sha'].includes(key)))
    || !['branch', 'commit'].includes(revision.kind))) throw failure('route_invalid', `Invalid revision for Route ${site}/${id}.`)
  if (route.checkout_mode === 'managed-worktree' && !revision) throw failure('route_invalid', `Managed worktree Route ${site}/${id} requires a revision.`)
  if (route.checkout_mode === 'submodule' && revision) throw failure('route_invalid', `Submodule Route ${site}/${id} cannot declare a revision.`)
  if (route.route_state === 'superseded' ? !validId(route.superseded_by) || route.superseded_by === id : route.superseded_by !== undefined) throw failure('route_invalid', `Invalid lifecycle for Route ${site}/${id}.`)
  if (Object.keys(route).some((key) => !['$schema', 'kind', 'id', 'site', 'owner', 'route_state', 'superseded_by', 'checkout_mode', 'revision'].includes(key))) throw failure('route_invalid', `Invalid Route ${site}/${id}.`)
}

function requireLifecycleRoute(route) {
  if (![8, 9].includes(route.schemaVersion)) throw failure('route_migration_required', `Route ${route.site}/${route.id} must be migrated before changing lifecycle.`)
}

function parseCheckoutRef(value) {
  const match = String(value).match(/^(checkout|worktree):([a-z0-9][a-z0-9._-]{0,127})\/([a-z0-9][a-z0-9._-]{0,127})$/)
  if (!match) throw failure('checkout_ref_invalid', 'Use checkout:<site>/<route> or worktree:<site>/<id>.', 2)
  return { kind: match[1], site: match[2], id: match[3] }
}

function adoptTarget(value, explicitRoute) {
  if (explicitRoute) return { site: value, route: required(explicitRoute, 'Route id') }
  const match = String(value).match(/^([a-z0-9][a-z0-9._-]{0,127})\/([a-z0-9][a-z0-9._-]{0,127})$/)
  if (!match) throw failure('usage', 'Pass <site>/<route> or pass the Route id with --id.', 2)
  return { site: match[1], route: match[2] }
}

function assertDistinctGitDirs(checkouts) {
  const [duplicate] = findDuplicateGitDirs(checkouts)
  if (duplicate) throw failure('checkout_duplicate_git_dir', `${duplicate.first} and ${duplicate.second} resolve to the same Git directory.`)
}

function findDuplicateGitDirs(checkouts) {
  const seen = new Map()
  const duplicates = []
  for (const checkout of checkouts.filter((entry) => entry.declared && entry.observed.repository?.available)) {
    const gitDir = checkout.observed.repository.gitDir
    const existing = seen.get(gitDir)
    if (existing) duplicates.push({ gitDir, first: existing, second: checkout.ref })
    else seen.set(gitDir, checkout.ref)
  }
  return duplicates
}

async function assertGitDirAvailable(input, evidence) {
  for (const route of await scanRouteGraph(input)) {
    const observed = await routeRepositoryPath(input, route).then(inspectRepository).catch(() => null)
    if (observed?.gitDir === evidence.gitDir) throw failure('checkout_duplicate_git_dir', `${route.ref} already declares this Git checkout.`)
  }
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
async function writeJsonAtomic(path, document, mode) {
  mode ??= await lstat(path).then((info) => info.mode & 0o777).catch((error) => error.code === 'ENOENT' ? 0o600 : Promise.reject(error))
  await writeBytesAtomic(path, Buffer.from(`${JSON.stringify(document, null, 2)}\n`), mode)
}
async function writeBytesAtomic(path, content, mode) {
  let temporary
  let handle
  for (let attempt = 0; attempt < 10; attempt += 1) {
    temporary = `${path}.${process.pid}.${Date.now()}.${attempt}.tmp`
    try {
      handle = await open(temporary, 'wx', mode)
      break
    } catch (error) {
      if (error.code !== 'EEXIST' || attempt === 9) throw error
    }
  }
  try {
    await handle.writeFile(content)
    await handle.chmod(mode)
    await handle.sync()
    await handle.close()
    handle = undefined
    await rename(temporary, path)
    await syncDirectory(dirname(path))
  } catch (error) {
    await handle?.close().catch(() => {})
    await rm(temporary, { force: true }).catch(() => {})
    throw error
  }
}
async function syncDirectory(path) {
  const handle = await open(path, 'r')
  try { await handle.sync() } finally { await handle.close() }
}
async function routeFileState(path) {
  const [bytes, info] = await Promise.all([readFile(path), lstat(path)])
  return { sha256: sha256(bytes), mode: info.mode & 0o777 }
}
function sha256(value) { return createHash('sha256').update(value).digest('hex') }
function migrationRunId() { return `${new Date().toISOString().replace(/[-:.]/g, '').replace('Z', 'z')}-${process.pid}` }
function inside(root, candidate) { const path = relative(root, candidate); return path && !path.startsWith('..') && !isAbsolute(path) }
async function canonicalPath(path) { return realpath(path).catch(() => resolve(path)) }
async function symlinkTarget(path) {
  const target = await readlink(path)
  return isAbsolute(target) ? resolve(target) : resolve(dirname(path), target)
}
async function removeEmpty(path, stop) {
  let current = path
  while (current !== stop) { try { await rmdir(current) } catch { break }; current = dirname(current) }
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
  if (value.routes) return value.routes.length ? value.routes.map((route) => `${route.ref} · ${route.declared.status} · ${route.declared.checkout.mode}`).join('\n') : 'No Routes.'
  if (value.checkouts) return value.checkouts.length ? value.checkouts.map((checkout) => {
    const declared = checkout.declared
    const available = declared ? checkout.observed.repository.available : checkout.observed.available
    return `${checkout.ref} · ${declared?.status ?? 'observed'} · ${declared?.checkout.mode ?? checkout.observed.checkout} · ${available ? 'available' : 'missing'}`
  }).join('\n') : 'No Checkouts.'
  return Object.entries(value).map(([key, entry]) => `${key}: ${typeof entry === 'object' ? JSON.stringify(entry) : entry}`).join('\n')
}
function help(surface, command) {
  const entries = surface === 'route' ? ROUTE_HELP : surface === 'checkout' ? CHECKOUT_HELP : SITE_HELP
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
