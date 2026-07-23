import { lstat, mkdir, readdir, readlink, realpath, symlink, unlink } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { loadDesk, loadHome, saveDesk, saveHome, settingsFor, updateSettings } from './home.mjs'
import { inspectRepository, normalizeRepository } from './git.mjs'
import { HairnessError } from './lib/errors.mjs'
import { assertId, exists } from './lib/io.mjs'

export async function targetBinding(root, id) {
  const link = join(root, '.desk', 'targets', id)
  let info
  try {
    info = await lstat(link)
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
  if (!info.isSymbolicLink()) throw new HairnessError('target_binding_invalid', `${link} is not a symbolic link.`)
  try {
    return { link, raw: await readlink(link), path: await realpath(link) }
  } catch (error) {
    if (error.code === 'ENOENT') return { link, raw: await readlink(link), path: null, broken: true }
    throw error
  }
}

export async function listTargets(root) {
  const home = await loadHome(root)
  const desk = await loadDesk(root)
  const targets = settingsFor(home, 'hairness/targets').targets ?? []
  const active = settingsFor(desk, 'hairness/targets').active ?? null
  return Promise.all(targets.map(async (target) => {
    const binding = await targetBinding(root, target.id)
    const evidence = binding?.path ? await inspectRepository(binding.path).catch((error) => ({ error: error.message })) : null
    const matches = evidence?.remotes?.some((remote) => remote.repository === normalizeRepository(target.repository)) ?? false
    return { ...target, active: target.id === active, binding: binding?.path ?? null, broken: binding?.broken ?? false, matches, evidence }
  }))
}

export async function addTarget(root, repository, options = {}) {
  const home = await loadHome(root)
  const settings = structuredClone(settingsFor(home, 'hairness/targets'))
  settings.targets ??= []
  let path = null
  let normalized = normalizeRepository(repository)
  if (await exists(repository)) {
    const evidence = await inspectRepository(repository)
    if (!evidence.remotes.length) throw new HairnessError('target_remote_missing', 'A Target must have at least one Git remote.')
    path = evidence.root
    normalized = evidence.remotes[0].repository
  }
  const id = assertId(options.id ?? slug(path ? basename(path) : normalized.split('/').at(-1)), 'Target id')
  if (settings.targets.some((target) => target.id === id)) throw new HairnessError('target_exists', `Target ${id} already exists.`)
  settings.targets.push({ id, repository: normalized, ...(options.summary ? { summary: options.summary } : {}) })
  updateSettings(home, 'hairness/targets', settings)
  await saveHome(root, home)
  if (path) await bindTarget(root, id, path)
  return (await listTargets(root)).find((target) => target.id === id)
}

export async function bindTarget(root, id, repositoryPath) {
  const home = await loadHome(root)
  await loadDesk(root, { required: true })
  const target = (settingsFor(home, 'hairness/targets').targets ?? []).find((entry) => entry.id === id)
  if (!target) throw new HairnessError('target_missing', `Target ${id} is not declared.`)
  const evidence = await inspectRepository(repositoryPath)
  if (!evidence.remotes.some((remote) => remote.repository === normalizeRepository(target.repository))) {
    throw new HairnessError('target_remote_mismatch', `${evidence.root} does not match ${target.repository}.`)
  }
  const link = join(root, '.desk', 'targets', id)
  const previous = await targetBinding(root, id)
  if (previous?.path === evidence.root) return { id, path: evidence.root, repository: target.repository }
  if (previous) await unlink(link)
  await mkdir(join(root, '.desk', 'targets'), { recursive: true })
  await symlink(evidence.root, link, 'dir')
  return { id, path: await realpath(link), repository: target.repository }
}

export async function unbindTarget(root, id) {
  const binding = await targetBinding(root, id)
  if (!binding) return { id, status: 'unbound' }
  await unlink(binding.link)
  return { id, status: 'unbound' }
}

export async function useTarget(root, id) {
  const home = await loadHome(root)
  const desk = await loadDesk(root, { required: true })
  const target = (settingsFor(home, 'hairness/targets').targets ?? []).find((entry) => entry.id === id)
  if (!target) throw new HairnessError('target_missing', `Target ${id} is not declared.`)
  const binding = await targetBinding(root, id)
  if (!binding?.path) throw new HairnessError('target_unbound', `Target ${id} is not bound on this Desk.`)
  const settings = structuredClone(settingsFor(desk, 'hairness/targets'))
  settings.active = id
  updateSettings(desk, 'hairness/targets', settings)
  await saveDesk(root, desk)
  return { id, status: 'active', path: binding.path }
}

export async function removeTarget(root, id) {
  const home = await loadHome(root)
  const settings = structuredClone(settingsFor(home, 'hairness/targets'))
  settings.targets ??= []
  if (!settings.targets.some((target) => target.id === id)) throw new HairnessError('target_missing', `Target ${id} is not declared.`)
  await unbindTarget(root, id)
  settings.targets = settings.targets.filter((target) => target.id !== id)
  updateSettings(home, 'hairness/targets', settings)
  await saveHome(root, home)
  const desk = await loadDesk(root)
  if (desk && settingsFor(desk, 'hairness/targets').active === id) {
    const deskSettings = structuredClone(settingsFor(desk, 'hairness/targets'))
    delete deskSettings.active
    updateSettings(desk, 'hairness/targets', deskSettings)
    await saveDesk(root, desk)
  }
  return { id, status: 'removed' }
}

export async function doctorTargets(root) {
  const targets = await listTargets(root)
  const limits = targets.flatMap((target) => target.broken
    ? [`target-broken:${target.id}`]
    : !target.binding
      ? [`target-unbound:${target.id}`]
      : !target.matches
        ? [`target-remote-mismatch:${target.id}`]
        : [])
  return { status: limits.length ? 'partial' : 'ready', targets, limits }
}

export async function discoverTargets(directory, options = {}) {
  const root = await realpath(directory)
  const ignored = new Set(options.ignored ?? ['.git', '.hg', '.svn', 'node_modules', 'dist', 'build', 'coverage', '.cache', '.next', 'tmp'])
  const repositories = []
  const limits = []
  async function visit(path) {
    let entries
    try {
      entries = await readdir(path, { withFileTypes: true })
    } catch (error) {
      limits.push({ path, code: error.code ?? 'read_failed', message: error.message })
      return
    }
    if (entries.some((entry) => entry.name === '.git')) {
      try {
        repositories.push(await inspectRepository(path))
      } catch (error) {
        limits.push({ path, code: error.code ?? 'git_failed', message: error.message })
      }
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || ignored.has(entry.name)) continue
      await visit(join(path, entry.name))
    }
  }
  await visit(root)
  return { root, repositories, limits }
}

function slug(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-|-$/g, '').slice(0, 80)
}
