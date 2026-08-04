import Ajv2020 from 'ajv/dist/2020.js'
import { readFile, readdir, realpath } from 'node:fs/promises'
import { basename, join, relative } from 'node:path'
import { allInstalledEquipment, catalogEquipment } from './equipment.mjs'
import { deskGitBoundary, loadDesk } from './desk.mjs'
import { renderFloorPlan } from './front-door.mjs'
import { loadHome, WORKPLACE_INSTRUCTION } from './home.mjs'
import { DESK_INSTRUCTION } from './instructions.mjs'
import { EndroitError } from './lib/errors.mjs'
import { digest, resolvePackageFile } from './lib/io.mjs'
import { loadSites } from './sites.mjs'
import { loadRoutes } from './routes.mjs'
import { listMembers } from './member.mjs'

export async function resolveHome(root) {
  root = await realpath(root)
  const [home, loadedDesk, loadedMembers, installed, catalog] = await Promise.all([
    loadHome(root),
    loadDesk(root),
    listMembers(root, { body: true }),
    allInstalledEquipment(root),
    catalogEquipment(root),
  ])
  const invalidMember = loadedMembers.find((member) => member.invalid)
  if (invalidMember) throw new EndroitError('member_invalid', `${invalidMember.id} is invalid: ${invalidMember.invalid}`)
  if (!loadedMembers.length) throw new EndroitError('member_missing', 'A Workplace requires at least one Member source.')
  const members = loadedMembers.map(withoutDocumentContent)
  const desk = loadedDesk ? { ...withoutDocumentContent(loadedDesk), repository: await deskGitBoundary(root) } : null
  const invalid = installed.find((entry) => entry.invalid)
  if (invalid) throw new EndroitError('equipment_invalid', `${invalid.id} is invalid: ${invalid.invalid.message}`)

  const homeEquipment = installed.filter((entry) => entry.scope === 'home')
  const deskEquipment = installed.filter((entry) => entry.scope === 'desk')
  const effective = new Map(homeEquipment.map((entry) => [entry.id, entry]))
  for (const entry of deskEquipment) {
    const base = effective.get(entry.id)
    if (base && entry.manifest.origin.kind !== 'override') {
      throw new EndroitError('equipment_collision', `${entry.id} exists in both Workplace and Desk scopes without an override origin.`)
    }
    effective.set(entry.id, entry)
  }

  const equipment = [...effective.values()].sort((left, right) => left.id.localeCompare(right.id))
  const sites = await loadSites(root)
  const declaredRoutes = await loadRoutes(root, desk ? join(root, '.desk') : null, sites)
  const accessors = await accessorRoutes(root, desk, sites)
  assertRoomIdentities(accessors.room)
  const plan = {
    root,
    workplace: home.declaration.metadata,
    home,
    desk,
    members,
    homeInstruction: {
      id: 'workplace',
      owner: 'endroit/workplace',
      scope: 'home',
      root,
      path: WORKPLACE_INSTRUCTION,
    },
    deskInstruction: desk ? {
      id: 'desk',
      owner: 'endroit/desk',
      scope: 'desk',
      root: join(root, '.desk'),
      path: DESK_INSTRUCTION,
    } : null,
    equipment: [],
    catalog,
    rooms: accessors.room,
    meetings: accessors.meeting,
    sites: accessors.site,
    routes: declaredRoutes,
    roomNamespaces: [],
    instructions: [],
    capabilities: [],
    skills: [],
    commands: [],
    references: [],
    artifactKinds: [],
    setup: [],
    runtimes: [],
    frontDoor: null,
    sources: [],
    documents: [],
    fragments: resolvedFragments(home, loadedMembers, loadedDesk),
    revision: null,
  }

  for (const entry of equipment) {
    const manifest = entry.manifest
    await validateSettings(entry, home.settings?.[entry.id], desk?.settings?.[entry.id])
    plan.equipment.push({
      id: entry.id,
      version: manifest.version,
      description: manifest.description,
      roomNamespace: manifest.roomNamespace ?? null,
      scope: entry.scope,
      root: entry.root,
      overridden: entry.scope === 'desk' && homeEquipment.some((equipment) => equipment.id === entry.id),
      runtime: manifest.runtime ? {
        namespace: manifest.runtime.namespace,
        entry: manifest.runtime.entry,
        commands: manifest.runtime.commands,
      } : null,
    })
    if (manifest.roomNamespace) {
      plan.roomNamespaces.push({
        id: manifest.roomNamespace,
        owner: entry.id,
        scope: entry.scope,
      })
    }
    for (const item of manifest.instructions ?? []) plan.instructions.push(material(entry, item))
    for (const item of manifest.capabilities ?? []) plan.capabilities.push(material(entry, item))
    for (const item of manifest.references ?? []) plan.references.push(material(entry, item))
    for (const item of manifest.skills ?? []) {
      for (const route of item.forEach ? accessors[item.forEach] : [null]) {
        plan.skills.push(accessor(home, entry, item, 'model', route))
      }
    }
    for (const item of manifest.commands ?? []) {
      for (const route of item.forEach ? accessors[item.forEach] : [null]) {
        plan.commands.push(accessor(home, entry, item, 'user', route))
      }
    }
    for (const item of manifest.artifactKinds ?? []) {
      plan.artifactKinds.push({
        ...item,
        id: canonical(entry.id, item.id),
        localId: item.id,
        owner: entry.id,
        roomNamespace: manifest.roomNamespace ?? null,
        scope: entry.scope,
        root: entry.root,
      })
    }
    for (const id of manifest.setup ?? []) plan.setup.push({ equipment: entry.id, capability: canonical(entry.id, id), scope: entry.scope })
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
  assertUnique(plan.roomNamespaces, (entry) => entry.id, 'Room namespace')
  assertUnique(plan.artifactKinds, (entry) => entry.id, 'Artifact kind')
  assertAccessors(plan.skills, plan.commands)
  const frontDoor = home.frontDoor ?? (plan.runtimes.some((entry) => entry.owner === 'endroit/hud') ? { wakeUp: 'endroit/hud:prompt' } : null)
  plan.frontDoor = resolveFrontDoor(frontDoor, plan)
  plan.sources = await resolvedSources(root, home, loadedMembers, loadedDesk, equipment, plan.rooms, plan.meetings, sites, declaredRoutes)
  plan.documents = resolvedDocuments(home, loadedMembers, loadedDesk)
  plan.revision = digest(JSON.stringify({
    profile: home.profile,
    runtime: home.runtime,
    sources: plan.sources.map(({ path, source_digest }) => [path, source_digest]),
  }))
  plan.resolvedWorkplace = {
    status: home.legacy ? 'degraded' : 'resolved',
    id: home.id,
    profile: home.profile,
    runtime: home.runtime,
    revision: plan.revision,
    sources: plan.sources,
    documents: plan.documents,
    fragments: plan.fragments,
  }
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
    workplace: plan.workplace,
    resolved_workplace: plan.resolvedWorkplace,
    desk: plan.desk,
    members: plan.members,
    homeInstruction: withoutRoot(plan.homeInstruction),
    deskInstruction: plan.deskInstruction ? withoutRoot(plan.deskInstruction) : null,
    equipment: plan.equipment.map(withoutRoot),
    catalog: plan.catalog,
    rooms: plan.rooms,
    meetings: plan.meetings,
    sites: plan.sites,
    routes: plan.routes.map((route) => publicRoute(plan.root, route)),
    roomNamespaces: plan.roomNamespaces,
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

function publicRoute(root, route) {
  const { declaredPath, documentPath, ...value } = route
  const declared = value.declared?.checkout?.path
    ? { ...value.declared, checkout: { mode: value.declared.checkout.mode } }
    : value.declared
  return { ...value, declared, ...(documentPath ? { document_path: relative(root, documentPath) } : {}) }
}

async function resolvedSources(root, home, members, desk, equipment, rooms, meetings, sites, routes) {
  const values = [{
    ref: `workplace:${home.id}`,
    kind: 'endroit/workplace',
    owner: home.owner,
    path: home.declaration.path,
    source_digest: home.declaration.source_digest,
  }]
  for (const member of members) values.push({
    ref: `member:${member.id}`,
    kind: member.kind,
    owner: member.owner,
    path: member.path,
    source_digest: member.source_digest,
  })
  if (desk) values.push({
    ref: `desk:${desk.id}`,
    kind: desk.kind,
    owner: desk.owner,
    path: desk.path,
    source_digest: desk.source_digest,
  })
  for (const entry of equipment) {
    await addFileSource(values, root, join(entry.root, 'equipment.json'), `equipment:${entry.id}`, 'endroit/equipment', entry.id)
    for (const file of [...entry.manifest.files].sort()) {
      await addFileSource(values, root, join(entry.root, file), `equipment:${entry.id}#${file}`, 'endroit/equipment-material', entry.id, true)
    }
  }
  for (const room of rooms) await addFileSource(values, root, join(root, room.path), room.ref, 'endroit/room', room.ref)
  for (const meeting of meetings) await addFileSource(values, root, join(root, meeting.path), meeting.ref, 'endroit/meeting', `room:${meeting.scope}/${meeting.room}`)
  for (const site of sites) await addFileSource(values, root, join(root, site.path), site.ref, 'endroit/site', site.ref)
  for (const route of routes) {
    if (route.documentPath) await addFileSource(values, root, route.documentPath, `route:${route.site}/${route.id}`, 'endroit/route', route.owner ?? `desk:${desk?.id ?? 'legacy'}`)
  }
  return values.sort((left, right) => left.path.localeCompare(right.path))
}

async function addFileSource(values, root, path, ref, kind, owner, optional = false) {
  const sourcePath = relative(root, path)
  if (sourcePath === '..' || sourcePath.startsWith('../')) throw new EndroitError('source_path_escape', `${ref} source escapes the Workplace.`)
  try {
    values.push({ ref, kind, owner, path: sourcePath, source_digest: digest(await readFile(path)) })
  } catch (error) {
    if (!optional || error.code !== 'ENOENT') throw error
  }
}

function resolvedDocuments(home, members, desk) {
  return [
    { ref: `workplace:${home.id}`, kind: 'endroit/workplace', owner: home.owner, path: home.declaration.path, source_digest: home.declaration.source_digest },
    ...members.map((member) => ({ ref: `member:${member.id}`, kind: member.kind, owner: member.owner, path: member.path, source_digest: member.source_digest })),
    ...(desk ? [{ ref: `desk:${desk.id}`, kind: desk.kind, owner: desk.owner, path: desk.path, source_digest: desk.source_digest }] : []),
  ]
}

function resolvedFragments(home, members, desk) {
  return [home.declaration, ...members, ...(desk ? [desk] : [])].flatMap((document) =>
    (document.fragments ?? []).map((fragment) => ({
      ...fragment,
      document: document.path,
      owner: document.owner,
    })))
}

function withoutDocumentContent({ body, sections, fragments, metadata, legacy_document, ...value }) { return value }

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

function accessor(home, entry, item, invocation, route) {
  const equipmentPrefix = entry.manifest.prefix ?? basename(entry.id)
  if (item.projectedName?.includes('{route}') && !route) {
    throw new EndroitError('projected_name_route_missing', `${entry.id}:${item.id} uses {route} without forEach.`)
  }
  const projectedId = item.projectedName
    ? (route ? item.projectedName.replaceAll('{route}', slug(route.id)) : item.projectedName)
    : [home.prefix, equipmentPrefix, item.id, route && slug(route.id)].filter(Boolean).join('-')
  if (/[{}]/.test(projectedId)) throw new EndroitError('projected_name_invalid', `${entry.id}:${item.id} contains an unsupported projectedName placeholder.`)
  return {
    ...item,
    id: canonical(entry.id, item.id),
    localId: item.id,
    projectedId,
    capability: canonical(entry.id, item.capability),
    invocation,
    ...(route ? { route } : {}),
    owner: entry.id,
    scope: entry.scope,
    root: entry.root,
  }
}

async function accessorRoutes(root, desk, sites) {
  const values = { room: [], meeting: [], site: [] }
  const scopes = [
    { scope: 'home', root: join(root, 'rooms') },
    ...(desk ? [{ scope: 'desk', root: join(root, '.desk', 'rooms') }] : []),
  ]
  for (const candidate of scopes) {
    const roomsRoot = candidate.root
    for (const room of await roomDirectories(roomsRoot)) {
      values.room.push({
        kind: 'room',
        id: room.id,
        scope: candidate.scope,
        ref: `room:${candidate.scope}/${room.id}`,
        path: relative(root, join(room.path, 'ROOM.md')),
        emoji: await documentEmoji(join(room.path, 'ROOM.md')),
      })
      for (const meeting of await directories(join(room.path, 'meetings'))) {
        values.meeting.push({
          kind: 'meeting',
          id: `${room.id}/${meeting}`,
          scope: candidate.scope,
          room: room.id,
          ref: `meeting:${candidate.scope}/${room.id}/${meeting}`,
          path: relative(root, join(room.path, 'meetings', meeting, 'MEETING.md')),
          emoji: await documentEmoji(join(room.path, 'meetings', meeting, 'MEETING.md')),
        })
      }
    }
  }
  for (const site of sites) {
    values.site.push({
      kind: 'site',
      id: site.id,
      ref: `site:${site.id}`,
      emoji: site.emoji ?? null,
      summary: site.summary ?? null,
      when: site.when ?? [],
      tags: site.tags ?? [],
      repository: site.repository ?? null,
      source: site.source ?? null,
      path: site.path,
    })
  }
  return values
}

function assertRoomIdentities(rooms) {
  const scopes = new Map()
  for (const room of rooms) {
    const current = scopes.get(room.id)
    if (current) {
      throw new EndroitError('room_collision', `Room ${room.id} exists in both ${current} and ${room.scope} scope.`)
    }
    scopes.set(room.id, room.scope)
  }
}

async function directories(path) {
  return (await readdir(path, { withFileTypes: true }).catch((error) => error.code === 'ENOENT' ? [] : Promise.reject(error)))
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .map((entry) => entry.name)
    .sort()
}

async function roomDirectories(root) {
  const rooms = []
  const visit = async (path, parent = '') => {
    for (const entry of await directories(path)) {
      const id = parent ? `${parent}/${entry}` : entry
      const destination = join(path, entry)
      if (!parent || await documentExists(join(destination, 'ROOM.md'))) {
        rooms.push({ id, path: destination })
        if (await documentExists(join(destination, 'ROOM.md'))) await visit(destination, id)
      }
    }
  }
  await visit(root)
  return rooms
}

async function documentExists(path) {
  return readFile(path).then(() => true, (error) => error.code === 'ENOENT' ? false : Promise.reject(error))
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
  if (paths.home) await validateSetting(entry, paths.home, homeSettings ?? {}, 'Workplace')
  else if (homeSettings !== undefined) throw new EndroitError('settings_schema_missing', `${entry.id} does not accept Workplace settings.`)
  if (paths.desk) await validateSetting(entry, paths.desk, deskSettings ?? {}, 'Desk')
  else if (deskSettings !== undefined) throw new EndroitError('settings_schema_missing', `${entry.id} does not accept Desk settings.`)
}

async function validateSetting(entry, path, value, scope) {
  const schemaPath = await resolvePackageFile(entry.root, path, `${entry.id} ${scope} settings schema`)
  const schema = JSON.parse(await readFile(schemaPath, 'utf8'))
  const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema)
  if (!validate(value)) {
    const message = validate.errors.map((error) => `${error.instancePath || '/'} ${error.message}`).join('; ')
    throw new EndroitError('settings_invalid', `${scope} settings for ${entry.id} are invalid: ${message}.`)
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
  if (!runtime) throw new EndroitError('front_door_runtime_missing', `${frontDoor.wakeUp} references an Equipment without an effective runtime.`)
  if (!runtime.commands.some((entry) => entry.name === command)) {
    throw new EndroitError('front_door_command_missing', `${frontDoor.wakeUp} references an undeclared runtime command.`)
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
      throw new EndroitError('context_budget_exceeded', `${key} is ${actual} bytes, over the ${budgets[key]} byte budget.`)
    }
  }
}

function assertUnique(entries, key, label) {
  const owners = new Map()
  for (const entry of entries) {
    const id = key(entry)
    if (owners.has(id)) throw new EndroitError('surface_collision', `${label} ${id} is owned by both ${owners.get(id)} and ${entry.owner}.`)
    owners.set(id, entry.owner)
  }
}

function assertAccessors(skills, commands) {
  const claims = new Map()
  for (const entry of [...skills, ...commands]) {
    const key = `${entry.invocation}:${entry.projectedId}`
    const current = claims.get(key)
    if (current) throw new EndroitError('surface_collision', `${entry.invocation} surface ${entry.projectedId} is owned by both ${current} and ${entry.owner}.`)
    claims.set(key, entry.owner)
  }
}

function canonical(owner, id) {
  return `${owner}:${id}`
}
