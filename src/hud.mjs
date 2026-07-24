import { API, validateDocument } from './contracts.mjs'
import { listArtifacts } from './artifacts.mjs'
import { listIntegrations } from './integrations.mjs'
import { listTargets, targetMapFreshness } from './targets.mjs'
import { homeGitState, renderSessionPrompt, resolveHome } from './resolved.mjs'

export async function hudModel(root) {
  const plan = await resolveHome(root)
  const requested = new Set(plan.hud.map((entry) => entry.probe))
  const probes = {}
  const warnings = [...plan.warnings]
  if (requested.has('kernel:home')) probes.home = { name: plan.home.name, mode: plan.home.mode, runtime: plan.home.runtime, providers: plan.home.providers }
  if (requested.has('kernel:desk')) probes.desk = plan.desk ? { id: plan.desk.id } : null
  if (requested.has('kernel:git')) probes.git = await homeGitState(root)
  if (requested.has('kernel:assets')) probes.assets = plan.assets.map(({ root: _root, ...asset }) => asset)
  if (requested.has('kernel:artifacts')) probes.artifacts = await listArtifacts(root)
  if (requested.has('kernel:targets')) {
    probes.targets = await listTargets(root)
    const freshness = await targetMapFreshness(root, probes.targets)
    probes.targets = probes.targets.map((target) => ({ ...target, map: freshness[target.id] }))
  }
  if (requested.has('kernel:integrations')) probes.integrations = await listIntegrations(root)
  if (probes.git?.available === false) warnings.push(warning('hud.git.unavailable', probes.git.error))
  for (const artifact of probes.artifacts ?? []) {
    if (artifact.invalid) warnings.push(warning(`hud.artifact.invalid.${artifact.path}`, `Invalid Artifact at ${artifact.path}: ${artifact.invalid}`))
  }
  for (const target of probes.targets ?? []) {
    for (const binding of target.bindings) {
      if (binding.broken) warnings.push(warning(`hud.target.broken.${target.id}.${binding.id}`, `Target ${target.id} Binding ${binding.id} is broken.`))
      else if (!binding.matches) warnings.push(warning(`hud.target.mismatch.${target.id}.${binding.id}`, `Target ${target.id} Binding ${binding.id} does not match its declared repository.`))
      if (binding.evidence?.conflicts) warnings.push(warning(`hud.target.conflicts.${target.id}.${binding.id}`, `Target ${target.id} Binding ${binding.id} has ${binding.evidence.conflicts} conflict(s).`))
    }
  }
  for (const integration of probes.integrations ?? []) {
    for (const provider of plan.home.providers) {
      if (!integration.bindings?.[provider]) warnings.push(warning(`hud.integration.unbound.${integration.id}.${provider}`, `Integration ${integration.id} is not bound for ${provider}.`))
    }
  }
  const surfaces = [
    ...plan.instructions.map((item) => surface(item, { bytes: Buffer.byteLength(item.content, 'utf8') })),
    ...plan.capabilities.map((item) => surface(item, { contract: item.contract ?? null })),
    ...plan.references.map((item) => surface(item, { description: item.description })),
    ...plan.skills.map((item) => surface(item, {
      projectedName: item.projectedName,
      access: 'model',
      projections: projections(plan, item),
    })),
    ...plan.commands.map((item) => surface(item, {
      projectedName: item.projectedName,
      access: 'user',
      projections: projections(plan, item),
    })),
    ...plan.cli.map((item) => ({ kind: 'cli', id: item.id, owner: item.owner, scope: item.scope, route: `hairness ${item.id}` })),
    ...plan.artifactKinds.map((item) => ({ kind: 'artifact', id: item.id, owner: item.owner, scope: item.scope, owners: item.owners })),
    ...plan.executables.map((item) => ({ kind: 'executable', id: item.id, owner: item.owner, scope: item.scope })),
  ].sort((left, right) => `${left.owner}:${left.kind}:${left.id}`.localeCompare(`${right.owner}:${right.kind}:${right.id}`))
  return validateDocument({
    apiVersion: API.hud,
    kind: 'HUD',
    generatedAt: new Date().toISOString(),
    home: { name: plan.home.name, mode: plan.home.mode, runtime: plan.home.runtime, providers: plan.home.providers, digest: plan.digest },
    desk: plan.desk ? { id: plan.desk.id } : null,
    surfaces,
    context: plan.context,
    warnings: warnings.sort((left, right) => left.id.localeCompare(right.id)),
    probes,
  }, 'hud')
}

export function renderHud(model, options = {}) {
  if (options.full) return renderFull(model)
  const git = model.probes.git
  const targets = model.probes.targets ?? []
  const assets = model.probes.assets ?? []
  const artifacts = model.probes.artifacts ?? []
  const bindings = targets.flatMap((target) => target.bindings)
  const targetWorktrees = new Set(bindings.flatMap((binding) => binding.evidence?.worktrees?.map((worktree) => worktree.path) ?? []))
  const lines = [
    `HOME        ${model.home.name} · ${model.home.mode} · ${model.home.runtime}`,
    `DESK        ${model.desk?.id ?? 'not configured'}`,
    `PROVIDERS   ${model.home.providers.join(' · ')}`,
    `ASSETS      ${assets.length || owners(model.surfaces).length}`,
    `SURFACES    ${counts(model.surfaces)}`,
    `ARTIFACTS   ${artifacts.length} · ${artifactCounts(artifacts)}`,
  ]
  if (git) {
    lines.push(`GIT         ${git.branch ?? 'detached'} · ${git.clean ? 'clean' : `${git.changes} changes`} · +${git.ahead}/-${git.behind} · ${git.worktrees?.length ?? 0} worktrees · ${relativeTime(git.committedAt)}`)
    if (git.operation || git.conflicts) lines.push(`GIT STATE   ${git.operation ?? 'no operation'} · ${git.conflicts ?? 0} conflicts`)
  }
  if (targets.length) {
    lines.push(`TARGETS     ${targets.length} declared · ${bindings.length} bindings · ${targetWorktrees.size} worktrees`)
    for (const target of targets) {
      const states = target.bindings.map((binding) => `${binding.id}:${bindingState(binding)}`).join(' · ')
      lines.push(`  ${target.id.padEnd(12)} ${states || 'declared'} · map:${target.map?.current ? 'current' : target.map?.maps ? 'stale' : 'missing'}`)
    }
  }
  lines.push(`CONTEXT     instructions:${model.context.instructionsBytes}B · desk:${model.context.deskInstructionsBytes}B · skills:${model.context.skillDescriptionsBytes}B · hud:${model.context.hudPromptBytes}B`)
  const warnings = model.warnings.filter((item) => item.level === 'warning')
  lines.push(`HEALTH      ${warnings.length ? `attention · ${warnings.length} warnings` : 'ready'}`)
  return lines.join('\n')
}

export function renderHudPrompt(model, plan) {
  const git = model.probes.git
  const surfaceCounts = countByKind(model.surfaces)
  const namespaces = [...new Set(model.surfaces
    .filter((entry) => entry.kind === 'cli')
    .map((entry) => entry.id.split(' ')[0]))].sort()
  const lines = [
    `<session generated-at="${escapeXml(model.generatedAt)}">`,
    `  <home name="${escapeXml(model.home.name)}" mode="${model.home.mode}" runtime="${escapeXml(model.home.runtime)}" providers="${escapeXml(model.home.providers.join(','))}"/>`,
    `  <desk configured="${Boolean(model.desk)}"${model.desk ? ` id="${escapeXml(model.desk.id)}"` : ''}/>`,
    `  <surfaces assets="${model.probes.assets?.length ?? owners(model.surfaces).length}" instructions="${surfaceCounts.instruction ?? 0}" capabilities="${surfaceCounts.capability ?? 0}" skills="${surfaceCounts.skill ?? 0}" commands="${surfaceCounts.command ?? 0}" cli="${surfaceCounts.cli ?? 0}" artifact-kinds="${surfaceCounts.artifact ?? 0}" namespaces="${escapeXml(namespaces.join(','))}"/>`,
    `  <context instructions-bytes="${model.context.instructionsBytes}" desk-instructions-bytes="${model.context.deskInstructionsBytes}" skill-descriptions-bytes="${model.context.skillDescriptionsBytes}" hud-prompt-bytes="${model.context.hudPromptBytes}"/>`,
    git
      ? `  <git branch="${escapeXml(git.branch ?? 'detached')}" head="${escapeXml(git.head)}" clean="${git.clean}" changes="${git.changes}" ahead="${git.ahead}" behind="${git.behind}" conflicts="${git.conflicts}" worktrees="${git.worktrees?.length ?? 0}" committed-at="${escapeXml(git.committedAt ?? '')}" operation="${escapeXml(git.operation ?? 'none')}"/>`
      : '  <git available="false"/>',
    '  <targets>',
  ]
  for (const target of model.probes.targets ?? []) {
    lines.push(`    <target id="${escapeXml(target.id)}" state="${target.state}" bindings="${target.bindings.length}" map="${target.map?.current ? 'current' : target.map?.maps ? 'stale' : 'missing'}">`)
    for (const binding of target.bindings) {
      const evidence = binding.evidence
      lines.push(`      <binding id="${escapeXml(binding.id)}" type="${binding.type}" usable="${Boolean(binding.path)}"${evidence ? ` branch="${escapeXml(evidence.branch ?? 'detached')}" head="${escapeXml(evidence.head)}" clean="${evidence.clean}" conflicts="${evidence.conflicts}" committed-at="${escapeXml(evidence.committedAt ?? '')}" worktrees="${evidence.worktrees?.length ?? 0}"` : ''}/>`)
    }
    lines.push('    </target>')
  }
  lines.push(
    '  </targets>',
    `  <artifacts count="${model.probes.artifacts?.length ?? 0}"/>`,
    `  <warnings count="${model.warnings.filter((item) => item.level === 'warning').length}"/>`,
    '</session>',
  )
  const facts = lines.join('\n')
  return `${renderSessionPrompt(plan)}\n${facts}`
}

function renderFull(model) {
  const lines = [renderHud(model), '', 'ASSETS']
  for (const asset of model.probes.assets ?? []) {
    lines.push(`  ${asset.name}@${asset.version} · ${asset.scope} · ${asset.status}${asset.override ? ` · overrides ${asset.override.asset}@${asset.override.version}` : ''}${asset.mobile ? ' · mobile source' : ''}`)
  }
  lines.push('', 'SURFACES')
  for (const owner of owners(model.surfaces)) {
    lines.push(owner)
    for (const item of model.surfaces.filter((entry) => entry.owner === owner)) {
      const projected = item.projections?.map((entry) => `${entry.provider}:${entry.status === 'projected' ? entry.name : entry.status}`).join(' · ')
      const detail = projected ?? item.route ?? item.owners?.join('|') ?? (item.bytes !== undefined ? `${item.bytes} bytes` : '')
      lines.push(`  ${item.kind.padEnd(12)} ${item.id}${detail ? ` · ${detail}` : ''}`)
    }
  }
  lines.push('', 'TARGETS')
  for (const target of model.probes.targets ?? []) {
    lines.push(`  ${target.id} · ${target.state} · ${target.repository} · map:${target.map?.current ? 'current' : target.map?.maps ? 'stale' : 'missing'}`)
    for (const binding of target.bindings) {
      const evidence = binding.evidence
      lines.push(`    ${binding.id} · ${binding.type} · ${evidence?.branch ?? 'unavailable'} · ${evidence ? evidence.clean ? 'clean' : `${evidence.changes.length} changes` : binding.broken ? 'broken' : 'unavailable'} · ${evidence?.worktrees?.length ?? 0} worktrees · ${relativeTime(evidence?.committedAt)}`)
    }
  }
  lines.push('', 'CONTEXT', `  shared instructions   ${model.context.instructionsBytes} bytes`, `  Desk instructions     ${model.context.deskInstructionsBytes} bytes`, `  skill descriptions    ${model.context.skillDescriptionsBytes} bytes`, `  HUD prompt             ${model.context.hudPromptBytes} bytes`)
  if (model.warnings.length) {
    lines.push('', 'WARNINGS')
    for (const warning of model.warnings) lines.push(`  ${warning.provider ?? 'home'} · ${warning.message}`)
  }
  return lines.join('\n')
}

function surface(item, extra) {
  return { kind: item.kind, id: item.id, owner: item.owner, scope: item.scope, ...extra }
}

function projections(plan, item) {
  const lossy = new Set(plan.home.settings?.['hairness/home']?.lossyProjection ?? [])
  const hasModelAccess = plan.skills.some((entry) => entry.id === item.id)
  return plan.home.providers.map((provider) => ({
    provider,
    name: item.projectedName,
    status: provider === 'codex' && item.kind === 'command' && !hasModelAccess && !lossy.has(`${provider}:${item.id}`)
      ? 'omitted'
      : 'projected',
  }))
}

function counts(values) {
  return Object.entries(countByKind(values)).sort().map(([kind, count]) => `${kind}:${count}`).join(' · ')
}

function countByKind(values) {
  const result = {}
  for (const item of values) result[item.kind] = (result[item.kind] ?? 0) + 1
  return result
}

function owners(values) {
  return [...new Set(values.map((item) => item.owner))].sort()
}

function bindingState(binding) {
  if (binding.broken) return 'broken'
  if (!binding.evidence) return 'unavailable'
  if (binding.evidence.conflicts) return `${binding.type}/conflicts`
  return `${binding.type}/${binding.evidence.clean ? 'clean' : 'dirty'}`
}

function artifactCounts(artifacts) {
  const counts = new Map()
  for (const artifact of artifacts) counts.set(artifact.scope, (counts.get(artifact.scope) ?? 0) + 1)
  return [...counts.entries()].sort().map(([scope, count]) => `${scope}:${count}`).join(' · ') || 'none'
}

function relativeTime(value) {
  if (!value) return 'unknown'
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 1000))
  if (seconds < 60) return 'just now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`
  return `${Math.floor(seconds / 86400)}d ago`
}

function escapeXml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

function warning(id, message) {
  return { id, level: 'warning', message }
}
