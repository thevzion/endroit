import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import test from 'node:test'
import { buildHome } from '../src/build.mjs'
import { createHome } from '../src/create.mjs'
import { digest, removeTree } from '../src/lib/io.mjs'
import { resolveHome } from '../src/resolved.mjs'

test('build writes one deterministic receipt without installing provider or Git integration', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'endroit-build-receipt-'))
  try {
    const home = join(temporary, 'workplace')
    await createHome(home)

    const integrations = new Map([
      [join(home, '.codex/hooks.json'), '{"user":"codex"}\n'],
      [join(home, '.claude/settings.json'), '{"user":"claude"}\n'],
      [join(home, '.git/info/exclude'), '# user-owned\n'],
    ])
    for (const [path, content] of integrations) {
      await mkdir(join(path, '..'), { recursive: true })
      await writeFile(path, content)
    }

    const receipt = await buildHome(home)
    const receiptPath = join(home, '.endroit/build.json')
    const firstBytes = await readFile(receiptPath)
    const plan = await resolveHome(home)

    assert.deepEqual(Object.keys(receipt), ['version', 'revision', 'sources', 'outputs'])
    assert.equal(receipt.version, 1)
    assert.equal(receipt.revision, plan.revision ?? plan.workplace?.source_digest ?? 'legacy')
    assert.deepEqual(receipt.sources.map(({ path }) => path), receipt.sources.map(({ path }) => path).toSorted())
    assert.deepEqual(receipt.outputs.map(({ path }) => path), receipt.outputs.map(({ path }) => path).toSorted())

    const sources = new Set(receipt.sources.map(({ path }) => path))
    for (const source of receipt.sources) {
      assert.deepEqual(Object.keys(source), ['path', 'owner', 'digest'])
      assert.equal(isAbsolute(source.path), false)
      assert.match(source.digest, /^sha256:[a-f0-9]{64}$/)
    }
    for (const output of receipt.outputs) {
      assert.deepEqual(Object.keys(output), ['path', 'digest', 'provider', 'owner', 'scope', 'sources'])
      assert.equal(isAbsolute(output.path), false)
      assert.match(output.digest, /^sha256:[a-f0-9]{64}$/)
      assert.deepEqual(output.sources, output.sources.toSorted())
      assert.ok(output.sources.length > 0)
      for (const source of output.sources) assert.ok(sources.has(source), `${output.path} references ${source}`)
      assert.equal(digest(await readFile(join(home, output.path))), output.digest)
    }

    assert.equal(receipt.outputs.some(({ path }) => /hooks\/endroit-session-start\.mjs$/.test(path)), false)
    for (const [path, content] of integrations) assert.equal(await readFile(path, 'utf8'), content)

    await buildHome(home)
    assert.deepEqual(await readFile(receiptPath), firstBytes)
    await buildHome(home, { check: true })
    assert.equal((await readdir(home)).some((name) => name.startsWith('.endroit-transaction-')), false)

    const capabilityPath = 'equipment/endroit/onboarding/capabilities/onboard.md'
    const beforeSource = receipt.sources.find(({ path }) => path === capabilityPath)
    const beforeSkills = receipt.outputs.filter(({ sources: outputSources }) => outputSources.includes(capabilityPath))
    const beforeBootstraps = new Map(receipt.outputs
      .filter(({ path }) => ['AGENTS.md', 'CLAUDE.md'].includes(path))
      .map((output) => [output.path, output.digest]))
    assert.ok(beforeSource)
    assert.ok(beforeSkills.length > 0)

    await writeFile(join(home, capabilityPath), `${await readFile(join(home, capabilityPath), 'utf8')}\nReceipt revision fixture.\n`)
    const changed = await buildHome(home)
    assert.notEqual(changed.revision, receipt.revision)
    assert.notEqual(changed.sources.find(({ path }) => path === capabilityPath).digest, beforeSource.digest)
    for (const before of beforeSkills) {
      assert.notEqual(changed.outputs.find(({ path }) => path === before.path).digest, before.digest)
    }
    for (const [path, beforeDigest] of beforeBootstraps) {
      const output = changed.outputs.find((candidate) => candidate.path === path)
      assert.notEqual(output.digest, beforeDigest)
      assert.ok(output.sources.includes(capabilityPath))
      assert.match(await readFile(join(home, path), 'utf8'), new RegExp(changed.revision.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    }
    for (const [path, content] of integrations) assert.equal(await readFile(path, 'utf8'), content)
  } finally {
    await removeTree(temporary, { force: true })
  }
})

test('an unowned output collision aborts before any build write', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'endroit-build-collision-'))
  try {
    const home = join(temporary, 'workplace')
    await createHome(home)
    const receiptPath = join(home, '.endroit/build.json')
    const receipt = JSON.parse(await readFile(receiptPath, 'utf8'))
    const victim = receipt.outputs.find(({ path }) => path === 'AGENTS.md') ?? receipt.outputs[0]
    const untouched = receipt.outputs.find(({ path }) => path !== victim.path)
    const untouchedBytes = await readFile(join(home, untouched.path))

    await rm(receiptPath)
    await writeFile(join(home, victim.path), 'user-owned collision\n')
    await assert.rejects(() => buildHome(home), (error) => error.code === 'generated_output_collision')

    assert.equal(await readFile(join(home, victim.path), 'utf8'), 'user-owned collision\n')
    assert.deepEqual(await readFile(join(home, untouched.path)), untouchedBytes)
    await assert.rejects(readFile(receiptPath), (error) => error.code === 'ENOENT')
    assert.equal((await readdir(home)).some((name) => name.startsWith('.endroit-transaction-')), false)
  } finally {
    await removeTree(temporary, { force: true })
  }
})
