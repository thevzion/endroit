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

Use Conventional Commits and keep changes focused. A new dependency, executable
Asset runtime or public contract change needs a concrete consumer and maintainer
agreement.
