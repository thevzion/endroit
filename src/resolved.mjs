import Ajv2020 from 'ajv/dist/2020.js'
import { readFile } from 'node:fs/promises'
import { basename, join, relative } from 'node:path'
import { allInstalledAssets } from './assets.mjs'
import { loadDesk } from './desk.mjs'
import { loadHome } from './home.mjs'
import { DESK_INSTRUCTION, HOME_INSTRUCTION, readInstructionFile } from './instructions.mjs'
import { HairnessError } from './lib/errors.mjs'
import { resolvePackageFile } from './lib/io.mjs'

export async function resolveHome(root) {
  const [home, desk, installed] = await Promise.all([loadHome(root), loadDesk(root), allInstalledAssets(root)])
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
    instructions: [],
    capabilities: [],
    skills: [],
    commands: [],
    references: [],
    artifactKinds: [],
    setup: [],
    runtimes: [],
  }

  for (const entry of assets) {
    const manifest = entry.manifest
    await validateSettings(entry, home.settings?.[entry.id], desk?.settings?.[entry.id])
    plan.assets.push({
      id: entry.id,
      version: manifest.version,
      description: manifest.description,
      scope: entry.scope,
      root: entry.root,
      overridden: entry.scope === 'desk' && homeAssets.some((asset) => asset.id === entry.id),
      runtime: manifest.runtime ? {
        namespace: manifest.runtime.namespace,
        entry: manifest.runtime.entry,
        commands: manifest.runtime.commands,
      } : null,
    })
    for (const item of manifest.instructions ?? []) plan.instructions.push(material(entry, item))
    for (const item of manifest.capabilities ?? []) plan.capabilities.push(material(entry, item))
    for (const item of manifest.references ?? []) plan.references.push(material(entry, item))
    for (const item of manifest.skills ?? []) plan.skills.push(accessor(home, entry, item, 'model'))
    for (const item of manifest.commands ?? []) plan.commands.push(accessor(home, entry, item, 'user'))
    for (const item of manifest.artifactKinds ?? []) {
      plan.artifactKinds.push({
        ...item,
        id: canonical(entry.id, item.id),
        localId: item.id,
        owner: entry.id,
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
  assertUnique(plan.artifactKinds, (entry) => entry.id, 'Artifact kind')
  assertAccessors(plan.skills, plan.commands)
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
    instructions: plan.instructions.map(withoutRoot),
    capabilities: plan.capabilities.map(withoutRoot),
    skills: plan.skills.map(withoutRoot),
    commands: plan.commands.map(withoutRoot),
    references: plan.references.map(withoutRoot),
    artifactKinds: plan.artifactKinds.map(withoutRoot),
    setup: plan.setup,
    runtimes: plan.runtimes.map(withoutRoot),
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

function accessor(home, entry, item, invocation) {
  const assetPrefix = entry.manifest.prefix ?? basename(entry.id)
  const projectedId = [home.prefix, assetPrefix, item.id].filter(Boolean).join('-')
  return {
    ...item,
    id: canonical(entry.id, item.id),
    localId: item.id,
    projectedId,
    capability: canonical(entry.id, item.capability),
    invocation,
    owner: entry.id,
    scope: entry.scope,
    root: entry.root,
  }
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
  const instructionBytes = await sumFiles([plan.homeInstruction, ...plan.instructions.filter((item) => item.scope === 'home')])
  const deskInstructionBytes = await sumFiles([...(plan.deskInstruction ? [plan.deskInstruction] : []), ...plan.instructions.filter((item) => item.scope === 'desk')])
  const modelDescriptionBytes = Buffer.byteLength(plan.skills.map((item) => item.description).join('\n'))
  return { instructionBytes, deskInstructionBytes, modelDescriptionBytes }
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
