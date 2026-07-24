import { claude } from './claude.mjs'
import { codex } from './codex.mjs'

const providers = new Map([[codex.id, codex], [claude.id, claude]])

export function provider(id) {
  return providers.get(id)
}

export function providerIds() {
  return [...providers.keys()]
}
