import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildHome } from '../src/build.mjs'
import { createHome } from '../src/create.mjs'
import { addAssets } from '../src/assets.mjs'
import { removeTree } from '../src/lib/io.mjs'

const root = new URL('../', import.meta.url).pathname
const temporary = await mkdtemp(join(tmpdir(), 'endroit-providers-'))
try {
  const home = join(temporary, 'home')
  await createHome(home)
  await addAssets(home, ['@endroit/scratch'])
  await buildHome(home)
  for (const id of ['endroit-home', 'endroit-onboarding', 'endroit-artifacts', 'endroit-target-manage', 'endroit-target-map', 'endroit-scratch']) {
    const codex = await readFile(join(home, '.agents/skills', id, 'SKILL.md'), 'utf8')
    const claude = await readFile(join(home, '.claude/skills', id, 'SKILL.md'), 'utf8')
    assert.equal(codex.replaceAll(`$${id}`, id).replaceAll('.agents', '.provider'), claude.replaceAll(`/${id}`, id).replaceAll('.claude', '.provider'))
  }
  console.log('provider parity passed')
} finally {
  await removeTree(temporary, { force: true })
}
