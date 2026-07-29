#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { lstat, readFile, readdir, realpath } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)

const HUD_HELP = {
  show: {
    usage: 'hairness hud show [--full]',
    effect: 'read-only',
    summary: 'Render the human HUD; --full includes its complete inventory.',
  },
  prompt: {
    usage: 'hairness hud prompt',
    effect: 'read-only',
    summary: 'Render the bounded agent-facing HUD selected by the Front Door.',
  },
  json: {
    usage: 'hairness hud json',
    effect: 'read-only',
    summary: 'Render the stable machine-readable HUD.',
  },
  activity: {
    usage: 'hairness hud activity [--since <duration|date>] [--scope <ref>] [--json]',
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
      const budget = input.resolvedHome.home.settings?.['hairness/hud']?.promptBytes
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
      'Usage: hairness hud <command> [options]',
      '',
      'Commands:',
      ...Object.entries(HUD_HELP).map(([name, entry]) => `  ${name.padEnd(8)} ${entry.summary}`),
      '',
      'Run hairness hud <command> --help for command details.',
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

  const workspaces = scope?.kind === 'workspace'
    ? model.items.workspaces.filter((entry) => entry.id === scope.id)
    : scope ? [] : model.items.workspaces
  for (const workspace of workspaces) {
    events.push(...await fileActivity(join(input.deskRoot, 'workspaces', workspace.id), since, workspace.ref, input.homeRoot))
  }

  const workstreams = scope?.kind === 'workstream'
    ? model.items.workstreams.filter((entry) => entry.id === scope.id)
    : []
  for (const workstream of workstreams) {
    const [workspace, id] = workstream.id.split('/')
    events.push(...await fileActivity(join(input.deskRoot, 'workspaces', workspace, 'workstreams', id), since, workstream.ref, input.homeRoot))
  }

  const targets = scope?.kind === 'target'
    ? model.targets.filter((entry) => entry.id === scope.id)
    : scope ? [] : model.targets
  for (const target of targets) {
    for (const binding of target.bindings) {
      const subject = `target:${target.id}/${binding.id}`
      if (binding.root) events.push(...await gitActivity(binding.root, since, subject))
      if (binding.git?.available && !binding.git.clean) events.push(currentGitActivity(subject, binding.git, generatedAt))
    }
    if (target.map.state !== 'current') {
      events.push({
        occurredAt: generatedAt,
        subject: `target:${target.id}`,
        verb: 'observed',
        summary: `Target Map is ${target.map.state}.`,
        confidence: 'observed',
        source: { kind: 'hud', ref: target.map.path },
      })
    }
  }

  const artifacts = model.artifacts.items.filter((artifact) => {
    if (!scope) return true
    if (scope.kind === 'artifact') return artifact.id === scope.id
    if (scope.kind === 'desk' || scope.kind === 'home') return artifact.scope === scope.kind
    if (scope.kind === 'target') return artifact.targets?.includes(scope.id)
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
    apiVersion: 'hairness.dev/hud/activity/v1alpha1',
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
    workspace: model.items.workspaces,
    workstream: model.items.workstreams,
    target: model.items.targets,
    artifact: model.artifacts.items,
  }
  if (!known[kind] || !id || !known[kind].some((entry) => entry.id === id)) {
    throw failure('activity_scope_unknown', `Unknown Activity scope: ${value}.`)
  }
  return { kind, id }
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
  const preferences = plan.desk?.settings?.['hairness/onboarding'] ?? {}
  const [homeGit, deskGit, artifacts, recentDesk, projections, orientation] = await Promise.all([
    gitProbe(homeRoot),
    deskRoot ? gitProbe(deskRoot) : null,
    scanArtifacts(homeRoot, deskRoot),
    deskRoot ? recentFiles(deskRoot) : [],
    projectionProbe(homeRoot, plan.home.providers),
    scanOrientation(homeRoot, deskRoot),
  ])
  const targets = await scanTargets(plan.home.settings?.['hairness/targets']?.targets ?? [], deskRoot, artifacts)
  const items = {
    workspaces: orientation.workspaces,
    workstreams: orientation.workstreams,
    targets: targets.map(targetItem),
    capabilities: capabilityItems(plan),
  }
  const trust = {
    runtimes: (input.runtimeTrust ?? []).sort((left, right) => left.owner.localeCompare(right.owner)),
  }
  trust.bundled = trust.runtimes.filter((entry) => entry.trust === 'bundled').length
  trust.approved = trust.runtimes.filter((entry) => entry.trust === 'approved').length
  trust.pending = trust.runtimes.filter((entry) => entry.trust === 'pending').length

  const attention = []
  if (!deskRoot && plan.home.mode === 'team') {
    attention.push(item('advisory', 'desk', 'desk-missing', 'No private Desk is configured; onboarding can initialize, clone or skip one.'))
  }
  if (!homeGit.available) attention.push(item('warning', 'home', 'home-git-unavailable', homeGit.error))
  else if (!homeGit.clean) attention.push(item('advisory', 'home', 'home-dirty', `Home has ${homeGit.changes} change(s).`))
  if (deskGit?.available && !deskGit.clean) attention.push(item('advisory', 'desk', 'desk-dirty', `Desk has ${deskGit.changes} change(s).`))
  for (const projection of projections) {
    if (projection.status !== 'fresh') attention.push(item('warning', `provider:${projection.id}`, 'projection-stale', `${projection.id} projections are ${projection.status}.`))
  }
  for (const target of targets) {
    const metadataError = orientationError(target)
    if (metadataError) attention.push(item('warning', `target:${target.id}`, 'orientation-invalid', metadataError))
    if (!target.bindings.length) attention.push(item('warning', `target:${target.id}`, 'target-unbound', `${target.id} has no local Binding.`))
    if (target.map.state === 'missing') attention.push(item('advisory', `target:${target.id}`, 'target-map-missing', `${target.id} has no Target Map.`))
    if (target.map.state === 'stale') attention.push(item('advisory', `target:${target.id}`, 'target-map-stale', `${target.id} Target Map is stale.`))
    const unboundWorktrees = target.worktrees.filter((worktree) => !worktree.binding)
    if (unboundWorktrees.length) {
      attention.push(item('advisory', `target:${target.id}`, 'target-worktrees-unbound', `${target.id} has ${unboundWorktrees.length} Git worktree(s) without a local Binding; inspect target list or target doctor.`))
    }
    for (const binding of target.bindings) {
      if (!binding.git?.available) attention.push(item('blocking', `target:${target.id}/${binding.id}`, 'target-broken', 'Binding is not a usable Git checkout.'))
      else if (binding.git.conflicts) attention.push(item('blocking', `target:${target.id}/${binding.id}`, 'target-conflicts', `Binding has ${binding.git.conflicts} conflict(s).`))
      else if (!binding.git.clean) attention.push(item('advisory', `target:${target.id}/${binding.id}`, 'target-dirty', `Binding has ${binding.git.changes} change(s).`))
    }
  }
  for (const runtime of trust.runtimes.filter((entry) => entry.trust === 'pending')) {
    attention.push(item('blocking', `runtime:${runtime.owner}`, 'runtime-pending', `${runtime.owner} requires approval before execution.`))
  }
  for (const entry of [...items.workspaces, ...items.workstreams]) {
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
    apiVersion: 'hairness.dev/hud/v2alpha1',
    generatedAt: new Date().toISOString(),
    status: severity,
    event: input.invocation?.kind ?? 'command',
    home: {
      name: plan.home.name,
      mode: plan.home.mode,
      root: homeRoot,
      providers: plan.home.providers,
      git: homeGit,
    },
    kernel: input.kernel,
    collaborator: plan.desk ? { id: plan.desk.id, ...preferences } : null,
    desk: plan.desk ? { configured: true, id: plan.desk.id, root: deskRoot, preferences, git: deskGit } : { configured: false },
    projections,
    surfaces: {
      assets: plan.assets.map((asset) => ({
        id: asset.id,
        version: asset.version,
        description: asset.description,
        scope: asset.scope,
        overridden: asset.overridden,
        runtime: asset.runtime,
      })),
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
      promptBudgetBytes: plan.home.settings?.['hairness/hud']?.promptBytes ?? null,
    },
    targets,
    items,
    artifacts,
    recentDesk,
    trust,
    attention: groupedAttention,
  }
}

async function scanOrientation(homeRoot, deskRoot) {
  if (!deskRoot) return { workspaces: [], workstreams: [] }
  const home = await readFile(join(homeRoot, 'HOME.md'), 'utf8')
  const registry = new Set([...(home.match(/## Active Workspaces([\s\S]*?)(?=\n## )/)?.[1] ?? '')
    .matchAll(/^- `([^`]+)`/gm)]
    .map((match) => match[1]))
  const workspaces = []
  const workstreams = []
  const root = join(deskRoot, 'workspaces')
  for (const entry of await safeReadDir(root)) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue
    const path = join(root, entry.name, 'workspace.md')
    const document = await orientationDocument(path)
    const active = registry.has(entry.name)
    workspaces.push({
      kind: 'workspace',
      id: entry.name,
      state: active ? 'active' : 'local',
      ...document.metadata,
      ref: `workspace:${entry.name}`,
      path: relative(homeRoot, path),
      access: ['model', 'user'],
      routable: active && !document.error,
      ...(document.error ? { metadataError: document.error } : {}),
    })
    for (const stream of await safeReadDir(join(root, entry.name, 'workstreams'))) {
      if (!stream.isDirectory() || stream.isSymbolicLink()) continue
      const streamPath = join(root, entry.name, 'workstreams', stream.name, 'workstream.md')
      const streamDocument = await orientationDocument(streamPath)
      const content = await readFile(streamPath, 'utf8').catch(() => '')
      const state = /^## Status\s*\n+\s*`active`/m.test(content) ? 'active' : 'local'
      workstreams.push({
        kind: 'workstream',
        id: `${entry.name}/${stream.name}`,
        workspace: entry.name,
        state,
        ...streamDocument.metadata,
        ref: `workstream:${entry.name}/${stream.name}`,
        path: relative(homeRoot, streamPath),
        access: ['model', 'user'],
        routable: active && state === 'active' && !streamDocument.error,
        ...(streamDocument.error ? { metadataError: streamDocument.error } : {}),
      })
    }
  }
  return { workspaces, workstreams }
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

function orientationError(value) {
  if (typeof value.summary !== 'string' || !value.summary.trim()) return 'summary must be a non-empty string.'
  if (!Array.isArray(value.when) || value.when.length < 1 || value.when.length > 3 || value.when.some((entry) => typeof entry !== 'string' || !entry.trim())) {
    return 'when must contain one to three non-empty situations.'
  }
  if (!Array.isArray(value.tags) || !value.tags.length || value.tags.some((entry) => typeof entry !== 'string' || !/^[a-z0-9][a-z0-9._-]*$/.test(entry))) {
    return 'tags must contain stable identifiers.'
  }
  return null
}

function capabilityItems(plan) {
  return plan.capabilities.flatMap((capability) => {
    const skills = plan.skills.filter((entry) => entry.capability === capability.id)
    const commands = plan.commands.filter((entry) => entry.capability === capability.id)
    if (!skills.length && !commands.length) return []
    const access = [...(skills.length ? ['model'] : []), ...(commands.length ? ['user'] : [])]
    return [{
      kind: 'capability',
      id: skills[0]?.projectedId ?? commands[0].projectedId,
      state: 'available',
      summary: capability.description,
      when: [...new Set(skills.map((entry) => entry.description))].slice(0, 3),
      tags: [...new Set([...capability.owner.split('/'), capability.localId])],
      ref: `capability:${capability.id}`,
      path: capability.path,
      access,
      routable: access.length > 0,
      entrypoint: {
        ...(skills[0] ? { model: skills[0].projectedId } : {}),
        ...(commands[0] ? { user: commands[0].projectedId } : {}),
      },
    }]
  })
}

function targetItem(target) {
  const metadataError = orientationError(target)
  return {
    kind: 'target',
    id: target.id,
    state: target.state,
    summary: target.summary ?? null,
    when: target.when ?? [],
    tags: target.tags ?? [],
    ref: `target:${target.id}`,
    access: ['model', 'user'],
    routable: !metadataError && target.bindings.some((binding) => binding.git?.available),
    entrypoint: { model: 'hairness-target-map', user: 'hairness-target-map' },
    bindings: target.bindings.map((binding) => ({
      id: binding.id,
      state: binding.git?.available ? binding.git.clean ? 'clean' : 'dirty' : 'broken',
      root: binding.root,
      head: binding.git?.head ?? null,
    })),
    worktrees: target.worktrees.map((worktree) => ({
      path: worktree.path,
      head: worktree.head ?? null,
      branch: worktree.branch ?? null,
      binding: worktree.binding,
      locked: Boolean(worktree.locked),
      prunable: Boolean(worktree.prunable),
    })),
    map: target.map,
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

async function scanTargets(targets, deskRoot, artifacts) {
  return Promise.all(targets.map(async (target) => {
    const bindings = []
    const targetRoot = deskRoot && join(deskRoot, 'targets', target.id)
    if (targetRoot) {
      for (const entry of await safeReadDir(targetRoot)) {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
        const mountPath = join(targetRoot, entry.name)
        const type = entry.isSymbolicLink() ? 'bound' : 'managed'
        const resolved = await realpath(mountPath).catch(() => null)
        bindings.push({
          id: entry.name,
          type,
          mount: relative(deskRoot, mountPath),
          root: resolved,
          git: resolved ? await gitProbe(resolved) : { available: false, error: 'Broken Binding.' },
        })
      }
    }
    const maps = artifacts.items
      .filter((artifact) => artifact.kind === 'hairness/targets:target-map' && artifact.targets?.includes(target.id))
      .sort((left, right) => String(right.createdAt ?? '').localeCompare(String(left.createdAt ?? '')))
    const heads = new Set(bindings.map((binding) => binding.git?.head).filter(Boolean))
    const registered = new Map(bindings.filter((binding) => binding.root).map((binding) => [binding.root, binding.id]))
    const worktrees = new Map()
    for (const binding of bindings) {
      for (const worktree of binding.git?.worktrees ?? []) worktrees.set(worktree.path, {
        ...worktree,
        binding: registered.get(worktree.path) ?? null,
      })
    }
    const current = maps.find((artifact) => heads.has(String(artifact.derivedFrom ?? '').replace(`target:${target.id}@`, '')))
    const selected = current ?? maps[0] ?? null
    return {
      ...target,
      state: bindings.length ? 'bound' : 'declared',
      bindings,
      worktrees: [...worktrees.values()].sort((left, right) => left.path.localeCompare(right.path)),
      map: {
        count: maps.length,
        state: current ? 'current' : maps.length ? 'stale' : 'missing',
        path: selected?.path ?? null,
        derivedFrom: selected?.derivedFrom ?? null,
        generatedAt: selected?.createdAt ?? null,
        route: `target map ${target.id}${bindings.length === 1 ? ` --binding ${bindings[0].id}` : ''}`,
      },
    }
  }))
}

async function scanArtifacts(homeRoot, deskRoot) {
  const items = []
  for (const [scope, root] of [['home', join(homeRoot, 'artifacts')], ['desk', deskRoot && join(deskRoot, 'artifacts')]]) {
    if (!root) continue
    for (const path of await findNamed(root, 'artifact.md')) {
      const directory = dirname(path)
      try {
        const metadata = frontmatter(await readFile(path, 'utf8'))
        items.push({ ...metadata, scope, path: directory })
      } catch (error) {
        items.push({ scope, path: directory, invalid: error.message })
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
      if (['.git', 'targets'].includes(entry.name)) continue
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
      run(['rev-parse', 'HEAD']).then((value) => value.trim()),
      run(['symbolic-ref', '--quiet', '--short', 'HEAD']).then((value) => value.trim()).catch(() => null),
      run(['status', '--porcelain=v2', '--branch', '--untracked-files=all']),
      run(['log', '-1', '--format=%cI']).then((value) => value.trim()),
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
  const state = await readJson(join(homeRoot, '.hairness', 'build.json'), null)
  const definitions = {
    codex: { instruction: 'AGENTS.md', hook: '.codex/hooks/hairness-session-start.mjs' },
    claude: { instruction: 'CLAUDE.md', hook: '.claude/hooks/hairness-session-start.mjs' },
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
    `HAIRNESS    ${model.home.name} · ${model.home.mode} · ${model.home.providers.join('+')} · ${model.kernel.runtime} · ${model.kernel.source} · ${model.status}`,
    `ROOT        ${model.home.root}`,
    `KERNEL      ${model.kernel.invoke}`,
    `HOME GIT    ${homeGit}`,
    `DESK        ${model.desk.configured ? `${model.desk.id} · ${model.desk.root} · ${deskGit}` : 'missing'} · recent:${model.recentDesk.length}`,
    `ITEMS       ${model.items.workspaces.length} workspaces · ${model.items.workstreams.length} workstreams · ${model.items.targets.length} targets · ${model.items.capabilities.length} capabilities`,
    `SURFACES    ${model.surfaces.assets.length} assets · ${model.surfaces.runtimes.map((entry) => entry.namespace).join(',')}`,
    `ARTIFACTS   ${model.artifacts.count} · ${Object.entries(model.artifacts.counts).map(([key, value]) => `${key}:${value}`).join(' ') || 'none'}`,
    `TARGETS     ${model.targets.length} declared · ${model.targets.reduce((sum, target) => sum + target.bindings.length, 0)} bindings`,
  ]
  for (const target of model.targets) {
    const bindings = target.bindings.map((binding) => `${binding.id}:${binding.git?.clean ? 'clean' : binding.git?.available ? 'dirty' : 'broken'}@${binding.root ?? 'missing'}`).join(' · ') || 'unbound'
    lines.push(`  ${target.id.padEnd(18)} ${bindings} · map:${target.map.state}${target.map.path ? `@${target.map.path}` : ''}`)
  }
  lines.push(`CONTEXT     instructions:${model.context.instructionBytes}B · desk:${model.context.deskInstructionBytes}B · model:${model.context.modelDescriptionBytes}B`)
  if (model.recentDesk.length) lines.push('RECENT DESK', ...model.recentDesk.map((entry) => `  ${entry.modifiedAt}  ${entry.path}`))
  const attention = Object.entries(model.attention).flatMap(([severity, entries]) => entries.map((entry) => ({ severity, ...entry })))
  if (attention.length) lines.push('ATTENTION', ...attention.map((entry) => `  ${entry.severity} · ${entry.code} · ${entry.message}`))
  if (full) {
    lines.push('ROUTABLE ITEMS', ...Object.values(model.items).flat().map((entry) => `  ${entry.kind}:${entry.id} · ${entry.state} · ${entry.access.join(',')} · routable:${entry.routable} · ${entry.ref}`))
    lines.push('PROJECTIONS', ...model.projections.map((entry) => `  ${entry.id} · ${entry.status} · ${entry.instruction} · ${entry.hook}`))
    lines.push('ASSETS', ...model.surfaces.assets.map((asset) => `  ${asset.id}@${asset.version} · ${asset.scope}${asset.overridden ? ' · override' : ''}${asset.runtime ? ` · ${asset.runtime.namespace}` : ''}`))
    lines.push('SKILLS', ...model.surfaces.skills.map((entry) => `  ${entry.projectedId} · ${entry.owner}`))
    lines.push('COMMANDS', ...model.surfaces.commands.map((entry) => `  ${entry.projectedId} · ${entry.owner}`))
    lines.push('RUNTIMES', ...model.surfaces.runtimes.map((entry) => `  ${entry.namespace} · ${entry.owner} · ${entry.commands.map((command) => command.name).join(',')}`))
    lines.push('ARTIFACT INVENTORY', ...model.artifacts.items.map((artifact) => `  ${artifact.kind ?? 'invalid'}:${artifact.id ?? 'unknown'} · ${artifact.scope} · ${artifact.state ?? 'invalid'} · ${artifact.path}`))
  }
  return lines.join('\n')
}

function gitSummary(git) {
  if (!git?.available) return 'unavailable'
  return `${git.branch ?? 'detached'} · ${git.clean ? 'clean' : `${git.changes} changes`} · ${short(git.head)} · ${git.worktrees.length} worktrees · ${date(git.committedAt)}`
}

async function xml(model, input) {
  const deskInstructions = await resolvedDeskInstructions(input.resolvedHome)
  const lines = [
    `<hairness-hud version="2" status="${model.status}" generated-at="${model.generatedAt}" event="${escape(model.event)}">`,
    `  <home name="${escape(model.home.name)}" mode="${model.home.mode}" root="${escape(model.home.root)}" providers="${model.home.providers.join(',')}"/>`,
    `  <kernel runtime="${escape(model.kernel.runtime)}" source="${model.kernel.source}" invoke="${escape(model.kernel.invoke)}"/>`,
  ]
  if (model.collaborator) {
    lines.push(`  <collaborator id="${escape(model.collaborator.id)}"${model.collaborator.addressAs ? ` address-as="${escape(model.collaborator.addressAs)}"` : ''}${model.collaborator.responseLanguage ? ` response-language="${escape(model.collaborator.responseLanguage)}"` : ''}/>`)
  }
  lines.push(`  <desk configured="${model.desk.configured}"${model.desk.configured ? ` id="${escape(model.desk.id)}" root="${escape(model.desk.root)}"` : ''}/>`)
  lines.push(`  ${gitXml('home-git', model.home.git)}`)
  if (model.desk.configured) lines.push(model.desk.git?.root === model.home.git?.root ? '  <desk-git same-as="home-git"/>' : `  ${gitXml('desk-git', model.desk.git)}`)
  lines.push('  <routing priority="explicit-human,unique-semantic-match,ask-if-ambiguous">The Wake-up does not know the user message. Use these items to infer later; do not resolve a route now.</routing>')
  lines.push('  <providers>')
  for (const projection of model.projections) {
    lines.push(`    <provider id="${projection.id}" status="${projection.status}" instruction="${escape(projection.instruction)}" hook="${escape(projection.hook)}"/>`)
  }
  lines.push('  </providers>', '  <items>')
  for (const group of ['workspaces', 'workstreams', 'targets', 'capabilities']) {
    lines.push(`    <${group}>`)
    for (const entry of model.items[group]) lines.push(`      <item ${itemAttributes(entry)}/>`)
    lines.push(`    </${group}>`)
  }
  lines.push('  </items>', '  <runtimes>')
  for (const runtime of model.surfaces.runtimes) {
    lines.push(`    <runtime namespace="${escape(runtime.namespace)}" commands="${escape(runtime.commands.map((command) => command.name).join(','))}"/>`)
  }
  lines.push('  </runtimes>', `  <context instructions-bytes="${model.context.instructionBytes}" desk-instructions-bytes="${model.context.deskInstructionBytes}" model-descriptions-bytes="${model.context.modelDescriptionBytes}"${model.context.promptBudgetBytes === null ? '' : ` hud-budget-bytes="${model.context.promptBudgetBytes}"`}/>`)
  lines.push(`  <trust bundled="${model.trust.bundled}" approved="${model.trust.approved}" pending="${model.trust.pending}">`)
  for (const runtime of model.trust.runtimes) lines.push(`    <runtime owner="${escape(runtime.owner)}" namespace="${escape(runtime.namespace)}" trust="${runtime.trust}"/>`)
  lines.push('  </trust>', '  <desk-instructions>')
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
  lines.push('  </attention>', '</hairness-hud>')
  return lines.join('\n')
}

function itemAttributes(entry) {
  return [
    `id="${escape(entry.id)}"`,
    `state="${entry.state}"`,
    ...(entry.routable ? [] : ['routable="false"']),
    `access="${entry.access.join(',')}"`,
    `summary="${escape(entry.summary ?? '')}"`,
    `tags="${escape(entry.tags.join(','))}"`,
    ...(entry.when.length ? [`when="${escape(entry.when.join(' | '))}"`] : []),
    ...(entry.kind === 'capability' ? [] : [`ref="${escape(entry.ref)}"`]),
    ...(entry.bindings ? [`bindings="${escape(entry.bindings.map((binding) => `${binding.id}:${binding.state}${binding.head ? `@${short(binding.head)}` : ''}`).join(','))}"`] : []),
    ...(entry.map ? [`map="${entry.map.state}:${entry.map.count}${entry.map.derivedFrom ? `@${short(String(entry.map.derivedFrom).split('@').at(-1))}` : ''}"`] : []),
    ...(entry.metadataError ? [`metadata-error="${escape(entry.metadataError)}"`] : []),
  ].join(' ')
}

function gitXml(name, git) {
  if (!git?.available) return `<${name} available="false"${git?.error ? ` error="${escape(git.error)}"` : ''}/>`
  return `<${name} available="true" root="${escape(git.root)}" branch="${escape(git.branch ?? 'detached')}" head="${git.head}" clean="${git.clean}" changes="${git.changes}" conflicts="${git.conflicts}" ahead="${git.ahead}" behind="${git.behind}" operation="${git.operation ?? 'none'}" worktrees="${git.worktrees.length}" committed-at="${git.committedAt}"/>`
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
      source: `assets/${instruction.owner}/${instruction.path}`,
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
