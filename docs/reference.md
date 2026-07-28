# Hairness 0.5 technical reference

Hairness 0.5 is an alpha. The schemas under `schemas/v5` are authoritative.

## Home

`hairness.json` requires:

- `$schema: https://hairness.dev/schema/home.json`;
- a stable `name`;
- the exact `@hairness/cli` runtime;
- `mode: solo | team`;
- at least one supported provider.

Optional fields are a projection `prefix`, budgets for Instructions and
model-facing descriptions, Asset-indexed `settings` and:

```json
{
  "frontDoor": {
    "wakeUp": "hairness/hud:prompt"
  }
}
```

The Wake-up route is `<asset-id>:<command>`. Its effective Asset runtime and
declared command must exist. A Home without it is valid and uses static
orientation only. Target declarations are settings owned by
`hairness/targets`; they are not a Kernel primitive.

Every Home contains a UTF-8, non-empty, regular, non-symlink `HOME.md`. It is
the shared constitution and a named Resolved Home source. `create` renders it
once from the bundled template with `home.name` and `home.mode`.
Unknown template variables are rejected. The resulting file is source-owned
and is never re-rendered automatically.

`create <directory>` creates a Git repository, initializes a Home, installs
Onboarding, HUD, Artifacts and Targets, selects `hairness/hud:prompt`, builds
shared projections, runs Doctor and commits the result.

## Desk

`.desk/desk.json` identifies the Desk and contains personal settings indexed by
Asset.

Every configured Desk also contains a UTF-8, non-empty, regular, non-symlink
`DESK.md`. It specializes language, style and personal conventions without
replacing `HOME.md`. It is rendered once with `desk.id` and `home.name`.

- `solo`: `.desk/` is part of the Home repository except local Target Bindings.
- `team`: `.desk/` is an independent private Git repository ignored by the
  parent Home.

`desk init` and `desk clone` are Kernel commands. A team Home is
valid without a Desk. A clone without both `desk.json` and `DESK.md` is rejected
and removed atomically.

`hairness/onboarding` owns the optional personal `name`, `addressAs` and
`responseLanguage` settings it collects. A selected Wake-up runtime may expose
accepted values to Ness; the Kernel gives them no business meaning.

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

`asset validate <source>` resolves any supported source without requiring a
Home. It validates the manifest, referenced files, paths, symlinks, runtime
inventory, Artifact schemas and templates, then reports the complete digest.
It installs nothing and executes no code.

## Resolved Home

The Kernel deterministically composes canonical instructions in this order:

1. `HOME.md`;
2. the generated provider-neutral Floor Plan;
3. Home Asset Instructions, ordered by Asset and instruction ID.

The first-party HUD prompt then adds `DESK.md` and Desk Asset Instructions in
the same deterministic order. That is HUD behavior, not Kernel grammar.

A Desk Asset may replace a Home Asset only when its origin marks an explicit
override.

`validate` exposes a root-free JSON view of the resolved Home: Assets,
Instructions, Capabilities, Skills, Commands, References, Artifact kinds,
setup routes, runtimes, the resolved Front Door and context footprint. No
lockfile is persisted. Floor Plan bytes are measured separately.

Runtime namespaces and projected surfaces must be unique. Settings are validated
against the schemas owned by each Asset. Optional budgets cover Instructions,
and model-facing descriptions. `hairness/hud` owns its prompt budget at
`settings["hairness/hud"].promptBytes`.

## Build and Bridges

`build` reads the Resolved Home and writes provider-native projections. It never
executes an Asset runtime.

Codex and Claude Bridges project the full shared instruction document, Skills,
Commands and, when configured, a generic SessionStart transport. `AGENTS.md` and
`CLAUDE.md` are entirely generated from `HOME.md`, the Floor Plan and Home Asset
Instructions with source attribution. A direct edit is a blocking divergence.
Generated Skills and Commands are tracked in Git. Desk projections in a team
Home are excluded locally by exact paths.

`.hairness/build.json` records output owners and digests but is not required
after clone. `build --check` recomputes desired bytes without writing.

Build also writes the tracked root `hairness.mjs` Home Console:

```text
node ./hairness.mjs <namespace> <command> [...arguments]
```

The Console uses `.hairness/dev-cli` only when it is a regular non-symlink file;
otherwise it invokes the exact Home runtime with `npx`. It centralizes
`development|npm` provenance and propagates stdio, signals and exit status.
A present but failing development launcher never falls back.

When `frontDoor.wakeUp` exists, each Bridge writes a tracked SessionStart
wrapper. The wrapper calls the resolved namespace and command through the
Console, passes `invocation.kind = wake-up` and the provider to the runtime, and
transports stdout without parsing it. Codex receives its official JSON hook
envelope; Claude receives raw stdout. Errors, empty or oversized output and a
30-second timeout collapse to:

```xml
<hairness-front-door version="1" status="degraded"
  reason="wake-up-unavailable" />
```

Runtime stderr is never injected. Static Floor Plan orientation is unaffected.

`hud show` renders dense text for humans, `hud prompt` deterministic XML for
Ness, `hud json` a stable tool contract and `hud show --full` the full
inventory. The prompt includes absolute Home, Desk, Binding, Artifact and
Target Map paths; the exact Console invocation; static surface inventories;
local Git and worktree evidence; projection and trust state; context
footprints; five recent regular Desk files; and severity-separated attention.
It follows no Desk symlink and executes no other Asset runtime.

## Runtime

An Asset runtime receives one JSON document on stdin:

```json
{
  "protocol": "hairness.dev/runtime/v1alpha1",
  "argv": ["audit", "--json"],
  "homeRoot": "/absolute/home",
  "deskRoot": "/absolute/home/.desk",
  "assetRoot": "/absolute/home/assets/company/security",
  "resolvedHome": {},
  "kernel": {
    "runtime": "@hairness/cli@0.5.0-alpha.1",
    "source": "npm",
    "invoke": "node ./hairness.mjs"
  },
  "runtimeTrust": [],
  "invocation": {
    "kind": "command"
  }
}
```

For Front Door execution, `invocation.kind` is `wake-up` and `provider` is
`codex` or `claude`. The runtime parses its arguments and owns stdout, stderr
and exit code. Hairness does not wrap its output.

Each runtime entry carries one trust value:

- `bundled`: the installed Asset matches the bytes bundled in the exact npm
  package;
- `approved`: its digest matches a local approval;
- `pending`: execution is blocked.

A digest change returns an approved runtime to `pending`.

`add`, `sync`, `build`, `doctor` and resolution never execute Asset runtimes.
HUD executes no other Asset runtime while composing its own output.

## First-party Assets

- `hairness/onboarding`: static, user-invoked, consent-first setup;
- `hairness/hud`: optional Wake-up and on-demand orientation through
  `show|prompt|json`;
- `hairness/artifacts`: generic Artifact lifecycle;
- `hairness/targets`: declarations, named Bindings and Target Maps;
- `hairness/scratch`: bundled, opt-in Scratch Artifact kind;
- `hairness/project`: external maintenance Asset, excluded from the package.

## CLI

```text
create <directory>
desk init|clone
asset validate <source>
asset add|status|sync|remove
asset override|publish|trust
validate
build [--check]
doctor
<runtime namespace> <arguments...>
```

After creation, use the tracked `node ./hairness.mjs` Console. `--home <path>`
remains available to repository tooling and direct Kernel use. `--json` formats
Kernel responses. The CLI strips its own `--home` flag before passing remaining
runtime arguments through unchanged.

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
