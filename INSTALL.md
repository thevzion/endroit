# Install from source

Endroit `v0.1.0-rc.1` is a pre-release that currently runs from this checkout
with Bun 1.3.14. No npm package or binary distribution is published.

```sh
bun install --frozen-lockfile
bun run typecheck
bun run test
```

## Commands

```sh
bun src/cli.ts new ~/Workplaces/studio
bun src/cli.ts check --mount examples/smallest/world --json
bun src/cli.ts check --mount examples/smallest/world \
  --profile profiles/standard/profile.json --json
bun src/cli.ts check /path/to/shared-root --staged --json
bun src/cli.ts check /path/to/shared-root --history --json
bun src/cli.ts compile --mount examples/smallest/world \
  --entry bindings/entry.json --provider codex
bun src/cli.ts ready examples/smallest/world --json
bun src/cli.ts preview examples/brownfield/source \
  --out /tmp/endroit-brownfield-preview --json
```

`new` is the interactive entry for a fresh personal Workplace. It previews the
exact Roots, files, adapters, Git guards and Git commits, then requires one confirmation.
It builds beside the target and moves the complete Mount into place only after
compile and check pass.

For deterministic automation, preview and Apply the same closed Request:

```sh
bun src/cli.ts new --request examples/fresh/request.json --preview --json
bun src/cli.ts new --request examples/fresh/request.json --apply <sha256> --json
```

Apply requires the current preview digest and an absent target. A changed
Request invalidates the digest. JSON mode has no prompts, ANSI, logo, spinner
or unstable prose.

`new`, `compile`, `check` and `ready` accept `--profile <package>`. A generated
Workplace pins the Package Ref and digest. If that exact Package is unavailable
or changed, existing projections remain readable while rebuild reports
`compile-required` with the repair action.

`compile` and `ready` require a declared shared Root and never create a Member,
Desk, WELCOME, Work, Site, repository, remote or deployment. Without an
EntryBinding they may compile the neutral entry, then return
`onboarding-required` with an exact next action.

`check --staged` validates the Git index; add `--commit-message <file>` for the
commit contract. `check --history` detects invalid commits even when hooks were
bypassed. A missing marked hook is degraded and `ready` can repair it; a foreign
hook or `core.hooksPath` collision is never overwritten.

`preview` is read-only with respect to its source. It creates only the new
output directory and does not Apply an adoption.

## Try the demonstrations

- [ADOPT.md](ADOPT.md) explains the shipped static brownfield Preview and the
  not-yet-shipped Apply boundary.
- [examples/fresh/TRY.md](examples/fresh/TRY.md) creates a fresh Workplace with
  no preinstalled subject.
- [examples/flappy/TRY.md](examples/flappy/TRY.md) creates a disposable mounted
  Workplace and three human trials.

No provider run is part of installation or tests.

## Remove Endroit

Compiled Front Doors and portable maps remain navigable after removing this
checkout, Bun and `.endroit/`. New guarded Shared/Desk commits fail closed until
the bound CLI is restored; recompilation and stale repair also require it.
