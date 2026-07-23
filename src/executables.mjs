import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { HairnessError } from './lib/errors.mjs'
import { digest, readJson, resolvePackageFile, treeFiles, writeJsonAtomic } from './lib/io.mjs'

export async function executableDigest(executable) {
  await resolvePackageFile(executable.root, executable.entry, `${executable.id} executable`)
  const files = await treeFiles(executable.root)
  return digest(Buffer.concat([Buffer.from(JSON.stringify({
    id: executable.id,
    entry: executable.entry,
    outputs: executable.outputs,
    runOn: executable.runOn ?? null,
    permissions: executable.permissions ?? [],
  })), ...files.flatMap((file) => [Buffer.from(`\n${file.path}\0`), file.content])]))
}

export async function approveExecutable(root, executable) {
  const path = join(root, '.hairness', 'approvals.json')
  const approvals = await readJson(path, { version: 1, executables: {} })
  approvals.executables[executable.id] = await executableDigest(executable)
  await writeJsonAtomic(path, approvals, 0o600)
  return { id: executable.id, status: 'approved', digest: approvals.executables[executable.id] }
}

export async function executableApproved(root, executable) {
  const approvals = await readJson(join(root, '.hairness', 'approvals.json'), { version: 1, executables: {} })
  return approvals.executables?.[executable.id] === await executableDigest(executable)
}

export async function runExecutable(root, executable, context = {}) {
  if (!await executableApproved(root, executable)) {
    throw new HairnessError('executable_approval_required', `${executable.id} requires local approval for its current digest.`)
  }
  const outputRoot = await mkdtemp(join(root, '.hairness-executable-'))
  try {
    const entry = await resolvePackageFile(executable.root, executable.entry, `${executable.id} executable`)
    await run(entry, await realpath(executable.root), await realpath(outputRoot), {
      ...context,
      permissions: executable.permissions ?? [],
    })
    const declared = executable.outputs.map((path) => path.replaceAll('\\', '/').replace(/\/+$/, ''))
    const files = await treeFiles(outputRoot)
    for (const file of files) {
      if (!declared.some((path) => file.path === path || file.path.startsWith(`${path}/`))) {
        throw new HairnessError('executable_output_undeclared', `${executable.id} wrote undeclared output ${file.path}.`)
      }
    }
    return files
  } finally {
    await rm(outputRoot, { recursive: true, force: true })
  }
}

async function run(entry, assetRoot, outputRoot, context) {
  await mkdir(outputRoot, { recursive: true })
  await new Promise((resolvePromise, reject) => {
    const runtimeArguments = [
      '--permission',
      `--allow-fs-read=${assetRoot}`,
      `--allow-fs-read=${outputRoot}`,
      `--allow-fs-write=${outputRoot}`,
    ]
    if (executablePermission(context, 'child-process')) runtimeArguments.push('--allow-child-process')
    runtimeArguments.push(entry)
    const child = spawn(process.execPath, runtimeArguments, {
      cwd: dirname(entry),
      env: {
        PATH: process.env.PATH ?? '',
        HOME: '/nonexistent',
        NO_COLOR: '1',
        HAIRNESS_OUTPUT_DIR: outputRoot,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const stderr = []
    let size = 0
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new HairnessError('executable_timeout', `${entry} exceeded 120 seconds.`))
    }, 120_000)
    for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => {
      size += chunk.length
      if (size > 2 * 1024 * 1024) child.kill('SIGKILL')
      else if (stream === child.stderr) stderr.push(chunk)
    })
    child.on('error', reject)
    child.on('close', (code) => {
      clearTimeout(timer)
      if (size > 2 * 1024 * 1024) reject(new HairnessError('executable_output_too_large', `${entry} emitted more than 2 MiB.`))
      else if (code !== 0) reject(new HairnessError('executable_failed', Buffer.concat(stderr).toString('utf8').trim() || `${entry} exited ${code}.`))
      else resolvePromise()
    })
    child.stdin.end(JSON.stringify(context))
  })
}

function executablePermission(context, permission) {
  return (context.permissions ?? []).includes(permission)
}
