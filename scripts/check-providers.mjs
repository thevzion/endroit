import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildHome } from '../src/build.mjs'
import { createHome } from '../src/create.mjs'
import { addAssets } from '../src/assets.mjs'

const root = new URL('../', import.meta.url).pathname
const temporary = await mkdtemp(join(tmpdir(), 'hairness-providers-'))
try {
  const home = join(temporary, 'home')
  await createHome(home)
  await addAssets(home, ['@hairness/scratch'])
  await buildHome(home)
  for (const id of ['hairness-home', 'hairness-onboarding', 'hairness-artifacts', 'hairness-target-manage', 'hairness-target-map', 'hairness-scratch']) {
    const codex = await readFile(join(home, '.agents/skills', id, 'SKILL.md'), 'utf8')
    const claude = await readFile(join(home, '.claude/skills', id, 'SKILL.md'), 'utf8')
    assert.equal(codex.replaceAll(`$${id}`, id).replaceAll('.agents', '.provider'), claude.replaceAll(`/${id}`, id).replaceAll('.claude', '.provider'))
  }
  console.log('provider parity passed')
} finally {
  await rm(temporary, { recursive: true, force: true })
}
