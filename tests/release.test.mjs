import assert from 'node:assert/strict'
import { test } from 'node:test'
import { gzipSync } from 'node:zlib'

import { comparePackedTrees } from '../scripts/lib/pack.mjs'

test('release verification accepts registry recompression but rejects changed or unsafe package trees', () => {
  const files = [{ name: 'package/bin/endroit.mjs', mode: 0o755, content: 'ready\n' }]
  assert.equal(comparePackedTrees(tarball(files, 1), tarball(files, 9)), true)
  assert.equal(comparePackedTrees(tarball(files), tarball([{ ...files[0], content: 'changed\n' }])), false)
  assert.equal(comparePackedTrees(tarball(files), tarball([{ ...files[0], mode: 0o644 }])), false)
  assert.throws(() => comparePackedTrees(tarball(files), tarball([{ ...files[0], name: '../escape' }])), /Unsafe package tar path/)
  assert.throws(() => comparePackedTrees(tarball(files), tarball([{ ...files[0], type: '2' }])), /Unsupported package tar entry type/)
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
