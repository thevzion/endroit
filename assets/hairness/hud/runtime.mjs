#!/usr/bin/env node
import { execFile } from 'node:child_process'
import { lstat, readFile, readdir, realpath } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)

try {
  const input = JSON.parse(await stdin())
  const model = await hud(input)
  const args = input.argv.filter((value) => value !== 'show')
  if (args.includes('--json')) process.stdout.write(`${JSON.stringify(model, null, 2)}\n`)
  else if (args.includes('--prompt')) {
    const prompt = await xml(model, input)
    const budget = input.resolvedHome.home.budgets?.hudPromptBytes
    if (budget !== undefined && Buffer.byteLength(prompt) > budget) throw failure('hud_budget_exceeded', `HUD prompt is ${Buffer.byteLength(prompt)} bytes, over the ${budget} byte budget.`)
    process.stdout.write(`${prompt}\n`)
  } else process.stdout.write(`${human(model, args.includes('--full'))}\n`)
} catch (error) {
  process.stderr.write(`${error.code ?? 'hud_failed'}: ${error.message}\n`)
  process.exitCode = error.exitCode ?? 4
}

async function hud(input) {
  const { resolvedHome: plan, homeRoot, deskRoot } = input
  const git = await gitProbe(homeRoot)
  const artifacts = await scanArtifacts(homeRoot, deskRoot)
  const targets = await scanTargets(plan.home.settings?.['hairness/targets']?.targets ?? [], deskRoot, artifacts)
  const recentDesk = deskRoot ? await recentFiles(deskRoot) : []
  const warnings = []
  if (!deskRoot && plan.home.mode === 'team') warnings.push({ code: 'desk-missing', message: 'No private Desk is configured; invoke hairness-onboarding to clone, initialize or skip one.' })
  if (!git.available) warnings.push({ code: 'home-git-unavailable', message: git.error })
  for (const target of targets) {
    if (!target.bindings.length) warnings.push({ code: `target-unbound:${target.id}`, message: `${target.id} has no local Binding.` })
    for (const binding of target.bindings) {
      if (!binding.git?.available) warnings.push({ code: `target-broken:${target.id}:${binding.id}`, message: `${target.id}/${binding.id} is not a usable Git checkout.` })
      else if (binding.git.conflicts) warnings.push({ code: `target-conflicts:${target.id}:${binding.id}`, message: `${target.id}/${binding.id} has ${binding.git.conflicts} conflict(s).` })
    }
  }
  return {
    apiVersion: 'hairness.dev/hud/v1alpha1',
    generatedAt: new Date().toISOString(),
    home: { name: plan.home.name, mode: plan.home.mode, runtime: plan.home.runtime, providers: plan.home.providers },
    desk: plan.desk ? { configured: true, id: plan.desk.id } : { configured: false },
    surfaces: {
      assets: plan.assets.length,
      instructions: plan.instructions.length,
      capabilities: plan.capabilities.length,
      skills: plan.skills.length,
      commands: plan.commands.length,
      runtimes: plan.runtimes.length,
      artifactKinds: plan.artifactKinds.length,
      namespaces: plan.runtimes.map((entry) => entry.namespace).sort(),
    },
    context: plan.context,
    git,
    targets,
    artifacts,
    recentDesk,
    assets: plan.assets.map((asset) => ({
      id: asset.id,
      version: asset.version,
      scope: asset.scope,
      overridden: asset.overridden,
      runtime: asset.runtime,
    })),
    warnings,
  }
}

async function scanTargets(targets, deskRoot, artifacts) {
  return Promise.all(targets.map(async (target) => {
    const bindings = []
    const root = deskRoot && join(deskRoot, 'targets', target.id)
    if (root) {
      for (const entry of await safeReadDir(root)) {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
        const path = join(root, entry.name)
        const type = entry.isSymbolicLink() ? 'bound' : 'managed'
        const resolved = await realpath(path).catch(() => null)
        bindings.push({ id: entry.name, type, path: resolved, git: resolved ? await gitProbe(resolved) : { available: false, error: 'Broken Binding.' } })
      }
    }
    const heads = bindings.map((binding) => binding.git?.head).filter(Boolean)
    const maps = artifacts.items.filter((artifact) => artifact.kind === 'hairness/targets:target-map' && artifact.targets?.includes(target.id))
    const current = maps.some((artifact) => heads.some((head) => artifact.derivedFrom === `target:${target.id}@${head}`))
    return { ...target, state: bindings.length ? 'bound' : 'declared', bindings, map: { count: maps.length, state: current ? 'current' : maps.length ? 'stale' : 'missing' } }
  }))
}

async function scanArtifacts(homeRoot, deskRoot) {
  const items = []
  for (const [scope, root] of [['home', join(homeRoot, 'artifacts')], ['desk', deskRoot && join(deskRoot, 'artifacts')]]) {
    if (!root) continue
    for (const path of await findNamed(root, 'artifact.md')) {
      try {
        const metadata = frontmatter(await readFile(path, 'utf8'))
        items.push({ ...metadata, scope, path: relative(homeRoot, path).replace(/\/artifact\.md$/, '') })
      } catch (error) {
        items.push({ scope, path: relative(homeRoot, path), invalid: error.message })
      }
    }
  }
  const counts = {}
  for (const item of items) counts[item.state ?? 'invalid'] = (counts[item.state ?? 'invalid'] ?? 0) + 1
  return { count: items.length, counts, items }
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
  return values.sort((left, right) => right.time - left.time || left.path.localeCompare(right.path)).slice(0, 5).map(({ time: _time, ...entry }) => entry)
}

async function gitProbe(root) {
  try {
    const run = (args) => exec('git', args, { cwd: root, maxBuffer: 8 * 1024 * 1024 }).then((value) => value.stdout.trim())
    const [top, head, branch, status, committedAt, worktrees] = await Promise.all([
      run(['rev-parse', '--show-toplevel']),
      run(['rev-parse', 'HEAD']),
      run(['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => null),
      run(['status', '--porcelain=v2', '--branch', '--untracked-files=all']),
      run(['log', '-1', '--format=%cI']),
      run(['worktree', 'list', '--porcelain']),
    ])
    const changes = status.split('\n').filter((line) => /^(1 |2 |u |\? )/.test(line))
    const divergence = status.match(/^# branch\.ab \+(\d+) -(\d+)$/m)
    return {
      available: true,
      root: top,
      head,
      branch,
      clean: changes.length === 0,
      changes: changes.length,
      conflicts: changes.filter((line) => line.startsWith('u ')).length,
      ahead: divergence ? Number(divergence[1]) : 0,
      behind: divergence ? Number(divergence[2]) : 0,
      committedAt,
      worktrees: worktrees.split('\n').filter((line) => line.startsWith('worktree ')).length,
    }
  } catch (error) {
    return { available: false, error: error.stderr?.trim() || error.message }
  }
}

function human(model, full) {
  const lines = [
    `HAIRNESS    ${model.home.name} · ${model.home.mode} · ${model.home.providers.join('+')} · ${model.home.runtime}`,
    `DESK        ${model.desk.configured ? model.desk.id : 'missing'} · recent:${model.recentDesk.length}`,
    `SURFACES    ${model.surfaces.assets} assets · ${model.surfaces.skills} skills · ${model.surfaces.commands} commands · ${model.surfaces.namespaces.join(',')}`,
    `ARTIFACTS   ${model.artifacts.count} · ${Object.entries(model.artifacts.counts).map(([key, value]) => `${key}:${value}`).join(' ') || 'none'}`,
    `GIT         ${model.git.available ? `${model.git.branch ?? 'detached'} · ${model.git.clean ? 'clean' : `${model.git.changes} changes`} · ${short(model.git.head)} · ${model.git.worktrees} worktrees · ${date(model.git.committedAt)}` : 'unavailable'}`,
    `TARGETS     ${model.targets.length} declared · ${model.targets.reduce((sum, target) => sum + target.bindings.length, 0)} bindings`,
  ]
  for (const target of model.targets) lines.push(`  ${target.id.padEnd(18)} ${target.bindings.map((binding) => `${binding.id}:${binding.git?.clean ? 'clean' : binding.git?.available ? 'dirty' : 'broken'}`).join(' · ') || 'unbound'} · map:${target.map.state}`)
  lines.push(`CONTEXT     instructions:${model.context.instructionBytes}B · desk:${model.context.deskInstructionBytes}B · model:${model.context.modelDescriptionBytes}B`)
  if (model.recentDesk.length) lines.push('RECENT DESK', ...model.recentDesk.map((entry) => `  ${entry.modifiedAt}  ${entry.path}`))
  if (model.warnings.length) lines.push('WARNINGS', ...model.warnings.map((entry) => `  ${entry.code}: ${entry.message}`))
  if (full) {
    lines.push('ASSETS', ...model.assets.map((asset) => `  ${asset.id}@${asset.version} · ${asset.scope}${asset.overridden ? ' · override' : ''}${asset.runtime ? ` · ${asset.runtime.namespace}` : ''}`))
    lines.push('ARTIFACT INVENTORY', ...model.artifacts.items.map((artifact) => `  ${artifact.kind ?? 'invalid'}:${artifact.id ?? artifact.path} · ${artifact.scope} · ${artifact.state ?? 'invalid'}`))
  }
  return lines.join('\n')
}

async function xml(model, input) {
  const deskInstructions = []
  for (const instruction of input.resolvedHome.instructions.filter((entry) => entry.scope === 'desk')) {
    deskInstructions.push({ owner: instruction.owner, content: await readFile(join(instruction.root, instruction.path), 'utf8') })
  }
  const lines = [
    '<hairness-hud version="1">',
    `  <home name="${escape(model.home.name)}" mode="${model.home.mode}" runtime="${escape(model.home.runtime)}" providers="${model.home.providers.join(',')}"/>`,
    `  <desk configured="${model.desk.configured}"${model.desk.id ? ` id="${escape(model.desk.id)}"` : ''}/>`,
    `  <surfaces assets="${model.surfaces.assets}" skills="${model.surfaces.skills}" commands="${model.surfaces.commands}" runtimes="${model.surfaces.runtimes}" namespaces="${escape(model.surfaces.namespaces.join(','))}"/>`,
    `  <git available="${model.git.available}"${model.git.available ? ` branch="${escape(model.git.branch ?? 'detached')}" head="${model.git.head}" clean="${model.git.clean}" changes="${model.git.changes}" conflicts="${model.git.conflicts}" worktrees="${model.git.worktrees}" committed-at="${model.git.committedAt}"` : ''}/>`,
    '  <targets>',
  ]
  for (const target of model.targets) {
    lines.push(`    <target id="${escape(target.id)}" state="${target.state}" map="${target.map.state}">`)
    for (const binding of target.bindings) lines.push(`      <binding id="${escape(binding.id)}" type="${binding.type}" usable="${binding.git.available}"${binding.git.available ? ` branch="${escape(binding.git.branch ?? 'detached')}" head="${binding.git.head}" clean="${binding.git.clean}" conflicts="${binding.git.conflicts}" committed-at="${binding.git.committedAt}" worktrees="${binding.git.worktrees}"` : ''}/>`)
    lines.push('    </target>')
  }
  lines.push('  </targets>', `  <artifacts count="${model.artifacts.count}"/>`, '  <recent-desk>')
  for (const entry of model.recentDesk) lines.push(`    <file path="${escape(entry.path)}" modified-at="${entry.modifiedAt}"/>`)
  lines.push('  </recent-desk>', '  <desk-instructions>')
  for (const instruction of deskInstructions) lines.push(`    <instruction owner="${escape(instruction.owner)}">${escape(instruction.content)}</instruction>`)
  lines.push('  </desk-instructions>', '  <warnings>')
  for (const warning of model.warnings) lines.push(`    <warning code="${escape(warning.code)}">${escape(warning.message)}</warning>`)
  lines.push('  </warnings>', '</hairness-hud>')
  return lines.join('\n')
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
  try { return (await readdir(path, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name)) }
  catch (error) { if (error.code === 'ENOENT') return []; throw error }
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
