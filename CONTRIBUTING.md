# Contributing

Read the [technical reference](docs/reference.md) and [security policy](SECURITY.md)
before changing public behavior.

Change canonical source under `src/`, `schemas/` or `assets/`. Keep the
README, reference, schemas, CLI and tests aligned. Add a durable test for a
recurring correction.

Endroit owns the recipe for its separate Development Home:

```bash
npm run dev:home
npm run dev:session -- --provider codex
npm run dev:verify
```

The default Home is `../endroit-development-home`. It is a team Home whose
`endroit/main` Binding points back to this repository. Use
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

## Delivery

`main` is protected and pull-request-only, including for maintainers. Start
delivery work from the current remote `main` on a short-lived branch such as
`codex/<topic>`. Do not attempt a status-gated direct push: the required
`delivery policy` check exists only on pull requests.

Open one focused pull request, wait for `test (22)`, `test (24)` and
`delivery policy`, then squash-merge it. GitHub deletes the remote branch
after merge. Wait for the post-merge `main` CI on the final commit before a
release or another external delivery effect.

## Runtime support

Endroit qualifies runtimes through evidence, not a compatibility claim. Check
the [runtime matrix and qualification gate](ROADMAP.md#runtime-matrix), then
open a
[Runtime support request](https://github.com/thevzion/endroit/issues/new?template=runtime-support.yml)
before implementation.

The request establishes:

- the exact runtime and versions;
- its role and native instruction, capability and continuity surfaces;
- the real user workflow motivating support;
- whether Endroit needs a Projection or a Bridge;
- the contributor who can maintain the integration.

After the scope is agreed, keep the implementation to the smallest existing
Endroit contract that fits. Do not add a generic Adapter primitive, registry
or marketplace for one runtime.

A runtime pull request links its request, documents versions and limits, and
provides dated evidence for the canonical first-Home activation journey. The
runtime remains `candidate` or `prototyping` until every qualification gate is
met. Qualification and maintainership are separate: community-maintained
runtimes name their maintainer explicitly.

## Release

The `npm release` workflow qualifies the exact public `main` commit, publishes
the packed CLI through npm trusted publishing and assigns the `latest` tag.
After registry verification, a maintainer with an authenticated npm session may
also move the prerelease channel:

```bash
npm dist-tag add @endroit/cli@<version> next
npm view @endroit/cli dist-tags --json
```

Trusted publishing does not authorize a later `npm dist-tag` mutation. Keep
that authenticated step separate from the OIDC workflow.

Use Conventional Commits and keep changes focused. A new dependency, executable
Asset runtime or public contract change needs a concrete consumer and maintainer
agreement.
