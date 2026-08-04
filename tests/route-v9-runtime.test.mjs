import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'
import { loadRoutes } from '../src/routes.mjs'

const exec = promisify(execFile)
const runtime = fileURLToPath(new URL('../equipment/endroit/sites/runtime.mjs', import.meta.url))

test('the Sites runtime writes pathless ROUTE.md and reconstructs its Checkout link from the local index', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'endroit-route-v9-runtime-'))
  const homeRoot = join(temporary, 'home')
  const deskRoot = join(homeRoot, '.desk')
  const repository = join(temporary, 'repository')
  const site = { id: 'demo', kind: 'site', status: 'active' }
  try {
    await mkdir(join(deskRoot, 'routes'), { recursive: true })
    await mkdir(repository)
    await git(repository, ['init', '--quiet'])
    await git(repository, ['config', 'user.email', 'test@example.invalid'])
    await git(repository, ['config', 'user.name', 'Endroit Test'])
    await writeFile(join(repository, 'README.md'), '# demo\n')
    await git(repository, ['add', 'README.md'])
    await git(repository, ['commit', '--quiet', '-m', 'fixture'])

    const input = runtimeInput(homeRoot, deskRoot, site, [])
    const adopted = await invoke(input, ['checkout', 'adopt', 'demo/main', repository, '--json'])
    assert.equal(adopted.ref, 'checkout:demo/main')

    const routePath = join(deskRoot, 'routes/demo/main/ROUTE.md')
    const source = await readFile(routePath, 'utf8')
    assert.match(source, /\$schema: "https:\/\/endroit\.org\/schema\/v9\/route\.json"/)
    assert.match(source, /kind: "endroit\/route"/)
    assert.match(source, /route_state: "active"/)
    assert.match(source, /checkout_mode: "existing"/)
    assert.doesNotMatch(source, /(?:^|\n)path:/)
    assert.equal(source.includes(await realpath(repository)), false)

    const address = join(homeRoot, 'checkouts/demo/main')
    assert.equal((await lstat(address)).isSymbolicLink(), true)
    assert.equal(await realpath(address), await realpath(repository))
    const indexPath = join(homeRoot, '.endroit/checkout-index.json')
    assert.deepEqual(JSON.parse(await readFile(indexPath, 'utf8')).links.map(({ path, target, ref }) => ({ path, target, ref })), [{
      path: 'checkouts/demo/main',
      target: await realpath(repository),
      ref: 'checkout:demo/main',
    }])

    await mkdir(join(repository, 'docs'))
    await writeFile(join(repository, 'docs/guide.md'), '# Guide\n')
    const logical = await invoke(runtimeInput(homeRoot, deskRoot, site, await loadRoutes(homeRoot, deskRoot, [site])), [
      'checkout', 'resolve', 'checkout:demo/main#docs/guide.md', '--json',
    ])
    assert.equal(logical.relative_path, 'docs/guide.md')
    assert.equal(logical.path, await realpath(join(repository, 'docs/guide.md')))
    await assert.rejects(invoke(runtimeInput(homeRoot, deskRoot, site, await loadRoutes(homeRoot, deskRoot, [site])), [
      'checkout', 'resolve', 'checkout:demo/main#../outside', '--json',
    ]), /checkout_ref_path_invalid/)
    await symlink(temporary, join(repository, 'escape'), 'dir')
    await assert.rejects(invoke(runtimeInput(homeRoot, deskRoot, site, await loadRoutes(homeRoot, deskRoot, [site])), [
      'checkout', 'resolve', 'checkout:demo/main#escape', '--json',
    ]), /checkout_ref_path_escape/)
    await rm(join(repository, 'escape'))

    const routes = await loadRoutes(homeRoot, deskRoot, [site])
    const resolved = runtimeInput(homeRoot, deskRoot, site, routes)
    await invoke(resolved, ['route', 'park', 'demo', '--id', 'main', '--json'])
    const parked = await readFile(routePath, 'utf8')
    assert.match(parked, /route_state: "parked"/)
    assert.match(parked, /Local address: `checkout:demo\/main`\./)

    await rm(address)
    const parkedRoutes = await loadRoutes(homeRoot, deskRoot, [site])
    const missing = runtimeInput(homeRoot, deskRoot, site, parkedRoutes)
    const checked = await invoke(missing, ['checkout', 'reconcile', '--check', '--json'])
    assert.equal(checked.status, 'stale')
    assert.equal(checked.readOnly, true)
    assert.equal((await invoke(missing, ['route', 'inspect', 'demo', '--id', 'main', '--json'])).observed.index, 'missing')
    await invoke(missing, ['checkout', 'reconcile', '--apply', '--json'])
    assert.equal(await realpath(address), await realpath(repository))

    const unknown = join(homeRoot, 'checkouts/demo/unknown')
    await symlink(repository, unknown, 'dir')
    await invoke(missing, ['checkout', 'reconcile', '--apply', '--json'])
    assert.equal(await realpath(unknown), await realpath(repository))

    await invoke(runtimeInput(homeRoot, deskRoot, site, parkedRoutes), ['route', 'remove', 'demo', '--id', 'main', '--json'])
    await assert.rejects(lstat(address), (error) => error.code === 'ENOENT')
    await assert.rejects(lstat(routePath), (error) => error.code === 'ENOENT')
    assert.equal(JSON.parse(await readFile(indexPath, 'utf8')).links.length, 0)
    assert.equal(await realpath(unknown), await realpath(repository))
    assert.equal(await readFile(join(repository, 'README.md'), 'utf8'), '# demo\n')
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
})

function runtimeInput(homeRoot, deskRoot, site, routes) {
  return {
    argv: [],
    homeRoot,
    deskRoot,
    resolvedHome: {
      home: { settings: {} },
      desk: { id: 'local', settings: {} },
      sites: [site],
      routes,
    },
  }
}

async function invoke(input, argv) {
  const result = await new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [runtime], { cwd: input.homeRoot, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', reject)
    child.on('close', (code) => code === 0 ? resolvePromise(stdout) : reject(new Error(stderr)))
    child.stdin.end(JSON.stringify({ ...input, argv }))
  })
  return JSON.parse(result)
}

async function git(cwd, args) {
  return (await exec('git', args, { cwd })).stdout.trim()
}
