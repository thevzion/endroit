import { readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { applyTransaction } from './assets.mjs'
import { git } from './git.mjs'
import { HairnessError } from './lib/errors.mjs'
import { digest, exists, readJson, resolvePackageFile, writeFileAtomic } from './lib/io.mjs'
import { provider } from './providers/index.mjs'
import { resolveHome } from './resolved.mjs'

const managedRegion = /<!-- hairness:begin id="agent-contract" -->[\s\S]*?<!-- hairness:end id="agent-contract" -->/

export async function buildHome(root, options = {}) {
  const plan = await resolveHome(root)
  const statePath = join(root, '.hairness', 'build.json')
  const previous = await readJson(statePath, null)
  const wanted = await providerOutputs(plan)
  wanted.sort((left, right) => left.path.localeCompare(right.path))
  assertNoOutputCollisions(wanted)
  const mutations = await reconcileOutputs(root, previous?.outputs ?? [], wanted, Boolean(options.check))
  const writes = [...mutations.writes]
  const managed = []

  for (const id of ['codex', 'claude']) {
    const projector = provider(id)
    const active = plan.home.providers.includes(id)
    const instructionPath = join(root, projector.instructionPath)
    const instruction = await planManagedText(instructionPath, active ? await renderAgentContract(plan, projector) : null, options.check)
    if (instruction.managed) managed.push(relativeManaged(root, instruction.managed))
    if (instruction.write) writes.push(instruction.write)

    const hookPath = join(root, projector.hookPath)
    const hook = await planHookConfig(hookPath, active, projector, options.check)
    if (hook.managed) managed.push(relativeManaged(root, hook.managed))
    if (hook.write) writes.push(hook.write)
  }

  const state = { version: 1, outputs: mutations.outputs, managed }
  if (options.check) {
    if (previous && JSON.stringify(previous) !== JSON.stringify(state)) throw stale('Local build state does not match the resolved Home.')
  } else {
    writes.push({ path: statePath, content: Buffer.from(`${JSON.stringify(state, null, 2)}\n`) })
  }
  await reconcileDeskExcludes(root, plan, mutations.outputs, Boolean(options.check))
  if (!options.check) await applyTransaction(root, writes, mutations.deletes)
  return state
}

async function providerOutputs(plan) {
  const capabilities = new Map()
  for (const entry of plan.capabilities) {
    capabilities.set(entry.id, { ...entry, content: await readFile(await resolvePackageFile(entry.root, entry.path, `${entry.owner} Capability`), 'utf8') })
  }
  const surfaces = new Map()
  for (const item of plan.skills) mergeSurface(surfaces, item, 'skill')
  for (const item of plan.commands) mergeSurface(surfaces, item, 'command')

  const values = []
  for (const providerId of plan.home.providers) {
    const projector = provider(providerId)
    values.push({
      path: projector.sessionPath,
      content: Buffer.from(sessionWrapper(providerId)),
      provider: providerId,
      owner: 'hairness/kernel',
      scope: 'home',
    })
    for (const surface of [...surfaces.values()].sort((left, right) => left.projectedId.localeCompare(right.projectedId))) {
      const capability = capabilities.get(surface.capability)
      if (!capability) throw new HairnessError('capability_missing', `${surface.id} references missing ${surface.capability}.`)
      const output = projector.output(surface, capability)
      values.push({ ...output, provider: providerId, owner: surface.owner, scope: surface.scope, content: Buffer.from(output.content) })
    }
  }
  return values
}

function mergeSurface(surfaces, item, kind) {
  const key = `${item.projectedId}:${item.capability}`
  const conflicting = [...surfaces.values()].find((entry) => entry.projectedId === item.projectedId && entry.capability !== item.capability)
  if (conflicting) throw new HairnessError('surface_collision', `${item.projectedId} maps to multiple Capabilities.`)
  const surface = surfaces.get(key) ?? {
    id: item.id,
    owner: item.owner,
    scope: item.scope,
    projectedId: item.projectedId,
    capability: item.capability,
  }
  surface[kind] = item
  surfaces.set(key, surface)
}

async function renderAgentContract(plan, projector) {
  const entries = []
  for (const instruction of plan.instructions.filter((entry) => entry.scope === 'home')) {
    const content = await readFile(await resolvePackageFile(instruction.root, instruction.path, `${instruction.owner} Instruction`), 'utf8')
    entries.push(`### ${instruction.owner}\n\n${content.trim()}`)
  }
  return `<!-- hairness:begin id="agent-contract" -->\n## Hairness Home\n\n- If no Hairness HUD was injected, run \`node ${projector.sessionPath}\` once. If it reports an unavailable HUD, stop recovery and tell the collaborator instead of exploring the Home.\n- Treat provider files as projections; edit Home or Asset sources instead.\n\n${entries.join('\n\n')}\n<!-- hairness:end id="agent-contract" -->`
}

async function reconcileOutputs(root, previous, wanted, check) {
  const wantedPaths = new Set(wanted.map((entry) => entry.path))
  const deletes = []
  for (const prior of previous) {
    if (wantedPaths.has(prior.path)) continue
    const path = join(root, prior.path)
    if (!await exists(path)) continue
    if (digest(await readFile(path)) !== prior.digest) throw diverged(prior.path)
    if (check) throw stale(`${prior.path} is a stale generated output.`)
    deletes.push(path)
  }
  const outputs = []
  const writes = []
  for (const entry of wanted) {
    const path = join(root, entry.path)
    const prior = previous.find((item) => item.path === entry.path)
    const current = await readFile(path).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error))
    if (current && prior && digest(current) !== prior.digest) throw diverged(entry.path)
    if (current && !prior && digest(current) !== digest(entry.content)) throw new HairnessError('generated_output_collision', `${entry.path} already exists and Hairness does not own it.`, { exitCode: 5 })
    if (check && (!current || digest(current) !== digest(entry.content))) throw stale(`${entry.path} needs a rebuild.`)
    if (!check && (!current || digest(current) !== digest(entry.content))) writes.push({ path, content: entry.content })
    outputs.push({ path: entry.path, provider: entry.provider, owner: entry.owner, scope: entry.scope, digest: digest(entry.content) })
  }
  return { outputs, writes, deletes }
}

async function planManagedText(path, block, check) {
  const current = await readFile(path, 'utf8').catch((error) => error.code === 'ENOENT' ? '' : Promise.reject(error))
  const next = block
    ? managedRegion.test(current) ? current.replace(managedRegion, block) : `${current.trimEnd()}${current.trim() ? '\n\n' : ''}${block}\n`
    : current.replace(managedRegion, '').trimStart()
  if (check && current !== next) throw stale(`${path} needs a managed-region rebuild.`)
  return {
    managed: block ? { path, digest: digest(next) } : null,
    write: !check && current !== next ? { path, content: Buffer.from(next) } : null,
  }
}

async function planHookConfig(path, active, projector, check) {
  const currentText = await readFile(path, 'utf8').catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error))
  if (!active && currentText === null) return { managed: null, write: null }
  const current = currentText ? JSON.parse(currentText) : {}
  current.hooks ??= {}
  const entries = (current.hooks.SessionStart ?? []).flatMap((entry) => {
    const hooks = (entry.hooks ?? []).filter((hook) => !hairnessSessionHook(hook.command))
    return hooks.length ? [{ ...entry, hooks }] : []
  })
  if (active) entries.push(projector.hook())
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

function hairnessSessionHook(command = '') {
  return /hairness.* hud --prompt$/.test(command) || /hairness-session-start\.mjs$/.test(command)
}

function sessionWrapper(providerId) {
  return `#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { lstatSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const provider = ${JSON.stringify(providerId)}
const homeRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const unavailable = '<hairness-hud status="unavailable" reason="runtime-unavailable"/>'

try {
  const home = JSON.parse(readFileSync(join(homeRoot, 'hairness.json'), 'utf8'))
  if (!/^@hairness\\/cli@[0-9]+\\.[0-9]+\\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(home.runtime)) throw new Error('Invalid runtime.')
  const development = join(homeRoot, '.hairness', 'dev-cli')
  let local = false
  try { lstatSync(development); local = true }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  const command = local ? development : process.platform === 'win32' ? 'npx.cmd' : 'npx'
  const args = local
    ? ['hud', '--prompt', '--home', homeRoot]
    : ['--yes', home.runtime, 'hud', '--prompt', '--home', homeRoot]
  const result = await execute(command, args, local ? 'development' : 'registry')
  const context = result.code === 0 && /^<hairness-hud(?:\\s|>)/.test(result.stdout.trim())
    ? result.stdout.trim()
    : unavailable
  emit(context)
} catch {
  emit(unavailable)
}

function emit(context) {
  if (provider === 'codex') {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: context,
      },
    }) + '\\n')
  } else {
    process.stdout.write(context + '\\n')
  }
}

function execute(command, args, source) {
  return new Promise((resolvePromise) => {
    let output = ''
    let settled = false
    let timer
    const child = spawn(command, args, {
      cwd: homeRoot,
      env: { ...process.env, HAIRNESS_RUNTIME_SOURCE: source },
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise(value)
    }
    timer = setTimeout(() => {
      child.kill('SIGTERM')
      finish({ code: null, stdout: '' })
    }, 30_000)
    child.on('error', () => finish({ code: null, stdout: '' }))
    child.stdout.on('data', (chunk) => {
      output += chunk
      if (Buffer.byteLength(output) > 256 * 1024) {
        child.kill('SIGTERM')
        finish({ code: null, stdout: '' })
      }
    })
    child.on('close', (code) => finish({ code, stdout: output }))
  })
}
`
}

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
  const base = current.replace(region, '')
  const paths = plan.home.mode === 'team' && plan.desk
    ? outputs.filter((entry) => entry.scope === 'desk').map((entry) => `/${entry.path}`).sort()
    : []
  const block = paths.length ? `# hairness:desk-projections begin\n${paths.join('\n')}\n# hairness:desk-projections end\n` : ''
  const next = block ? `${base.trimEnd()}${base.trim() ? '\n' : ''}${block}` : `${base.trimEnd()}${base.trim() ? '\n' : ''}`
  if (check && current !== next) throw stale('Local Git excludes do not match Desk projections.')
  if (!check && current !== next) await writeFileAtomic(path, next, 0o644)
}

function assertNoOutputCollisions(outputs) {
  const owners = new Map()
  for (const output of outputs) {
    if (owners.has(output.path)) throw new HairnessError('generated_output_collision', `${output.path} is owned by both ${owners.get(output.path)} and ${output.owner}.`)
    owners.set(output.path, output.owner)
  }
}

function relativeManaged(root, entry) { return { ...entry, path: relative(root, entry.path) } }
function stale(message) { return new HairnessError('build_stale', message, { exitCode: 5 }) }
function diverged(path) { return new HairnessError('generated_output_diverged', `${path} was edited.`, { exitCode: 5 }) }
