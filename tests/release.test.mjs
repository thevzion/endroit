import assert from 'node:assert/strict'
import { test } from 'node:test'
import { gzipSync } from 'node:zlib'

import { comparePackedTrees } from '../scripts/lib/pack.mjs'
import {
  collectVersionedSchemas,
  collectWorkSchemas,
  verifyVersionedSchemas,
  verifyWorkSchemas,
} from '../scripts/lib/release-schemas.mjs'

const root = new URL('../', import.meta.url).pathname

test('release verification accepts registry recompression but rejects changed or unsafe package trees', () => {
  const files = [{ name: 'package/bin/endroit.mjs', mode: 0o755, content: 'ready\n' }]
  assert.equal(comparePackedTrees(tarball(files, 1), tarball(files, 9)), true)
  assert.equal(comparePackedTrees(tarball(files), tarball([{ ...files[0], content: 'changed\n' }])), false)
  assert.equal(comparePackedTrees(tarball(files), tarball([{ ...files[0], mode: 0o644 }])), false)
  assert.throws(() => comparePackedTrees(tarball(files), tarball([{ ...files[0], name: '../escape' }])), /Unsafe package tar path/)
  assert.throws(() => comparePackedTrees(tarball(files), tarball([{ ...files[0], type: '2' }])), /Unsupported package tar entry type/)
})

test('release qualification preserves frozen contracts and gates every current public schema', async () => {
  const v7Names = ['home', 'desk', 'member', 'equipment', 'site', 'route', 'runtime', 'artifact']
  const v9Names = ['document', 'profile', 'workplace', 'member', 'desk', 'room', 'site', 'route', 'equipment', 'artifact']
  const workNames = ['v1alpha1', 'v1alpha2']
  const schemas = await collectVersionedSchemas(root, 'v7', v7Names)
  const schemasV8 = await collectVersionedSchemas(root, 'v8', ['route'])
  const schemasV9 = await collectVersionedSchemas(root, 'v9', v9Names)
  const schemasWork = await collectWorkSchemas(root, workNames)
  assert.equal(schemas.find((entry) => entry.name === 'runtime').sha256, '7f95cf78217d0a94219cb0d9dd6f0b952fb854ac95c8e91ec1dd8367830e8799')
  assert.equal(schemasV8[0].url, 'https://endroit.org/schema/v8/route.json')
  assert.equal(schemasV9.find((entry) => entry.name === 'workplace').url, 'https://endroit.org/schema/v9/workplace.json')
  assert.equal(schemasWork.at(-1).url, 'https://endroit.org/schema/work/v1alpha2.json')

  const verified = []
  const verify = async (entry) => verified.push(entry.url)
  await verifyVersionedSchemas(schemas, 'v7', v7Names, verify)
  await verifyVersionedSchemas(schemasV8, 'v8', ['route'], verify)
  await verifyVersionedSchemas(schemasV9, 'v9', v9Names, verify)
  await verifyWorkSchemas(schemasWork, workNames, verify)
  assert.equal(verified.at(-1), 'https://endroit.org/schema/work/v1alpha2.json')
  await assert.rejects(() => verifyVersionedSchemas([], 'v8', ['route'], verify), /Release v8 schemas must be route/)
  await assert.rejects(() => verifyVersionedSchemas([{ ...schemasV8[0], url: 'https://endroit.org/schema/v7/route.json' }], 'v8', ['route'], verify), /Route schema URL must be https:\/\/endroit\.org\/schema\/v8\/route\.json/i)
  await assert.rejects(() => verifyWorkSchemas([], workNames, verify), /Release Work schemas must be v1alpha1, v1alpha2/)
})

function tarball(entries, level = 6) {
  const blocks = []
  for (const entry of entries) {
    const content = Buffer.from(entry.content)
    const header = Buffer.alloc(512)
    header.write(entry.name, 0, 100, 'utf8')
    writeOctal(header, 100, 8, entry.mode)
    writeOctal(header, 108, 8, 0)
    writeOctal(header, 116, 8, 0)
    writeOctal(header, 124, 12, content.length)
    writeOctal(header, 136, 12, 0)
    header.fill(32, 148, 156)
    header[156] = (entry.type ?? '0').charCodeAt(0)
    header.write('ustar\0', 257, 6, 'ascii')
    header.write('00', 263, 2, 'ascii')
    const checksum = header.reduce((sum, value) => sum + value, 0)
    header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii')
    blocks.push(header, content, Buffer.alloc(Math.ceil(content.length / 512) * 512 - content.length))
  }
  blocks.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(blocks), { level })
}

function writeOctal(buffer, offset, length, value) {
  buffer.write(`${value.toString(8).padStart(length - 1, '0')}\0`, offset, length, 'ascii')
}
