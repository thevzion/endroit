import { spawn } from 'node:child_process'
import { realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { allInstalledEquipment, equipmentDigest, installedEquipmentDigest, resolveEquipment } from './equipment.mjs'
import { API, validateDocument } from './contracts.mjs'
import { loadDesk } from './desk.mjs'
import { EndroitError } from './lib/errors.mjs'
import { readJson, resolvePackageFile, writeJsonAtomic } from './lib/io.mjs'
import { resolveHome } from './resolved.mjs'

export async function runtimeTrust(root, selector, options = {}) {
  const plan = await resolveHome(root)
  const runtime = selectRuntime(plan, selector)
  const installed = plan.equipment.find((entry) => entry.id === runtime.owner)
  const digest = await runtimeDigest(plan, runtime.owner)
  const path = join(root, '.endroit', 'approvals.json')
  const approvals = await readJson(path, { version: 1, runtimes: {} })
  if (options.revoke) {
    delete approvals.runtimes[runtime.owner]
    await writeJsonAtomic(path, approvals, 0o600)
    return { status: 'revoked', name: runtime.owner, digest }
  }
  if (options.digest !== digest) {
    throw new EndroitError('runtime_digest_mismatch', `Approval digest must equal ${digest}.`, { details: { expected: digest, received: options.digest } })
  }
  approvals.runtimes[runtime.owner] = digest
  await writeJsonAtomic(path, approvals, 0o600)
  return {
    status: 'trusted',
    name: runtime.owner,
    digest,
    scope: installed.scope,
    trust: await exactFirstParty(root, runtime, digest) ? 'bundled' : 'approved',
  }
}

export async function runtimeTrustState(root, owner, plan) {
  plan ??= await resolveHome(root)
  const runtime = selectRuntime(plan, owner)
  const digest = await runtimeDigest(plan, owner)
  if (await exactFirstParty(root, runtime, digest)) return { trust: 'bundled', digest }
  const approvals = await readJson(join(root, '.endroit', 'approvals.json'), { version: 1, runtimes: {} })
  return { trust: approvals.runtimes?.[owner] === digest ? 'approved' : 'pending', digest }
}

export async function dispatchRuntime(root, namespace, argv, io = process) {
  const plan = await resolveHome(root)
  const runtime = plan.runtimes.find((entry) => entry.namespace === namespace)
  if (!runtime) throw new EndroitError('usage', `Unknown command ${namespace}.`, { exitCode: 2 })
  const trust = await runtimeTrustState(root, runtime.owner, plan)
  if (trust.trust === 'pending') {
    throw new EndroitError('runtime_trust_required', `${runtime.owner} runtime ${trust.digest} requires local approval. Review it, then run endroit equipment trust ${runtime.owner} --digest ${trust.digest}.`, {
      exitCode: 6,
      details: { equipment: runtime.owner, digest: trust.digest, entry: runtime.entry, namespace },
    })
  }
  const entry = await resolvePackageFile(runtime.root, runtime.entry, `${runtime.owner} runtime`)
  const desk = await loadDesk(root)
  const homeRoot = await realpath(root)
  const deskRoot = desk ? await realpath(join(root, '.desk')) : null
  const runtimeSource = process.env.ENDROIT_RUNTIME_SOURCE === 'development' ? 'development' : 'npm'
  const invocationKind = process.env.ENDROIT_INVOCATION_KIND === 'wake-up' ? 'wake-up' : 'command'
  const invocationProvider = ['codex', 'claude'].includes(process.env.ENDROIT_INVOCATION_PROVIDER)
    ? process.env.ENDROIT_INVOCATION_PROVIDER
    : undefined
  const trustStates = []
  for (const candidate of plan.runtimes) {
    try {
      trustStates.push({ owner: candidate.owner, namespace: candidate.namespace, ...await runtimeTrustState(root, candidate.owner, plan) })
    } catch (error) {
      trustStates.push({ owner: candidate.owner, namespace: candidate.namespace, trust: 'pending', error: error.code ?? 'runtime-invalid' })
    }
  }
  const input = {
    protocol: API.runtime,
    argv,
    homeRoot,
    deskRoot,
    equipmentRoot: runtime.root,
    resolvedHome: plan,
    kernel: {
      runtime: plan.home.runtime,
      source: runtimeSource,
      invoke: 'node ./endroit.mjs',
    },
    runtimeTrust: trustStates,
    invocation: {
      kind: invocationKind,
      ...(invocationProvider ? { provider: invocationProvider } : {}),
    },
  }
  await validateDocument(input, 'runtime')
  return run(entry, input, io)
}

async function run(entry, input, io) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [entry], {
      cwd: input.homeRoot,
      env: { ...process.env, ENDROIT_HOME_PATH: input.homeRoot },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    child.stdout.on('data', (chunk) => io.stdout.write(chunk))
    child.stderr.on('data', (chunk) => io.stderr.write(chunk))
    child.on('error', reject)
    child.on('close', (code, signal) => {
      if (signal) reject(new EndroitError('runtime_failed', `${entry} terminated with ${signal}.`, { exitCode: 4 }))
      else resolvePromise(code ?? 1)
    })
    child.stdin.end(JSON.stringify(input))
  })
}

async function runtimeDigest(plan, owner) {
  const entry = plan.equipment.find((equipment) => equipment.id === owner)
  const values = await allInstalledEquipment(plan.root)
  const source = values.find((equipment) => equipment.id === owner && equipment.scope === entry.scope)
  return installedEquipmentDigest(source)
}

async function exactFirstParty(root, runtime, digest) {
  if (!runtime.owner.startsWith('endroit/')) return false
  try {
    const builtin = await resolveEquipment(root, `@${runtime.owner}`)
    return builtin.firstParty && equipmentDigest(builtin) === digest
  } catch {
    return false
  }
}

function selectRuntime(plan, selector) {
  const matches = plan.runtimes.filter((entry) => entry.owner === selector || entry.owner.split('/').at(-1) === selector || entry.namespace === selector)
  if (!matches.length) throw new EndroitError('runtime_missing', `${selector} does not identify an active Equipment runtime.`)
  if (matches.length > 1) throw new EndroitError('runtime_ambiguous', `${selector} matches multiple Equipment runtimes.`)
  return matches[0]
}
