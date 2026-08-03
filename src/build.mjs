import { lstat, readFile } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { applyTransaction } from './equipment.mjs'
import { homeConsole, renderProviderBootstrap } from './front-door.mjs'
import { extractSection, readDocument } from './documents.mjs'
import { EndroitError } from './lib/errors.mjs'
import { digest, readJson, resolvePackageFile } from './lib/io.mjs'
import { provider } from './providers/index.mjs'
import { resolveHome } from './resolved.mjs'

export async function buildHome(root, options = {}) {
  const plan = await resolveHome(root)
  const statePath = join(root, '.endroit', 'build.json')
  const previous = await readJson(statePath, null)
  const wanted = await providerOutputs(plan)
  wanted.sort((left, right) => compareStrings(left.path, right.path))
  assertNoOutputCollisions(wanted)
  const mutations = await reconcileOutputs(root, previous?.outputs ?? [], wanted, Boolean(options.check))
  const state = {
    version: 1,
    revision: plan.revision ?? plan.workplace?.source_digest ?? 'legacy',
    sources: await receiptSources(plan, wanted),
    outputs: mutations.outputs,
  }
  if (options.check) {
    if (previous && JSON.stringify(previous) !== JSON.stringify(state)) throw stale('Local build state does not match the resolved Home.')
  } else {
    mutations.writes.push({ path: statePath, content: Buffer.from(`${JSON.stringify(state, null, 2)}\n`) })
  }
  if (!options.check) await applyTransaction(root, mutations.writes, mutations.deletes)
  return state
}

async function providerOutputs(plan) {
  const declaration = declarationSource(plan)
  const resolvedSources = resolvedSourcePaths(plan)
  const capabilities = new Map()
  for (const entry of plan.capabilities) {
    capabilities.set(entry.id, { ...entry, content: await readFile(await resolvePackageFile(entry.root, entry.path, `${entry.owner} Capability`), 'utf8') })
  }
  const surfaces = new Map()
  for (const item of plan.skills) mergeSurface(surfaces, item, 'skill')
  for (const item of plan.commands) mergeSurface(surfaces, item, 'command')

  const values = []
  values.push({
    path: 'endroit.mjs',
    content: Buffer.from(homeConsole()),
    provider: null,
    owner: 'endroit/kernel',
    scope: 'home',
    sources: [sourcePath(plan, declaration)],
  })
  for (const providerId of plan.workplace?.providers ?? plan.home.providers) {
    const projector = provider(providerId)
    values.push({
      path: projector.instructionPath,
      content: Buffer.from(await renderAgentContract(plan)),
      provider: providerId,
      owner: 'endroit/instructions',
      scope: 'home',
      sources: resolvedSources.length ? resolvedSources : [sourcePath(plan, declaration)],
    })
    for (const surface of [...surfaces.values()].sort((left, right) => compareStrings(left.projectedId, right.projectedId))) {
      const capability = capabilities.get(surface.capability)
      if (!capability) throw new EndroitError('capability_missing', `${surface.id} references missing ${surface.capability}.`)
      const output = projector.output(surface, capability)
      values.push({
        ...output,
        provider: providerId,
        owner: surface.owner,
        scope: surface.scope,
        sources: surfaceSourcePaths(plan, surface, capability),
        content: Buffer.from(output.content),
      })
    }
  }
  return values
}

function mergeSurface(surfaces, item, kind) {
  const key = `${item.projectedId}:${item.capability}`
  const conflicting = [...surfaces.values()].find((entry) => entry.projectedId === item.projectedId && entry.capability !== item.capability)
  if (conflicting) throw new EndroitError('surface_collision', `${item.projectedId} maps to multiple Capabilities.`)
  const surface = surfaces.get(key) ?? {
    id: item.id,
    owner: item.owner,
    scope: item.scope,
    projectedId: item.projectedId,
    capability: item.capability,
    route: item.route,
  }
  surface[kind] = item
  surfaces.set(key, surface)
}

async function renderAgentContract(plan) {
  if (plan.workplace) {
    const source = declarationSource(plan)
    const document = plan.home?.declaration
      ?? await readDocument(await resolvePackageFile(source.root, source.path, 'Workplace declaration'))
    return renderProviderBootstrap(plan, extractSection(document, 'Constitution')?.body)
  }
  const source = declarationSource(plan)
  const constitution = await readFile(await resolvePackageFile(source.root, source.path, 'Home Instruction'), 'utf8')
  return renderProviderBootstrap(plan, constitution)
}

async function reconcileOutputs(root, previous, wanted, check) {
  const wantedPaths = new Set(wanted.map((entry) => entry.path))
  const deletes = []
  for (const prior of previous) {
    if (wantedPaths.has(prior.path)) continue
    const path = join(root, prior.path)
    const current = await generatedFile(path, prior.path)
    if (!current) continue
    if (digest(current) !== prior.digest) throw diverged(prior.path)
    if (check) throw stale(`${prior.path} is a stale generated output.`)
    deletes.push(path)
  }
  const outputs = []
  const writes = []
  for (const entry of wanted) {
    const path = join(root, entry.path)
    const prior = previous.find((item) => item.path === entry.path)
    const current = await generatedFile(path, entry.path)
    if (current && prior && digest(current) !== prior.digest) throw diverged(entry.path)
    if (current && !prior && digest(current) !== digest(entry.content)) throw new EndroitError('generated_output_collision', `${entry.path} already exists and Endroit does not own it.`, { exitCode: 5 })
    if (check && (!current || digest(current) !== digest(entry.content))) throw stale(`${entry.path} needs a rebuild.`)
    if (!check && (!current || digest(current) !== digest(entry.content))) writes.push({ path, content: entry.content })
    outputs.push({
      path: entry.path,
      digest: digest(entry.content),
      provider: entry.provider,
      owner: entry.owner,
      scope: entry.scope,
      sources: [...new Set(entry.sources)].sort(),
    })
  }
  return { outputs, writes, deletes }
}

async function generatedFile(path, label) {
  try {
    const info = await lstat(path)
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new EndroitError('generated_output_invalid', `${label} must be a regular non-symlink file.`, { exitCode: 5 })
    }
    return readFile(path)
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

function assertNoOutputCollisions(outputs) {
  const owners = new Map()
  for (const output of outputs) {
    if (owners.has(output.path)) throw new EndroitError('generated_output_collision', `${output.path} is owned by both ${owners.get(output.path)} and ${output.owner}.`)
    owners.set(output.path, output.owner)
  }
}

async function receiptSources(plan, outputs) {
  const candidates = plan.sources ?? plan.workplace?.sources ?? []
  const sources = candidates.map((source) => ({
    path: sourcePath(plan, source),
    owner: source.owner,
    digest: source.digest ?? source.source_digest,
  }))
  const needed = new Set(outputs.flatMap((output) => output.sources))
  const dependencies = [
    declarationSource(plan),
    ...plan.capabilities.flatMap((capability) => [
      capability,
      { root: capability.root, path: 'equipment.json', owner: capability.owner },
    ]),
  ]
  for (const source of dependencies) {
    if (!source?.path) continue
    const path = sourcePath(plan, source)
    if (!needed.has(path) || sources.some((entry) => entry.path === path)) continue
    const file = await resolvePackageFile(source.root ?? plan.root, source.path, `${source.owner} source`)
    sources.push({ path, owner: source.owner, digest: digest(await readFile(file)) })
  }
  const receipt = sources
    .filter((source) => source.path && source.owner && source.digest)
    .sort((left, right) => compareStrings(left.path, right.path))
  const declared = new Set(receipt.map((source) => source.path))
  const missing = [...needed].filter((path) => !declared.has(path))
  if (missing.length) throw new EndroitError('build_source_missing', `Build outputs reference missing sources: ${missing.join(', ')}.`)
  return receipt
}

function sourcePath(plan, source) {
  const path = isAbsolute(source.path)
    ? relative(plan.root, source.path)
    : relative(plan.root, join(source.root ?? plan.root, source.path))
  if (!path || path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) {
    throw new EndroitError('build_source_invalid', `Build source ${source.path} is outside the Workplace.`)
  }
  return path
}

function resolvedSourcePaths(plan) {
  return [...new Set((plan.sources ?? plan.workplace?.sources ?? []).map((source) => sourcePath(plan, source)))].sort(compareStrings)
}

function surfaceSourcePaths(plan, surface, capability) {
  const paths = [
    sourcePath(plan, capability),
    sourcePath(plan, { root: capability.root, path: 'equipment.json' }),
    ...(surface.route?.path ? [sourcePath(plan, { root: plan.root, path: surface.route.path })] : []),
  ]
  return [...new Set(paths)].sort(compareStrings)
}

function declarationSource(plan) {
  if (plan.workplace?.path) {
    return {
      root: plan.root,
      path: plan.workplace.path,
      owner: plan.workplace.owner,
    }
  }
  return plan.homeInstruction
}

function compareStrings(left, right) { return left < right ? -1 : left > right ? 1 : 0 }
function stale(message) { return new EndroitError('build_stale', message, { exitCode: 5 }) }
function diverged(path) { return new EndroitError('generated_output_diverged', `${path} was edited.`, { exitCode: 5 }) }
