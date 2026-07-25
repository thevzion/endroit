#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { lstat, readFile, readdir, realpath } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
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
    if (budget !== undefined && Buffer.byteLength(prompt) > budget) {
      throw failure('hud_budget_exceeded', `HUD prompt is ${Buffer.byteLength(prompt)} bytes, over the ${budget} byte budget.`)
    }
    process.stdout.write(`${prompt}\n`)
  } else {
    process.stdout.write(`${human(model, args.includes('--full'))}\n`)
  }
} catch (error) {
  process.stderr.write(`${error.code ?? 'hud_failed'}: ${error.message}\n`)
  process.exitCode = error.exitCode ?? 4
}

async function hud(input) {
  const { resolvedHome: plan, homeRoot, deskRoot } = input
  const preferences = plan.desk?.settings?.['hairness/onboarding'] ?? {}
  const [homeGit, deskGit, artifacts, recentDesk, projections] = await Promise.all([
    gitProbe(homeRoot),
    deskRoot ? gitProbe(deskRoot) : null,
    scanArtifacts(homeRoot, deskRoot),
    deskRoot ? recentFiles(deskRoot) : [],
    projectionProbe(homeRoot, plan.home.providers),
  ])
  const targets = await scanTargets(plan.home.settings?.['hairness/targets']?.targets ?? [], deskRoot, artifacts)
  const trust = {
    runtimes: (input.runtimeTrust ?? []).sort((left, right) => left.owner.localeCompare(right.owner)),
  }
  trust.firstParty = trust.runtimes.filter((entry) => entry.trusted && entry.source === 'distribution').length
  trust.externalApproved = trust.runtimes.filter((entry) => entry.trusted && entry.source === 'local').length
  trust.pending = trust.runtimes.filter((entry) => !entry.trusted).length

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
    if (!target.bindings.length) attention.push(item('warning', `target:${target.id}`, 'target-unbound', `${target.id} has no local Binding.`))
    if (target.map.state === 'missing') attention.push(item('advisory', `target:${target.id}`, 'target-map-missing', `${target.id} has no Target Map.`))
    if (target.map.state === 'stale') attention.push(item('advisory', `target:${target.id}`, 'target-map-stale', `${target.id} Target Map is stale.`))
    for (const binding of target.bindings) {
      if (!binding.git?.available) attention.push(item('blocking', `target:${target.id}/${binding.id}`, 'target-broken', 'Binding is not a usable Git checkout.'))
      else if (binding.git.conflicts) attention.push(item('blocking', `target:${target.id}/${binding.id}`, 'target-conflicts', `Binding has ${binding.git.conflicts} conflict(s).`))
      else if (!binding.git.clean) attention.push(item('advisory', `target:${target.id}/${binding.id}`, 'target-dirty', `Binding has ${binding.git.changes} change(s).`))
    }
  }
  for (const runtime of trust.runtimes.filter((entry) => !entry.trusted)) {
    attention.push(item('blocking', `runtime:${runtime.owner}`, 'runtime-untrusted', `${runtime.owner} requires approval before execution.`))
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
    apiVersion: 'hairness.dev/hud/v1alpha1',
    generatedAt: new Date().toISOString(),
    status: severity,
    event: process.env.HAIRNESS_HUD_EVENT ?? 'on-demand',
    home: {
      name: plan.home.name,
      mode: plan.home.mode,
      root: homeRoot,
      providers: plan.home.providers,
      git: homeGit,
    },
    kernel: input.kernel ?? {
      runtime: plan.home.runtime,
      source: process.env.HAIRNESS_RUNTIME_SOURCE === 'development' ? 'development' : 'registry',
      invoke: process.env.HAIRNESS_RUNTIME_SOURCE === 'development' ? '.hairness/dev-cli' : `npx --yes ${plan.home.runtime}`,
    },
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
      hudPromptBudgetBytes: plan.home.budgets?.hudPromptBytes ?? null,
    },
    targets,
    artifacts,
    recentDesk,
    trust,
    attention: groupedAttention,
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
    const current = maps.find((artifact) => heads.has(String(artifact.derivedFrom ?? '').replace(`target:${target.id}@`, '')))
    const selected = current ?? maps[0] ?? null
    return {
      ...target,
      state: bindings.length ? 'bound' : 'declared',
      bindings,
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
      run(['worktree', 'list', '--porcelain']),
    ])
    const state = parseStatus(status)
    const worktrees = []
    for (const entry of parseWorktrees(worktreeOutput)) {
      const worktreeStatus = await run(['status', '--porcelain=v2', '--branch', '--untracked-files=all'], entry.path).catch(() => '')
      worktrees.push({ ...entry, ...parseStatus(worktreeStatus), current: entry.path === top })
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
  let current
  for (const line of value.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current) entries.push(current)
      current = { path: line.slice(9) }
    } else if (current && line.startsWith('HEAD ')) current.head = line.slice(5)
    else if (current && line.startsWith('branch ')) current.branch = line.slice(7).replace('refs/heads/', '')
    else if (current && line === 'detached') current.detached = true
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
    `SURFACES    ${model.surfaces.assets.length} assets · ${model.surfaces.skills.length} skills · ${model.surfaces.commands.length} commands · ${model.surfaces.runtimes.map((entry) => entry.namespace).join(',')}`,
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
    `<hairness-hud version="1" status="${model.status}" generated-at="${model.generatedAt}" event="${escape(model.event)}">`,
    `  <home name="${escape(model.home.name)}" mode="${model.home.mode}" root="${escape(model.home.root)}" providers="${model.home.providers.join(',')}"/>`,
    `  <kernel runtime="${escape(model.kernel.runtime)}" source="${model.kernel.source}" invoke="${escape(model.kernel.invoke)}"/>`,
  ]
  if (model.collaborator) {
    lines.push(`  <collaborator id="${escape(model.collaborator.id)}"${model.collaborator.addressAs ? ` address-as="${escape(model.collaborator.addressAs)}"` : ''}${model.collaborator.responseLanguage ? ` response-language="${escape(model.collaborator.responseLanguage)}"` : ''}/>`)
  }
  lines.push(`  <desk configured="${model.desk.configured}"${model.desk.configured ? ` id="${escape(model.desk.id)}" root="${escape(model.desk.root)}"` : ''}/>`)
  lines.push(`  ${gitXml('home-git', model.home.git)}`)
  if (model.desk.configured) lines.push(`  ${gitXml('desk-git', model.desk.git)}`)
  lines.push('  <projections>')
  for (const projection of model.projections) {
    lines.push(`    <provider id="${projection.id}" status="${projection.status}" instruction="${escape(projection.instruction)}" hook="${escape(projection.hook)}"/>`)
  }
  lines.push('  </projections>', '  <surfaces>', '    <assets>')
  for (const asset of model.surfaces.assets) {
    lines.push(`      <asset id="${escape(asset.id)}" version="${escape(asset.version)}" scope="${asset.scope}" overridden="${asset.overridden}"${asset.runtime ? ` runtime="${escape(asset.runtime.namespace)}"` : ''}/>`)
  }
  lines.push('    </assets>', '    <skills>')
  for (const skill of model.surfaces.skills) {
    lines.push(`      <skill id="${escape(skill.projectedId)}" owner="${escape(skill.owner)}" invocation="${skill.invocation}" description="${escape(skill.description)}"/>`)
  }
  lines.push('    </skills>', '    <commands>')
  for (const command of model.surfaces.commands) {
    lines.push(`      <command id="${escape(command.projectedId)}" owner="${escape(command.owner)}" invocation="${command.invocation}" description="${escape(command.description)}"/>`)
  }
  lines.push('    </commands>', '    <runtimes>')
  for (const runtime of model.surfaces.runtimes) {
    lines.push(`      <runtime owner="${escape(runtime.owner)}" namespace="${escape(runtime.namespace)}" scope="${runtime.scope}">`)
    for (const command of runtime.commands) lines.push(`        <command name="${escape(command.name)}" description="${escape(command.description)}"/>`)
    lines.push('      </runtime>')
  }
  lines.push('    </runtimes>', '  </surfaces>', '  <targets>')
  for (const target of model.targets) {
    lines.push(`    <target id="${escape(target.id)}" state="${target.state}" repository="${escape(target.repository)}">`)
    for (const binding of target.bindings) {
      lines.push(`      <binding id="${escape(binding.id)}" type="${binding.type}" mount="${escape(binding.mount)}"${binding.root ? ` root="${escape(binding.root)}"` : ''} usable="${binding.git.available}">`)
      if (binding.git.available) {
        lines.push(`        ${gitXml('git', binding.git)}`, '        <worktrees>')
        for (const worktree of binding.git.worktrees) {
          lines.push(`          <worktree path="${escape(worktree.path)}"${worktree.branch ? ` branch="${escape(worktree.branch)}"` : ''}${worktree.head ? ` head="${worktree.head}"` : ''} clean="${worktree.clean}" current="${worktree.current}"/>`)
        }
        lines.push('        </worktrees>')
      }
      lines.push('      </binding>')
    }
    lines.push(`      <map state="${target.map.state}" count="${target.map.count}"${target.map.path ? ` path="${escape(target.map.path)}"` : ''}${target.map.derivedFrom ? ` derived-from="${escape(target.map.derivedFrom)}"` : ''}${target.map.generatedAt ? ` generated-at="${escape(target.map.generatedAt)}"` : ''} route="${escape(target.map.route)}"/>`)
    lines.push('    </target>')
  }
  lines.push('  </targets>', `  <artifacts count="${model.artifacts.count}">`)
  for (const artifact of model.artifacts.items) {
    lines.push(`    <artifact${artifact.id ? ` id="${escape(artifact.id)}"` : ''}${artifact.kind ? ` kind="${escape(artifact.kind)}"` : ''} scope="${artifact.scope}"${artifact.owner ? ` owner="${escape(artifact.owner)}"` : ''}${artifact.state ? ` state="${escape(artifact.state)}"` : ''} path="${escape(artifact.path)}"/>`)
  }
  lines.push('  </artifacts>', `  <context instructions-bytes="${model.context.instructionBytes}" desk-instructions-bytes="${model.context.deskInstructionBytes}" model-descriptions-bytes="${model.context.modelDescriptionBytes}"${model.context.hudPromptBudgetBytes === null ? '' : ` hud-budget-bytes="${model.context.hudPromptBudgetBytes}"`}/>`)
  lines.push(`  <trust first-party="${model.trust.firstParty}" external-approved="${model.trust.externalApproved}" pending="${model.trust.pending}">`)
  for (const runtime of model.trust.runtimes) lines.push(`    <runtime owner="${escape(runtime.owner)}" namespace="${escape(runtime.namespace)}" trusted="${runtime.trusted}"${runtime.source ? ` source="${runtime.source}"` : ''}/>`)
  lines.push('  </trust>', '  <recent-desk>')
  for (const entry of model.recentDesk) lines.push(`    <file path="${escape(entry.path)}" modified-at="${entry.modifiedAt}"/>`)
  lines.push('  </recent-desk>', '  <desk-instructions>')
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
