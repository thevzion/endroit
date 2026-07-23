import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addAssets } from '../src/assets.mjs'
import { buildHome } from '../src/build.mjs'
import { createHome } from '../src/create.mjs'

const temporary = await mkdtemp(join(tmpdir(), 'hairness-providers-'))
try {
  const home = join(temporary, 'home')
  await createHome(home)
  await addAssets(home, ['@hairness/scratch'])
  await buildHome(home)
  for (const id of ['hairness-home', 'hairness-onboarding', 'hairness-target-manage', 'hairness-scratch']) {
    const codex = await readFile(join(home, '.agents/skills', id, 'SKILL.md'), 'utf8')
    const claude = await readFile(join(home, '.claude/skills', id, 'SKILL.md'), 'utf8')
    assert.match(codex, new RegExp(`name: ${id}`))
    assert.match(claude, new RegExp(`name: ${id}`))
    assert.match(codex, /generated from hairness\//)
    assert.match(claude, /generated from hairness\//)
  }
  assert.match(await readFile(join(home, '.codex/hooks.json'), 'utf8'), /hud --prompt/)
  assert.match(await readFile(join(home, '.claude/settings.json'), 'utf8'), /hud --prompt/)
  const hooks = JSON.parse(await readFile(join(home, '.codex/hooks.json'), 'utf8'))
  hooks.hooks.SessionStart[0].hooks.push({ type: 'command', command: 'printf human-hook' })
  await writeFile(join(home, '.codex/hooks.json'), `${JSON.stringify(hooks, null, 2)}\n`)
  await buildHome(home)
  const rebuilt = JSON.parse(await readFile(join(home, '.codex/hooks.json'), 'utf8'))
  assert.ok(rebuilt.hooks.SessionStart.some((entry) => entry.hooks.some((hook) => hook.command === 'printf human-hook')))
  assert.equal(rebuilt.hooks.SessionStart.flatMap((entry) => entry.hooks).filter((hook) => /hud --prompt$/.test(hook.command)).length, 1)
  console.log('provider projections passed')
} finally {
  await rm(temporary, { recursive: true, force: true })
}
