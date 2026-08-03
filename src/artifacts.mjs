import { readFile, readdir, realpath } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

export async function listArtifacts(homeRoot, deskRoot, plan) {
  const roots = []
  for (const room of plan.rooms ?? []) {
    roots.push({
      scope: room.scope,
      room,
      path: dirname(resolve(homeRoot, room.path)),
      legacy: false,
    })
  }
  roots.push(
    { scope: 'home', path: join(homeRoot, 'artifacts'), legacy: true },
    ...(deskRoot ? [{ scope: 'desk', path: join(deskRoot, 'artifacts'), legacy: true }] : []),
  )
  for (const site of plan.sites ?? []) {
    for (const route of (plan.routes ?? []).filter((entry) => entry.site === site.id)) {
      for (const kind of plan.artifactKinds.filter((entry) => entry.owners.includes('site') && entry.sitePath)) {
        roots.push({
          scope: `site:${site.id}`,
          route: route.id,
          site: site.id,
          path: join(route.declaredPath, kind.sitePath),
          legacy: false,
        })
      }
    }
  }

  const found = []
  const seen = new Set()
  for (const root of roots) {
    for (const path of await findNamed(root.path, 'artifact.md')) {
      const key = await realpath(path).catch(() => path)
      if (seen.has(key)) continue
      seen.add(key)
      const directory = await realpath(dirname(path)).catch(() => dirname(path))
      try {
        const parsed = parseArtifact(await readFile(path, 'utf8'))
        const metadata = normalizeMetadata(parsed.metadata)
        const kind = selectKind(plan, metadata.kind)
        const room = root.room ?? roomFromOwner(metadata.owner, plan.rooms)
        found.push({
          ...metadata,
          scope: root.scope,
          ...(room ? { room: room.id } : {}),
          ...(root.site ? { site: root.site } : {}),
          ...(root.route ? { route: root.route } : {}),
          ref: room ? artifactRef(room, kind, metadata.id) : legacyRef(metadata, root),
          path: directory,
          legacy: root.legacy || isLegacyMetadata(parsed.metadata),
        })
      } catch (error) {
        found.push({ scope: root.scope, path: directory, legacy: root.legacy, invalid: error.message })
      }
    }
  }
  return found.sort((left, right) => `${left.kind}:${left.id}:${left.scope}`.localeCompare(`${right.kind}:${right.id}:${right.scope}`))
}

function selectKind(plan, selector) {
  const matches = plan.artifactKinds.filter((kind) => kind.id === selector || kind.localId === selector)
  if (matches.length !== 1) throw new Error(`${selector} does not identify one declared Artifact kind.`)
  return matches[0]
}

function roomFromOwner(owner, rooms = []) {
  const match = String(owner).match(/^room:(home|desk)\/(.+)$/)
  return match ? rooms.find((entry) => entry.scope === match[1] && entry.id === match[2]) : null
}

function artifactRef(room, kind, id) {
  return `artifact:${room.scope}/${room.id}/${kind.roomNamespace}/${kind.localId}/${id}`
}

function legacyRef(metadata, root) {
  return `artifact:${root.scope}/${metadata.kind}/${metadata.id}@${metadata.created_at}`
}

function normalizeMetadata(raw) {
  const createdAt = raw.created_at ?? raw.createdAt
  return {
    ...raw,
    status: raw.status ?? raw.state,
    created_by: raw.created_by ?? raw.createdBy,
    created_at: createdAt,
    updated_at: raw.updated_at ?? createdAt,
    derived_from: values(raw.derived_from ?? raw.derivedFrom),
  }
}

function isLegacyMetadata(raw) {
  return raw.state !== undefined || raw.createdAt !== undefined || raw.derivedFrom !== undefined
}

function parseArtifact(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!match) throw new Error('artifact.md must start with frontmatter.')
  const metadata = {}
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(':')
    if (separator < 1) throw new Error(`Invalid frontmatter line: ${line}`)
    const key = line.slice(0, separator).trim()
    const value = line.slice(separator + 1).trim()
    try { metadata[key] = JSON.parse(value) } catch { metadata[key] = value }
  }
  return { metadata, body: match[2] }
}

async function findNamed(root, name) {
  const found = []
  async function visit(directory) {
    for (const entry of await safeReadDir(directory)) {
      const path = join(directory, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile() && entry.name === name) found.push(path)
    }
  }
  await visit(root)
  return found
}

async function safeReadDir(path) {
  try { return await readdir(path, { withFileTypes: true }) }
  catch (error) { if (error.code === 'ENOENT') return []; throw error }
}

function values(value) {
  if (value === undefined || value === null || value === '') return []
  return Array.isArray(value) ? value : [value]
}
