import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { statusEquipment } from './equipment.mjs'
import { buildHome } from './build.mjs'
import { loadDesk } from './desk.mjs'
import { loadHome } from './home.mjs'
import { EndroitError } from './lib/errors.mjs'
import { resolveHome } from './resolved.mjs'
import { runtimeTrustState } from './runtime.mjs'
import { doctorMembers } from './member.mjs'

export async function doctorHome(root) {
  let plan
  try {
    plan = await resolveHome(root)
  } catch (error) {
    if (!(error instanceof EndroitError)) throw error
    const home = await loadHome(root)
    const desk = await loadDesk(root).catch(() => null)
    return {
      status: 'partial',
      home: { name: home.name, runtime: home.runtime, providers: home.providers },
      desk: desk ? { id: desk.id, configured: true } : { configured: false },
      members: [],
      equipment: [],
      runtimes: [],
      context: null,
      frontDoor: null,
      build: error.code,
      limits: [error.code],
      warnings: [error.message],
    }
  }
  const desk = await loadDesk(root)
  const memberReport = await doctorMembers(root)
  const statuses = [
    ...await statusEquipment(root, undefined, { scope: 'home' }),
    ...await statusEquipment(root, undefined, { scope: 'desk' }),
  ]
  const limits = statuses.filter((entry) => entry.state !== 'clean').map((entry) => `equipment-${entry.state}:${entry.name}`)
  limits.push(...memberReport.issues.map((issue) => `${issue.code}${issue.member ? `:${issue.member}` : ''}`))
  const roomIssues = await inspectRooms(root, plan)
  limits.push(...roomIssues.limits)
  const runtimes = []
  for (const runtime of plan.runtimes) {
    try {
      const trust = await runtimeTrustState(root, runtime.owner, plan)
      runtimes.push({ name: runtime.owner, namespace: runtime.namespace, ...trust })
      if (trust.trust === 'pending') limits.push(`runtime-pending:${runtime.owner}`)
    } catch (error) {
      const code = error instanceof EndroitError ? error.code : error.code ?? 'runtime-invalid'
      runtimes.push({ name: runtime.owner, namespace: runtime.namespace, trust: 'pending', error: code })
      limits.push(`runtime-invalid:${runtime.owner}:${code}`)
    }
  }
  let build = 'ready'
  try {
    await buildHome(root, { check: true })
  } catch (error) {
    if (!(error instanceof EndroitError)) throw error
    build = error.code
    limits.push(`build:${error.code}`)
  }
  return {
    status: limits.length ? 'partial' : 'ready',
    home: { name: plan.home.name, runtime: plan.home.runtime, providers: plan.home.providers },
    desk: desk ? { id: desk.id, configured: true } : { configured: false },
    members: memberReport.members,
    equipment: plan.equipment.map((entry) => ({ id: entry.id, scope: entry.scope, version: entry.version, overridden: entry.overridden, roomNamespace: entry.roomNamespace })),
    runtimes,
    context: plan.context,
    frontDoor: plan.frontDoor,
    build,
    limits,
    warnings: [
      ...(!desk ? ['desk-missing: No Desk is configured; continue without one or initialize or clone one when local continuity is needed.'] : []),
      ...(!plan.frontDoor ? ['front-door-static-only: no Wake-up route is configured.'] : []),
      ...roomIssues.warnings,
    ],
  }
}

async function inspectRooms(root, plan) {
  const limits = []
  const warnings = []
  if (plan.equipment.some((entry) => entry.id === 'endroit/rooms')
    && !plan.rooms.some((entry) => entry.scope === 'home' && entry.id === 'home')) {
    limits.push('room-home-missing')
  }
  for (const room of plan.rooms) {
    const base = room.scope === 'home'
      ? join(root, 'rooms', room.id)
      : join(root, '.desk', 'rooms', room.id)
    for (const file of ['ROOM.md', 'inbox.md']) {
      try {
        const info = await lstat(join(base, file))
        if (info.isSymbolicLink() || !info.isFile()) limits.push(`room-document-invalid:${room.scope}/${room.id}/${file}`)
      } catch (error) {
        if (error.code === 'ENOENT') limits.push(`room-document-missing:${room.scope}/${room.id}/${file}`)
        else throw error
      }
    }
  }
  for (const path of [
    ['artifacts', join(root, 'artifacts')],
    ['.desk/artifacts', join(root, '.desk', 'artifacts')],
  ]) {
    try {
      if ((await lstat(path[1])).isDirectory()) warnings.push(`legacy-artifacts-root:${path[0]} is read-only; migrate its Artifacts into owning Rooms.`)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  return { limits: [...new Set(limits)], warnings }
}
