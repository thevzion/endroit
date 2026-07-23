import { API, validateDocument } from './contracts.mjs'
import { listArtifacts } from './artifacts.mjs'
import { listIntegrations } from './integrations.mjs'
import { listTargets } from './targets.mjs'
import { homeGitState, renderSessionPrompt, resolveHome } from './resolved.mjs'

export async function hudModel(root) {
  const plan = await resolveHome(root)
  const requested = new Set(plan.hud.map((entry) => entry.probe))
  const probes = {}
  const warnings = [...plan.warnings]
  if (requested.has('kernel:home')) probes.home = { name: plan.home.name, mode: plan.home.mode, providers: plan.home.providers }
  if (requested.has('kernel:desk')) probes.desk = plan.desk ? { id: plan.desk.id } : null
  if (requested.has('kernel:git')) probes.git = await homeGitState(root)
  if (requested.has('kernel:assets')) probes.assets = plan.assets.map(({ root: _root, ...asset }) => asset)
  if (requested.has('kernel:artifacts')) probes.artifacts = await listArtifacts(root)
  if (requested.has('kernel:targets')) probes.targets = await listTargets(root)
  if (requested.has('kernel:integrations')) probes.integrations = await listIntegrations(root)
  if (probes.git?.available === false) warnings.push(warning('hud.git.unavailable', probes.git.error))
  for (const artifact of probes.artifacts ?? []) {
    if (artifact.invalid) warnings.push(warning(`hud.artifact.invalid.${artifact.path}`, `Invalid Artifact at ${artifact.path}: ${artifact.invalid}`))
  }
  for (const target of probes.targets ?? []) {
    if (target.broken) warnings.push(warning(`hud.target.broken.${target.id}`, `Target ${target.id} has a broken Desk binding.`))
    else if (!target.binding) warnings.push(warning(`hud.target.unbound.${target.id}`, `Target ${target.id} is not bound on this Desk.`))
    else if (!target.matches) warnings.push(warning(`hud.target.mismatch.${target.id}`, `Target ${target.id} does not match its declared repository.`))
  }
  for (const integration of probes.integrations ?? []) {
    for (const provider of plan.home.providers) {
      if (!integration.bindings?.[provider]) warnings.push(warning(`hud.integration.unbound.${integration.id}.${provider}`, `Integration ${integration.id} is not bound for ${provider}.`))
    }
  }
  const surfaces = [
    ...plan.instructions.map((item) => surface(item, { bytes: Buffer.byteLength(item.content, 'utf8') })),
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
    home: { name: plan.home.name, mode: plan.home.mode, providers: plan.home.providers, digest: plan.digest },
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
  const lines = [
    `HOME        ${model.home.name} · ${model.home.mode}`,
    `DESK        ${model.desk?.id ?? 'not configured'}`,
    `PROVIDERS   ${model.home.providers.join(' · ')}`,
    `ASSETS      ${assets.length || owners(model.surfaces).length}`,
    `SURFACES    ${counts(model.surfaces)}`,
  ]
  if (git) lines.push(`GIT         ${git.branch ?? 'detached'} · ${git.clean ? 'clean' : `${git.changes} changes`} · ${git.worktrees ?? 0} worktrees`)
  if (targets.length) lines.push(`TARGETS     ${targets.filter((item) => item.binding).length}/${targets.length} bound`)
  const activeTarget = targets.find((item) => item.active)
  if (activeTarget) lines.push(`ACTIVE      ${activeTarget.id} · ${activeTarget.evidence?.branch ?? 'detached'} · ${activeTarget.evidence?.clean ? 'clean' : 'dirty'}`)
  const warnings = model.warnings.filter((item) => item.level === 'warning')
  lines.push(`HEALTH      ${warnings.length ? `attention · ${warnings.length} warnings` : 'ready'}`)
  return lines.join('\n')
}

export function renderHudPrompt(model, plan) {
  const facts = [
    '<session>',
    `  <git>${model.probes.git ? `${model.probes.git.branch ?? 'detached'};${model.probes.git.clean ? 'clean' : 'dirty'}` : 'unknown'}</git>`,
    `  <targets>${(model.probes.targets ?? []).filter((item) => item.binding).map((item) => item.id).join(',')}</targets>`,
    `  <warnings>${model.warnings.filter((item) => item.level === 'warning').length}</warnings>`,
    '</session>',
  ].join('\n')
  return `${renderSessionPrompt(plan)}\n${facts}`
}

function renderFull(model) {
  const lines = [renderHud(model), '', 'ASSETS']
  for (const asset of model.probes.assets ?? []) {
    lines.push(`  ${asset.name}@${asset.version} · ${asset.scope} · ${asset.status}${asset.mobile ? ' · mobile source' : ''}`)
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
  lines.push('', 'CONTEXT', `  instructions          ${model.context.instructionsBytes} bytes`, `  skill descriptions   ${model.context.skillDescriptionsBytes} bytes`, `  HUD prompt            ${model.context.hudPromptBytes} bytes`)
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
  const result = {}
  for (const item of values) result[item.kind] = (result[item.kind] ?? 0) + 1
  return Object.entries(result).sort().map(([kind, count]) => `${kind}:${count}`).join(' · ')
}

function owners(values) {
  return [...new Set(values.map((item) => item.owner))].sort()
}

function warning(id, message) {
  return { id, level: 'warning', message }
}
