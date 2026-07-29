# Lifecycles

## Home and Desk instructions

```text
create          → render HOME.md once → source-owned constitution
solo Desk      → render DESK.md once → versionable personal conventions
team Desk      → init or clone       → private repository with DESK.md
```

The built-in templates accept only `home.name`, `home.mode` and `desk.id`.
Rendering happens once. Later edits are canonical source changes and are never
re-templated. A team Home remains valid without a Desk; an existing Desk is
valid only with both `desk.json` and `DESK.md`.

## Asset source

```text
validate source → add → clean
                         ├─ edit Home source → customized → sync --check blocks
                         └─ override → Desk variant → promote → Home diff/PR
```

`asset validate <source>` works outside a Home and validates the manifest,
referenced files, schemas, templates and digest without installation. `add`
previews and transactionally copies files. `status` is offline and exposes the
effective digest. `sync --check` resolves the recorded or selected source and
returns the complete upstream diff without writing. `remove` deletes only
declared source-owned files and preserves unknown files.

An override records the Home base digests. Promotion replaces the Home Asset
only if those bytes are unchanged; no automatic merge occurs.

If the Home selected an Asset command for `frontDoor.wakeUp`, add, sync, remove,
override and promote compute the effective post-mutation composition first.
They refuse any write that would remove its runtime or command.

## Runtime trust

```text
installed static source
  → inspect source + offline status and digest
  → trust exact digest locally
  → dispatch runtime
  → any byte changes
  → approval no longer matches
```

```text
exact npm-bundled bytes → bundled
matching local approval → approved
anything else           → pending
```

Only `bundled` and `approved` runtimes can execute. Any byte change returns an
approved runtime to `pending`.

## Workspace

```text
create Home → workspace:home/home
durable personal milestone → workspace create <id> --scope desk
```

Every live Workspace has `workspace.md` and `inbox.md`. Home and Desk IDs are
unique in one Resolved Home. `workstreams/` and `decisions/` remain sparse.
`workspace doctor` is read-only and never repairs or archives implicitly.

## Artifact

```text
create/import in Workspace → validate → promote to Home Workspace or Target
                                   └── source remains
```

An Artifact kind is declared by an Asset. The kind owns allowed owners, states,
schema and template. `--from <directory>` imports a tree atomically after
rejecting symbolic links and the reserved `artifact.md`.

New Artifact sources use
`<workspace>/<workspaceNamespace>/<kind>/<id>/artifact.md`. Legacy
`artifacts/` and `.desk/artifacts/` roots are read-only: list, inspect,
validate and promote can consume them, but create never writes there.

Promotion preserves content, records the canonical source ref and digest, and
never removes the source. Desk → Home or Target and Home → Target are allowed;
Home → Desk is not.

Artifact-to-Asset curation is a separate human authoring step. `artifact
publish` and `asset publish` are deprecated prerelease aliases for promotion.

## Publishing

```text
outline → draft → ready → exact consent → observed remote success → published
                                                        └── Handle
```

A Publication Artifact requires `content.md`, the exact projectable source.
The instruction-only Publishing Capability obtains consent for content,
account and destination, uses an available connector, verifies the external
result and only then writes a Handle. Without a connector it returns a manual
handoff and records neither a Handle nor `published`. Revalidation updates
dated observations and drift status without importing remote content
implicitly.

## Target

```text
declare remote identity
  ├─ clone → managed Binding
  ├─ bind existing checkout → external Binding
  └─ usable Binding → managed linked worktree
          ↓
      deterministic inspect
          ↓
    agent interpretation
          ↓
    Desk Target Map Artifact
```

A Target accepts multiple named Bindings. A unique Binding is inferred;
ambiguity requires `--binding` or `--from-binding` while creating a worktree.
Bindings preserve compatible ownership as `bound | managed` and separately
identify their checkout as `main | linked-worktree`.

`target worktree` creates only below `.desk/targets/<target>/<binding>`, from a
local branch or a new branch at a locally resolved commit. It never fetches,
forces or copies source working-tree changes. `target list` aggregates
`git worktree list --porcelain -z` across usable Bindings and exposes
unregistered worktrees without binding them.

`target inspect` reads tracked paths, manifests, test names and local Git
evidence, caps inspection at 5,000 paths and never writes into the Target. The
Target Map Capability then guides the agent to interpret the bounded evidence
and create one inspectable Artifact per Target.

Unbinding a symlink removes only the link. Deleting a clean managed clone uses
filesystem removal only when its common Git directory has no dependent
worktrees. Deleting a clean, unlocked linked worktree uses
`git worktree remove`; Hairness never deletes its branch or automatically
forces, prunes, repairs or unlocks Git metadata.

## Front Door

```text
build
  → HOME.md
  → static Floor Plan
  → Home Asset Instructions
  → provider entrypoint
  → optional SessionStart Bridge
  → Home Console
  → selected Wake-up route
```

The Floor Plan is immediately usable from tracked projections. A Home without a
Wake-up route has no Hairness SessionStart wrapper and remains valid.

When configured, the provider Bridge invokes the route through
`node ./hairness.mjs`. The Console uses a regular non-symlink
`.hairness/dev-cli` when present; otherwise it invokes the exact
`hairness.json#runtime` through `npx`. A present but failing development
launcher never falls back to npm.

The Bridge treats output as opaque. It discards stderr, caps stdout at 256 KiB
and expires after 30 seconds. Failure yields a bounded
`<hairness-front-door status="degraded" … />` marker while the Floor Plan
continues to orient the session.

The first-party default is `hairness/hud:prompt`. HUD reads local evidence and
the Resolved Home, includes `DESK.md` and Desk Asset Instructions, then emits
XML for Ness. It executes no other Asset runtime. Its optional prompt budget is
owned by `settings["hairness/hud"].promptBytes`.

`hud activity` computes recent attributed observations on demand. It stores no
event log and does not run during `build`, `doctor` or Home resolution.

## Hairness development

```text
dev:home → reconcile sibling team Home → bind repository → build → doctor
dev:session → open provider inside that Home → static Floor Plan + Wake-up
dev:verify → contracts + persistent Home
dev:verify --full → release qualification
```

`dev:home:recreate` requires clean Home and Desk repositories. It qualifies a
staged replacement, moves the original Desk without transforming it, swaps the
Home and restores the previous instance after any failure.
