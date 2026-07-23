import { join } from 'node:path'

export const claude = {
  id: 'claude',
  instructionPath: 'CLAUDE.md',
  hookPath: '.claude/settings.json',
  skillRoot: '.claude/skills',
  output(surface, capability) {
    const description = surface.skill?.description ?? surface.command?.summary
    const userOnly = surface.command && !surface.skill
    const invocation = `/${surface.projectedName}`
    const content = `---\nname: ${surface.projectedName}\ndescription: ${JSON.stringify(description)}${userOnly ? '\ndisable-model-invocation: true' : ''}\n---\n\n# ${invocation}\n\n${capability.content.trim()}\n\nThis file is generated from ${surface.owner}. Edit the Asset source instead.\n`
    return { path: join(this.skillRoot, surface.projectedName, 'SKILL.md'), content }
  },
  hook(runtime) {
    return { matcher: 'startup|resume|clear|compact', hooks: [{ type: 'command', command: `npx --yes ${runtime} hud --prompt` }] }
  },
}
