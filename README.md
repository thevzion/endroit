<div align="center">

# hairness

### A shared, owned way of working for humans and agents.

Hairness is a source-owned framework and CLI for Home-first agent work.
It gives collaborators one portable environment, projects it into Codex and
Claude, and connects independent repositories as Targets.

[Website](https://hairness.dev) ·
[Home-first proposal](https://thevzion.com/home-first/) ·
[Technical reference](https://github.com/thevzion/hairness/blob/main/docs/reference.md)

[![npm latest](https://img.shields.io/npm/v/%40hairness%2Fcli/latest?label=npm%20latest)](https://www.npmjs.com/package/@hairness/cli)
[![CI](https://github.com/thevzion/hairness/actions/workflows/ci.yml/badge.svg)](https://github.com/thevzion/hairness/actions/workflows/ci.yml)
[![MIT](https://img.shields.io/badge/license-MIT-d8996a.svg)](https://github.com/thevzion/hairness/blob/main/LICENSE)

<sub>Hairness 0.5 is an alpha. Keep each Home in a dedicated Git repository and inspect executable Asset runtimes before trusting them.</sub>

</div>

## Create a Home

```bash
npx --yes @hairness/cli@latest create my-home
cd my-home
codex

# Or:
claude
```

The command initializes Git, installs the first-party Assets, creates the
Codex and Claude projections, runs Doctor and commits the result. The Home pins
its runtime in `hairness.json` and exposes every operation through its tracked
console:

```bash
node ./hairness.mjs <namespace> <command> [...arguments]
```

Run `$hairness-onboarding` in Codex or `/hairness-onboarding` in Claude to
configure your Desk.

## Why a Home

Agent sessions usually start inside a product repository. Instructions,
personal continuity, reusable methods and generated work then accumulate
beside the product source or inside provider-specific configuration.

Hairness places that collaboration environment in its own repository:

```text
Codex or Claude
       │
       ▼
Front Door → Home + active Desk
                  │
           explicit Bindings
                  │
                  ▼
          independent Targets
```

The Home owns shared orientation and reusable Assets. Each collaborator owns a
Desk. Product repositories remain independent Targets, and provider files
remain reconstructible projections.

[The Home-first proposal](https://thevzion.com/home-first/) explains the
ownership model. Hairness implements that model as a working framework; it
does not define the proposal or require other implementations to copy its
folder names.

## Hairness Today

Hairness `0.5.0-alpha.1` ships these inspectable contracts:

| Contract | Current implementation |
| --- | --- |
| **Home** | `hairness.json`, `HOME.md` and Git history |
| **Desk** | Solo and team modes with collaborator-owned continuity |
| **Assets** | Validation, installation, overrides, sync, publication and runtime trust |
| **Artifacts** | Typed results with owner, state, source files, lineage and readable hierarchical paths |
| **Bindings and Targets** | Routable declarations, local checkouts and agent-authored Target Maps backed by deterministic inspection |
| **Front Door** | Static Floor Plan, Routable Items, tracked Console and optional Wake-up |
| **Provider projections** | Deterministic Codex and Claude Instructions, Skills, Commands and hooks |
| **Pinned execution** | Exact npm runtime recorded in the Home |

Canonical sources stay readable as ordinary files:

```text
my-home/
├── hairness.json
├── HOME.md
├── assets/
├── artifacts/
├── .desk/
└── hairness.mjs
```

`AGENTS.md`, `CLAUDE.md`, `.agents/`, `.claude/` and `.codex/` are generated
views. Change the Home, Desk or Asset source, then rebuild the projections.

## Work across repositories

Declare existing repositories as Targets:

```bash
node ./hairness.mjs target add ../payments-api --id payments
node ./hairness.mjs target add ../product-app --id app
node ./hairness.mjs target list
```

The Home records Target identities. The active Desk records local Bindings.
Hairness does not install agent infrastructure in those repositories.

Inspect recent evidence without creating an event log:

```bash
node ./hairness.mjs hud activity --since 2d
node ./hairness.mjs hud activity --scope target:payments --json
```

Keep a result when it deserves a durable contract:

```bash
node ./hairness.mjs artifact create hairness/scratch:scratch api-redesign --owner desk
node ./hairness.mjs artifact inspect api-redesign
node ./hairness.mjs artifact validate api-redesign
node ./hairness.mjs artifact publish api-redesign --to home
```

Publishing records ownership and lineage. Turning a useful Artifact into a new
or improved Asset remains a deliberate authoring and review step.

## Trust and alpha limits

Static Assets execute no code. An Asset runtime executes with your user rights.
Hairness binds runtime approval to an exact digest and blocks changed or
unapproved runtimes:

```bash
node ./hairness.mjs asset status company/security --json
$EDITOR assets/company/security/runtime.mjs
node ./hairness.mjs asset trust company/security --digest sha256:…
node ./hairness.mjs doctor
```

Hairness does not provide an operating-system sandbox. Provider sessions,
models and external tools remain outside its authority.

The alpha has no Registry, marketplace, dependency solver, daemon, automatic
merge, public Adapter SDK, agent scheduler or live collaboration service.
Codex and Claude are the qualified providers today. Other runtimes and
specialized Homes remain product directions.

## Reference

- [Technical reference](docs/reference.md)
- [Architecture](docs/architecture.md)
- [Lifecycles](docs/lifecycles.md)
- [Security policy](SECURITY.md)
- [Contributing](CONTRIBUTING.md)

## License

MIT
