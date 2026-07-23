import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { addAssets, diffAsset, publishAsset, removeAsset, resolveAsset, statusAssets, syncAssets } from '../src/assets.mjs'
import { buildHome } from '../src/build.mjs'
import { createHome } from '../src/create.mjs'
import { executableApproved } from '../src/executables.mjs'
import { resolveHome } from '../src/resolved.mjs'
import { asset, writeAsset } from './helpers.mjs'

const exec = promisify(execFile)

test('add, status, diff, sync and remove preserve source ownership', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hairness-lifecycle-'))
  try {
    const home = join(root, 'home')
    await createHome(home)
    const v1 = await writeAsset(join(root, 'v1'), asset(), { 'capabilities/review.md': 'Review version one.\n' })
    await addAssets(home, [v1])
    assert.equal((await statusAssets(home, 'fixture/review'))[0].state, 'clean')
    await buildHome(home)
    assert.match(await readFile(join(home, '.agents/skills/hairness-review/SKILL.md'), 'utf8'), /version one/)

    const sourceFile = join(home, 'assets/fixture/review/capabilities/review.md')
    await writeFile(sourceFile, 'Local customization.\n')
    assert.equal((await statusAssets(home, 'review'))[0].state, 'customized')
    const v2 = await writeAsset(join(root, 'v2'), asset({
      version: '2.0.0',
      references: [{ id: 'new', source: 'knowledge/new.md', description: 'New knowledge.' }],
    }), { 'capabilities/review.md': 'Review version two.\n', 'knowledge/new.md': 'New knowledge.\n' })
    const before = await readFile(sourceFile)
    await assert.rejects(() => syncAssets(home, 'review', { to: v2 }), (error) => error.code === 'sync_customized')
    assert.deepEqual(await readFile(sourceFile), before)
    assert.equal((await diffAsset(home, 'review', { to: v2 })).files.find((file) => file.path === 'capabilities/review.md').change, 'changed')

    const unknown = join(home, 'assets/fixture/review/notes.md')
    await writeFile(unknown, 'Owned locally.\n')
    await syncAssets(home, 'review', { to: v2, overwrite: true })
    assert.equal(await readFile(unknown, 'utf8'), 'Owned locally.\n')
    assert.equal(await readFile(sourceFile, 'utf8'), 'Review version two.\n')
    await removeAsset(home, 'review')
    assert.equal(await readFile(unknown, 'utf8'), 'Owned locally.\n')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a Desk Asset publishes to the Home with origin removed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hairness-publish-'))
  try {
    const home = join(root, 'home')
    await createHome(home)
    const source = await writeAsset(join(root, 'source'), asset({ name: 'personal/proof' }), { 'capabilities/review.md': 'Personal proof.\n' })
    await addAssets(home, [source], { scope: 'desk' })
    const result = await publishAsset(home, 'personal/proof')
    assert.equal(result.status, 'published')
    const manifest = JSON.parse(await readFile(join(home, 'assets/personal/proof/asset.json'), 'utf8'))
    assert.equal('origin' in manifest, false)
    await assert.rejects(readFile(join(home, '.desk/assets/personal/proof/asset.json')), (error) => error.code === 'ENOENT')
    assert.equal((await statusAssets(home, 'personal/proof'))[0].state, 'local')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('legacy manifests, Overlay, path escapes, symlinks and Home/Desk shadows are rejected', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hairness-safety-'))
  try {
    const home = join(root, 'home')
    await createHome(home)
    const source = join(root, 'source')
    await mkdir(source)
    await writeFile(join(root, 'outside.md'), 'outside\n')
    await symlink(join(root, 'outside.md'), join(source, 'linked.md'))
    const linked = await writeAsset(source, asset({ files: [{ source: 'linked.md' }] }), { 'capabilities/review.md': 'Review.\n' })
    await assert.rejects(() => addAssets(home, [linked]), (error) => error.code === 'symlink_forbidden')

    const old = join(root, 'hairness.json')
    await writeFile(old, JSON.stringify(asset()))
    await assert.rejects(() => resolveAsset(home, old), (error) => error.code === 'legacy_asset_manifest')

    const clean = await writeAsset(join(root, 'clean'), asset({ name: 'fixture/shadow' }), { 'capabilities/review.md': 'Review.\n' })
    await addAssets(home, [clean])
    await assert.rejects(() => addAssets(home, [clean], { scope: 'desk' }), (error) => error.code === 'asset_collision')

    await mkdir(join(home, '.overlay'))
    await assert.rejects(() => statusAssets(home), (error) => error.code === 'legacy_overlay')
    await rm(join(home, '.overlay'), { recursive: true, force: true })
    await mkdir(join(home, '.codex'), { recursive: true })
    await writeFile(join(home, '.codex/hooks.json'), '{"hooks":{"SessionStart":[{"hooks":[{"command":"npx --yes @hairness/cli@0.4.0-alpha.1 prologue"}]}]}}\n')
    await assert.rejects(() => statusAssets(home), (error) => error.code === 'legacy_prologue')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('executables are inert on add, approved by digest and revoked after source changes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hairness-executable-'))
  try {
    const home = join(root, 'home')
    await createHome(home)
    const manifest = asset({
      name: 'fixture/executable',
      capabilities: [],
      skills: [],
      executables: [{ id: 'proof', entry: 'proof.mjs', runOn: 'build', outputs: ['generated'] }],
      files: [],
    })
    const source = await writeAsset(join(root, 'source'), manifest, {
      'proof.mjs': "import { mkdirSync, writeFileSync } from 'node:fs'; import { join } from 'node:path'; const root = process.env.HAIRNESS_OUTPUT_DIR; mkdirSync(join(root, 'generated'), { recursive: true }); writeFileSync(join(root, 'generated/proof.txt'), 'ready\\n')\n",
    })
    await addAssets(home, [source])
    await assert.rejects(readFile(join(home, 'generated/proof.txt')), (error) => error.code === 'ENOENT')
    await assert.rejects(() => buildHome(home), (error) => error.code === 'executable_approval_required')
    await buildHome(home, { allowExecutables: ['fixture/executable:proof'] })
    assert.equal(await readFile(join(home, 'generated/proof.txt'), 'utf8'), 'ready\n')
    const executable = (await resolveHome(home)).executables[0]
    assert.equal(await executableApproved(home, executable), true)
    await writeFile(join(home, 'assets/fixture/executable/proof.mjs'), `${await readFile(join(home, 'assets/fixture/executable/proof.mjs'), 'utf8')}\n`)
    assert.equal(await executableApproved(home, (await resolveHome(home)).executables[0]), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('approved executables cannot write outside their staging directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hairness-executable-sandbox-'))
  try {
    const home = join(root, 'home')
    await createHome(home)
    const manifest = asset({
      name: 'fixture/escape',
      capabilities: [],
      skills: [],
      executables: [{ id: 'escape', entry: 'escape.mjs', runOn: 'build', outputs: ['generated'] }],
      files: [],
    })
    const source = await writeAsset(join(root, 'source'), manifest, {
      'escape.mjs': "import { writeFileSync } from 'node:fs'; writeFileSync('../../escaped.txt', 'unsafe\\n')\n",
    })
    await addAssets(home, [source])
    await assert.rejects(
      () => buildHome(home, { allowExecutables: ['fixture/escape:escape'] }),
      (error) => error.code === 'executable_failed' && /ERR_ACCESS_DENIED|restricted/.test(error.message),
    )
    await assert.rejects(readFile(join(home, 'escaped.txt')), (error) => error.code === 'ENOENT')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('GitHub tag, commit and mobile addresses resolve asset.json', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hairness-github-'))
  const previous = Object.fromEntries(['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0', 'GIT_CONFIG_KEY_1', 'GIT_CONFIG_VALUE_1'].map((key) => [key, process.env[key]]))
  try {
    await assert.rejects(
      () => resolveAsset(root, 'acme/repository/assets/review#--upload-pack=evil'),
      (error) => error.code === 'source_invalid',
    )
    const repository = join(root, 'source')
    const github = join(root, 'github')
    const bare = join(github, 'acme/assets.git')
    await exec('git', ['init', '--quiet', '--initial-branch=main', repository])
    await writeAsset(join(repository, 'assets/review'), asset({ name: 'acme/review' }), { 'capabilities/review.md': 'GitHub source.\n' })
    await exec('git', ['add', '--all'], { cwd: repository })
    await exec('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '-m', 'asset'], { cwd: repository })
    await exec('git', ['tag', 'v1.0.0'], { cwd: repository })
    await mkdir(join(github, 'acme'), { recursive: true })
    await exec('git', ['clone', '--quiet', '--bare', repository, bare])
    const commit = (await exec('git', ['rev-parse', 'HEAD'], { cwd: repository })).stdout.trim()
    process.env.GIT_CONFIG_COUNT = '2'
    process.env.GIT_CONFIG_KEY_0 = `url.file://${github}/.insteadOf`
    process.env.GIT_CONFIG_VALUE_0 = 'https://github.com/'
    process.env.GIT_CONFIG_KEY_1 = 'protocol.file.allow'
    process.env.GIT_CONFIG_VALUE_1 = 'always'
    const home = join(root, 'home')
    await createHome(home)
    await addAssets(home, ['acme/assets/assets/review#v1.0.0'])
    const installed = JSON.parse(await readFile(join(home, 'assets/acme/review/asset.json'), 'utf8'))
    assert.equal(installed.origin.requestedRef, 'v1.0.0')
    assert.equal(installed.origin.resolvedCommit, commit)
    assert.equal(installed.origin.mobile, false)
    assert.equal((await resolveAsset(home, 'acme/assets/assets/review')).mobile, true)
    assert.equal((await resolveAsset(home, `acme/assets/assets/review#${commit}`)).mobile, false)
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(root, { recursive: true, force: true })
  }
})

test('HTTPS Assets resolve relative source files without exposing URL secrets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hairness-https-'))
  const previousFetch = globalThis.fetch
  try {
    const manifest = asset({ name: 'fixture/https' })
    globalThis.fetch = async (url) => {
      const value = String(url)
      const content = value.endsWith('/asset.json')
        ? `${JSON.stringify(manifest)}\n`
        : value.endsWith('/capabilities/review.md')
          ? 'HTTPS review.\n'
          : null
      if (content === null) return response(value, 'missing', 404)
      return response(value, content, 200)
    }
    const home = join(root, 'home')
    await createHome(home)
    await addAssets(home, ['https://assets.example.test/review/asset.json'])
    assert.equal(await readFile(join(home, 'assets/fixture/https/capabilities/review.md'), 'utf8'), 'HTTPS review.\n')
    assert.equal((await statusAssets(home, 'fixture/https'))[0].mobile, true)
    await assert.rejects(
      () => resolveAsset(home, 'https://token:secret@assets.example.test/review/asset.json'),
      (error) => error.code === 'source_insecure' && !error.message.includes('token:secret'),
    )
    await assert.rejects(
      () => resolveAsset(home, 'https://assets.example.test/review/asset.json?token=secret'),
      (error) => error.code === 'source_insecure' && !error.message.includes('token=secret'),
    )
  } finally {
    globalThis.fetch = previousFetch
    await rm(root, { recursive: true, force: true })
  }
})

function response(url, content, status) {
  return {
    url,
    ok: status >= 200 && status < 300,
    status,
    arrayBuffer: async () => Buffer.from(content),
  }
}
