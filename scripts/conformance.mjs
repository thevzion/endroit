import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addAssets, statusAssets, syncAssets } from '../src/assets.mjs'
import { createHome } from '../src/create.mjs'

const temporary = await mkdtemp(join(tmpdir(), 'hairness-conformance-'))
try {
  const home = join(temporary, 'home')
  const source = join(temporary, 'asset')
  await createHome(home)
  await mkdir(source)
  const manifest = {
    $schema: 'https://hairness.dev/schema/asset.json',
    name: 'conformance/proof', version: '1.0.0', description: 'Conformance proof.',
    files: ['proof.md'],
    instructions: [{ id: 'proof', path: 'proof.md' }],
  }
  await writeFile(join(source, 'asset.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  await writeFile(join(source, 'proof.md'), 'one\n')
  await addAssets(home, [join(source, 'asset.json')])
  assert.equal((await statusAssets(home, 'proof'))[0].state, 'clean')
  manifest.version = '2.0.0'
  await writeFile(join(source, 'asset.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  await writeFile(join(source, 'proof.md'), 'two\n')
  assert.equal((await syncAssets(home, 'proof', { check: true }))[0].status, 'available')
  await syncAssets(home, 'proof')
  assert.equal(await readFile(join(home, 'assets/conformance/proof/proof.md'), 'utf8'), 'two\n')
  console.log('conformance passed')
} finally {
  await rm(temporary, { recursive: true, force: true })
}
