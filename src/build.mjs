import { readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { applyTransaction } from './assets.mjs'
import { approveExecutable, runExecutable } from './executables.mjs'
import { git } from './git.mjs'
import { HairnessError } from './lib/errors.mjs'
import { digest, exists, readJson, writeFileAtomic } from './lib/io.mjs'
import { provider } from './providers/index.mjs'
import { resolveHome } from './resolved.mjs'

const managedRegion = /<!-- hairness:begin id="agent-contract" -->[\s\S]*?<!-- hairness:end id="agent-contract" -->/

export async function buildHome(root, options = {}) {
  const plan = await resolveHome(root)
  const statePath = join(root, '.hairness', 'build.json')
  const previous = await readJson(statePath, null)
  const wanted = providerOutputs(plan)
  const executableBuild = await executableOutputs(root, plan, options, previous)
  wanted.push(...executableBuild.outputs)
  wanted.sort((left, right) => left.path.localeCompare(right.path))
  assertNoOutputCollisions(wanted)
  const mutations = await reconcileOutputs(root, previous?.outputs ?? [], wanted, Boolean(options.check))
  const managed = []
  const writes = [...mutations.writes]
  for (const id of ['codex', 'claude']) {
    const projector = provider(id)
    const active = plan.home.providers.includes(id)
    const instructionPath = join(root, projector.instructionPath)
    const instruction = await planManagedText(instructionPath, active ? renderAgentContract(plan) : null, options.check)
    managed.push(relativeManaged(root, instruction.managed))
    if (instruction.write) writes.push(instruction.write)
    const hookPath = join(root, projector.hookPath)
    const hook = await planHookConfig(hookPath, active, projector, plan.home.runtime, options.check)
    managed.push(relativeManaged(root, hook.managed))
    if (hook.write) writes.push(hook.write)
  }
  const state = {
    version: 2,
    planDigest: plan.digest,
    outputs: mutations.outputs,
    managed: managed.filter(Boolean),
    executables: executableBuild.executables,
  }
  if (options.check) {
    if (previous && JSON.stringify(previous) !== JSON.stringify(state)) throw stale('Local build state does not match the resolved Home.')
  } else {
    writes.push({ path: statePath, content: Buffer.from(`${JSON.stringify(state, null, 2)}\n`), mode: 0o600 })
  }
  await reconcileDeskExcludes(root, plan, mutations.outputs, Boolean(options.check))
  if (!options.check) await applyTransaction(root, writes, mutations.deletes)
  return state
}

function providerOutputs(plan) {
  const values = []
  const capabilities = new Map(plan.capabilities.map((item) => [item.id, item]))
  const skillMap = new Map(plan.skills.map((item) => [item.id, item]))
  const commandMap = new Map(plan.commands.map((item) => [item.id, item]))
  const lossy = new Set(plan.home.settings?.['hairness/home']?.lossyProjection ?? [])
  for (const providerId of plan.home.providers) {
    const projector = provider(providerId)
    for (const id of [...new Set([...skillMap.keys(), ...commandMap.keys()])].sort()) {
      const skill = skillMap.get(id)
      const command = commandMap.get(id)
      const surface = {
        id,
        owner: skill?.owner ?? command.owner,
        projectedName: skill?.projectedName ?? command.projectedName,
        skill,
        command,
      }
      const capability = capabilities.get(skill?.capability ?? command.capability)
      const output = projector.output(surface, capability, { allowLossy: lossy.has(`${providerId}:${id}`) })
      if (output) values.push({ ...output, provider: providerId, owner: surface.owner, scope: skill?.scope ?? command.scope })
    }
  }
  return values
}

async function executableOutputs(root, plan, options, previous) {
  const values = []
  const built = []
  const allowed = new Set(Array.isArray(options.allowExecutables) ? options.allowExecutables : options.allowExecutables ? [options.allowExecutables] : [])
  for (const executable of plan.executables.filter((entry) => entry.runOn === 'build')) {
    if (allowed.has(executable.id) || allowed.has(executable.localId)) await approveExecutable(root, executable)
    if (options.check) {
      const prior = (previous?.outputs ?? []).filter((entry) => entry.provider === 'executable' && entry.owner === executable.owner)
      if (!prior.length) throw stale(`${executable.id} has not completed an approved build.`)
      values.push(...prior.map((entry) => ({ ...entry, content: null, scope: executable.scope })))
      built.push(executable.id)
      continue
    }
    const files = await runExecutable(root, executable, {
      home: { id: plan.home.name, providers: plan.home.providers },
      settings: plan.home.settings?.[executable.owner] ?? {},
    })
    for (const file of files) {
      if (reserved(file.path)) throw new HairnessError('executable_output_reserved', `${executable.id} wrote reserved output ${file.path}.`)
      values.push({ path: file.path, provider: 'executable', owner: executable.owner, scope: executable.scope, content: file.content })
    }
    built.push(executable.id)
  }
  return { outputs: values, executables: built.sort() }
}

async function reconcileOutputs(root, previous, wanted, check) {
  const normalized = []
  for (const entry of wanted) {
    if (entry.content !== null) normalized.push(entry)
    else {
      const current = await readFile(join(root, entry.path)).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error))
      if (!current || digest(current) !== entry.digest) throw stale(`${entry.path} needs an approved executable rebuild.`)
      normalized.push({ ...entry, content: current })
    }
  }
  const wantedPaths = new Set(normalized.map((entry) => entry.path))
  const removals = []
  for (const prior of previous) {
    if (wantedPaths.has(prior.path)) continue
    const path = join(root, prior.path)
    if (!await exists(path)) continue
    if (digest(await readFile(path)) !== prior.digest) throw diverged(prior.path)
    if (check) throw stale(`${prior.path} is a stale generated output.`)
    removals.push(path)
  }
  const outputs = []
  const writes = []
  for (const entry of normalized) {
    const path = join(root, entry.path)
    const prior = previous.find((item) => item.path === entry.path)
    const current = await readFile(path).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error))
    if (current && prior && digest(current) !== prior.digest) throw diverged(entry.path)
    if (current && !prior && digest(current) !== digest(entry.content)) throw new HairnessError('generated_output_collision', `${entry.path} already exists and Hairness does not own it.`, { exitCode: 5 })
    if (check && (!current || digest(current) !== digest(entry.content))) throw stale(`${entry.path} needs a rebuild.`)
    if (!check && (!current || digest(current) !== digest(entry.content))) writes.push({ path, content: entry.content })
    outputs.push({ path: entry.path, provider: entry.provider, owner: entry.owner, scope: entry.scope ?? 'home', digest: digest(entry.content) })
  }
  return { outputs, writes, deletes: removals }
}

function renderAgentContract(plan) {
  const instructions = plan.instructions.filter((entry) => entry.scope === 'home')
  return `<!-- hairness:begin id="agent-contract" -->\n## Hairness Home\n\n- Run \`npx --yes ${plan.home.runtime} hud --prompt\` when no Hairness HUD was injected for this session.\n- Treat provider files as projections; edit Home or Asset sources instead.\n\n${instructions.map((entry) => `### ${entry.owner}\n\n${entry.content.trim()}`).join('\n\n')}\n<!-- hairness:end id="agent-contract" -->`
}

async function planManagedText(path, block, check) {
  const current = await readFile(path, 'utf8').catch((error) => error.code === 'ENOENT' ? '' : Promise.reject(error))
  const next = block ? managedRegion.test(current) ? current.replace(managedRegion, block) : `${current.trimEnd()}${current.trim() ? '\n\n' : ''}${block}\n` : current.replace(managedRegion, '').trimStart()
  if (check && current !== next) throw stale(`${path} needs a managed-region rebuild.`)
  return {
    managed: block ? { path, digest: digest(next) } : null,
    write: !check && current !== next ? { path, content: Buffer.from(next) } : null,
  }
}

async function planHookConfig(path, active, projector, runtime, check) {
  const currentText = await readFile(path, 'utf8').catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error))
  if (!active && currentText === null) return { managed: null, write: null }
  const current = currentText ? JSON.parse(currentText) : {}
  current.hooks ??= {}
  const entries = (current.hooks.SessionStart ?? []).flatMap((entry) => {
    const hooks = (entry.hooks ?? []).filter((hook) => !/hairness.* hud --prompt$/.test(hook.command ?? ''))
    return hooks.length ? [{ ...entry, hooks }] : []
  })
  if (active) entries.push(projector.hook(runtime))
  if (entries.length) current.hooks.SessionStart = entries
  else delete current.hooks.SessionStart
  if (!Object.keys(current.hooks).length) delete current.hooks
  const next = `${JSON.stringify(current, null, 2)}\n`
  if (check && currentText !== next) throw stale(`${path} needs a SessionStart hook rebuild.`)
  return {
    managed: active ? { path, digest: digest(next) } : null,
    write: !check && currentText !== next ? { path, content: Buffer.from(next) } : null,
  }
}

function assertNoOutputCollisions(outputs) {
  const owners = new Map()
  for (const output of outputs) {
    if (owners.has(output.path)) throw new HairnessError('generated_output_collision', `${output.path} is owned by both ${owners.get(output.path)} and ${output.owner}.`)
    owners.set(output.path, output.owner)
  }
}

function reserved(path) {
  return ['hairness.json', 'AGENTS.md', 'CLAUDE.md', '.codex/hooks.json', '.claude/settings.json', '.hairness'].some((entry) => path === entry || path.startsWith(`${entry}/`))
}

function relativeManaged(root, entry) { return entry ? { ...entry, path: relative(root, entry.path) } : null }
function stale(message) { return new HairnessError('build_stale', message, { exitCode: 5 }) }
function diverged(path) { return new HairnessError('generated_output_diverged', `${path} was edited.`, { exitCode: 5 }) }

async function reconcileDeskExcludes(root, plan, outputs, check) {
  let path
  try {
    path = await git(['rev-parse', '--git-path', 'info/exclude'], { cwd: root })
  } catch {
    return
  }
  if (!path.startsWith('/')) path = join(root, path)
  const current = await readFile(path, 'utf8').catch((error) => error.code === 'ENOENT' ? '' : Promise.reject(error))
  const region = /# hairness:desk-projections begin\n[\s\S]*?# hairness:desk-projections end\n?/g
  const withoutRegion = current.replace(region, '')
  const paths = plan.home.mode === 'team' && plan.desk
    ? outputs.filter((entry) => entry.scope === 'desk').map((entry) => `/${entry.path}`).sort()
    : []
  const block = paths.length
    ? `# hairness:desk-projections begin\n${paths.join('\n')}\n# hairness:desk-projections end\n`
    : ''
  const next = block
    ? `${withoutRegion.trimEnd()}${withoutRegion.trim() ? '\n' : ''}${block}`
    : current === withoutRegion ? current : `${withoutRegion.trimEnd()}${withoutRegion.trim() ? '\n' : ''}`
  if (check && current !== next) throw stale('Local Git excludes do not match Desk projections.')
  if (!check && current !== next) await writeFileAtomic(path, next, 0o644)
}
