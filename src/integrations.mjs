import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { loadDesk, loadHome, saveDesk, saveHome, settingsFor, updateSettings } from './home.mjs'
import { HairnessError } from './lib/errors.mjs'
import { assertId, writeJsonAtomic } from './lib/io.mjs'

const exec = promisify(execFile)

export async function listIntegrations(root) {
  const home = await loadHome(root)
  const desk = await loadDesk(root)
  const integrations = settingsFor(home, 'hairness/integrations').integrations ?? []
  const bindings = settingsFor(desk, 'hairness/integrations').bindings ?? {}
  return integrations.map((integration) => ({
    ...integration,
    bindings: bindings[integration.id] ?? {},
  }))
}

export async function addIntegration(root, id, accessors, summary) {
  const home = await loadHome(root)
  const settings = structuredClone(settingsFor(home, 'hairness/integrations'))
  settings.integrations ??= []
  assertId(id, 'Integration id')
  if (settings.integrations.some((entry) => entry.id === id)) throw new HairnessError('integration_exists', `Integration ${id} already exists.`)
  if (!accessors.length) throw new HairnessError('usage', 'At least one Integration accessor is required.')
  settings.integrations.push({ id, ...(summary ? { summary } : {}), accessors })
  updateSettings(home, 'hairness/integrations', settings)
  await saveHome(root, home)
  return { id, accessors, bindings: {} }
}

export async function bindIntegration(root, id, provider, descriptor) {
  const home = await loadHome(root)
  const desk = await loadDesk(root, { required: true })
  if (!home.providers.includes(provider)) throw new HairnessError('provider_inactive', `Provider ${provider} is not active.`)
  const integration = (settingsFor(home, 'hairness/integrations').integrations ?? []).find((entry) => entry.id === id)
  if (!integration) throw new HairnessError('integration_missing', `Integration ${id} is not declared.`)
  const binding = parseBinding(descriptor)
  if (binding.kind !== 'none' && !integration.accessors.some((accessor) => sameAccessor(accessor, binding, provider))) {
    throw new HairnessError('integration_accessor_missing', `${descriptor} is not declared for ${id} on ${provider}.`)
  }
  const settings = structuredClone(settingsFor(desk, 'hairness/integrations'))
  settings.bindings ??= {}
  settings.bindings[id] ??= {}
  settings.bindings[id][provider] = binding
  updateSettings(desk, 'hairness/integrations', settings)
  await saveDesk(root, desk)
  return { id, provider, binding }
}

export async function unbindIntegration(root, id, provider) {
  const desk = await loadDesk(root, { required: true })
  const settings = structuredClone(settingsFor(desk, 'hairness/integrations'))
  settings.bindings ??= {}
  if (settings.bindings[id]) {
    delete settings.bindings[id][provider]
    if (!Object.keys(settings.bindings[id]).length) delete settings.bindings[id]
    updateSettings(desk, 'hairness/integrations', settings)
    await saveDesk(root, desk)
  }
  return { id, provider, status: 'unbound' }
}

export async function removeIntegration(root, id) {
  const home = await loadHome(root)
  const homeSettings = structuredClone(settingsFor(home, 'hairness/integrations'))
  homeSettings.integrations ??= []
  if (!homeSettings.integrations.some((entry) => entry.id === id)) throw new HairnessError('integration_missing', `Integration ${id} is not declared.`)
  homeSettings.integrations = homeSettings.integrations.filter((entry) => entry.id !== id)
  updateSettings(home, 'hairness/integrations', homeSettings)
  await saveHome(root, home)
  const desk = await loadDesk(root)
  if (desk) {
    const deskSettings = structuredClone(settingsFor(desk, 'hairness/integrations'))
    deskSettings.bindings ??= {}
    delete deskSettings.bindings[id]
    updateSettings(desk, 'hairness/integrations', deskSettings)
    await saveDesk(root, desk)
  }
  return { id, status: 'removed' }
}

export async function doctorIntegrations(root) {
  const home = await loadHome(root)
  const integrations = await listIntegrations(root)
  const limits = []
  const checked = []
  for (const integration of integrations) {
    const bindings = {}
    for (const provider of home.providers) {
      const binding = integration.bindings[provider]
      if (!binding) {
        limits.push(`integration-unbound:${integration.id}:${provider}`)
        continue
      }
      if (binding.kind === 'none') {
        limits.push(`integration-unavailable:${integration.id}:${provider}`)
        bindings[provider] = { ...binding, available: false }
      } else if (binding.kind === 'cli') {
        const available = await exec('which', [binding.command]).then(() => true, () => false)
        if (!available) limits.push(`integration-cli-missing:${integration.id}:${binding.command}`)
        bindings[provider] = { ...binding, available }
      } else {
        bindings[provider] = { ...binding, available: null }
      }
    }
    checked.push({ ...integration, bindings })
  }
  return { status: limits.length ? 'partial' : 'ready', integrations: checked, limits }
}

export function parseAccessors(values = {}) {
  const accessors = []
  for (const command of split(values.cli)) accessors.push({ kind: 'cli', command })
  for (const item of split(values.provider)) {
    const separator = item.indexOf(':')
    if (separator < 1) throw new HairnessError('usage', `Provider accessor must be <provider>:<id>, received ${item}.`)
    accessors.push({ kind: 'provider', provider: item.slice(0, separator), id: item.slice(separator + 1) })
  }
  return accessors
}

function parseBinding(value) {
  if (value === 'none') return { kind: 'none' }
  const separator = String(value).indexOf(':')
  if (separator < 1) throw new HairnessError('usage', 'Accessor must be cli:<command>, provider:<id> or none.')
  const kind = value.slice(0, separator)
  const selected = value.slice(separator + 1)
  if (kind === 'cli') return { kind, command: selected }
  if (kind === 'provider') return { kind, id: selected }
  throw new HairnessError('usage', `Unknown accessor kind ${kind}.`)
}

function sameAccessor(accessor, binding, provider) {
  return accessor.kind === binding.kind
    && (binding.kind === 'cli' ? accessor.command === binding.command : accessor.provider === provider && accessor.id === binding.id)
}

function split(value) {
  if (value === undefined) return []
  return (Array.isArray(value) ? value : [value]).flatMap((entry) => String(entry).split(',')).map((entry) => entry.trim()).filter(Boolean)
}
