#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { lstat, readFile, readdir, realpath } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)

const HUD_HELP = {
  show: {
    usage: 'endroit hud show [--full]',
    effect: 'read-only',
    summary: 'Render the human HUD; --full includes its complete inventory.',
  },
  prompt: {
    usage: 'endroit hud prompt',
    effect: 'read-only',
    summary: 'Render the bounded agent-facing HUD selected by the Front Door.',
  },
  json: {
    usage: 'endroit hud json',
    effect: 'read-only',
    summary: 'Render the stable machine-readable HUD.',
  },
  activity: {
    usage: 'endroit hud activity [--since <duration|date>] [--scope <ref>] [--json]',
    effect: 'read-only',
    summary: 'Show recent sourced observations without persisting an event log.',
  },
}

try {
  const input = JSON.parse(await stdin())
  const [command, ...args] = input.argv
  if (command === '--help' && args.length === 0) {
    process.stdout.write(`${helpFor()}\n`)
  } else if (args.length === 1 && args[0] === '--help') {
    process.stdout.write(`${helpFor(command)}\n`)
  } else if (command === 'activity') {
    const options = activityOptions(args)
    const model = await activity(input, options)
    process.stdout.write(options.json ? `${JSON.stringify(model, null, 2)}\n` : `${activityHuman(model)}\n`)
  } else {
    const model = await hud(input)
    if (command === 'json' && args.length === 0) process.stdout.write(`${JSON.stringify(model, null, 2)}\n`)
    else if (command === 'prompt' && args.length === 0) {
      const prompt = await xml(model, input)
      const budget = input.resolvedHome.home.settings?.['endroit/hud']?.promptBytes
      if (budget !== undefined && Buffer.byteLength(prompt) > budget) {
        throw failure('hud_budget_exceeded', `HUD prompt is ${Buffer.byteLength(prompt)} bytes, over the ${budget} byte budget.`)
      }
      process.stdout.write(`${prompt}\n`)
    } else if (command === 'show' && args.every((value) => value === '--full')) {
      process.stdout.write(`${human(model, args.includes('--full'))}\n`)
    } else throw failure('usage', 'Use hud show [--full], hud prompt, hud json or hud activity.', 2)
  }
} catch (error) {
  process.stderr.write(`${error.code ?? 'hud_failed'}: ${error.message}\n`)
  process.exitCode = error.exitCode ?? 4
}

function helpFor(command) {
  if (!command) {
    return [
      'Usage: endroit hud <command> [options]',
      '',
      'Commands:',
      ...Object.entries(HUD_HELP).map(([name, entry]) => `  ${name.padEnd(8)} ${entry.summary}`),
      '',
      'Run endroit hud <command> --help for command details.',
    ].join('\n')
  }
  const entry = HUD_HELP[command]
  if (!entry) throw failure('usage', `Unknown hud command ${command}.`, 2)
  return [`Usage: ${entry.usage}`, `Effect: ${entry.effect}`, '', entry.summary].join('\n')
}

function activityOptions(args) {
  const options = { since: '1d', scope: null, json: false }
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]
    if (value === '--json') options.json = true
    else if (value === '--since' && args[index + 1]) options.since = args[++index]
    else if (value === '--scope' && args[index + 1]) options.scope = args[++index]
    else throw failure('usage', 'Use hud activity [--since <duration|date>] [--scope <ref>] [--json].', 2)
  }
  return options
}

async function activity(input, options) {
  const generatedAt = new Date().toISOString()
  const since = activitySince(options.since, generatedAt)
  const model = await hud(input)
  const scope = resolveActivityScope(options.scope, model)
  const events = []

  if (!scope || scope.kind === 'home') {
    events.push(...await gitActivity(input.homeRoot, since, 'home'))
    if (!model.home.git.clean) events.push(currentGitActivity('home', model.home.git, generatedAt))
  }
  if ((!scope || scope.kind === 'desk') && input.deskRoot) {
    if (scope) {
      const root = model.desk.git?.root ?? input.deskRoot
      const pathspec = root === model.home.git?.root ? relative(root, input.deskRoot) : null
      events.push(...await gitActivity(root, since, 'desk', pathspec))
    }
    if (scope && !model.desk.git.clean) events.push(currentGitActivity('desk', model.desk.git, generatedAt))
  }

  const rooms = scope?.kind === 'room'
    ? model.items.rooms.filter((entry) => entry.id === scope.id)
    : scope ? [] : model.items.rooms
  for (const room of rooms) {
    events.push(...await fileActivity(dirname(join(input.homeRoot, room.path)), since, room.ref, input.homeRoot))
  }

  const meetings = scope?.kind === 'meeting'
    ? model.items.meetings.filter((entry) => entry.id === scope.id)
    : []
  for (const meeting of meetings) {
    events.push(...await fileActivity(dirname(join(input.homeRoot, meeting.path)), since, meeting.ref, input.homeRoot))
  }

  const sites = scope?.kind === 'site'
    ? model.sites.filter((entry) => entry.id === scope.id)
    : scope ? [] : model.sites
  for (const site of sites) {
    for (const route of site.routes) {
      const subject = `site:${site.id}/${route.id}`
      if (route.root) events.push(...await gitActivity(route.root, since, subject))
      if (route.git?.available && !route.git.clean) events.push(currentGitActivity(subject, route.git, generatedAt))
    }
    if (site.map.state !== 'current') {
      events.push({
        occurredAt: generatedAt,
        subject: `site:${site.id}`,
        verb: 'observed',
        summary: `Site Map is ${site.map.state}.`,
        confidence: 'observed',
        source: { kind: 'hud', ref: site.map.path },
      })
    }
  }

  const artifacts = model.artifacts.items.filter((artifact) => {
    if (!scope) return true
    if (scope.kind === 'artifact') return artifact.id === scope.id
    if (scope.kind === 'desk' || scope.kind === 'home') return artifact.scope === scope.kind
    if (scope.kind === 'site') return artifact.sites?.includes(scope.id)
    return false
  })
  for (const artifact of artifacts) {
    const timestamp = Date.parse(artifact.createdAt)
    if (Number.isNaN(timestamp)) continue
    const occurredAt = new Date(timestamp).toISOString()
    if (occurredAt < since) continue
    events.push({
      occurredAt,
      subject: `artifact:${artifact.id}`,
      verb: 'created',
      summary: `${artifact.kind} entered ${artifact.state ?? 'unknown'} state in ${artifact.scope}.`,
      confidence: 'authoritative',
      source: { kind: 'artifact-metadata', ref: relative(input.homeRoot, artifact.path) },
    })
  }

  const ordered = events
    .filter((entry) => entry.occurredAt >= since)
    .sort((left, right) => right.occurredAt.localeCompare(left.occurredAt) || left.subject.localeCompare(right.subject))
  return {
    apiVersion: 'endroit.org/hud/activity/v1alpha1',
    generatedAt,
    since,
    scope: options.scope,
    truncated: ordered.length > 100,
    events: ordered.slice(0, 100),
  }
}

function activitySince(value, now) {
  const duration = String(value).match(/^(\d+)(m|h|d|w)$/)
  if (duration) {
    const units = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }
    const timestamp = Date.parse(now) - Number(duration[1]) * units[duration[2]]
    if (Number.isFinite(timestamp)) return new Date(timestamp).toISOString()
  }
  const timestamp = Date.parse(value)
  if (!Number.isNaN(timestamp)) return new Date(timestamp).toISOString()
  throw failure('activity_since_invalid', `Invalid Activity duration or date: ${value}.`)
}

function resolveActivityScope(value, model) {
  if (!value) return null
  if (value === 'home' || value === 'desk') return { kind: value }
  const [kind, id] = value.split(/:(.+)/)
  const known = {
    room: model.items.rooms,
    meeting: model.items.meetings,
    site: model.items.sites,
    artifact: model.artifacts.items,
  }
  const selected = known[kind]?.find((entry) => entry.id === id || entry.ref === value)
  if (!selected) {
    throw failure('activity_scope_unknown', `Unknown Activity scope: ${value}.`)
  }
  return { kind, id: selected.id }
}

async function gitActivity(root, since, subject, pathspec = null) {
  try {
    const args = ['log', `--since=${since}`, '--format=%H%x00%cI%x00%s']
    if (pathspec && pathspec !== '.') args.push('--', pathspec)
    const { stdout } = await exec('git', args, { cwd: root, maxBuffer: 8 * 1024 * 1024 })
    return stdout.trim().split('\n').filter(Boolean).map((line) => {
      const [commit, occurredAt, summary] = line.split('\0')
      return {
        occurredAt,
        subject,
        verb: 'committed',
        summary,
        confidence: 'observed',
        source: { kind: 'git', ref: commit },
      }
    })
  } catch {
    return []
  }
}

function currentGitActivity(subject, git, observedAt) {
  return {
    occurredAt: observedAt,
    subject,
    verb: 'observed',
    summary: `${git.changes} uncommitted change(s), ${git.conflicts} conflict(s).`,
    confidence: 'observed',
    source: { kind: 'git-status', ref: git.root },
  }
}

async function fileActivity(root, since, subject, homeRoot) {
  const events = []
  async function visit(directory) {
    for (const entry of await safeReadDir(directory)) {
      const path = join(directory, entry.name)
      const info = await lstat(path)
      if (info.isSymbolicLink()) continue
      if (info.isDirectory()) await visit(path)
      else if (info.isFile() && info.mtime.toISOString() >= since) {
        events.push({
          occurredAt: info.mtime.toISOString(),
          subject,
          verb: 'modified',
          summary: `Updated ${relative(root, path)}.`,
          confidence: 'observed',
          source: { kind: 'filesystem', ref: relative(homeRoot, path) },
        })
      }
    }
  }
  await visit(root)
  return events
}

function activityHuman(model) {
  const lines = [
    `ACTIVITY    since ${model.since} · scope:${model.scope ?? 'all'} · ${model.events.length}${model.truncated ? '+' : ''} event(s)`,
  ]
  for (const event of model.events) {
    lines.push(`  ${event.occurredAt} · ${event.confidence} · ${event.verb} · ${event.subject} · ${event.summary}`)
  }
  return lines.join('\n')
}

async function hud(input) {
  const { resolvedHome: plan, homeRoot, deskRoot } = input
  const preferences = plan.desk?.settings?.['endroit/onboarding'] ?? {}
  const [homeGit, deskGit, artifacts, recentDesk, projections, orientation] = await Promise.all([
    gitProbe(homeRoot),
    deskRoot ? gitProbe(deskRoot) : null,
    scanArtifacts(homeRoot, deskRoot, plan),
    deskRoot ? recentFiles(deskRoot) : [],
    projectionProbe(homeRoot, plan.home.providers),
    scanOrientation(homeRoot, plan),
  ])
  const sites = await scanSites(plan.sites ?? [], homeRoot, deskRoot, artifacts)
  const items = {
    rooms: orientation.rooms,
    meetings: orientation.meetings,
    sites: sites.map(siteItem),
    capabilities: capabilityItems(plan),
  }
  const trust = {
    runtimes: (input.runtimeTrust ?? []).sort((left, right) => left.owner.localeCompare(right.owner)),
  }
  trust.bundled = trust.runtimes.filter((entry) => entry.trust === 'bundled').length
  trust.approved = trust.runtimes.filter((entry) => entry.trust === 'approved').length
  trust.pending = trust.runtimes.filter((entry) => entry.trust === 'pending').length

  const attention = []
  if (!deskRoot) {
    attention.push(item('advisory', 'desk', 'desk-missing', 'No Desk is configured; continue without one or initialize or clone one when local continuity is needed.'))
  }
  if (!homeGit.available) attention.push(item('warning', 'home', 'home-git-unavailable', homeGit.error))
  else if (!homeGit.clean) attention.push(item('advisory', 'home', 'home-dirty', `Home has ${homeGit.changes} change(s).`))
  if (deskGit?.available && !deskGit.clean) attention.push(item('advisory', 'desk', 'desk-dirty', `Desk has ${deskGit.changes} change(s).`))
  for (const projection of projections) {
    if (projection.status !== 'fresh') attention.push(item('warning', `provider:${projection.id}`, 'projection-stale', `${projection.id} projections are ${projection.status}.`))
  }
  for (const site of sites) {
    const metadataError = orientationError(site, false)
    if (metadataError) attention.push(item('warning', `site:${site.id}`, 'orientation-invalid', metadataError))
    if (!(site.when?.length)) attention.push(item('advisory', `site:${site.id}`, 'site-routing-hint-missing', `${site.id} has no routing hint.`))
    if (!site.routes.length) attention.push(item('warning', `site:${site.id}`, 'site-unrouted', `${site.id} has no local Route.`))
    if (site.map.state === 'stale') attention.push(item('advisory', `site:${site.id}`, 'site-map-stale', `${site.id} Site Map is stale.`))
    const unroutedWorktrees = site.worktrees.filter((worktree) => !worktree.route)
    if (unroutedWorktrees.length) {
      attention.push(item('advisory', `site:${site.id}`, 'site-worktrees-unrouted', `${site.id} has ${unroutedWorktrees.length} Git worktree(s) without a local Route; inspect site list or site doctor.`))
    }
    for (const route of site.routes) {
      if (!route.git?.available) attention.push(item('blocking', `site:${site.id}/${route.id}`, 'site-broken', 'Route is not a usable Git checkout.'))
      else if (route.git.conflicts) attention.push(item('blocking', `site:${site.id}/${route.id}`, 'site-conflicts', `Route has ${route.git.conflicts} conflict(s).`))
      else if (!route.git.clean) attention.push(item('advisory', `site:${site.id}/${route.id}`, 'site-dirty', `Route has ${route.git.changes} change(s).`))
    }
  }
  for (const runtime of trust.runtimes.filter((entry) => entry.trust === 'pending')) {
    attention.push(item('blocking', `runtime:${runtime.owner}`, 'runtime-pending', `${runtime.owner} requires approval before execution.`))
  }
  for (const entry of [...items.rooms, ...items.meetings]) {
    if (entry.metadataError) attention.push(item('warning', `${entry.kind}:${entry.id}`, 'orientation-invalid', entry.metadataError))
  }

  const groupedAttention = {
    blocking: attention.filter((entry) => entry.severity === 'blocking').map(withoutSeverity),
    warning: attention.filter((entry) => entry.severity === 'warning').map(withoutSeverity),
    advisory: attention.filter((entry) => entry.severity === 'advisory').map(withoutSeverity),
  }
  const severity = groupedAttention.blocking.length
    ? 'blocked'
    : groupedAttention.warning.length ? 'attention' : 'ready'
  return {
    apiVersion: 'endroit.org/hud/v2alpha1',
    generatedAt: new Date().toISOString(),
    status: severity,
    event: input.invocation?.kind ?? 'command',
    home: {
      name: plan.home.name,
      emoji: plan.home.emoji ?? null,
      root: homeRoot,
      providers: plan.home.providers,
      git: homeGit,
    },
    kernel: input.kernel,
    members: plan.members,
    collaborator: plan.desk ? { id: plan.desk.member, ...preferences } : null,
    desk: plan.desk ? { configured: true, id: plan.desk.id, member: plan.desk.member, repository: plan.desk.repository, root: deskRoot, preferences, git: deskGit } : { configured: false },
    projections,
    surfaces: {
      equipment: plan.equipment.map((equipment) => ({
        id: equipment.id,
        version: equipment.version,
        description: equipment.description,
        roomNamespace: equipment.roomNamespace,
        scope: equipment.scope,
        overridden: equipment.overridden,
        runtime: equipment.runtime,
      })),
      catalog: plan.catalog,
      skills: plan.skills.map((entry) => surface(entry)),
      commands: plan.commands.map((entry) => surface(entry)),
      runtimes: plan.runtimes.map((entry) => ({
        owner: entry.owner,
        namespace: entry.namespace,
        scope: entry.scope,
        commands: entry.commands,
      })),
      artifactKinds: plan.artifactKinds.map((entry) => ({ id: entry.id, owner: entry.owner, scope: entry.scope })),
    },
    context: {
      ...plan.context,
      promptBudgetBytes: plan.home.settings?.['endroit/hud']?.promptBytes ?? null,
    },
    sites,
    items,
    artifacts,
    recentDesk,
    trust,
    attention: groupedAttention,
  }
}

async function scanOrientation(homeRoot, plan) {
  const rooms = []
  const meetings = []
  for (const entry of plan.rooms) {
    const path = join(homeRoot, entry.path)
    const document = await orientationDocument(path)
    const state = document.metadata.status || 'active'
    rooms.push({
      kind: 'room',
      id: entry.id,
      scope: entry.scope,
      state,
      ...document.metadata,
      ref: entry.ref,
      path: entry.path,
      access: ['model', 'user'],
      routable: state === 'active' && !document.error,
      ...(document.error ? { metadataError: document.error } : {}),
    })
  }
  for (const entry of plan.meetings) {
    const path = join(homeRoot, entry.path)
    const document = await orientationDocument(path)
    const content = await readFile(path, 'utf8').catch(() => '')
    const state = document.metadata.status || (/^## Status\s*\n+\s*`active`/m.test(content) ? 'active' : 'local')
    meetings.push({
      kind: 'meeting',
      id: entry.id,
      scope: entry.scope,
      room: entry.room,
      state,
      ...document.metadata,
      ref: entry.ref,
      path: entry.path,
      access: ['model', 'user'],
      routable: rooms.some((room) => room.id === entry.room && room.routable) && state === 'active' && !document.error,
      ...(document.error ? { metadataError: document.error } : {}),
    })
  }
  return { rooms, meetings }
}

async function orientationDocument(path) {
  try {
    const metadata = frontmatter(await readFile(path, 'utf8'))
    const error = orientationError(metadata)
    return { metadata, ...(error ? { error } : {}) }
  } catch (error) {
    return { metadata: { summary: null, when: [], tags: [] }, error: error.message }
  }
}

function orientationError(value, required = true) {
  if (value.emoji != null && (typeof value.emoji !== 'string' || !value.emoji.trim() || [...value.emoji].length > 16)) {
    return 'emoji must contain 1 to 16 characters.'
  }
  if ((required || (value.summary != null && value.summary !== '')) && (typeof value.summary !== 'string' || !value.summary.trim())) return 'summary must be a non-empty string.'
  if ((required && (!Array.isArray(value.when) || value.when.length < 1 || value.when.length > 3 || value.when.some((entry) => typeof entry !== 'string' || !entry.trim())))
    || (!required && value.when != null && (!Array.isArray(value.when) || value.when.length > 3 || value.when.some((entry) => typeof entry !== 'string' || !entry.trim())))) {
    return 'when must contain one to three non-empty situations.'
  }
  if ((required && (!Array.isArray(value.tags) || !value.tags.length || value.tags.some((entry) => typeof entry !== 'string' || !/^[a-z0-9][a-z0-9._-]*$/.test(entry))))
    || (!required && value.tags != null && (!Array.isArray(value.tags) || value.tags.some((entry) => typeof entry !== 'string' || !/^[a-z0-9][a-z0-9._-]*$/.test(entry))))) {
    return 'tags must contain stable identifiers.'
  }
  return null
}

function capabilityItems(plan) {
  return plan.capabilities.flatMap((capability) => {
    const skills = plan.skills.filter((entry) => entry.capability === capability.id)
    const commands = plan.commands.filter((entry) => entry.capability === capability.id)
    if (!skills.length && !commands.length) return []
    return [...new Set([...skills, ...commands].map((entry) => entry.projectedId))].map((projectedId) => {
      const skill = skills.find((entry) => entry.projectedId === projectedId)
      const command = commands.find((entry) => entry.projectedId === projectedId)
      const access = [...(skill ? ['model'] : []), ...(command ? ['user'] : [])]
      return {
        kind: 'capability',
        id: projectedId,
        state: 'available',
        summary: capability.description,
        when: [...new Set(skills.map((entry) => entry.description))].slice(0, 3),
        tags: [...new Set([...capability.owner.split('/'), capability.localId])],
        ref: `capability:${capability.id}`,
        path: capability.path,
        access,
        routable: access.length > 0,
        entrypoint: {
          ...(skill ? { model: skill.projectedId } : {}),
          ...(command ? { user: command.projectedId } : {}),
        },
      }
    })
  })
}

function siteItem(site) {
  const metadataError = orientationError(site, false)
  return {
    kind: 'site',
    id: site.id,
    emoji: site.emoji ?? null,
    state: site.state,
    summary: site.summary ?? null,
    when: site.when ?? [],
    tags: site.tags ?? [],
    ref: `site:${site.id}`,
    access: ['model', 'user'],
    routable: !metadataError && site.routes.some((route) => route.git?.available),
    entrypoint: { model: 'endroit-site-map', user: 'endroit-site-map' },
    routes: site.routes.map((route) => ({
      id: route.id,
      state: route.git?.available ? route.git.clean ? 'clean' : 'dirty' : 'broken',
      root: route.root,
      head: route.git?.head ?? null,
    })),
    worktrees: site.worktrees.map((worktree) => ({
      path: worktree.path,
      head: worktree.head ?? null,
      branch: worktree.branch ?? null,
      route: worktree.route,
      locked: Boolean(worktree.locked),
      prunable: Boolean(worktree.prunable),
    })),
    map: site.map,
    ...(metadataError ? { metadataError } : {}),
  }
}

function surface(entry) {
  return {
    id: entry.id,
    projectedId: entry.projectedId,
    owner: entry.owner,
    scope: entry.scope,
    invocation: entry.invocation,
    description: entry.description,
  }
}

async function scanSites(sites, homeRoot, deskRoot, artifacts) {
  return Promise.all(sites.map(async (site) => {
    const routes = []
    const siteRoot = deskRoot && join(deskRoot, 'routes', site.id)
    if (siteRoot) {
      for (const entry of await safeReadDir(siteRoot)) {
        if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith('.json')) continue
        const route = JSON.parse(await readFile(join(siteRoot, entry.name), 'utf8'))
        if (route.$schema !== 'https://endroit.org/schema/v7/route.json' || route.site !== site.id) continue
        const resolved = await realpath(resolve(homeRoot, route.path)).catch(() => null)
        routes.push({
          id: route.id,
          type: route.mode,
          declaration: relative(deskRoot, join(siteRoot, entry.name)),
          root: resolved,
          git: resolved ? await gitProbe(resolved) : { available: false, error: 'Broken Route.' },
        })
      }
    }
    const maps = artifacts.items
      .filter((artifact) => artifact.kind === 'endroit/sites:site-map' && artifact.sites?.includes(site.id))
      .sort((left, right) => String(right.createdAt ?? '').localeCompare(String(left.createdAt ?? '')))
    const heads = new Set(routes.map((route) => route.git?.head).filter(Boolean))
    const registered = new Map(routes.filter((route) => route.root).map((route) => [route.root, route.id]))
    const worktrees = new Map()
    for (const route of routes) {
      for (const worktree of route.git?.worktrees ?? []) worktrees.set(worktree.path, {
        ...worktree,
        route: registered.get(worktree.path) ?? null,
      })
    }
    const current = maps.find((artifact) => {
      const sources = Array.isArray(artifact.derivedFrom) ? artifact.derivedFrom : [artifact.derivedFrom]
      return sources.some((source) => heads.has(String(source ?? '').replace(`site:${site.id}@`, '')))
    })
    const selected = current ?? maps[0] ?? null
    return {
      ...site,
      state: routes.length ? 'routed' : 'declared',
      routes,
      worktrees: [...worktrees.values()].sort((left, right) => left.path.localeCompare(right.path)),
      map: {
        count: maps.length,
        state: current ? 'current' : maps.length ? 'stale' : 'missing',
        path: selected?.path ?? null,
        derivedFrom: selected?.derivedFrom ?? null,
        generatedAt: selected?.createdAt ?? null,
        route: `site map ${site.id}${routes.length === 1 ? ` --route ${routes[0].id}` : ''}`,
      },
    }
  }))
}

async function scanArtifacts(homeRoot, deskRoot, plan) {
  const items = []
  const roots = [
    ...plan.rooms.map((room) => [room.scope, dirname(join(homeRoot, room.path)), room.id, false]),
    ['home', join(homeRoot, 'artifacts'), null, true],
    ['desk', deskRoot && join(deskRoot, 'artifacts'), null, true],
  ]
  for (const [scope, root, room, legacy] of roots) {
    if (!root) continue
    for (const path of await findNamed(root, 'artifact.md')) {
      const directory = dirname(path)
      try {
        const metadata = frontmatter(await readFile(path, 'utf8'))
        items.push({
          ...metadata,
          status: metadata.status ?? metadata.state,
          state: metadata.status ?? metadata.state,
          createdAt: metadata.created_at ?? metadata.createdAt,
          derivedFrom: metadata.derived_from ?? metadata.derivedFrom,
          scope,
          room,
          legacy,
          path: directory,
        })
      } catch (error) {
        items.push({ scope, room, legacy, path: directory, invalid: error.message })
      }
    }
  }
  const counts = {}
  for (const entry of items) counts[entry.state ?? 'invalid'] = (counts[entry.state ?? 'invalid'] ?? 0) + 1
  return {
    count: items.length,
    counts,
    items: items.sort((left, right) => `${left.kind}:${left.id}:${left.scope}`.localeCompare(`${right.kind}:${right.id}:${right.scope}`)),
  }
}

async function recentFiles(root) {
  const values = []
  async function visit(directory) {
    for (const entry of await safeReadDir(directory)) {
      if (['.git', 'sites'].includes(entry.name)) continue
      const path = join(directory, entry.name)
      const info = await lstat(path)
      if (info.isSymbolicLink()) continue
      if (info.isDirectory()) await visit(path)
      else if (info.isFile()) values.push({ path: relative(root, path), modifiedAt: info.mtime.toISOString(), time: info.mtimeMs })
    }
  }
  await visit(root)
  return values
    .sort((left, right) => right.time - left.time || left.path.localeCompare(right.path))
    .slice(0, 5)
    .map(({ time: _time, ...entry }) => entry)
}

async function gitProbe(root) {
  try {
    const run = (args, cwd = root) => exec('git', args, { cwd, maxBuffer: 8 * 1024 * 1024 }).then((value) => value.stdout)
    const [top, head, branch, status, committedAt, worktreeOutput] = await Promise.all([
      run(['rev-parse', '--show-toplevel']).then((value) => value.trim()),
      run(['rev-parse', 'HEAD']).then((value) => value.trim()).catch(() => null),
      run(['symbolic-ref', '--quiet', '--short', 'HEAD']).then((value) => value.trim()).catch(() => null),
      run(['status', '--porcelain=v2', '--branch', '--untracked-files=all']),
      run(['log', '-1', '--format=%cI']).then((value) => value.trim()).catch(() => null),
      run(['worktree', 'list', '--porcelain', '-z']),
    ])
    const state = parseStatus(status)
    const worktrees = []
    for (const parsed of parseWorktrees(worktreeOutput)) {
      const path = await realpath(parsed.path).catch(() => resolve(parsed.path))
      const worktreeStatus = await run(['status', '--porcelain=v2', '--branch', '--untracked-files=all'], path).catch(() => '')
      worktrees.push({ ...parsed, path, ...parseStatus(worktreeStatus), current: path === top })
    }
    return {
      available: true,
      root: top,
      head,
      branch,
      ...state,
      committedAt,
      operation: await gitOperation(top),
      worktrees,
    }
  } catch (error) {
    return { available: false, error: error.stderr?.trim() || error.message }
  }
}

function parseStatus(status) {
  const changes = status.split('\n').filter((line) => /^(1 |2 |u |\? )/.test(line))
  const divergence = status.match(/^# branch\.ab \+(\d+) -(\d+)$/m)
  return {
    clean: changes.length === 0,
    changes: changes.length,
    conflicts: changes.filter((line) => line.startsWith('u ')).length,
    ahead: divergence ? Number(divergence[1]) : 0,
    behind: divergence ? Number(divergence[2]) : 0,
  }
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
  }
  if (current) entries.push(current)
  return entries
}

async function gitOperation(root) {
  const checks = [
    ['merge', 'MERGE_HEAD'],
    ['cherry-pick', 'CHERRY_PICK_HEAD'],
    ['revert', 'REVERT_HEAD'],
    ['rebase', 'rebase-merge'],
    ['rebase', 'rebase-apply'],
  ]
  for (const [name, marker] of checks) {
    const path = await exec('git', ['rev-parse', '--git-path', marker], { cwd: root }).then((value) => value.stdout.trim())
    try {
      await lstat(path.startsWith('/') ? path : join(root, path))
      return name
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  return null
}

async function projectionProbe(homeRoot, providers) {
  const state = await readJson(join(homeRoot, '.endroit', 'build.json'), null)
  const definitions = {
    codex: { instruction: 'AGENTS.md', hook: '.codex/hooks/endroit-session-start.mjs' },
    claude: { instruction: 'CLAUDE.md', hook: '.claude/hooks/endroit-session-start.mjs' },
  }
  const values = []
  for (const id of providers) {
    const definition = definitions[id]
    const expected = [definition.instruction, definition.hook]
    const owned = [...(state?.outputs ?? []), ...(state?.managed ?? [])].filter((entry) => expected.includes(entry.path))
    let status = state ? 'fresh' : 'tracked-unverified'
    for (const path of expected) {
      const content = await readFile(join(homeRoot, path)).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error))
      if (!content) status = 'missing'
      const record = owned.find((entry) => entry.path === path)
      if (content && record?.digest && digest(content) !== record.digest) status = 'stale'
    }
    values.push({ id, status, ...definition })
  }
  return values
}

function human(model, full) {
  const homeGit = gitSummary(model.home.git)
  const deskGit = model.desk.configured ? gitSummary(model.desk.git) : 'missing'
  const lines = [
    `ENDROIT    ${model.home.name} · ${model.home.providers.join('+')} · ${model.kernel.runtime} · ${model.kernel.source} · ${model.status}`,
    `ROOT        ${model.home.root}`,
    `KERNEL      ${model.kernel.invoke}`,
    `HOME GIT    ${homeGit}`,
    `DESK        ${model.desk.configured ? `${model.desk.id} · member:${model.desk.member} · ${model.desk.repository} · ${model.desk.root} · ${deskGit}` : 'missing'} · recent:${model.recentDesk.length}`,
    `ITEMS       ${model.items.rooms.length} rooms · ${model.items.meetings.length} meetings · ${model.items.sites.length} sites · ${model.items.capabilities.length} capabilities`,
    `SURFACES    ${model.surfaces.equipment.length} equipment · ${model.surfaces.catalog.filter((entry) => !entry.installed.length).length} native available · ${model.surfaces.runtimes.map((entry) => entry.namespace).join(',')}`,
    `ARTIFACTS   ${model.artifacts.count} · ${Object.entries(model.artifacts.counts).map(([key, value]) => `${key}:${value}`).join(' ') || 'none'}`,
    `SITES       ${model.sites.length} declared · ${model.sites.reduce((sum, site) => sum + site.routes.length, 0)} routes`,
  ]
  for (const site of model.sites) {
    const routes = site.routes.map((route) => `${route.id}:${route.git?.clean ? 'clean' : route.git?.available ? 'dirty' : 'broken'}@${route.root ?? 'missing'}`).join(' · ') || 'unbound'
    lines.push(`  ${site.id.padEnd(18)} ${routes} · map:${site.map.state}${site.map.path ? `@${site.map.path}` : ''}`)
  }
  lines.push(`CONTEXT     instructions:${model.context.instructionBytes}B · desk:${model.context.deskInstructionBytes}B · model:${model.context.modelDescriptionBytes}B`)
  if (model.recentDesk.length) lines.push('RECENT DESK', ...model.recentDesk.map((entry) => `  ${entry.modifiedAt}  ${entry.path}`))
  const attention = Object.entries(model.attention).flatMap(([severity, entries]) => entries.map((entry) => ({ severity, ...entry })))
  if (attention.length) lines.push('ATTENTION', ...attention.map((entry) => `  ${entry.severity} · ${entry.code} · ${entry.message}`))
  if (full) {
    lines.push('ROUTABLE ITEMS', ...Object.values(model.items).flat().map((entry) => `  ${entry.kind}:${entry.id} · ${entry.state} · ${entry.access.join(',')} · routable:${entry.routable} · ${entry.ref}`))
    lines.push('PROJECTIONS', ...model.projections.map((entry) => `  ${entry.id} · ${entry.status} · ${entry.instruction} · ${entry.hook}`))
    lines.push('EQUIPMENT', ...model.surfaces.equipment.map((equipment) => `  ${equipment.id}@${equipment.version} · ${equipment.scope}${equipment.overridden ? ' · override' : ''}${equipment.runtime ? ` · ${equipment.runtime.namespace}` : ''}`))
    lines.push('NATIVE EQUIPMENT', ...model.surfaces.catalog.map((equipment) => `  ${equipment.id}@${equipment.version} · ${equipment.installed.length ? `installed:${equipment.installed.join(',')}` : 'available'}`))
    lines.push('SKILLS', ...model.surfaces.skills.map((entry) => `  ${entry.projectedId} · ${entry.owner}`))
    lines.push('COMMANDS', ...model.surfaces.commands.map((entry) => `  ${entry.projectedId} · ${entry.owner}`))
    lines.push('RUNTIMES', ...model.surfaces.runtimes.map((entry) => `  ${entry.namespace} · ${entry.owner} · ${entry.commands.map((command) => command.name).join(',')}`))
    lines.push('ARTIFACT INVENTORY', ...model.artifacts.items.map((artifact) => `  ${artifact.kind ?? 'invalid'}:${artifact.id ?? 'unknown'} · ${artifact.scope} · ${artifact.state ?? 'invalid'} · ${artifact.path}`))
  }
  return lines.join('\n')
}

function gitSummary(git) {
  if (!git?.available) return 'unavailable'
  if (!git.head) return `${git.branch ?? 'unborn'} · unborn · ${git.clean ? 'clean' : `${git.changes} changes`} · ${git.worktrees.length} worktrees`
  return `${git.branch ?? 'detached'} · ${git.clean ? 'clean' : `${git.changes} changes`} · ${short(git.head)} · ${git.worktrees.length} worktrees · ${date(git.committedAt)}`
}

async function xml(model, input) {
  const deskInstructions = await resolvedDeskInstructions(input.resolvedHome)
  const lines = [
    `<endroit-hud version="2" status="${model.status}" generated-at="${model.generatedAt}" event="${escape(model.event)}">`,
    `  <home name="${escape(model.home.name)}"${model.home.emoji ? ` emoji="${escape(model.home.emoji)}"` : ''} root="${escape(model.home.root)}" providers="${model.home.providers.join(',')}" members="${escape(model.members.map((member) => member.id).join(','))}"/>`,
    `  <kernel runtime="${escape(model.kernel.runtime)}" source="${model.kernel.source}" invoke="${escape(model.kernel.invoke)}"/>`,
  ]
  if (model.collaborator) {
    lines.push(`  <collaborator id="${escape(model.collaborator.id)}"${model.collaborator.addressAs ? ` address-as="${escape(model.collaborator.addressAs)}"` : ''}${model.collaborator.responseLanguage ? ` response-language="${escape(model.collaborator.responseLanguage)}"` : ''}/>`)
  }
  lines.push(`  <desk configured="${model.desk.configured}"${model.desk.configured ? ` id="${escape(model.desk.id)}" member="${escape(model.desk.member)}" repository="${model.desk.repository}" root="${escape(model.desk.root)}"` : ''}/>`)
  lines.push(`  ${gitXml('home-git', model.home.git)}`)
  if (model.desk.configured) lines.push(model.desk.git?.root === model.home.git?.root ? '  <desk-git same-as="home-git"/>' : `  ${gitXml('desk-git', model.desk.git)}`)
  lines.push('  <routing priority="explicit-human,unique-semantic-match,ask-if-ambiguous">The Wake-up does not know the user message. Use these items to infer later; do not resolve a route now.</routing>')
  lines.push(`  <providers states="${escape(model.projections.map((entry) => `${entry.id}:${entry.status}`).join(','))}"/>`, '  <items>')
  for (const group of ['rooms', 'meetings', 'sites', 'capabilities']) {
    lines.push(`    <${group}>`)
    const entries = group === 'capabilities' ? promptCapabilityItems(input.resolvedHome) : model.items[group]
    for (const entry of entries) lines.push(`      <item ${group === 'capabilities' ? promptCapabilityAttributes(entry) : itemAttributes(entry)}/>`)
    lines.push(`    </${group}>`)
  }
  lines.push('  </items>', `  <runtimes namespaces="${escape(model.surfaces.runtimes.map((entry) => entry.namespace).join(','))}"/>`)
  lines.push(`  <context instructions-bytes="${model.context.instructionBytes}" desk-instructions-bytes="${model.context.deskInstructionBytes}" model-descriptions-bytes="${model.context.modelDescriptionBytes}"${model.context.promptBudgetBytes === null ? '' : ` hud-budget-bytes="${model.context.promptBudgetBytes}"`}/>`)
  lines.push(`  <trust bundled="${model.trust.bundled}" approved="${model.trust.approved}" pending="${model.trust.pending}"/>`, '  <desk-instructions>')
  for (const instruction of deskInstructions) {
    lines.push(`    <instruction owner="${escape(instruction.owner)}" id="${escape(instruction.id)}" source="${escape(instruction.source)}">${escape(instruction.content)}</instruction>`)
  }
  lines.push('  </desk-instructions>', '  <attention>')
  for (const [severity, entries] of Object.entries(model.attention)) {
    lines.push(`    <${severity}>`)
    for (const entry of entries) {
      lines.push(`      <item subject="${escape(entry.subject)}" code="${escape(entry.code)}">${escape(entry.message)}</item>`)
    }
    lines.push(`    </${severity}>`)
  }
  lines.push('  </attention>', '</endroit-hud>')
  return lines.join('\n')
}

function itemAttributes(entry) {
  const capability = entry.kind === 'capability'
  return [
    `id="${escape(entry.id)}"`,
    ...(entry.emoji ? [`emoji="${escape(entry.emoji)}"`] : []),
    ...(capability ? [] : [`state="${entry.state}"`]),
    ...(entry.routable ? [] : ['routable="false"']),
    ...(capability ? [] : [`access="${entry.access.join(',')}"`]),
    `summary="${escape(entry.summary ?? '')}"`,
    ...(capability ? [] : [`tags="${escape((entry.tags ?? []).join(','))}"`]),
    ...((entry.when ?? []).length ? [`when="${escape(entry.when.join(' | '))}"`] : []),
    ...(capability ? [] : [`ref="${escape(entry.ref)}"`]),
    ...(entry.routes ? [`routes="${escape(entry.routes.map((route) => `${route.id}:${route.state}${route.head ? `@${short(route.head)}` : ''}`).join(','))}"`] : []),
    ...(entry.map ? [`map="${entry.map.state === 'missing' ? 'missing' : `${entry.map.state}:${entry.map.count}${entry.map.derivedFrom ? `@${short(String(entry.map.derivedFrom).split('@').at(-1))}` : ''}`}"`] : []),
    ...(entry.metadataError ? [`metadata-error="${escape(entry.metadataError)}"`] : []),
  ].join(' ')
}

function promptCapabilityItems(plan) {
  return plan.capabilities.flatMap((capability) => {
    const skills = plan.skills.filter((entry) => entry.capability === capability.id)
    if (!skills.length) return []
    return [{
      ref: `capability:${capability.id}`,
      summary: capability.description,
      when: [...new Set(skills.map((entry) => entry.description))],
      entrypoints: [...new Set(skills.map((entry) => entry.projectedId))].sort(),
    }]
  }).sort((left, right) => left.ref.localeCompare(right.ref))
}

function promptCapabilityAttributes(entry) {
  return [
    `ref="${escape(entry.ref)}"`,
    `summary="${escape(entry.summary)}"`,
    ...(entry.when.length ? [`when="${escape(entry.when.join(' | '))}"`] : []),
    `entrypoints="${escape(entry.entrypoints.join(','))}"`,
  ].join(' ')
}

function gitXml(name, git) {
  if (!git?.available) return `<${name} available="false"${git?.error ? ` error="${escape(git.error)}"` : ''}/>`
  return `<${name} available="true" root="${escape(git.root)}" branch="${escape(git.branch ?? 'detached')}"${git.head ? ` head="${git.head}"` : ' state="unborn"'} clean="${git.clean}" changes="${git.changes}" conflicts="${git.conflicts}" ahead="${git.ahead}" behind="${git.behind}" operation="${git.operation ?? 'none'}" worktrees="${git.worktrees.length}"${git.committedAt ? ` committed-at="${git.committedAt}"` : ''}/>`
}

async function resolvedDeskInstructions(plan) {
  const entries = []
  if (plan.deskInstruction) {
    entries.push({
      owner: plan.deskInstruction.owner,
      id: plan.deskInstruction.id,
      source: plan.deskInstruction.path,
      content: await readFile(join(plan.deskInstruction.root, plan.deskInstruction.path), 'utf8'),
    })
  }
  for (const instruction of plan.instructions.filter((entry) => entry.scope === 'desk')) {
    entries.push({
      owner: instruction.owner,
      id: instruction.localId,
      source: `equipment/${instruction.owner}/${instruction.path}`,
      content: await readFile(join(instruction.root, instruction.path), 'utf8'),
    })
  }
  return entries
}

function frontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!match) throw new Error('Missing Artifact frontmatter.')
  const value = {}
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(':')
    if (separator < 1) continue
    const key = line.slice(0, separator).trim()
    const raw = line.slice(separator + 1).trim()
    value[key] = raw.startsWith('[') ? JSON.parse(raw) : raw.replace(/^"|"$/g, '')
  }
  return value
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
  return values.sort()
}

async function safeReadDir(path) {
  try {
    return (await readdir(path, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return fallback
    throw error
  }
}

function digest(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function item(severity, subject, code, message) {
  return { severity, subject, code, message }
}

function withoutSeverity({ severity: _severity, ...entry }) {
  return entry
}

function stdin() {
  return new Promise((resolvePromise, reject) => {
    const chunks = []
    process.stdin.on('data', (chunk) => chunks.push(chunk))
    process.stdin.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8')))
    process.stdin.on('error', reject)
  })
}

function short(value) { return value?.slice(0, 8) ?? 'none' }
function date(value) { return value?.slice(0, 10) ?? 'unknown' }
function escape(value) { return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;') }
function failure(code, message) { const error = new Error(message); error.code = code; error.exitCode = 5; return error }
