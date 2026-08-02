import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
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
  for (const id of [
    'endroit-home', 'endroit-onboarding', 'endroit-artifacts', 'endroit-site-manage',
    'endroit-site-map', 'endroit-scratch', 'enter-the-home', 'enter-the-home-room',
    'call-the-researcher', 'work-as-an-engineer', 'use-research', 'retain-this',
    'advance-this', 'accept-this', 'deliver-this', 'archive-this', 'maintain-the-home',
  ]) {
    const codex = await readFile(join(home, '.agents/skills', id, 'SKILL.md'), 'utf8')
    const claude = await readFile(join(home, '.claude/skills', id, 'SKILL.md'), 'utf8')
    assert.equal(codex.replaceAll(`$${id}`, id).replaceAll('.agents', '.provider'), claude.replaceAll(`/${id}`, id).replaceAll('.claude', '.provider'))
  }
  console.log('provider parity passed')
} finally {
  await removeTree(temporary, { force: true })
}
