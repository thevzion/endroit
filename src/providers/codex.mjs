import { join } from 'node:path'

export const codex = {
  id: 'codex',
  instructionPath: 'AGENTS.md',
  hookPath: '.codex/hooks.json',
  sessionPath: '.codex/hooks/endroit-session-start.mjs',
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
  const route = surface.route
    ? `\n\nThis accessor is bound to ${surface.route.ref}${surface.route.emoji ? ` ${surface.route.emoji}` : ''}. Apply the Capability to that exact Route without asking the human to repeat it.`
    : ''
  const content = `${frontmatter}\n\n# ${projector.invocation}${surface.projectedId}${route}\n\n${capability.content.trim()}\n\nThis file is generated from ${surface.owner}. Edit the Equipment source instead.\n`
  return { path: join(projector.skillRoot, surface.projectedId, 'SKILL.md'), content }
}
