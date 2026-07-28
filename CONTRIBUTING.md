# Contributing

Read the [technical reference](docs/reference.md) and [security policy](SECURITY.md)
before changing public behavior.

Change canonical source under `src/`, `schemas/` or `assets/`. Keep the
README, reference, schemas, CLI and tests aligned. Add a durable test for a
recurring correction.

Hairness owns the recipe for its separate Development Home:

```bash
npm run dev:home
npm run dev:session -- --provider codex
npm run dev:verify
```

The default Home is `../hairness-development-home`. It is a team Home whose
`hairness/main` Binding points back to this repository. Use
`npm run dev:home:recreate` for a clean rebuild; it refuses dirty Home or Desk
repositories and rolls back a failed replacement. The scripts never create a
remote, commit or push.

Edit `HOME.md`, `DESK.md` or the relevant Asset Instruction as canonical
source. Never edit `AGENTS.md` or `CLAUDE.md`; they are fully owned provider
projections. The development reconciler preserves these source-owned
instructions and refuses an incomplete Desk.

```bash
npm ci --ignore-scripts
npm run check
npm test
npm run conformance
npm run check:providers
npm run check:pack
npm run check:lab
```

Run `npm run dev:verify -- --full` before a merge checkpoint. It adds the
Node 22/24, conformance, security, pack and lab gates to the persistent Home
checks.

## Release

The `npm release` workflow qualifies the exact public `main` commit, publishes
the packed CLI through npm trusted publishing and assigns the `latest` tag.
After registry verification, a maintainer with an authenticated npm session may
also move the prerelease channel:

```bash
npm dist-tag add @hairness/cli@<version> next
npm view @hairness/cli dist-tags --json
```

Trusted publishing does not authorize a later `npm dist-tag` mutation. Keep
that authenticated step separate from the OIDC workflow.

Use Conventional Commits and keep changes focused. A new dependency, executable
Asset runtime or public contract change needs a concrete consumer and maintainer
agreement.
