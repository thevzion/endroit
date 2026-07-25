import { join } from 'node:path'

export const codex = {
  id: 'codex',
  instructionPath: 'AGENTS.md',
  hookPath: '.codex/hooks.json',
  sessionPath: '.codex/hooks/hairness-session-start.mjs',
  skillRoot: '.agents/skills',
  invocation: '$',
  output(surface, capability) {
    return projectedSkill(this, surface, capability)
  },
  hook() {
    return { matcher: 'startup|resume|clear|compact', hooks: [{ type: 'command', command: `node ${this.sessionPath}` }] }
  },
}

function projectedSkill(projector, surface, capability) {
  const userOnly = surface.command && !surface.skill
  const description = surface.skill?.description ?? surface.command.description
  const frontmatter = `---\nname: ${surface.projectedId}\ndescription: ${JSON.stringify(description)}${userOnly ? '\ndisable-model-invocation: true' : ''}\n---`
  const content = `${frontmatter}\n\n# ${projector.invocation}${surface.projectedId}\n\n${capability.content.trim()}\n\nThis file is generated from ${surface.owner}. Edit the Asset source instead.\n`
  return { path: join(projector.skillRoot, surface.projectedId, 'SKILL.md'), content }
}
