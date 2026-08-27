# Contributing

Endroit is developed as a sovereign Site. Compatibility with unrelated
Workplace instances is not inferred; the versioned Profile owns compatibility.

## Setup

```sh
bun install --frozen-lockfile
bun run typecheck
bun run test
```

Use Bun 1.3.14 and TypeScript 5.9.3. Keep `bun.lock` current.

## Change contract

- Keep the compiler generic; Standard vocabulary belongs in Profiles.
- Change SPEC, docs, example and tests together when a semantic contract moves.
- Public Markdown at the Site root stays Site-native and has no Workplace
  frontmatter.
- Never add consumer AGENTS/CLAUDE/FRONTDOOR files to this repository root.
- Never make runtime state necessary to navigate compiled output.
- Never write through a Site Route during compile, check, ready or enter.
- Keep local adapters at MountRoot and portable projections at SharedRoot.
- Treat provider targets as an explicit allowlist, never ambient authority.
- Add dependencies only when platform and installed code do not cover the need.

## Gates

```sh
bun run typecheck
bun run test
bun run example:reset
bun run example:fresh:preview
bun src/cli.ts check <generated-shared-root> --history --json
```

Then compile/check smallest, rich, FieldLab and Flappy using
[INSTALL.md](INSTALL.md). A finished batch leaves the worktree clean.
Qualification fixtures are immutable cases; create a new ignored run rather
than replacing evidence from an older run.

```sh
bun run case:new -- viral-game
bun run case:snapshot -- <run-id> --task <task-id> --trajectory <file>
bun run case:verdict -- <run-id> --verdict pass|changes-needed
```

These commands prepare and capture evidence only. They never launch Codex or
another provider. A terminal verdict requires an observed snapshot.

## Commits

One commit carries one responsibility. Source truth and generated projections
stay separate. Do not push, tag or release without explicit owner consent.
