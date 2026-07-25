import { join } from 'node:path'

export const claude = {
  id: 'claude',
  instructionPath: 'CLAUDE.md',
  hookPath: '.claude/settings.json',
  sessionPath: '.claude/hooks/hairness-session-start.mjs',
  skillRoot: '.claude/skills',
  invocation: '/',
  output(surface, capability) {
    const userOnly = surface.command && !surface.skill
    const description = surface.skill?.description ?? surface.command.description
    const frontmatter = `---\nname: ${surface.projectedId}\ndescription: ${JSON.stringify(description)}${userOnly ? '\ndisable-model-invocation: true' : ''}\n---`
    const content = `${frontmatter}\n\n# /${surface.projectedId}\n\n${capability.content.trim()}\n\nThis file is generated from ${surface.owner}. Edit the Asset source instead.\n`
    return { path: join(this.skillRoot, surface.projectedId, 'SKILL.md'), content }
  },
  hook() {
    return { matcher: 'startup|resume|clear|compact', hooks: [{ type: 'command', command: `node ${this.sessionPath}` }] }
  },
}
