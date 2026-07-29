import Ajv2020 from 'ajv/dist/2020.js'
import { readFile, readdir } from 'node:fs/promises'
import { basename, join, relative } from 'node:path'
import { allInstalledAssets, catalogAssets } from './assets.mjs'
import { loadDesk } from './desk.mjs'
import { renderFloorPlan } from './front-door.mjs'
import { loadHome } from './home.mjs'
import { DESK_INSTRUCTION, HOME_INSTRUCTION, readInstructionFile } from './instructions.mjs'
import { HairnessError } from './lib/errors.mjs'
import { resolvePackageFile } from './lib/io.mjs'

export async function resolveHome(root) {
  const [home, desk, installed, catalog] = await Promise.all([
    loadHome(root),
    loadDesk(root),
    allInstalledAssets(root),
    catalogAssets(root),
  ])
  await readInstructionFile(join(root, HOME_INSTRUCTION), 'home_instruction')
  if (desk) await readInstructionFile(join(root, '.desk', DESK_INSTRUCTION), 'desk_instruction')
  const invalid = installed.find((entry) => entry.invalid)
  if (invalid) throw new HairnessError('asset_invalid', `${invalid.id} is invalid: ${invalid.invalid.message}`)

  const homeAssets = installed.filter((entry) => entry.scope === 'home')
  const deskAssets = installed.filter((entry) => entry.scope === 'desk')
  const effective = new Map(homeAssets.map((entry) => [entry.id, entry]))
  for (const entry of deskAssets) {
    const base = effective.get(entry.id)
    if (base && entry.manifest.origin.kind !== 'override') {
      throw new HairnessError('asset_collision', `${entry.id} exists in both Home and Desk without an override origin.`)
    }
    effective.set(entry.id, entry)
  }

  const assets = [...effective.values()].sort((left, right) => left.id.localeCompare(right.id))
  const bindings = await accessorBindings(root, home, desk)
  assertWorkspaceIdentities(bindings.workspace)
  const plan = {
    root,
    home,
    desk,
    homeInstruction: {
      id: 'home',
      owner: 'hairness/home',
      scope: 'home',
      root,
      path: HOME_INSTRUCTION,
    },
    deskInstruction: desk ? {
      id: 'desk',
      owner: 'hairness/desk',
      scope: 'desk',
      root: join(root, '.desk'),
      path: DESK_INSTRUCTION,
    } : null,
    assets: [],
    catalog,
    workspaces: bindings.workspace,
    workstreams: bindings.workstream,
    workspaceNamespaces: [],
    instructions: [],
    capabilities: [],
    skills: [],
    commands: [],
    references: [],
    artifactKinds: [],
    setup: [],
    runtimes: [],
    frontDoor: null,
  }

  for (const entry of assets) {
    const manifest = entry.manifest
    await validateSettings(entry, home.settings?.[entry.id], desk?.settings?.[entry.id])
    plan.assets.push({
      id: entry.id,
      version: manifest.version,
      description: manifest.description,
      workspaceNamespace: manifest.workspaceNamespace ?? null,
      scope: entry.scope,
      root: entry.root,
      overridden: entry.scope === 'desk' && homeAssets.some((asset) => asset.id === entry.id),
      runtime: manifest.runtime ? {
        namespace: manifest.runtime.namespace,
        entry: manifest.runtime.entry,
        commands: manifest.runtime.commands,
      } : null,
    })
    if (manifest.workspaceNamespace) {
      plan.workspaceNamespaces.push({
        id: manifest.workspaceNamespace,
        owner: entry.id,
        scope: entry.scope,
      })
    }
    for (const item of manifest.instructions ?? []) plan.instructions.push(material(entry, item))
    for (const item of manifest.capabilities ?? []) plan.capabilities.push(material(entry, item))
    for (const item of manifest.references ?? []) plan.references.push(material(entry, item))
    for (const item of manifest.skills ?? []) {
      for (const binding of item.forEach ? bindings[item.forEach] : [null]) {
        plan.skills.push(accessor(home, entry, item, 'model', binding))
      }
    }
    for (const item of manifest.commands ?? []) {
      for (const binding of item.forEach ? bindings[item.forEach] : [null]) {
        plan.commands.push(accessor(home, entry, item, 'user', binding))
      }
    }
    for (const item of manifest.artifactKinds ?? []) {
      plan.artifactKinds.push({
        ...item,
        id: canonical(entry.id, item.id),
        localId: item.id,
        owner: entry.id,
        workspaceNamespace: manifest.workspaceNamespace ?? null,
        scope: entry.scope,
        root: entry.root,
      })
    }
    for (const id of manifest.setup ?? []) plan.setup.push({ asset: entry.id, capability: canonical(entry.id, id), scope: entry.scope })
    if (manifest.runtime) {
      plan.runtimes.push({
        owner: entry.id,
        scope: entry.scope,
        root: entry.root,
        namespace: manifest.runtime.namespace,
        entry: manifest.runtime.entry,
        commands: manifest.runtime.commands,
      })
    }
  }

  assertUnique(plan.runtimes, (entry) => entry.namespace, 'runtime namespace')
  assertUnique(plan.workspaceNamespaces, (entry) => entry.id, 'Workspace namespace')
  assertUnique(plan.artifactKinds, (entry) => entry.id, 'Artifact kind')
  assertAccessors(plan.skills, plan.commands)
  plan.frontDoor = resolveFrontDoor(home.frontDoor, plan)
  plan.context = await contextFootprint(plan)
  enforceBudgets(home.budgets ?? {}, plan.context)
  return plan
}

export function publicPlan(plan) {
  const withoutRoot = (value) => {
    const { root, ...entry } = value
    return { ...entry, ...(entry.path ? { path: relative(plan.root, join(root ?? plan.root, entry.path)) } : {}) }
  }
  return {
    home: plan.home,
    desk: plan.desk,
    homeInstruction: withoutRoot(plan.homeInstruction),
    deskInstruction: plan.deskInstruction ? withoutRoot(plan.deskInstruction) : null,
    assets: plan.assets.map(withoutRoot),
    catalog: plan.catalog,
    workspaces: plan.workspaces,
    workstreams: plan.workstreams,
    workspaceNamespaces: plan.workspaceNamespaces,
    instructions: plan.instructions.map(withoutRoot),
    capabilities: plan.capabilities.map(withoutRoot),
    skills: plan.skills.map(withoutRoot),
    commands: plan.commands.map(withoutRoot),
    references: plan.references.map(withoutRoot),
    artifactKinds: plan.artifactKinds.map(withoutRoot),
    setup: plan.setup,
    runtimes: plan.runtimes.map(withoutRoot),
    frontDoor: plan.frontDoor,
    context: plan.context,
  }
}

function material(entry, item) {
  return {
    ...item,
    id: canonical(entry.id, item.id),
    localId: item.id,
    owner: entry.id,
    scope: entry.scope,
    root: entry.root,
  }
}

function accessor(home, entry, item, invocation, binding) {
  const assetPrefix = entry.manifest.prefix ?? basename(entry.id)
  const projectedId = [home.prefix, assetPrefix, item.id, binding && slug(binding.id)].filter(Boolean).join('-')
  return {
    ...item,
    id: canonical(entry.id, item.id),
    localId: item.id,
    projectedId,
    capability: canonical(entry.id, item.capability),
    invocation,
    ...(binding ? { binding } : {}),
    owner: entry.id,
    scope: entry.scope,
    root: entry.root,
  }
}

async function accessorBindings(root, home, desk) {
  const values = { workspace: [], workstream: [], target: [] }
  const scopes = [
    { scope: 'home', root: join(root, 'workspaces') },
    ...(desk ? [{ scope: 'desk', root: join(root, '.desk', 'workspaces') }] : []),
  ]
  for (const candidate of scopes) {
    const workspacesRoot = candidate.root
    for (const workspace of await directories(workspacesRoot)) {
      values.workspace.push({
        kind: 'workspace',
        id: workspace,
        scope: candidate.scope,
        ref: `workspace:${candidate.scope}/${workspace}`,
        path: relative(root, join(workspacesRoot, workspace, 'workspace.md')),
        emoji: await documentEmoji(join(workspacesRoot, workspace, 'workspace.md')),
      })
      for (const workstream of await directories(join(workspacesRoot, workspace, 'workstreams'))) {
        values.workstream.push({
          kind: 'workstream',
          id: `${workspace}/${workstream}`,
          scope: candidate.scope,
          workspace,
          ref: `workstream:${candidate.scope}/${workspace}/${workstream}`,
          path: relative(root, join(workspacesRoot, workspace, 'workstreams', workstream, 'workstream.md')),
          emoji: await documentEmoji(join(workspacesRoot, workspace, 'workstreams', workstream, 'workstream.md')),
        })
      }
    }
  }
  for (const target of home.settings?.['hairness/targets']?.targets ?? []) {
    values.target.push({
      kind: 'target',
      id: target.id,
      ref: `target:${target.id}`,
      emoji: target.emoji ?? null,
    })
  }
  return values
}

function assertWorkspaceIdentities(workspaces) {
  const scopes = new Map()
  for (const workspace of workspaces) {
    const current = scopes.get(workspace.id)
    if (current) {
      throw new HairnessError('workspace_collision', `Workspace ${workspace.id} exists in both ${current} and ${workspace.scope} scope.`)
    }
    scopes.set(workspace.id, workspace.scope)
  }
}

async function directories(path) {
  return (await readdir(path, { withFileTypes: true }).catch((error) => error.code === 'ENOENT' ? [] : Promise.reject(error)))
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .map((entry) => entry.name)
    .sort()
}

async function documentEmoji(path) {
  const content = await readFile(path, 'utf8').catch((error) => error.code === 'ENOENT' ? '' : Promise.reject(error))
  const raw = content.match(/^emoji:\s*(.+)$/m)?.[1]?.trim()
  return raw ? raw.replace(/^"|"$/g, '') : null
}

function slug(value) {
  return String(value).replace(/[^a-z0-9._-]+/g, '-').replace(/^-|-$/g, '')
}

async function validateSettings(entry, homeSettings, deskSettings) {
  const paths = entry.manifest.settings ?? {}
  if (paths.home) await validateSetting(entry, paths.home, homeSettings ?? {}, 'Home')
  else if (homeSettings !== undefined) throw new HairnessError('settings_schema_missing', `${entry.id} does not accept Home settings.`)
  if (paths.desk) await validateSetting(entry, paths.desk, deskSettings ?? {}, 'Desk')
  else if (deskSettings !== undefined) throw new HairnessError('settings_schema_missing', `${entry.id} does not accept Desk settings.`)
}

async function validateSetting(entry, path, value, scope) {
  const schemaPath = await resolvePackageFile(entry.root, path, `${entry.id} ${scope} settings schema`)
  const schema = JSON.parse(await readFile(schemaPath, 'utf8'))
  const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema)
  if (!validate(value)) {
    const message = validate.errors.map((error) => `${error.instancePath || '/'} ${error.message}`).join('; ')
    throw new HairnessError('settings_invalid', `${scope} settings for ${entry.id} are invalid: ${message}.`)
  }
}

async function contextFootprint(plan) {
  const floorPlanBytes = Buffer.byteLength(renderFloorPlan(plan))
  const instructionBytes = floorPlanBytes + await sumFiles([plan.homeInstruction, ...plan.instructions.filter((item) => item.scope === 'home')])
  const deskInstructionBytes = await sumFiles([...(plan.deskInstruction ? [plan.deskInstruction] : []), ...plan.instructions.filter((item) => item.scope === 'desk')])
  const modelDescriptionBytes = Buffer.byteLength(plan.skills.map((item) => item.description).join('\n'))
  return { instructionBytes, floorPlanBytes, deskInstructionBytes, modelDescriptionBytes }
}

function resolveFrontDoor(frontDoor, plan) {
  if (!frontDoor) return null
  const separator = frontDoor.wakeUp.lastIndexOf(':')
  const owner = frontDoor.wakeUp.slice(0, separator)
  const command = frontDoor.wakeUp.slice(separator + 1)
  const runtime = plan.runtimes.find((entry) => entry.owner === owner)
  if (!runtime) throw new HairnessError('front_door_runtime_missing', `${frontDoor.wakeUp} references an Asset without an effective runtime.`)
  if (!runtime.commands.some((entry) => entry.name === command)) {
    throw new HairnessError('front_door_command_missing', `${frontDoor.wakeUp} references an undeclared runtime command.`)
  }
  return {
    route: frontDoor.wakeUp,
    owner,
    namespace: runtime.namespace,
    command,
  }
}

async function sumFiles(entries) {
  let bytes = 0
  for (const entry of entries) bytes += (await readFile(await resolvePackageFile(entry.root, entry.path, `${entry.owner} material`))).byteLength
  return bytes
}

function enforceBudgets(budgets, context) {
  const values = [
    ['instructionsBytes', context.instructionBytes + context.deskInstructionBytes],
    ['modelDescriptionsBytes', context.modelDescriptionBytes],
  ]
  for (const [key, actual] of values) {
    if (budgets[key] !== undefined && actual > budgets[key]) {
      throw new HairnessError('context_budget_exceeded', `${key} is ${actual} bytes, over the ${budgets[key]} byte budget.`)
    }
  }
}

function assertUnique(entries, key, label) {
  const owners = new Map()
  for (const entry of entries) {
    const id = key(entry)
    if (owners.has(id)) throw new HairnessError('surface_collision', `${label} ${id} is owned by both ${owners.get(id)} and ${entry.owner}.`)
    owners.set(id, entry.owner)
  }
}

function assertAccessors(skills, commands) {
  const claims = new Map()
  for (const entry of [...skills, ...commands]) {
    const key = `${entry.invocation}:${entry.projectedId}`
    const current = claims.get(key)
    if (current) throw new HairnessError('surface_collision', `${entry.invocation} surface ${entry.projectedId} is owned by both ${current} and ${entry.owner}.`)
    claims.set(key, entry.owner)
  }
}

function canonical(owner, id) {
  return `${owner}:${id}`
}
