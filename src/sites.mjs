import { lstat, mkdir, readFile, readdir } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { API, validateDocument } from './contracts.mjs'
import { EndroitError } from './lib/errors.mjs'
import { assertId, writeFileAtomic, writeJsonAtomic } from './lib/io.mjs'
import { resolveCheckout, routeV8Document } from './routes.mjs'

export async function loadSites(root) {
  const sitesRoot = join(root, 'sites')
  const values = []
  for (const entry of await directories(sitesRoot)) {
    const path = join(sitesRoot, entry, 'SITE.md')
    let content
    try {
      const info = await lstat(path)
      if (info.isSymbolicLink() || !info.isFile()) throw new EndroitError('site_invalid', `${relative(root, path)} must be a regular file.`)
      content = await readFile(path, 'utf8')
    } catch (error) {
      if (error.code === 'ENOENT') throw new EndroitError('site_invalid', `${relative(root, path)} is missing.`)
      throw error
    }
    const site = await validateDocument(frontmatter(content, path), 'site')
    if (site.id !== entry) throw new EndroitError('site_invalid', `${relative(root, path)} must identify Site ${entry}.`)
    values.push({ ...site, ref: `site:${site.id}`, path: relative(root, path) })
  }
  return values.sort((left, right) => left.id.localeCompare(right.id))
}

export async function writeSite(root, site) {
  const document = await validateDocument({
    $schema: API.site,
    id: assertId(site.id, 'Site id'),
    kind: 'site',
    status: 'active',
    ...(site.repository ? { repository: site.repository } : {}),
    ...(site.source ? { source: site.source } : {}),
    ...(site.emoji ? { emoji: site.emoji } : {}),
    ...(site.summary ? { summary: site.summary } : {}),
    ...(site.when?.length ? { when: site.when } : {}),
    ...(site.tags?.length ? { tags: site.tags } : {}),
  }, 'site')
  const directory = join(root, 'sites', document.id)
  await mkdir(join(root, 'sites'), { recursive: true })
  await mkdir(directory, { recursive: false })
  await writeFileAtomic(join(directory, 'SITE.md'), renderSite(document), 0o644)
  return { ...document, ref: `site:${document.id}`, path: relative(root, join(directory, 'SITE.md')) }
}

export async function writeRoute(root, deskRoot, route) {
  const document = await routeV8Document(route)
  const path = join(deskRoot, 'routes', document.site, `${document.id}.json`)
  await mkdir(join(deskRoot, 'routes', document.site), { recursive: true })
  await writeJsonAtomic(path, document, 0o600)
  return resolveCheckout(root, document, { documentPath: path })
}

function frontmatter(content, path) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!match) throw new EndroitError('site_invalid', `${path} must start with frontmatter.`)
  const value = {}
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(':')
    if (separator < 1) continue
    const key = line.slice(0, separator).trim()
    const raw = line.slice(separator + 1).trim()
    try { value[key] = JSON.parse(raw) } catch { value[key] = raw.replace(/^"|"$/g, '') }
  }
  return value
}

function renderSite(site) {
  const lines = ['---']
  for (const [key, value] of Object.entries(site)) lines.push(`${key}: ${JSON.stringify(value)}`)
  lines.push('---', '', `# ${site.id}`, '', site.summary ?? 'A sovereign Site connected to this Home.', '')
  return lines.join('\n')
}

async function directories(path) {
  return (await readdir(path, { withFileTypes: true }).catch((error) => error.code === 'ENOENT' ? [] : Promise.reject(error)))
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .map((entry) => entry.name)
    .sort()
}
