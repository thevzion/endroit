export function renderFloorPlan(plan) {
  const runtimes = plan.runtimes
    .map((runtime) => `- \`${runtime.namespace}\`: ${runtime.commands.map((command) => command.name).join(', ')}`)
    .join('\n') || '- none'
  const wakeUp = plan.frontDoor
    ? `\`${plan.frontDoor.route}\` via \`${plan.frontDoor.namespace} ${plan.frontDoor.command}\``
    : 'not configured'
  return `## Hairness Floor Plan

<!-- generated from the Resolved Home; rebuild instead of editing -->

- Home: \`${plan.home.name}\` (\`${plan.home.mode}\`)
- Providers: ${plan.home.providers.map((provider) => `\`${provider}\``).join(', ')}
- Canonical sources: \`hairness.json\`, \`HOME.md\`, \`assets/\`, \`artifacts/\`
- Collaborator sources: \`.desk/DESK.md\`, \`.desk/assets/\`, \`.desk/artifacts/\`, \`.desk/targets/\`
- Local rebuildable state: \`.hairness/\`

The Home owns shared sources and projections. The Desk owns collaborator-local
continuity. Targets remain independent repositories. Generated provider files
are never canonical.

Use the tracked Home Console for every Kernel or Asset route:

    node ./hairness.mjs <namespace> <command> [...arguments]

Kernel routes:

- \`desk init|clone\`
- \`asset validate|add|status|sync|remove|override|publish|trust\`
- \`validate\`, \`build\`, \`doctor\`

Asset runtime namespaces:

${runtimes}

Wake-up: ${wakeUp}.

If Wake-up is unavailable, this Floor Plan remains authoritative. Do not guess
another runtime or search outside the Home to compensate.`
}

export function homeConsole() {
  return `#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { lstatSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const homeRoot = dirname(fileURLToPath(import.meta.url))
const home = JSON.parse(readFileSync(join(homeRoot, 'hairness.json'), 'utf8'))
if (!/^@hairness\\/cli@[0-9]+\\.[0-9]+\\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(home.runtime)) {
  throw new Error('hairness.json contains an invalid runtime.')
}

const development = join(homeRoot, '.hairness', 'dev-cli')
let local = false
try {
  const info = lstatSync(development)
  if (info.isSymbolicLink() || !info.isFile()) throw new Error('.hairness/dev-cli must be a regular file.')
  local = true
} catch (error) {
  if (error.code !== 'ENOENT') throw error
}

const command = local ? process.execPath : process.platform === 'win32' ? 'npx.cmd' : 'npx'
const args = local
  ? [development, ...process.argv.slice(2)]
  : ['--yes', home.runtime, ...process.argv.slice(2)]
const child = spawn(command, args, {
  cwd: homeRoot,
  env: {
    ...process.env,
    HAIRNESS_HOME_PATH: homeRoot,
    HAIRNESS_RUNTIME_SOURCE: local ? 'development' : 'npm',
  },
  stdio: 'inherit',
})

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => child.kill(signal))
}
child.on('error', (error) => {
  process.stderr.write(\`hairness_console_failed: \${error.message}\\n\`)
  process.exitCode = 1
})
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exitCode = code ?? 1
})
`
}

export function sessionWrapper(provider, frontDoor, limits = {}) {
  const timeoutMs = limits.timeoutMs ?? 30_000
  const maxBytes = limits.maxBytes ?? 256 * 1024
  return `#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const provider = ${JSON.stringify(provider)}
const route = ${JSON.stringify([frontDoor.namespace, frontDoor.command])}
const homeRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const degraded = '<hairness-front-door version="1" status="degraded" reason="wake-up-unavailable" />'

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
    const child = spawn(process.execPath, [join(homeRoot, 'hairness.mjs'), ...route], {
      cwd: homeRoot,
      env: {
        ...process.env,
        HAIRNESS_INVOCATION_KIND: 'wake-up',
        HAIRNESS_INVOCATION_PROVIDER: provider,
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
