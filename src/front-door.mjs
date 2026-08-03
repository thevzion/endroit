const BOOTSTRAP_MAX_BYTES = 4_096

export function renderFloorPlan(plan) {
  const workplace = resolvedWorkplace(plan)
  return `## Endroit Workplace

<!-- generated provider projection; rebuild instead of editing -->

- Identity: \`${workplace.id}\`
- Profile: \`${workplace.profile}\`
- Protocol: \`${workplace.protocol}\`
- Revision: \`${sourceRevision(plan)}\`

### Source and projection

Owned Markdown sources are canonical. This provider file is a rebuildable
projection; edit its named source and rebuild it instead of treating edits here
as durable truth.

### Authority and routing

The human retains direction, judgment, acceptance and delivery consent. Prefer
an explicitly named Room, Site or Route; otherwise continue only a unique
semantic match and ask when the destination is ambiguous. Access to a Site is
not authority to mutate or deliver it.

### Local Console

    node ./endroit.mjs <namespace> <command> [...arguments]

If the Console is unavailable, keep working from readable owned sources,
report \`degraded\`, and stop structural mutation, Route-mediated mutation and
external effects.`
}

export function renderProviderBootstrap(plan, constitution) {
  const body = `# Endroit provider bootstrap

<!-- source revision: ${sourceRevision(plan)} -->

## Constitution

${String(constitution ?? '').trim()}

${renderFloorPlan(plan)}
`
  const bytes = Buffer.byteLength(body)
  if (bytes > BOOTSTRAP_MAX_BYTES) {
    const error = new Error(`Provider bootstrap is ${bytes} bytes, over the ${BOOTSTRAP_MAX_BYTES} byte limit.`)
    error.code = 'context_budget_exceeded'
    throw error
  }
  return body
}

export function homeConsole() {
  return `#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { lstatSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const workplaceRoot = dirname(fileURLToPath(import.meta.url))
const runtime = declaredRuntime(workplaceRoot)
if (!/^@endroit\\/cli@[0-9]+\\.[0-9]+\\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(runtime)) {
  throw new Error('The Workplace declaration contains an invalid runtime.')
}

const development = join(workplaceRoot, '.endroit', 'dev-cli')
let local = false
try {
  const info = lstatSync(development)
  if (info.isSymbolicLink() || !info.isFile()) throw new Error('.endroit/dev-cli must be a regular file.')
  local = true
} catch (error) {
  if (error.code !== 'ENOENT') throw error
}

const command = local ? process.execPath : process.platform === 'win32' ? 'npx.cmd' : 'npx'
const args = local
  ? [development, ...process.argv.slice(2)]
  : ['--yes', runtime, ...process.argv.slice(2)]
const child = spawn(command, args, {
  cwd: workplaceRoot,
  env: {
    ...process.env,
    ENDROIT_WORKPLACE_PATH: workplaceRoot,
    ENDROIT_HOME_PATH: workplaceRoot,
    ENDROIT_RUNTIME_SOURCE: local ? 'development' : 'npm',
  },
  stdio: 'inherit',
})

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => child.kill(signal))
}
child.on('error', (error) => {
  process.stderr.write(\`endroit_console_failed: \${error.message}\\n\`)
  process.exitCode = 1
})
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exitCode = code ?? 1
})

function declaredRuntime(root) {
  try {
    const source = readFileSync(join(root, 'WORKPLACE.md'), 'utf8')
    const match = source.match(/^runtime:\\s*(.+)$/m)
    if (!match) throw new Error('WORKPLACE.md has no runtime.')
    try { return JSON.parse(match[1].trim()) } catch { return match[1].trim() }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    return JSON.parse(readFileSync(join(root, 'endroit.json'), 'utf8')).runtime
  }
}
`
}

export function sessionWrapper(provider, frontDoor = {}, limits = {}) {
  const timeoutMs = limits.timeoutMs ?? 30_000
  const maxBytes = limits.maxBytes ?? BOOTSTRAP_MAX_BYTES
  const namespace = frontDoor.namespace ?? 'hud'
  const command = frontDoor.command ?? 'prompt'
  return `#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const provider = ${JSON.stringify(provider)}
const route = ${JSON.stringify([namespace, command])}
const workplaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const degraded = '<endroit-front-door version="1" status="degraded" reason="wake-up-unavailable" />'

try {
  const output = await execute()
  emit(output)
} catch {
  emit(degraded)
}

function emit(context) {
  const value = context.trimEnd()
  if (provider === 'codex') {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: value,
      },
    }) + '\\n')
  } else {
    process.stdout.write(value + '\\n')
  }
}

function execute() {
  return new Promise((resolvePromise, reject) => {
    let output = Buffer.alloc(0)
    let settled = false
    const child = spawn(process.execPath, [join(workplaceRoot, 'endroit.mjs'), ...route], {
      cwd: workplaceRoot,
      env: {
        ...process.env,
        ENDROIT_INVOCATION_KIND: 'wake-up',
        ENDROIT_INVOCATION_PROVIDER: provider,
      },
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const finish = (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else if (!output.length) reject(new Error('Wake-up produced no output.'))
      else resolvePromise(output.toString('utf8'))
    }
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      finish(new Error('Wake-up timed out.'))
    }, ${timeoutMs})
    child.on('error', finish)
    child.stdout.on('data', (chunk) => {
      output = Buffer.concat([output, chunk])
      if (output.length > ${maxBytes}) {
        child.kill('SIGTERM')
        finish(new Error('Wake-up exceeded its output limit.'))
      }
    })
    child.on('close', (code) => finish(code === 0 ? null : new Error('Wake-up failed.')))
  })
}
`
}

function resolvedWorkplace(plan) {
  if (plan.workplace) {
    return {
      id: plan.workplace.id,
      profile: plan.workplace.profile,
      protocol: plan.workplace.protocol,
    }
  }
  return {
    id: plan.home.name,
    profile: 'endroit/legacy-v7',
    protocol: 'open-workplace/0.1',
  }
}

function sourceRevision(plan) {
  return plan.revision ?? plan.workplace?.source_digest ?? 'legacy'
}
