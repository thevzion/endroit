import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildHome } from '../src/build.mjs'
import { createHome } from '../src/create.mjs'
import { addEquipment } from '../src/equipment.mjs'
import { removeTree } from '../src/lib/io.mjs'

const root = new URL('../', import.meta.url).pathname
const temporary = await mkdtemp(join(tmpdir(), 'endroit-providers-'))
try {
  const home = join(temporary, 'home')
  await createHome(home)
  await addEquipment(home, ['@endroit/scratch'])
  await buildHome(home)
  const codexRoot = join(home, '.agents/skills')
  const claudeRoot = join(home, '.claude/skills')
  const ids = (await readdir(codexRoot)).sort()
  assert.deepEqual(ids, (await readdir(claudeRoot)).sort())
  for (const id of ['enter-workplace', 'work-on-site', 'retain-this', 'accept-this', 'archive-this', 'deliver-this']) {
    assert.ok(ids.includes(id), `missing foundation Skill ${id}`)
  }
  assert.ok(!ids.includes('work-on-self'), 'Sites must not generate per-Site Skills')
  assert.ok(!ids.includes('enter-the-home-room'), 'Rooms must not generate per-Room Skills')
  for (const id of ids) {
    const codex = await readFile(join(codexRoot, id, 'SKILL.md'), 'utf8')
    const claude = await readFile(join(claudeRoot, id, 'SKILL.md'), 'utf8')
    assert.equal(codex.replaceAll(`$${id}`, id).replaceAll('.agents', '.provider'), claude.replaceAll(`/${id}`, id).replaceAll('.claude', '.provider'))
  }
  console.log('provider parity passed')
} finally {
  await removeTree(temporary, { force: true })
}
