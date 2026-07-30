# Endroit 0.7 technical reference

Endroit 0.7 is an alpha. The schemas under `schemas/v6` are authoritative.

## Home

`endroit.json` requires:

- `$schema: https://endroit.org/schema/home.json`;
- a stable `name`;
- the exact `@endroit/cli` runtime;
- `mode: solo | team`;
- at least one supported provider.

Optional fields are a projection `prefix`, budgets for Instructions and
model-facing descriptions, Asset-indexed `settings` and:

```json
{
  "frontDoor": {
    "wakeUp": "endroit/hud:prompt"
  }
}
```

The Wake-up route is `<asset-id>:<command>`. Its effective Asset runtime and
declared command must exist. A Home without it is valid and uses static
orientation only. Target declarations are settings owned by
`endroit/targets`; they are not a Kernel primitive.

Every Home contains a UTF-8, non-empty, regular, non-symlink `HOME.md`. It is
the shared constitution and a named Resolved Home source. `create` renders it
once from the bundled template with `home.name` and `home.mode`.
Unknown template variables are rejected. The resulting file is source-owned
and is never re-rendered automatically.

`create <directory>` uses a Clack wizard when stdin and stdout are TTYs. It
explains Home, Desk and Target, asks for `solo` or `team`, offers Research,
Planning, Publishing and Scratch with no default selection, previews the
result, asks for final confirmation, then reports the commands that open Codex
or Claude in the new Home.

The creation itself is atomic. It initializes Git, installs Workspaces,
Onboarding, HUD, Artifacts and Targets, bootstraps `workspaces/home`, selects
`endroit/hud:prompt`, builds shared projections, runs Doctor and commits.

- `--mode solo|team` supplies the mode and skips that question.
- `--with research,planning,publishing,scratch`, `--with all` or `--with none`
  supplies the optional Assets and skips the multiselect.
- `--yes` skips only the final confirmation.
- `--no-interactive` disables the wizard.
- `--json` disables the wizard and returns machine-readable output.

Non-interactive and JSON output contain no ANSI sequences. `NO_COLOR` also
disables color in the TTY wizard.

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

`endroit/onboarding` owns the optional personal `name`, `addressAs` and
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
- `workspaceNamespace`: one optional unique directory name used for new
  Workspace-owned Artifact sources;
- `origin`: installation provenance and base digests.

Every referenced path must appear in `files`. Directories are conventions, not
magic paths.

Supported sources:

```text
@endroit/<bundled-name>
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

The Resolved Home discovers `workspaces/<id>` in Home scope and
`.desk/workspaces/<id>` in Desk scope. IDs are globally unique for that
Resolved Home. References are `workspace:home/<id>`,
`workspace:desk/<id>` and
`workstream:<scope>/<workspace>/<id>`. Installed Asset Workspace namespaces
must also be unique.

`validate` exposes a root-free JSON view of the resolved Home: Assets,
Instructions, Capabilities, Skills, Commands, References, Artifact kinds,
setup routes, runtimes, the resolved Front Door and context footprint. No
lockfile is persisted. Floor Plan bytes are measured separately.

Runtime namespaces and projected surfaces must be unique. Settings are validated
against the schemas owned by each Asset. Optional budgets cover Instructions,
and model-facing descriptions. `endroit/hud` owns its prompt budget at
`settings["endroit/hud"].promptBytes`.

## Build and Bridges

`build` reads the Resolved Home and writes provider-native projections. It never
executes an Asset runtime.

Codex and Claude Bridges project the full shared instruction document, Skills,
Commands and, when configured, a generic SessionStart transport. `AGENTS.md` and
`CLAUDE.md` are entirely generated from `HOME.md`, the Floor Plan and Home Asset
Instructions with source attribution. A direct edit is a blocking divergence.
Generated Skills and Commands are tracked in Git. Desk projections in a team
Home are excluded locally by exact paths.

`.endroit/build.json` records output owners and digests but is not required
after clone. `build --check` recomputes desired bytes without writing.

Build also writes the tracked root `endroit.mjs` Home Console:

```text
node ./endroit.mjs <namespace> <command> [...arguments]
```

The Console uses `.endroit/dev-cli` only when it is a regular non-symlink file;
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
<endroit-front-door version="1" status="degraded"
  reason="wake-up-unavailable" />
```

Runtime stderr is never injected. Static Floor Plan orientation is unaffected.

`hud show` renders dense text for humans, `hud prompt` deterministic XML for
Ness, `hud json` a stable tool contract and `hud show --full` the full
inventory. HUD v2 exposes Workspaces, Workstreams, Targets and Capabilities
through a normalized Routable Item envelope: `kind`, `id`, optional `emoji`,
`state`, `summary`, `when`, `tags`, `ref`, `access` and `routable`. Home,
Workspace and Workstream sources may declare `emoji`; Target declarations
accept the same field. The owning Markdown, Target settings, Asset manifest or
Artifact metadata remains canonical.

An Asset Skill or Command accessor may declare `forEach` with `workspace`,
`workstream` or `target`. Resolution expands that accessor into one stable
provider alias per matching Home item, suffixes the projected id with the
item's stable identity and embeds its exact `ref` and emoji in the generated
surface. The Capability remains the single source; aliases are rebuilt when
the resolved inventory changes.

Command-only Capabilities remain available in `hud json` for user interfaces
but are omitted from `hud prompt`. An explicit provider invocation loads the
generated command itself; the agent does not need the full command catalogue in
its session context.

`hud activity [--since <duration|date>] [--scope <ref>] [--json]` computes at
most 100 recent events. Supported scopes are `home`, `desk`,
`workspace:<scope>/<id>`, `workstream:<scope>/<workspace>/<id>`, `target:<id>` and
`artifact:<id>`. An unknown scope fails without searching outside the resolved
inventory. Artifact metadata is attributed `authoritative`; Git, filesystem,
current status and HUD freshness observations are `observed`. Activity stores
no journal and claims no unobserved causality.

The prompt includes the smallest routable inventory, Console and provider
state, context footprint, trust, Desk Instructions and severity-separated
attention. It follows no Desk symlink and executes no other Asset runtime.

## Runtime

An Asset runtime receives one JSON document on stdin:

```json
{
  "protocol": "endroit.org/runtime/v1alpha1",
  "argv": ["audit", "--json"],
  "homeRoot": "/absolute/home",
  "deskRoot": "/absolute/home/.desk",
  "assetRoot": "/absolute/home/assets/company/security",
  "resolvedHome": {},
  "kernel": {
    "runtime": "@endroit/cli@0.7.0-alpha.0",
    "source": "npm",
    "invoke": "node ./endroit.mjs"
  },
  "runtimeTrust": [],
  "invocation": {
    "kind": "command"
  }
}
```

For Front Door execution, `invocation.kind` is `wake-up` and `provider` is
`codex` or `claude`. The runtime parses its arguments and owns stdout, stderr
and exit code. Endroit does not wrap its output.

Each runtime entry carries one trust value:

- `bundled`: the installed Asset matches the bytes bundled in the exact npm
  package;
- `approved`: its digest matches a local approval;
- `pending`: execution is blocked.

A digest change returns an approved runtime to `pending`.

`add`, `sync`, `build`, `doctor` and resolution never execute Asset runtimes.
HUD executes no other Asset runtime while composing its own output.

## Target runtime

`endroit/targets` provides:

```text
target list|discover|doctor|add|bind|clone|worktree|unbind|remove|inspect
```

Target declarations are Home-owned. Named Binding paths are local Desk state
under `.desk/targets/<target>/<binding>` and never enter settings.

`target bind` symlinks an existing checkout. `target clone` creates a physical
managed clone. `target worktree` creates a physical managed linked worktree
from one usable source Binding, either by checking out an unused local branch
or by creating a new branch at the source HEAD or an explicit locally resolved
start point.

Inspection reports compatible ownership `bound | managed` plus checkout
`main | linked-worktree`. Its worktree inventory comes from
`git worktree list --porcelain -z`, is deduplicated across usable Bindings and
marks the Binding associated with each registered path. Discovery never binds
an unregistered worktree.

`target unbind --delete` requires a clean managed checkout. It refuses locked,
prunable or dependent worktrees, uses `git worktree remove` for a linked
worktree and never deletes a branch or runs `--force`, `prune`, `repair`,
`unlock` or `fetch`.

## First-party Assets

- `endroit/workspaces`: required scoped Workspace lifecycle and runtime
  `workspace create|list|inspect|doctor`;
- `endroit/onboarding`: static, user-invoked, consent-first setup;
- `endroit/hud`: optional Wake-up and on-demand orientation through
  `show|prompt|json|activity`;
- `endroit/artifacts`: generic Workspace-owned Artifact lifecycle;
- `endroit/targets`: routable declarations, named Bindings, deterministic
  inspection and agent-authored Target Maps;
- `endroit/research`: optional instruction-only Studies under `researching`;
- `endroit/planning`: optional instruction-only roadmaps and Initiatives under
  `planning`;
- `endroit/publishing`: optional instruction-only Publications and external
  Handles under `publishing`;
- `endroit/scratch`: bundled, opt-in Scratch Artifact kind;
- `endroit/project`: Endroit maintenance methodology consuming Planning.

## CLI

```text
create <directory> [--mode solo|team] [--with <ids|all|none>]
  [--no-interactive] [--yes] [--json]
desk init|clone
asset validate <source>
asset add|status|sync|remove
asset override|promote|catalog|trust
validate
build [--check]
doctor
<runtime namespace> <arguments...>
```

After creation, use the tracked `node ./endroit.mjs` Console. `--home <path>`
remains available to repository tooling and direct Kernel use. `--json` formats
Kernel responses. The CLI strips its own `--home` flag before passing remaining
runtime arguments through unchanged.

## Repository development commands

These commands are available only from an Endroit source checkout:

```text
npm run dev:home
npm run dev:home:recreate
npm run dev:bootstrap -- [directory] [create options]
npm run dev:session -- --provider codex|claude
npm run dev:verify
npm run dev:verify -- --full
```

`dev:bootstrap` packs the current checkout, runs the canonical `create`
experience from that tarball and attaches it as the Home's development runtime.
It defaults to the sibling `endroit-bootstrap-home` directory and leaves the
created Home in place for manual testing.

`--home <path>` selects a disposable or alternate Development Home.
`--desk <id>` initializes its Desk and `--desk-repository <path-or-url>` clones
one. `--downstream <home>` is repeatable during full verification. No command
creates a remote, commit or push.
