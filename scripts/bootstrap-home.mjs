#!/usr/bin/env node
import { execFile, spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { installPackedRuntime, packHairness } from './lib/pack.mjs'

const exec = promisify(execFile)
const projectRoot = new URL('../', import.meta.url).pathname
const argumentsList = process.argv.slice(2)
const destinationArgument = argumentsList[0] && !argumentsList[0].startsWith('-')
  ? argumentsList.shift()
  : undefined
const home = resolve(destinationArgument ?? join(projectRoot, '..', 'hairness-bootstrap-home'))
const temporary = await mkdtemp(join(tmpdir(), 'hairness-bootstrap-'))

try {
  const { cli } = await packHairness(projectRoot, join(temporary, 'packages'))
  await run('npx', ['--yes', '--package', cli, 'hairness', 'create', home, ...argumentsList])
  await installPackedRuntime(home, cli)

  const { stdout } = await exec(process.execPath, [join(home, 'hairness.mjs'), 'doctor', '--json'], {
    cwd: home,
    maxBuffer: 20 * 1024 * 1024,
  })
  const doctor = JSON.parse(stdout)
  if (doctor.status !== 'ready') throw new Error(`Created Home is ${doctor.status}: ${doctor.limits.join(', ')}`)

  process.stdout.write(`
Local packed runtime attached
Home: ${home}
The Home is ready to open with the command shown above.
`)
} finally {
  await rm(temporary, { recursive: true, force: true })
}

function run(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.platform === 'win32' && command === 'npx' ? 'npx.cmd' : command, args, {
      cwd: projectRoot,
      stdio: 'inherit',
    })
    child.on('error', reject)
    child.on('exit', (code, signal) => {
      if (signal) reject(new Error(`${command} stopped by ${signal}`))
      else if (code === 0) resolvePromise()
      else reject(new Error(`${command} exited with code ${code}`))
    })
  })
}
