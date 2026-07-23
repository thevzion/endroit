import { join } from 'node:path'

export const codex = {
  id: 'codex',
  instructionPath: 'AGENTS.md',
  hookPath: '.codex/hooks.json',
  skillRoot: '.agents/skills',
  output(surface, capability, options = {}) {
    if (surface.command && !surface.skill && !options.allowLossy) return null
    const description = surface.skill?.description ?? surface.command?.summary
    const invocation = `$${surface.projectedName}`
    const content = `---\nname: ${surface.projectedName}\ndescription: ${JSON.stringify(description)}\n---\n\n# ${invocation}\n\n${capability.content.trim()}\n\nThis file is generated from ${surface.owner}. Edit the Asset source instead.\n`
    return { path: join(this.skillRoot, surface.projectedName, 'SKILL.md'), content }
  },
  hook(runtime) {
    return { matcher: 'startup|resume|clear|compact', hooks: [{ type: 'command', command: `npx --yes ${runtime} hud --prompt` }] }
  },
}
