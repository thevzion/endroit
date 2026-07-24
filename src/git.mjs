import { execFile } from 'node:child_process'
import { lstat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import { HairnessError } from './lib/errors.mjs'

const exec = promisify(execFile)

export async function git(args, options = {}) {
  try {
    const result = await exec('git', args, {
      cwd: options.cwd,
      maxBuffer: options.maxBuffer ?? 8 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...options.env },
    })
    return options.trim === false ? result.stdout : result.stdout.trim()
  } catch (error) {
    throw new HairnessError('git_failed', `git ${args.join(' ')} failed: ${error.stderr?.trim() || error.message}`, {
      exitCode: 4,
      details: { args, cwd: options.cwd, stderr: error.stderr?.trim() },
      cause: error,
    })
  }
}

export async function inspectRepository(path) {
  const root = await git(['rev-parse', '--show-toplevel'], { cwd: path })
  const [head, branch, status, remoteOutput, committedAt, worktreeOutput] = await Promise.all([
    git(['rev-parse', 'HEAD'], { cwd: root }).catch(() => null),
    git(['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: root }).catch(() => null),
    git(['status', '--porcelain=v2', '--branch', '--untracked-files=all'], { cwd: root, trim: false }),
    git(['config', '--get-regexp', '^remote\\..*\\.url$'], { cwd: root }).catch(() => ''),
    git(['log', '-1', '--format=%cI'], { cwd: root }).catch(() => null),
    git(['worktree', 'list', '--porcelain'], { cwd: root, trim: false }).catch(() => ''),
  ])
  const remotes = remoteOutput.split('\n').filter(Boolean).map((line) => {
    const separator = line.indexOf(' ')
    const name = line.slice(0, separator).replace(/^remote\./, '').replace(/\.url$/, '')
    const url = line.slice(separator + 1).trim()
    return { name, url, repository: normalizeRepository(url) }
  })
  const changes = status.split('\n').filter((line) => /^(1 |2 |u |\? )/.test(line))
  const branchLine = (prefix) => status.split('\n').find((line) => line.startsWith(prefix))?.slice(prefix.length).trim() ?? null
  const divergence = branchLine('# branch.ab ')?.match(/^\+(\d+) -(\d+)$/)
  return {
    root,
    head,
    branch,
    detached: !branch,
    clean: changes.length === 0,
    changes,
    conflicts: changes.filter((line) => line.startsWith('u ')).length,
    upstream: branchLine('# branch.upstream '),
    ahead: divergence ? Number(divergence[1]) : 0,
    behind: divergence ? Number(divergence[2]) : 0,
    committedAt,
    operation: await gitOperation(root),
    worktrees: parseWorktrees(worktreeOutput),
    remotes,
  }
}

export const gitEvidence = inspectRepository

async function gitOperation(root) {
  const checks = [
    ['merge', 'MERGE_HEAD'],
    ['cherry-pick', 'CHERRY_PICK_HEAD'],
    ['revert', 'REVERT_HEAD'],
    ['rebase', 'rebase-merge'],
    ['rebase', 'rebase-apply'],
  ]
  for (const [name, marker] of checks) {
    const value = await git(['rev-parse', '--git-path', marker], { cwd: root })
    const candidate = isAbsolute(value) ? value : join(root, value)
    try {
      await lstat(candidate)
      return name
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  return null
}

function parseWorktrees(value) {
  const entries = []
  let current
  for (const line of value.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current) entries.push(current)
      current = { path: line.slice(9) }
    } else if (current && line.startsWith('HEAD ')) current.head = line.slice(5)
    else if (current && line.startsWith('branch ')) current.branch = line.slice(7).replace('refs/heads/', '')
    else if (current && line === 'detached') current.detached = true
  }
  if (current) entries.push(current)
  return entries
}

export function normalizeRepository(value) {
  let source = String(value).trim()
  const scp = source.match(/^(?:[^@]+@)?([^:/]+):(.+)$/)
  if (scp && !source.includes('://')) source = `ssh://${scp[1]}/${scp[2]}`
  try {
    const url = new URL(source)
    return `${url.hostname.toLowerCase()}/${url.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '').toLowerCase()}`
  } catch {
    return source.replace(/\.git$/i, '').replace(/^\/+|\/+$/g, '').toLowerCase()
  }
}
