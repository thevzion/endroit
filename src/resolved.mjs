import { readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { assetStatus, installedAssets } from './assets.mjs'
import { validateAgainstSchema } from './contracts.mjs'
import { inspectRepository } from './git.mjs'
import { loadDesk, loadHome, settingsFor } from './home.mjs'
import { HairnessError } from './lib/errors.mjs'
import { digest, resolvePackageFile } from './lib/io.mjs'

const kernelOperations = new Set([
  'kernel:artifacts.create',
  'kernel:artifacts.list',
  'kernel:artifacts.inspect',
  'kernel:artifacts.validate',
  'kernel:artifacts.publish',
  'kernel:commands.render',
  'kernel:desk.clone',
  'kernel:desk.init',
  'kernel:desk.status',
  'kernel:hud.show',
  'kernel:integrations.add',
  'kernel:integrations.bind',
  'kernel:integrations.doctor',
  'kernel:integrations.list',
  'kernel:integrations.remove',
  'kernel:integrations.unbind',
  'kernel:scratch.create',
  'kernel:targets.add',
  'kernel:targets.bind',
  'kernel:targets.discover',
  'kernel:targets.doctor',
  'kernel:targets.list',
  'kernel:targets.remove',
  'kernel:targets.unbind',
  'kernel:targets.use',
])
const kernelNamespaces = new Set(['create', 'init', 'asset', 'validate', 'build', 'doctor'])

export async function resolveHome(root) {
  const [home, desk, installed] = await Promise.all([loadHome(root), loadDesk(root), installedAssets(root)])
  const invalid = installed.find((entry) => entry.invalid)
  if (invalid) throw new HairnessError('asset_invalid', `${invalid.scope} Asset ${invalid.id} is invalid: ${invalid.invalid.message}`)
  const statuses = await Promise.all(installed.map(assetStatus))
  const assets = []
  const instructions = []
  const capabilities = []
  const references = []
  const skills = []
  const commands = []
  const cli = []
  const artifactKinds = []
  const executables = []
  const hud = []
  const setup = []
  const warnings = []
  const projectedClaims = new Map()
  const cliClaims = new Map()
  const canonicalClaims = new Map()

  for (const entry of installed) {
    const manifest = entry.manifest
    await validateSettings(entry, home, desk)
    const asset = {
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      prefix: manifest.prefix ?? null,
      scope: entry.scope,
      root: entry.root,
      status: statuses.find((status) => status.name === entry.id && status.scope === entry.scope)?.state,
      mobile: manifest.origin?.mobile ?? false,
    }
    assets.push(asset)

    for (const item of manifest.instructions ?? []) {
      const content = await text(entry, item.source)
      const value = material(entry, item, 'instruction', content)
      claim(canonicalClaims, `instruction:${value.id}`, manifest.name)
      instructions.push(value)
    }
    for (const item of manifest.capabilities ?? []) {
      const content = await text(entry, item.source)
      const value = material(entry, item, 'capability', content)
      claim(canonicalClaims, `capability:${value.id}`, manifest.name)
      capabilities.push(value)
    }
    for (const item of manifest.references ?? []) {
      const content = await text(entry, item.source)
      references.push({ ...material(entry, item, 'reference', content), description: item.description })
    }

    const assetCapabilities = new Set((manifest.capabilities ?? []).map((item) => item.id))
    for (const item of manifest.skills ?? []) {
      const value = surface(entry, item, 'skill', home)
      value.capability = canonical(manifest.name, item.capability)
      if (!assetCapabilities.has(item.capability)) throw new HairnessError('asset_invalid', `${value.id} references a missing Capability.`)
      assertProjected(projectedClaims, value)
      skills.push(value)
    }
    for (const item of manifest.commands ?? []) {
      const value = surface(entry, item, 'command', home)
      value.capability = canonical(manifest.name, item.capability)
      if (!assetCapabilities.has(item.capability)) throw new HairnessError('asset_invalid', `${value.id} references a missing Capability.`)
      assertProjected(projectedClaims, value)
      commands.push(value)
    }

    for (const group of manifest.cli ?? []) for (const route of group.routes) {
      if (kernelNamespaces.has(group.namespace)) throw new HairnessError('cli_collision', `${manifest.name} cannot claim Kernel namespace ${group.namespace}.`)
      const id = `${group.namespace} ${route.name}`
      claim(cliClaims, id, manifest.name)
      if (route.operation && !kernelOperations.has(route.operation)) throw new HairnessError('operation_unsupported', `${manifest.name} declares unsupported ${route.operation}.`)
      cli.push({
        id,
        namespace: group.namespace,
        name: route.name,
        owner: manifest.name,
        scope: entry.scope,
        ...(route.operation ? { operation: route.operation } : {}),
        ...(route.executable ? { executable: canonical(manifest.name, route.executable) } : {}),
        ...(route.defaults ? { defaults: route.defaults } : {}),
      })
    }

    for (const item of manifest.artifactKinds ?? []) {
      const id = canonical(manifest.name, item.id)
      claim(canonicalClaims, `artifact:${id}`, manifest.name)
      artifactKinds.push({
        ...item,
        id,
        localId: item.id,
        owner: manifest.name,
        scope: entry.scope,
        root: entry.root,
      })
    }
    for (const item of manifest.executables ?? []) {
      const id = canonical(manifest.name, item.id)
      claim(canonicalClaims, `executable:${id}`, manifest.name)
      executables.push({ ...item, id, localId: item.id, owner: manifest.name, scope: entry.scope, root: entry.root })
    }
    for (const item of manifest.hud ?? []) hud.push({ ...item, id: canonical(manifest.name, item.id), localId: item.id, owner: manifest.name, scope: entry.scope })
    for (const item of manifest.setup ?? []) setup.push({ ...item, command: canonical(manifest.name, item.command), owner: manifest.name })
  }

  const capabilityIds = new Set(capabilities.map((item) => item.id))
  for (const item of [...skills, ...commands]) if (!capabilityIds.has(item.capability)) throw new HairnessError('capability_missing', `${item.id} references missing ${item.capability}.`)
  const commandIds = new Set(commands.map((item) => item.id))
  for (const item of setup) if (!commandIds.has(item.command)) throw new HairnessError('command_missing', `Setup references missing ${item.command}.`)
  const executableIds = new Set(executables.map((item) => item.id))
  for (const route of cli) if (route.executable && !executableIds.has(route.executable)) throw new HairnessError('executable_missing', `${route.id} references missing ${route.executable}.`)

  for (const provider of home.providers) warnings.push(...projectionWarnings(provider, home, skills, commands))

  const context = {
    instructionsBytes: byteCount(instructions.filter((item) => item.scope === 'home').map((item) => item.content).join('\n\n')),
    skillDescriptionsBytes: byteCount(skills.map((item) => item.description).join('\n')),
    hudPromptBytes: 0,
    byAsset: contextByAsset(instructions, skills),
  }
  const plan = {
    home,
    desk,
    assets,
    instructions: sort(instructions),
    capabilities: sort(capabilities),
    references: sort(references),
    skills: sort(skills),
    commands: sort(commands),
    cli: sort(cli),
    artifactKinds: sort(artifactKinds),
    executables: sort(executables),
    hud: sort(hud),
    setup: sort(setup),
    context,
    warnings: warnings.sort((left, right) => left.id.localeCompare(right.id)),
  }
  plan.context.hudPromptBytes = byteCount(renderSessionPrompt(plan))
  validateBudgets(plan)
  plan.digest = digest(stable(publicPlan(plan)))
  return plan
}

export function publicPlan(plan) {
  return {
    digest: plan.digest,
    home: plan.home,
    desk: plan.desk,
    assets: plan.assets.map(withoutRoot),
    instructions: plan.instructions.map(withoutContent),
    capabilities: plan.capabilities.map(withoutContent),
    references: plan.references.map(withoutContent),
    skills: plan.skills,
    commands: plan.commands,
    cli: plan.cli,
    artifactKinds: plan.artifactKinds.map(withoutRoot),
    executables: plan.executables.map(withoutRoot),
    hud: plan.hud,
    setup: plan.setup,
    context: plan.context,
    warnings: plan.warnings,
  }
}

export function renderSessionPrompt(plan) {
  const lines = [
    '<hairness-hud version="1">',
    `  <home name="${escapeXml(plan.home.name)}" mode="${plan.home.mode}"/>`,
    plan.desk ? `  <desk id="${escapeXml(plan.desk.id)}"/>` : '  <desk missing="true"/>',
    '  <instructions>',
  ]
  for (const item of plan.instructions) {
    lines.push(`    <instruction owner="${escapeXml(item.owner)}" scope="${item.scope}">`)
    lines.push(indent(item.content.trim(), 6))
    lines.push('    </instruction>')
  }
  lines.push('  </instructions>', '</hairness-hud>')
  return lines.join('\n')
}

export async function homeGitState(root) {
  try {
    const evidence = await inspectRepository(root)
    const worktrees = await import('./git.mjs').then(({ git }) => git(['worktree', 'list', '--porcelain'], { cwd: root }))
    return {
      branch: evidence.branch,
      head: evidence.head,
      clean: evidence.clean,
      changes: evidence.changes.length,
      worktrees: worktrees.split('\n').filter((line) => line.startsWith('worktree ')).length,
    }
  } catch (error) {
    return { available: false, error: error.message }
  }
}

async function validateSettings(entry, home, desk) {
  for (const scope of ['home', 'desk']) {
    const source = entry.manifest.settings?.[scope]
    if (!source) continue
    const document = scope === 'home' ? home : desk
    const value = settingsFor(document, entry.manifest.name)
    const path = await resolvePackageFile(entry.root, source, `${entry.manifest.name} ${scope} settings schema`)
    let schema
    try { schema = JSON.parse(await readFile(path, 'utf8')) }
    catch (error) { throw new HairnessError('settings_schema_invalid', `${relative(entry.root, path)} is not valid JSON.`, { cause: error }) }
    await validateAgainstSchema(value, schema, `${entry.manifest.name} ${scope} settings`)
  }
}

async function text(entry, source) {
  return readFile(await resolvePackageFile(entry.root, source, `${entry.manifest.name} source`), 'utf8')
}

function material(entry, item, kind, content) {
  return {
    id: canonical(entry.manifest.name, item.id),
    localId: item.id,
    kind,
    owner: entry.manifest.name,
    scope: entry.scope,
    source: item.source,
    content,
  }
}

function surface(entry, item, kind, home) {
  return {
    id: canonical(entry.manifest.name, item.id),
    localId: item.id,
    kind,
    owner: entry.manifest.name,
    scope: entry.scope,
    projectedName: projected(home.projection?.prefix ?? 'hairness', entry.manifest.prefix, item.id),
    ...(kind === 'skill' ? { description: item.description } : { summary: item.summary }),
  }
}

function canonical(asset, localId) {
  return `${asset}:${localId}`
}

function projected(homePrefix, assetPrefix, localId) {
  return [homePrefix, assetPrefix, localId].filter(Boolean).join('-')
}

function assertProjected(claims, item) {
  const current = claims.get(item.projectedName)
  if (current && current !== item.id) throw new HairnessError('projection_collision', `${item.projectedName} is claimed by both ${current} and ${item.id}.`)
  claims.set(item.projectedName, item.id)
}

function projectionWarnings(provider, home, skills, commands) {
  const warnings = []
  const skillIds = new Set(skills.map((item) => item.id))
  const commandIds = new Set(commands.map((item) => item.id))
  const lossy = new Set(settingsFor(home, 'hairness/home').lossyProjection ?? [])
  for (const id of new Set([...skillIds, ...commandIds])) {
    const hasSkill = skillIds.has(id)
    const hasCommand = commandIds.has(id)
    if (provider === 'codex' && hasCommand && !hasSkill && !lossy.has(`${provider}:${id}`)) {
      warnings.push({
        id: `projection.${provider}.${id}.command-omitted`,
        level: 'warning',
        provider,
        surface: id,
        message: 'Codex cannot guarantee user-only invocation; the Command is omitted.',
      })
    } else if (hasSkill && !hasCommand) {
      warnings.push({
        id: `projection.${provider}.${id}.manual-invocation`,
        level: 'info',
        provider,
        surface: id,
        message: 'The provider may still allow manual invocation of this model-facing Skill.',
      })
    }
  }
  return warnings
}

function contextByAsset(instructions, skills) {
  const owners = new Set([...instructions.map((item) => item.owner), ...skills.map((item) => item.owner)])
  return Object.fromEntries([...owners].sort().map((owner) => [owner, {
    instructionsBytes: byteCount(instructions.filter((item) => item.owner === owner && item.scope === 'home').map((item) => item.content).join('\n\n')),
    skillDescriptionsBytes: byteCount(skills.filter((item) => item.owner === owner).map((item) => item.description).join('\n')),
  }]))
}

function validateBudgets(plan) {
  const budgets = plan.home.projection?.budgets ?? {}
  for (const [name, limit] of Object.entries(budgets)) {
    if (plan.context[name] > limit) throw new HairnessError('context_budget_exceeded', `${name} is ${plan.context[name]} bytes; Home budget is ${limit}.`, { details: { name, actual: plan.context[name], limit } })
  }
}

function claim(claims, id, owner) {
  const current = claims.get(id)
  if (current && current !== owner) throw new HairnessError('surface_collision', `${id} is claimed by both ${current} and ${owner}.`)
  claims.set(id, owner)
}

function sort(values) {
  return values.sort((left, right) => String(left.id).localeCompare(String(right.id)))
}

function byteCount(value) {
  return Buffer.byteLength(value, 'utf8')
}

function withoutRoot(value) {
  const { root, ...rest } = value
  return rest
}

function withoutContent(value) {
  const { content, ...rest } = value
  return rest
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]))
  return value
}

function escapeXml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

function indent(value, spaces) {
  const prefix = ' '.repeat(spaces)
  return value.split('\n').map((line) => `${prefix}${line}`).join('\n')
}
