# Hairness 0.5 technical reference

Hairness 0.5 is an alpha. The schemas under `schemas/v5` are authoritative.

## Home

`hairness.json` requires:

- `$schema: https://hairness.dev/schema/home.json`;
- a stable `name`;
- the exact `@hairness/cli` runtime;
- `mode: solo | team`;
- at least one supported provider.

Optional fields are a projection `prefix`, context `budgets` and Asset-indexed
`settings`. Target declarations are settings owned by `hairness/targets`; they
are not a Kernel primitive.

`create <directory>` creates a Git repository, initializes a Home, installs
Onboarding, HUD, Artifacts and Targets, builds shared projections, runs Doctor
and commits the result. `init` writes a bare Home.

## Desk

`.desk/desk.json` identifies the Desk and contains personal settings indexed by
Asset.

- `solo`: `.desk/` is part of the Home repository except local Target Bindings.
- `team`: `.desk/` is an independent private Git repository ignored by the
  parent Home.

`desk init`, `desk clone` and `desk status` are Kernel commands. A team Home is
valid without a Desk.

`hairness/onboarding` owns the optional personal `name`, `addressAs` and
`responseLanguage` settings it collects. The HUD exposes accepted values to
Ness; the Kernel gives them no business meaning.

## Asset

An installed Asset lives at `assets/<namespace>/<name>/asset.json` or, for a
Desk override, `.desk/assets/<namespace>/<name>/asset.json`.

The manifest may declare:

- `instructions`: invariant Home or Desk context;
- `capabilities`: provider-neutral procedures;
- `skills`: model access to Capabilities;
- `commands`: human access to Capabilities;
- `references` and `files`: source material loaded on demand;
- `artifactKinds`: schemas, templates, owners and states;
- `settings`: Home and Desk JSON schemas;
- `setup`: Capability IDs proposed by onboarding;
- `runtime`: one namespace, entrypoint and static command inventory;
- `origin`: installation provenance and base digests.

Every referenced path must appear in `files`. Directories are conventions, not
magic paths.

Supported sources:

```text
@hairness/<bundled-name>
owner/repository/path#tag
owner/repository/path#40-character-commit
owner/repository/path
https://example.com/path/asset.json
./path/to/asset.json
```

Git tags and full commits are pinned. Unpinned Git, HTTPS and local sources are
reported as mobile.

## Resolved Home

The Kernel deterministically composes Home Assets and Desk Assets. A Desk Asset
may replace a Home Asset only when its origin marks an explicit override.

`validate` exposes a root-free JSON view of the resolved Home: Assets,
Instructions, Capabilities, Skills, Commands, References, Artifact kinds,
setup routes, runtimes and context footprint. No lockfile is persisted.

Runtime namespaces and projected surfaces must be unique. Settings are validated
against the schemas owned by each Asset. Optional budgets cover Instructions,
model-facing descriptions and HUD prompt bytes.

## Build and Bridges

`build` reads the Resolved Home and writes provider-native projections. It never
executes an Asset runtime.

Codex and Claude Bridges currently project shared Instructions, Skills, Commands
and session-start HUD hooks. Generated Skills and Commands are tracked in Git.
Desk projections in a team Home are excluded locally by exact paths.

`.hairness/build.json` records output owners and digests but is not required
after clone. `build --check` recomputes desired bytes without writing.

Each Bridge also writes a tracked SessionStart wrapper. The wrapper prefers
`.hairness/dev-cli` when present and otherwise invokes the exact Home runtime
with `npx`. Codex receives its official JSON hook envelope; Claude receives the
raw XML HUD. Errors, oversized output and a 30-second timeout collapse to a
bounded `status="unavailable"` HUD without stderr.

## Runtime

An Asset runtime receives one JSON document on stdin:

```json
{
  "protocol": "hairness.dev/runtime/v1alpha1",
  "argv": ["audit", "--json"],
  "homeRoot": "/absolute/home",
  "deskRoot": "/absolute/home/.desk",
  "assetRoot": "/absolute/home/assets/company/security",
  "resolvedHome": {}
}
```

The runtime parses its arguments and owns stdout, stderr and exit code. Hairness
does not wrap its output. An external runtime must be approved locally by exact
Asset digest. A digest change revokes approval. Exact first-party runtime bytes
from the pinned CLI distribution are trusted as part of that distribution.

`add`, `sync`, `build`, `doctor`, HUD and resolution never execute third-party
runtimes.

## First-party Assets

- `hairness/onboarding`: static, user-invoked, consent-first setup;
- `hairness/hud`: session orientation in text, XML prompt and JSON;
- `hairness/artifacts`: generic Artifact lifecycle;
- `hairness/targets`: declarations, named Bindings and Target Maps;
- `hairness/scratch`: bundled, opt-in Scratch Artifact kind;
- `hairness/project`: external maintenance Asset, excluded from the package.

## CLI

```text
create <directory>
init
desk init|clone|status
asset review|add|status|diff|sync|remove|validate
asset override|publish|trust
validate
build [--check]
doctor
<runtime namespace> <arguments...>
```

Use `--home <path>` when invoking a Kernel command outside the Home. Use
`--json` for Kernel responses. Runtime flags pass through unchanged.

## Repository development commands

These commands are available only from a Hairness source checkout:

```text
npm run dev:home
npm run dev:home:recreate
npm run dev:session -- --provider codex|claude
npm run dev:verify
npm run dev:verify -- --full
```

`--home <path>` selects a disposable or alternate Development Home.
`--desk <id>` initializes its Desk and `--desk-repository <path-or-url>` clones
one. `--downstream <home>` is repeatable during full verification. No command
creates a remote, commit or push.
