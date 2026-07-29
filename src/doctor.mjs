import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { statusAssets } from './assets.mjs'
import { buildHome } from './build.mjs'
import { loadDesk } from './desk.mjs'
import { loadHome } from './home.mjs'
import { HairnessError } from './lib/errors.mjs'
import { resolveHome } from './resolved.mjs'
import { runtimeTrustState } from './runtime.mjs'

export async function doctorHome(root) {
  let plan
  try {
    plan = await resolveHome(root)
  } catch (error) {
    if (!(error instanceof HairnessError)) throw error
    const [home, desk] = await Promise.all([loadHome(root), loadDesk(root)])
    return {
      status: 'partial',
      home: { name: home.name, mode: home.mode, runtime: home.runtime, providers: home.providers },
      desk: desk ? { id: desk.id, configured: true } : { configured: false },
      assets: [],
      runtimes: [],
      context: null,
      frontDoor: null,
      build: error.code,
      limits: [error.code],
      warnings: [error.message],
    }
  }
  const desk = await loadDesk(root)
  const statuses = [
    ...await statusAssets(root, undefined, { scope: 'home' }),
    ...await statusAssets(root, undefined, { scope: 'desk' }),
  ]
  const limits = statuses.filter((entry) => entry.state !== 'clean').map((entry) => `asset-${entry.state}:${entry.name}`)
  const workspaceIssues = await inspectWorkspaces(root, plan)
  limits.push(...workspaceIssues.limits)
  const runtimes = []
  for (const runtime of plan.runtimes) {
    try {
      const trust = await runtimeTrustState(root, runtime.owner, plan)
      runtimes.push({ name: runtime.owner, namespace: runtime.namespace, ...trust })
      if (trust.trust === 'pending') limits.push(`runtime-pending:${runtime.owner}`)
    } catch (error) {
      const code = error instanceof HairnessError ? error.code : error.code ?? 'runtime-invalid'
      runtimes.push({ name: runtime.owner, namespace: runtime.namespace, trust: 'pending', error: code })
      limits.push(`runtime-invalid:${runtime.owner}:${code}`)
    }
  }
  let build = 'ready'
  try {
    await buildHome(root, { check: true })
  } catch (error) {
    if (!(error instanceof HairnessError)) throw error
    build = error.code
    limits.push(`build:${error.code}`)
  }
  return {
    status: limits.length ? 'partial' : 'ready',
    home: { name: plan.home.name, mode: plan.home.mode, runtime: plan.home.runtime, providers: plan.home.providers },
    desk: desk ? { id: desk.id, configured: true } : { configured: false },
    assets: plan.assets.map((entry) => ({ id: entry.id, scope: entry.scope, version: entry.version, overridden: entry.overridden, workspaceNamespace: entry.workspaceNamespace })),
    runtimes,
    context: plan.context,
    frontDoor: plan.frontDoor,
    build,
    limits,
    warnings: [
      ...(!desk && plan.home.mode === 'team' ? ['desk-missing: invoke hairness-onboarding to clone, initialize or skip a private Desk.'] : []),
      ...(!plan.frontDoor ? ['front-door-static-only: no Wake-up route is configured.'] : []),
      ...workspaceIssues.warnings,
    ],
  }
}

async function inspectWorkspaces(root, plan) {
  const limits = []
  const warnings = []
  if (plan.assets.some((entry) => entry.id === 'hairness/workspaces')
    && !plan.workspaces.some((entry) => entry.scope === 'home' && entry.id === 'home')) {
    limits.push('workspace-home-missing')
  }
  for (const workspace of plan.workspaces) {
    const base = workspace.scope === 'home'
      ? join(root, 'workspaces', workspace.id)
      : join(root, '.desk', 'workspaces', workspace.id)
    for (const file of ['workspace.md', 'inbox.md']) {
      try {
        const info = await lstat(join(base, file))
        if (info.isSymbolicLink() || !info.isFile()) limits.push(`workspace-document-invalid:${workspace.scope}/${workspace.id}/${file}`)
      } catch (error) {
        if (error.code === 'ENOENT') limits.push(`workspace-document-missing:${workspace.scope}/${workspace.id}/${file}`)
        else throw error
      }
    }
  }
  for (const path of [
    ['artifacts', join(root, 'artifacts')],
    ['.desk/artifacts', join(root, '.desk', 'artifacts')],
  ]) {
    try {
      if ((await lstat(path[1])).isDirectory()) warnings.push(`legacy-artifacts-root:${path[0]} is read-only; migrate its Artifacts into owning Workspaces.`)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  return { limits: [...new Set(limits)], warnings }
}
