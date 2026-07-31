import { execFile } from 'node:child_process'
import { chmod, copyFile, mkdir, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)

export async function packEndroit(root, destination) {
  await mkdir(destination, { recursive: true })
  const cli = await pack(root, destination, [])
  return { cli: join(destination, cli.filename) }
}

export async function installPackedRuntime(home, cli) {
  const runtimeRoot = join(home, '.endroit')
  const packageRoot = join(runtimeRoot, 'packages')
  const filename = basename(cli)
  await mkdir(packageRoot, { recursive: true })
  await copyFile(cli, join(packageRoot, filename))

  const launcher = join(runtimeRoot, 'dev-cli')
  await writeFile(launcher, `#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const cli = join(dirname(fileURLToPath(import.meta.url)), 'packages', ${JSON.stringify(filename)})
const result = spawnSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['--yes', '--package', cli, 'endroit', ...process.argv.slice(2)], { stdio: 'inherit' })
process.exitCode = result.status ?? 1
`)
  await chmod(launcher, 0o755)
  return { launcher, cli: join(packageRoot, filename) }
}

async function pack(root, destination, room) {
  const { stdout } = await exec('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', destination, ...room], {
    cwd: root,
    maxBuffer: 20 * 1024 * 1024,
  })
  return JSON.parse(stdout)[0]
}
