import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addEquipment, statusEquipment, syncEquipment, validateEquipmentSource } from '../src/equipment.mjs'
import { createHome } from '../src/create.mjs'
import { removeTree } from '../src/lib/io.mjs'

const temporary = await mkdtemp(join(tmpdir(), 'endroit-conformance-'))
try {
  const home = join(temporary, 'home')
  const source = join(temporary, 'equipment')
  await createHome(home)
  await mkdir(source)
  const manifest = {
    $schema: 'https://endroit.org/schema/equipment.json',
    name: 'conformance/proof', version: '1.0.0', description: 'Conformance proof.',
    files: ['proof.md'],
    instructions: [{ id: 'proof', path: 'proof.md' }],
  }
  await writeFile(join(source, 'equipment.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  await writeFile(join(source, 'proof.md'), 'one\n')
  assert.equal((await validateEquipmentSource(temporary, join(source, 'equipment.json'))).status, 'valid')
  await addEquipment(home, [join(source, 'equipment.json')])
  assert.equal((await statusEquipment(home, 'proof'))[0].state, 'clean')
  manifest.version = '2.0.0'
  await writeFile(join(source, 'equipment.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  await writeFile(join(source, 'proof.md'), 'two\n')
  const check = (await syncEquipment(home, 'proof', { check: true }))[0]
  assert.equal(check.status, 'available')
  assert.deepEqual(check.files, [{ path: 'proof.md', change: 'changed', local: 'clean' }])
  await syncEquipment(home, 'proof')
  assert.equal(await readFile(join(home, 'equipment/conformance/proof/proof.md'), 'utf8'), 'two\n')
  console.log('conformance passed')
} finally {
  await removeTree(temporary, { force: true })
}
