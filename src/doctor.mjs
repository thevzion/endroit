import { join } from 'node:path'
import { assetStatus, installedAssets } from './assets.mjs'
import { buildHome } from './build.mjs'
import { RUNTIME, loadDesk, loadHome } from './home.mjs'
import { doctorIntegrations } from './integrations.mjs'
import { exists } from './lib/io.mjs'
import { resolveHome } from './resolved.mjs'
import { doctorTargets } from './targets.mjs'

export async function doctorHome(root) {
  const [home, desk, installed] = await Promise.all([loadHome(root), loadDesk(root), installedAssets(root)])
  const assets = await Promise.all(installed.map(assetStatus))
  const errors = []
  const warnings = []
  if (home.runtime !== RUNTIME) errors.push(`runtime-mismatch:${home.runtime}`)
  if (await exists(join(root, 'hairness.lock.json'))) errors.push('legacy-home-lock-present')
  for (const asset of assets) {
    if (['missing', 'invalid'].includes(asset.state)) errors.push(`asset-${asset.state}:${asset.name}`)
    if (asset.mobile) warnings.push(`asset-mobile:${asset.name}`)
  }
  let plan = null
  try {
    plan = await resolveHome(root)
    warnings.push(...plan.warnings.filter((warning) => warning.level === 'warning').map((warning) => warning.id))
  } catch (error) {
    errors.push(`resolve:${error.code ?? 'invalid'}`)
  }
  let build = 'ready'
  try { await buildHome(root, { check: true }) }
  catch (error) {
    build = 'stale'
    errors.push(`build:${error.code ?? 'invalid'}`)
  }
  const [targets, integrations] = await Promise.all([doctorTargets(root), doctorIntegrations(root)])
  warnings.push(...targets.limits, ...integrations.limits)
  return {
    status: errors.length ? 'error' : 'ready',
    home: { name: home.name, mode: home.mode, providers: home.providers },
    desk: desk ? { id: desk.id } : null,
    kernel: { runtime: home.runtime, current: RUNTIME },
    plan: plan ? { digest: plan.digest, context: plan.context } : null,
    assets,
    targets: targets.targets,
    integrations: integrations.integrations,
    build,
    errors,
    warnings: [...new Set(warnings)].sort(),
    routes: repairRoutes(errors, warnings),
  }
}

function repairRoutes(errors, warnings) {
  const values = [...errors, ...warnings]
  const routes = []
  if (values.some((item) => item.startsWith('build:'))) routes.push('hairness build')
  if (values.some((item) => item.startsWith('target-'))) routes.push('hairness target doctor')
  if (values.some((item) => item.startsWith('integration-'))) routes.push('hairness integration doctor')
  if (values.some((item) => item.startsWith('asset-'))) routes.push('hairness asset status')
  if (values.some((item) => item.startsWith('runtime-'))) routes.push('use hairness.json#runtime')
  return routes
}
