import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { lstat, mkdir, open, readFile, readdir, realpath, rm } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import { parseDocument, renderDocument, V9_API } from './documents.mjs'
import { planFirstPartyEquipmentUpgrade } from './equipment.mjs'
import {
  checkoutBindingsDocument,
  checkoutIndexDocument,
  checkoutLinkState,
  proposeRoutePurposes,
  readCheckoutBindings,
  validateCheckoutIndex,
  workplaceGitStorage,
} from './git-workplace.mjs'
import { EndroitError } from './lib/errors.mjs'
import { writeFileAtomic } from './lib/io.mjs'

const ROUTE_V9 = 'https://endroit.org/schema/v9/route.json'
const UPGRADE_KIND = 'endroit/workplace-upgrade-v1'
const exec = promisify(execFile)

export async function planWorkplaceUpgrade(homeRoot, options = {}) {
  const plan = await buildPlan(homeRoot, options)
  return publicPlan(plan)
}

export async function applyWorkplaceUpgrade(homeRoot, options = {}) {
  homeRoot = await realpath(homeRoot).catch(() => resolve(homeRoot))
  const initial = await buildPlan(homeRoot, options)
  const visible = publicPlan(initial)
  if (options.expectPlan !== visible.planDigest) throw new EndroitError('workplace_upgrade_plan_mismatch', `Pass --expect-plan ${visible.planDigest}.`)
  if (options.approve !== `workplace:${initial.workplace}`) throw new EndroitError('workplace_upgrade_approval_required', `Pass --approve workplace:${initial.workplace}.`)
  if (!initial.homeGit.clean) throw new EndroitError('workplace_upgrade_home_dirty', 'Workplace upgrade requires a clean Home Git worktree.')
  if (typeof options.verify !== 'function') throw new EndroitError('workplace_upgrade_verifier_required', 'Workplace upgrade requires validate/build/Doctor verification callbacks.')
  if (!initial.writes.length) return { status: 'current', readOnly: false, changes: 0, routePurposes: initial.routePurposes }
  const locks = await acquireUpgradeLocks(initial)
  try {
    const plan = await buildPlan(homeRoot, options)
    if (!samePlan(initial, plan)) throw new EndroitError('workplace_upgrade_drift', 'Workplace upgrade inputs changed after planning.')
    const runId = upgradeRunId()
    const runRoot = join(homeRoot, '.endroit', 'upgrades', 'workplace-v1', runId)
    const snapshotRoot = join(runRoot, 'snapshots')
    await mkdir(snapshotRoot, { recursive: true })
    const projectionBefore = await captureProjectionState(homeRoot)
    const entries = []
    for (const [index, write] of plan.writes.entries()) {
      const snapshot = write.before ? join(snapshotRoot, `${String(index).padStart(4, '0')}-${sha256(write.path)}-${basename(write.path)}`) : null
      if (snapshot) await writeFileAtomic(snapshot, write.before.bytes, write.before.mode)
      entries.push({
        kind: write.kind,
        path: write.path,
        beforeSha256: write.before?.sha256 ?? null,
        beforeMode: write.before?.mode ?? null,
        afterSha256: write.after ? sha256(write.after) : null,
        afterMode: write.after ? write.mode : null,
        snapshot,
        progress: 'before',
      })
    }
    let journal = {
      version: 1,
      kind: UPGRADE_KIND,
      runId,
      status: 'prepared',
      homeRoot,
      desk: plan.desk,
      createdAt: new Date().toISOString(),
      entries,
    }
    const journalPath = join(runRoot, 'journal.json')
    await writeJournal(journalPath, journal)
    journal = { ...journal, status: 'applying', updatedAt: new Date().toISOString() }
    await writeJournal(journalPath, journal)
    try {
      for (let index = 0; index < plan.writes.length; index += 1) {
        const write = plan.writes[index]
        await assertFileState(write.path, write.before?.sha256 ?? null, write.before?.mode ?? null, 'workplace_upgrade_drift')
        if (write.after) await writeFileAtomic(write.path, write.after, write.mode)
        else await rm(write.path)
        await assertFileState(write.path, write.after ? sha256(write.after) : null, write.after ? write.mode : null, 'workplace_upgrade_write_failed')
        journal.entries[index].progress = 'after'
        journal = { ...journal, updatedAt: new Date().toISOString() }
        await writeJournal(journalPath, journal)
        if (process.env.NODE_ENV === 'test' && process.env.ENDROIT_TEST_FAULT_AFTER_WORKPLACE_UPGRADE_WRITE === write.kind) {
          throw new EndroitError('workplace_upgrade_fault', `Injected failure after ${write.kind}.`)
        }
      }
      const verification = await options.verify({ homeRoot, plan: publicPlan(plan) })
      if (verification === false || verification?.status === 'failed') throw new EndroitError('workplace_upgrade_verification_failed', 'Workplace upgrade verification failed.')
      journal = await recordProjectionChanges(homeRoot, snapshotRoot, journalPath, journal, projectionBefore)
    } catch (error) {
      try {
        journal = await recordProjectionChanges(homeRoot, snapshotRoot, journalPath, journal, projectionBefore)
        journal = await rollbackJournal(journalPath, journal)
        error.message = `${error.message} Upgrade run ${runId} was rolled back exactly.`
      } catch (rollbackError) {
        error.message = `${error.message} Automatic rollback failed: ${rollbackError.message}. Upgrade run ${runId} remains recoverable with workplace upgrade --rollback ${runId}.`
      }
      throw error
    }
    journal = { ...journal, status: 'applied', appliedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
    await writeJournal(journalPath, journal)
    return {
      status: 'upgraded',
      runId,
      planDigest: visible.planDigest,
      changes: plan.writes.length,
      routePurposes: plan.routePurposes,
      rollback: `workplace upgrade --rollback ${runId}`,
    }
  } finally {
    await releaseUpgradeLocks(locks)
  }
}

export async function rollbackWorkplaceUpgrade(homeRoot, runId) {
  homeRoot = await realpath(homeRoot).catch(() => resolve(homeRoot))
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(runId)) throw new EndroitError('workplace_upgrade_run_invalid', `Invalid upgrade run ${runId}.`)
  const runRoot = join(homeRoot, '.endroit', 'upgrades', 'workplace-v1', runId)
  const journalPath = join(runRoot, 'journal.json')
  let journal = await readJournal(journalPath, runId, homeRoot)
  if (journal.status === 'rolled-back') return { status: 'current', runId, changes: 0 }
  if (!['prepared', 'applying', 'applied', 'rolling-back'].includes(journal.status)) {
    throw new EndroitError('workplace_upgrade_state_invalid', `Upgrade run ${runId} cannot be rolled back from ${journal.status}.`)
  }
  const bindingLockPaths = journal.entries
    .filter((entry) => entry.kind === 'checkout-bindings')
    .map((entry) => join(dirname(entry.path), 'checkout-bindings.lock'))
  const plan = { homeRoot, bindingLockPaths: [...new Set(bindingLockPaths)].sort() }
  const locks = await acquireUpgradeLocks(plan)
  try {
    journal = await readJournal(journalPath, runId, homeRoot)
    const before = journal.entries.filter((entry) => entry.progress !== 'before').length
    journal = await rollbackJournal(journalPath, journal)
    return { status: 'rolled-back', runId, changes: before }
  } finally {
    await releaseUpgradeLocks(locks)
  }
}

async function buildPlan(homeRoot, options) {
  homeRoot = await realpath(homeRoot).catch(() => resolve(homeRoot))
  const deskRoot = options.deskRoot ? resolve(options.deskRoot) : join(homeRoot, '.desk')
  const desk = options.desk ?? await readDeskId(deskRoot)
  const workplace = await readWorkplaceId(homeRoot)
  const homeGit = await inspectHomeGit(homeRoot)
  const routes = await scanRoutes(deskRoot)
  const routePurposeMap = proposeRoutePurposes(routes, options.purposes)
  const writes = []
  const target = {
    version: options.targetVersion ?? null,
    sourceCommit: options.sourceCommit ?? null,
    packageDigest: options.packageDigest ?? null,
    packageIntegrity: options.packageIntegrity ?? null,
  }
  writes.push(...await planLegacySources(homeRoot, deskRoot, target))
  const equipmentPlan = await planFirstPartyEquipmentUpgrade(homeRoot, {
    targetVersion: target.version,
    sourceCommit: target.sourceCommit,
  })
  for (const write of equipmentPlan.writes) await addPlannedWrite(writes, write.kind, write.path, write.content, 0o644)
  for (const deletion of equipmentPlan.deletes) await addPlannedWrite(writes, deletion.kind, deletion.path, null, 0o644)
  const routePurposes = []
  for (const route of routes) {
    const purpose = routePurposeMap.get(`${route.site}/${route.id}`)
    if (!purpose) continue
    if (route.current) {
      const after = insertRoutePurpose(route.bytes, purpose)
      writes.push(await plannedWrite('route-purpose', route.path, after, route.mode))
    } else {
      const destination = join(dirname(route.path), route.id, 'ROUTE.md')
      if (await fileState(destination)) throw new EndroitError('route_source_collision', `Route ${route.site}/${route.id} already has a v9 declaration.`)
      writes.push(await plannedWrite('route-v9', destination, renderRouteV9(route, desk, purpose), route.mode))
      writes.push(await plannedWrite('route-legacy-remove', route.path, null, route.mode))
    }
    routePurposes.push({ site: route.site, route: route.id, purpose })
  }

  const indexPath = join(homeRoot, '.endroit', 'checkout-index.json')
  const legacyIndex = await readLegacyIndex(indexPath, desk)
  const bindingsByDesk = new Map()
  for (const [owner, links] of legacyIndex.desks) {
    for (const link of links) {
      if (link.projectionOnly) continue
      const ref = parseCheckoutRef(link.ref)
      if (!ref) continue
      addBinding(bindingsByDesk, owner, { site: ref.site, route: ref.route, target: await canonicalTarget(link.target) })
    }
  }
  for (const route of routes.filter((entry) => entry.modeName !== 'embedded')) {
    const existing = bindingsByDesk.get(desk)?.get(`${route.site}/${route.id}`)
    if (existing) continue
    const address = join(homeRoot, 'checkouts', route.site, route.id)
    const declared = route.checkoutPath
      ? resolve(homeRoot, route.checkoutPath)
      : route.modeName?.startsWith('managed-')
        ? join(homeGit.primaryRoot, 'checkouts', route.site, route.id)
        : address
    const target = await existingTarget(declared)
    if (target) addBinding(bindingsByDesk, desk, { site: route.site, route: route.id, target })
  }

  const bindingLockPaths = []
  for (const owner of [...new Set([...bindingsByDesk.keys(), desk])].sort()) {
    const layout = await workplaceGitStorage(homeRoot, owner)
    bindingLockPaths.push(layout.bindingsLockPath)
    const current = await readCheckoutBindings(layout.bindingsPath, owner)
    const merged = new Map(current.bindings.map((binding) => [`${binding.site}/${binding.route}`, binding]))
    for (const binding of bindingsByDesk.get(owner)?.values() ?? []) {
      const key = `${binding.site}/${binding.route}`
      const prior = merged.get(key)
      if (prior && prior.target !== binding.target) throw new EndroitError('checkout_binding_conflict', `${owner} binds ${key} to two targets.`)
      merged.set(key, binding)
    }
    const document = checkoutBindingsDocument(owner, [...merged.values()])
    const after = Buffer.from(`${JSON.stringify(document, null, 2)}\n`)
    const before = await fileState(layout.bindingsPath)
    if (before || document.bindings.length) {
      if (before?.sha256 !== sha256(after)) writes.push({ kind: 'checkout-bindings', path: layout.bindingsPath, after, mode: before?.mode ?? 0o600, before })
    }
    bindingsByDesk.set(owner, new Map(document.bindings.map((binding) => [`${binding.site}/${binding.route}`, binding])))
  }

  const projections = []
  const currentBindings = bindingsByDesk.get(desk) ?? new Map()
  for (const route of routes.filter((entry) => entry.modeName !== 'embedded')) {
    const binding = currentBindings.get(`${route.site}/${route.id}`)
    if (!binding) continue
    const address = join(homeRoot, 'checkouts', route.site, route.id)
    projections.push({
      site: route.site,
      route: route.id,
      address: relative(homeRoot, address),
      target: binding.target,
      linkState: checkoutLinkState(homeRoot, address, binding.target),
    })
  }
  for (const link of legacyIndex.desks.get(desk) ?? []) {
    const ref = parseWorktreeRef(link.ref)
    if ((!ref && !link.projectionOnly) || projections.some((entry) => entry.address === link.address)) continue
    projections.push({
      site: ref?.site ?? link.site,
      route: ref?.route ?? link.route,
      address: link.address,
      target: await canonicalTarget(link.target),
      linkState: checkoutLinkState(homeRoot, join(homeRoot, link.address), link.target),
    })
  }
  const index = checkoutIndexDocument(desk, projections)
  const indexAfter = Buffer.from(`${JSON.stringify(index, null, 2)}\n`)
  const indexBefore = await fileState(indexPath)
  if (indexBefore || projections.length) {
    if (indexBefore?.sha256 !== sha256(indexAfter)) writes.push({ kind: 'checkout-index', path: indexPath, after: indexAfter, mode: indexBefore?.mode ?? 0o600, before: indexBefore })
  }

  writes.sort((left, right) => left.path.localeCompare(right.path))
  routePurposes.sort((left, right) => left.site.localeCompare(right.site) || left.route.localeCompare(right.route))
  return {
    homeRoot,
    deskRoot,
    desk,
    workplace,
    homeGit,
    target,
    equipment: equipmentPlan.equipment,
    retired: equipmentPlan.retired,
    routes,
    routePurposes,
    writes,
    bindingLockPaths: [...new Set(bindingLockPaths)].sort(),
  }
}

async function planLegacySources(homeRoot, deskRoot, target) {
  const writes = []
  const legacyHomePath = join(homeRoot, 'endroit.json')
  const workplacePath = join(homeRoot, 'WORKPLACE.md')
  const legacyHome = await fileState(legacyHomePath)
  const currentWorkplace = await fileState(workplacePath)
  if (legacyHome && currentWorkplace) throw new EndroitError('ambiguous_sources', `${homeRoot} contains both WORKPLACE.md and legacy endroit.json declarations.`)
  if (legacyHome) {
    if (!target.version) throw new EndroitError('workplace_upgrade_target_version_required', 'Pass the target Endroit version for a legacy Workplace upgrade.')
    let home
    try { home = JSON.parse(legacyHome.bytes) } catch { throw new EndroitError('legacy_document_invalid', `${legacyHomePath} is invalid JSON.`) }
    const homeBodyPath = join(homeRoot, 'HOME.md')
    const homeBody = await fileState(homeBodyPath)
    if (!homeBody) throw new EndroitError('legacy_workplace_missing', `${homeBodyPath} does not exist.`)
    const owner = await legacyOwner(homeRoot)
    const body = legacyWorkplaceBody(homeBody.bytes.toString('utf8'), home.name)
    const metadata = {
      $schema: V9_API.workplace,
      kind: 'endroit/workplace',
      id: home.name,
      owner: `member:${owner}`,
      profile: 'endroit/0.10',
      protocol: 'open-workplace/0.2-draft',
      runtime: `@endroit/cli@${target.version}`,
      providers: home.providers,
      ...(home.prefix ? { prefix: home.prefix } : {}),
      ...(home.emoji ? { emoji: home.emoji } : {}),
      ...(home.settings && Object.keys(home.settings).length ? { settings: home.settings } : {}),
    }
    await addPlannedWrite(writes, 'workplace-v9', workplacePath, renderDocument({ metadata, body }), homeBody.mode)
    await addPlannedWrite(writes, 'workplace-legacy-remove', legacyHomePath, null, legacyHome.mode)
    await addPlannedWrite(writes, 'home-instruction-legacy-remove', homeBodyPath, null, homeBody.mode)
  } else if (currentWorkplace && target.version) {
    const document = parseDocument(currentWorkplace.bytes, { path: workplacePath })
    const runtime = `@endroit/cli@${target.version}`
    if (document.metadata.runtime !== runtime) {
      await addPlannedWrite(writes, 'workplace-runtime', workplacePath, renderDocument({ metadata: { ...document.metadata, runtime }, body: document.body }), currentWorkplace.mode)
    }
  }

  const legacyDeskPath = join(deskRoot, 'desk.json')
  const deskPath = join(deskRoot, 'DESK.md')
  const legacyDesk = await fileState(legacyDeskPath)
  if (legacyDesk) {
    let desk
    try { desk = JSON.parse(legacyDesk.bytes) } catch { throw new EndroitError('legacy_document_invalid', `${legacyDeskPath} is invalid JSON.`) }
    const body = await fileState(deskPath)
    if (!body) throw new EndroitError('legacy_desk_missing', `${deskPath} does not exist.`)
    const metadata = {
      $schema: V9_API.desk,
      kind: 'endroit/desk',
      id: desk.id,
      owner: `member:${desk.member}`,
      desk_state: 'active',
      ...(desk.settings && Object.keys(desk.settings).length ? { settings: desk.settings } : {}),
    }
    await addPlannedWrite(writes, 'desk-v9', deskPath, renderDocument({ metadata, body: body.bytes.toString('utf8') }), body.mode)
    await addPlannedWrite(writes, 'desk-legacy-remove', legacyDeskPath, null, legacyDesk.mode)
  }

  for (const memberId of await directoryNames(join(homeRoot, 'members'))) {
    const path = join(homeRoot, 'members', memberId, 'MEMBER.md')
    const state = await fileState(path)
    if (!state) continue
    const document = parseDocument(state.bytes, { path })
    if (document.metadata.$schema !== 'https://endroit.org/schema/v7/member.json') continue
    const metadata = {
      $schema: V9_API.member,
      kind: 'endroit/member',
      id: document.metadata.id,
      owner: `member:${document.metadata.id}`,
      name: document.metadata.name,
      membership_state: document.metadata.status,
      accounts: document.metadata.accounts,
    }
    await addPlannedWrite(writes, 'member-v9', path, renderDocument({ metadata, body: document.body }), state.mode)
  }
  return writes
}

async function legacyOwner(homeRoot) {
  const ids = await directoryNames(join(homeRoot, 'members'))
  if (ids.includes('owner')) return 'owner'
  if (ids.length === 1) return ids[0]
  throw new EndroitError('workplace_owner_ambiguous', `${homeRoot}/endroit.json cannot resolve one legacy Member owner.`)
}

function legacyWorkplaceBody(source, fallbackTitle) {
  const titleMatch = source.match(/^#\s+(.+)\r?\n/)
  const title = titleMatch?.[1].trim() || fallbackTitle
  const legacyGuidance = nestHeadings(titleMatch ? source.slice(titleMatch[0].length) : source).trim()
  return [
    `# ${title}`,
    '',
    '## Purpose',
    '',
    `Operate ${fallbackTitle} as one durable, local and inspectable Workplace.`,
    '',
    '## Constitution',
    '',
    '- Human direction, judgment, acceptance and delivery consent remain explicit.',
    '- Owned sources are canonical; provider files and indexes are rebuildable projections.',
    '- Conversation and generated results remain ephemeral until an explicit transition.',
    '- A Site keeps its own source, history, permissions and delivery lifecycle.',
    '',
    '## Boundaries',
    '',
    'Resolve only this declared Workplace and the sources required for the current work.',
    '',
    '## Limits',
    '',
    'External access and generated projections never grant authority or replace owned sources.',
    '',
    '## Migrated guidance',
    '',
    '<!-- Preserved verbatim from HOME.md below this heading; it is not part of the provider bootstrap. -->',
    '',
    legacyGuidance,
    '',
  ].join('\n')
}

function nestHeadings(source) {
  let fence = null
  return source.split(/(?<=\n)/).map((line) => {
    const marker = line.match(/^\s*(`{3,}|~{3,})/)?.[1]
    if (marker) {
      if (fence === marker[0]) fence = null
      else if (!fence) fence = marker[0]
      return line
    }
    return fence ? line : line.replace(/^(#{1,4})(?=\s)/, '##$1')
  }).join('')
}

async function addPlannedWrite(writes, kind, path, after, mode) {
  const before = await fileState(path)
  const bytes = after === null ? null : Buffer.from(after)
  if ((before?.sha256 ?? null) === (bytes ? sha256(bytes) : null) && (before?.mode ?? null) === (bytes ? mode : null)) return
  writes.push({ kind, path, after: bytes, mode: bytes ? (before?.mode ?? mode) : mode, before })
}

async function scanRoutes(deskRoot) {
  const routes = []
  const root = join(deskRoot, 'routes')
  for (const site of await directoryNames(root)) {
    const siteRoot = join(root, site)
    for (const entry of await readdir(siteRoot, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new EndroitError('route_invalid', `${join(siteRoot, entry.name)} must not be a symbolic link.`)
      if (entry.isDirectory()) {
        const path = join(siteRoot, entry.name, 'ROUTE.md')
        const before = await fileState(path)
        if (!before) continue
        const parsed = parseDocument(before.bytes.toString('utf8'), { path })
        if (parsed.metadata.$schema !== ROUTE_V9 || parsed.metadata.id !== entry.name || parsed.metadata.site !== site) continue
        routes.push({
          id: entry.name,
          site,
          path,
          bytes: before.bytes,
          mode: before.mode,
          current: true,
          status: parsed.metadata.route_state,
          purpose: parsed.metadata.route_purpose,
          modeName: parsed.metadata.checkout_mode,
        })
      } else if (entry.isFile() && entry.name.endsWith('.json')) {
        const path = join(siteRoot, entry.name)
        const before = await fileState(path)
        let document
        try { document = JSON.parse(before.bytes) } catch { continue }
        routes.push({
          id: entry.name.slice(0, -5),
          site,
          path,
          bytes: before.bytes,
          mode: before.mode,
          current: false,
          status: document.status ?? 'active',
          purpose: null,
          modeName: document.checkout?.mode ?? document.mode,
          checkoutPath: document.checkout?.path ?? document.path,
          revision: document.revision ?? (document.branch ? { kind: 'branch', name: document.branch } : null),
          supersededBy: document.supersededBy,
        })
      }
    }
  }
  return routes.sort((left, right) => left.site.localeCompare(right.site) || left.id.localeCompare(right.id))
}

async function readLegacyIndex(path, currentDesk) {
  const before = await fileState(path)
  if (!before) return { version: 3, desks: new Map() }
  let document
  try { document = JSON.parse(before.bytes) } catch { throw new EndroitError('checkout_index_invalid', `${path} is invalid.`) }
  if (document.version === 3) {
    validateCheckoutIndex(document)
    return { version: 3, desks: new Map([[document.desk, document.projections.map((entry) => ({ ...entry, projectionOnly: true }))]]) }
  }
  const partitions = document.version === 1 && Array.isArray(document.links)
    ? [[currentDesk, document.links]]
    : document.version === 2 && document.desks && typeof document.desks === 'object'
      ? Object.entries(document.desks).map(([desk, partition]) => [desk, partition.links])
      : null
  if (!partitions) throw new EndroitError('checkout_index_invalid', `${path} has an unsupported Checkout index.`)
  const desks = new Map()
  for (const [desk, links] of partitions) {
    if (!Array.isArray(links)) throw new EndroitError('checkout_index_invalid', `Invalid Checkout index partition ${desk}.`)
    desks.set(desk, links.map((link) => ({ address: link.path, target: link.target, ref: link.ref })))
  }
  return { version: document.version, desks }
}

function publicPlan(plan) {
  const writes = plan.writes.map((write) => ({ kind: write.kind, path: displayPath(plan.homeRoot, write.path), before: write.before?.sha256 ?? null, after: write.after ? sha256(write.after) : null }))
  const compatibility = ['rooms', 'sites', 'artifacts', 'work']
  const contract = {
    workplace: plan.workplace,
    desk: plan.desk,
    target: plan.target,
    homeHead: plan.homeGit.head,
    sources: ['workplace-v7', 'desk-v7', 'member-v7', 'route-v7-json', 'route-v8-json', 'route-v9-markdown', 'checkout-index-v1', 'checkout-index-v2', 'checkout-index-v3', 'installed-first-party-equipment'],
    compatibility,
    equipment: plan.equipment,
    retired: plan.retired,
    writes,
    routePurposes: plan.routePurposes,
    invariants: ['no-git-mutation', 'binding-targets-preserved', 'checkout-addresses-preserved', 'exact-snapshot-rollback'],
  }
  return {
    status: plan.writes.length ? 'upgrade-available' : 'current',
    readOnly: true,
    planDigest: sha256(JSON.stringify(contract)),
    workplace: plan.workplace,
    desk: plan.desk,
    target: plan.target,
    homeGit: plan.homeGit,
    sources: contract.sources,
    compatibility,
    equipment: plan.equipment,
    retired: plan.retired,
    writes,
    invariants: contract.invariants,
    rollback: 'workplace upgrade --rollback <run-id>',
    changes: writes,
    routePurposes: plan.routePurposes,
  }
}

function insertRoutePurpose(bytes, purpose) {
  const source = bytes.toString('utf8')
  if (/^route_purpose:/m.test(source)) return bytes
  const match = source.match(/^(---\r?\n)([\s\S]*?)(\r?\n---(?:\r?\n|$)[\s\S]*)$/)
  if (!match) throw new EndroitError('route_invalid', 'ROUTE.md must contain a closed frontmatter block.')
  const newline = match[1].includes('\r\n') ? '\r\n' : '\n'
  const lines = match[2].split(/\r?\n/)
  const state = lines.findIndex((line) => line.startsWith('route_state:'))
  if (state < 0) throw new EndroitError('route_invalid', 'ROUTE.md must declare route_state.')
  lines.splice(state + 1, 0, `route_purpose: ${JSON.stringify(purpose)}`)
  return Buffer.from(`${match[1]}${lines.join(newline)}${match[3]}`)
}

function renderRouteV9(route, desk, purpose) {
  const document = {
    $schema: ROUTE_V9,
    kind: 'endroit/route',
    id: route.id,
    owner: `desk:${desk}`,
    site: route.site,
    route_state: route.status,
    route_purpose: purpose,
    checkout_mode: route.modeName,
    ...(route.revision ? { revision: route.revision } : {}),
    ...(route.supersededBy ? { superseded_by: route.supersededBy } : {}),
  }
  const keys = ['$schema', 'kind', 'id', 'owner', 'site', 'route_state', 'route_purpose', 'checkout_mode', 'revision', 'superseded_by']
  const frontmatter = keys.filter((key) => document[key] !== undefined).map((key) => `${key}: ${JSON.stringify(document[key])}`)
  return Buffer.from(['---', ...frontmatter, '---', '', `# ${route.site} / ${route.id}`, '', `Local address: \`checkout:${route.site}/${route.id}\`.`, ''].join('\n'))
}

async function readDeskId(deskRoot) {
  const current = join(deskRoot, 'DESK.md')
  let currentError
  try {
    const document = parseDocument(await readFile(current, 'utf8'), { path: current })
    if (document.metadata.id) return document.metadata.id
  } catch (error) { currentError = error }
  try { return JSON.parse(await readFile(join(deskRoot, 'desk.json'), 'utf8')).id }
  catch (error) {
    if (error.code === 'ENOENT' && currentError?.code !== 'ENOENT') throw currentError
    if (error.code === 'ENOENT') throw new EndroitError('desk_missing', 'Configure a Desk before upgrading the Workplace.')
    throw error
  }
}

async function readWorkplaceId(homeRoot) {
  const current = join(homeRoot, 'WORKPLACE.md')
  try {
    const document = parseDocument(await readFile(current, 'utf8'), { path: current })
    if (document.metadata.id) return document.metadata.id
  } catch (error) { if (error.code !== 'ENOENT') throw error }
  try {
    const document = JSON.parse(await readFile(join(homeRoot, 'endroit.json'), 'utf8'))
    return document.id ?? document.name
  } catch (error) {
    if (error.code === 'ENOENT') throw new EndroitError('workplace_missing', 'No Workplace declaration can be upgraded.')
    throw error
  }
}

async function inspectHomeGit(homeRoot) {
  try {
    const [head, branch, status, worktrees] = await Promise.all([
      git(homeRoot, ['rev-parse', 'HEAD']),
      git(homeRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => null),
      git(homeRoot, ['status', '--porcelain=v2', '--untracked-files=all']),
      git(homeRoot, ['worktree', 'list', '--porcelain', '-z']),
    ])
    const primary = worktrees.split('\0').find((entry) => entry.startsWith('worktree '))?.slice(9)
    if (!primary) throw new EndroitError('workplace_upgrade_git_required', 'Workplace upgrade could not resolve the primary Home worktree.')
    return { available: true, head, branch, clean: status === '', primaryRoot: await canonicalTarget(primary) }
  } catch (error) {
    throw new EndroitError('workplace_upgrade_git_required', 'Workplace upgrade requires a Git-backed Home.', { cause: error })
  }
}

async function plannedWrite(kind, path, after, mode) { return { kind, path, after, mode, before: await fileState(path) } }
async function existingTarget(path) {
  const info = await lstat(path).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error))
  return info ? canonicalTarget(path) : null
}
async function canonicalTarget(path) { return realpath(path).catch(() => resolve(path)) }
function addBinding(bindingsByDesk, desk, binding) {
  const bindings = bindingsByDesk.get(desk) ?? new Map()
  const key = `${binding.site}/${binding.route}`
  const existing = bindings.get(key)
  if (existing && existing.target !== binding.target) throw new EndroitError('checkout_binding_conflict', `${desk} binds ${key} to two targets.`)
  bindings.set(key, binding)
  bindingsByDesk.set(desk, bindings)
}
function parseCheckoutRef(ref) {
  const match = String(ref).match(/^checkout:([a-z0-9][a-z0-9._-]{0,127})\/([a-z0-9][a-z0-9._-]{0,127})$/)
  return match ? { site: match[1], route: match[2] } : null
}
function parseWorktreeRef(ref) {
  const match = String(ref).match(/^worktree:([a-z0-9][a-z0-9._-]{0,127})\/([a-z0-9][a-z0-9._-]{0,127})$/)
  return match ? { site: match[1], route: match[2] } : null
}

async function fileState(path) {
  const info = await lstat(path).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error))
  if (!info) return null
  if (info.isSymbolicLink() || !info.isFile()) throw new EndroitError('workplace_upgrade_path_invalid', `${path} must be a regular file.`)
  const bytes = await readFile(path)
  return { bytes, mode: info.mode & 0o777, sha256: sha256(bytes) }
}

async function assertFileState(path, expectedSha, expectedMode, code) {
  const current = await fileState(path)
  if ((current?.sha256 ?? null) !== expectedSha || (current?.mode ?? null) !== expectedMode) throw new EndroitError(code, `${path} changed during the upgrade.`)
}

async function rollbackJournal(journalPath, journal) {
  for (const entry of journal.entries) {
    const current = await fileState(entry.path)
    const isAfter = (current?.sha256 ?? null) === entry.afterSha256 && (current?.mode ?? null) === entry.afterMode
    const isBefore = (current?.sha256 ?? null) === entry.beforeSha256 && (current?.mode ?? null) === entry.beforeMode
    if (!isAfter && !isBefore) throw new EndroitError('workplace_upgrade_rollback_drift', `${entry.path} changed after the upgrade.`)
    if (isAfter && entry.snapshot && sha256(await readFile(entry.snapshot)) !== entry.beforeSha256) {
      throw new EndroitError('workplace_upgrade_snapshot_corrupt', `${entry.snapshot} changed after the upgrade.`)
    }
  }
  journal = { ...journal, status: 'rolling-back', updatedAt: new Date().toISOString() }
  await writeJournal(journalPath, journal)
  for (let index = journal.entries.length - 1; index >= 0; index -= 1) {
    const entry = journal.entries[index]
    const current = await fileState(entry.path)
    const currentSha = current?.sha256 ?? null
    const currentMode = current?.mode ?? null
    const isAfter = currentSha === entry.afterSha256 && currentMode === entry.afterMode
    const isBefore = currentSha === entry.beforeSha256 && currentMode === entry.beforeMode
    if (!isAfter && !isBefore) {
      throw new EndroitError('workplace_upgrade_rollback_drift', `${entry.path} changed after the upgrade.`)
    }
    if (isAfter) {
      if (entry.snapshot) {
        const bytes = await readFile(entry.snapshot)
        if (sha256(bytes) !== entry.beforeSha256) throw new EndroitError('workplace_upgrade_snapshot_corrupt', `${entry.snapshot} changed after the upgrade.`)
        await writeFileAtomic(entry.path, bytes, entry.beforeMode)
      } else if (current) {
        await rm(entry.path)
        await removeEmptyProjectionParents(entry.path, journal.homeRoot)
      }
    }
    journal.entries[index].progress = 'before'
    journal = { ...journal, updatedAt: new Date().toISOString() }
    await writeJournal(journalPath, journal)
  }
  journal = { ...journal, status: 'rolled-back', rolledBackAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
  await writeJournal(journalPath, journal)
  return journal
}

async function captureProjectionState(homeRoot) {
  const paths = [
    join(homeRoot, 'AGENTS.md'),
    join(homeRoot, 'CLAUDE.md'),
    join(homeRoot, 'endroit.mjs'),
    join(homeRoot, '.endroit', 'build.json'),
    join(homeRoot, '.agents', 'skills'),
    join(homeRoot, '.claude', 'skills'),
  ]
  const state = new Map()
  for (const path of paths) await captureProjectionPath(path, state)
  return state
}

async function captureProjectionPath(path, state) {
  const info = await lstat(path).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error))
  if (!info) return
  if (info.isSymbolicLink()) throw new EndroitError('workplace_upgrade_projection_invalid', `${path} must not be a symbolic link.`)
  if (info.isFile()) {
    const bytes = await readFile(path)
    state.set(path, { bytes, mode: info.mode & 0o777, sha256: sha256(bytes) })
    return
  }
  if (!info.isDirectory()) throw new EndroitError('workplace_upgrade_projection_invalid', `${path} must be a regular projection path.`)
  for (const entry of await readdir(path, { withFileTypes: true })) await captureProjectionPath(join(path, entry.name), state)
}

async function recordProjectionChanges(homeRoot, snapshotRoot, journalPath, journal, before) {
  if (journal.entries.some((entry) => entry.kind === 'build-projection')) return journal
  const after = await captureProjectionState(homeRoot)
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort()
  for (const path of paths) {
    const prior = before.get(path) ?? null
    const current = after.get(path) ?? null
    if ((prior?.sha256 ?? null) === (current?.sha256 ?? null) && (prior?.mode ?? null) === (current?.mode ?? null)) continue
    const snapshot = prior ? join(snapshotRoot, `projection-${sha256(path)}-${basename(path)}`) : null
    if (snapshot) await writeFileAtomic(snapshot, prior.bytes, prior.mode)
    journal.entries.push({
      kind: 'build-projection',
      path,
      beforeSha256: prior?.sha256 ?? null,
      beforeMode: prior?.mode ?? null,
      afterSha256: current?.sha256 ?? null,
      afterMode: current?.mode ?? null,
      snapshot,
      progress: 'after',
    })
  }
  journal = { ...journal, updatedAt: new Date().toISOString() }
  await writeJournal(journalPath, journal)
  return journal
}

async function removeEmptyProjectionParents(path, homeRoot) {
  const roots = [join(homeRoot, '.agents', 'skills'), join(homeRoot, '.claude', 'skills')]
  const stop = roots.find((root) => path === root || path.startsWith(`${root}/`))
  if (!stop) return
  let current = dirname(path)
  while (current !== stop) {
    try { await rm(current) } catch { break }
    current = dirname(current)
  }
}

async function acquireUpgradeLocks(plan) {
  const paths = [join(plan.homeRoot, '.endroit', 'locks', 'workplace-upgrade.lock'), ...(plan.bindingLockPaths ?? [])].sort()
  const locks = []
  try {
    for (const path of paths) {
      await mkdir(dirname(path), { recursive: true })
      let handle
      try { handle = await open(path, 'wx', 0o600) }
      catch (error) {
        if (error.code === 'EEXIST') throw new EndroitError('workplace_upgrade_locked', `Workplace upgrade is locked at ${path}.`)
        throw error
      }
      const token = randomUUID()
      await handle.writeFile(`${JSON.stringify({ token, pid: process.pid, startedAt: new Date().toISOString() })}\n`)
      await handle.sync()
      locks.push({ path, handle, token })
    }
    return locks
  } catch (error) {
    await releaseUpgradeLocks(locks)
    throw error
  }
}

async function releaseUpgradeLocks(locks) {
  for (const lock of [...locks].reverse()) {
    await lock.handle.close().catch(() => {})
    let owner
    try { owner = JSON.parse(await readFile(lock.path, 'utf8')) } catch {}
    if (owner?.token === lock.token) await rm(lock.path, { force: true }).catch(() => {})
  }
}

async function writeJournal(path, journal) { await writeFileAtomic(path, `${JSON.stringify(journal, null, 2)}\n`, 0o600) }
async function readJournal(path, runId, homeRoot) {
  let journal
  try { journal = JSON.parse(await readFile(path, 'utf8')) }
  catch (error) { if (error.code === 'ENOENT') throw new EndroitError('workplace_upgrade_missing', `Upgrade run ${runId} does not exist.`); throw error }
  if (journal.version !== 1 || journal.kind !== UPGRADE_KIND || journal.runId !== runId || journal.homeRoot !== homeRoot || !Array.isArray(journal.entries)) {
    throw new EndroitError('workplace_upgrade_journal_invalid', `Upgrade run ${runId} is invalid.`)
  }
  return journal
}

function samePlan(left, right) {
  return JSON.stringify(left.writes.map(planIdentity)) === JSON.stringify(right.writes.map(planIdentity))
}
function planIdentity(write) { return [write.kind, write.path, write.before?.sha256 ?? null, write.after ? sha256(write.after) : null] }
function upgradeRunId() { return `${new Date().toISOString().replace(/[-:.]/g, '').replace('Z', 'z')}-${process.pid}` }
function displayPath(homeRoot, path) { const local = relative(homeRoot, path); return local.startsWith('..') ? path : local }
async function directoryNames(path) { return (await readdir(path, { withFileTypes: true }).catch((error) => error.code === 'ENOENT' ? [] : Promise.reject(error))).filter((entry) => entry.isDirectory() && !entry.isSymbolicLink()).map((entry) => entry.name).sort() }
function sha256(value) { return createHash('sha256').update(value).digest('hex') }
async function git(cwd, args) {
  const { stdout } = await exec('git', args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
  return stdout.trim()
}
