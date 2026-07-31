# Endroit 0.8 reference

Endroit is a local-first, headless framework for durable human-agent
workplaces. This reference describes `0.8.0-alpha.0`; the [migration guide](migration-0.8.md)
is the only 0.7 → 0.8 vocabulary map.

## Requirements

- Node.js 22 or newer;
- Git;
- Codex and/or Claude for first-class provider projections.

## Kernel commands

```text
create <directory> [--mode solo|team] [--with <ids|all|none>]
init [repository] [--mode solo|team] [--with <ids|all|none>]
desk init|clone
equipment validate|add|status|sync|remove|override|promote|catalog|trust
room create|list|inspect|doctor
site add|list|inspect|doctor|remove
route bind|clone|worktree|list|inspect|remove
validate
build [--check]
doctor
<Equipment runtime namespace> <arguments...>
```

After bootstrap, prefer the tracked Home Console:

```bash
node ./endroit.mjs doctor
```

`--home <path>` selects a Home for direct CLI use. Kernel responses support
`--json`; Equipment runtimes own their stdout, stderr and exit codes.

## Sources and projections

Canonical sources:

```text
endroit.json
HOME.md
rooms/<room>/ROOM.md
equipment/<owner>/<equipment>/equipment.json
sites/<site>/SITE.md
.desk/desk.json
.desk/DESK.md
.desk/rooms/<room>/ROOM.md
.desk/routes/<site>/<route>.json     ignored local source
```

Generated or rebuildable state:

```text
AGENTS.md
CLAUDE.md
.agents/
.claude/
.codex/
.endroit/
```

`.desk/sites/` contains ignored managed Git checkouts. It is materialization,
not Route metadata.

## Home and Desk

`endroit.json` declares the Home name, runtime, mode, providers, optional
prefix, Front Door and namespaced Equipment settings. `HOME.md` contains shared
house rules.

A Desk contains one collaborator's instructions, Rooms, Equipment overrides
and Routes. A solo Desk is part of the Home repository except for ignored
Routes and checkouts. A team Desk may be its own nested Git repository; it
also ignores Routes and checkouts. Machine paths stay Desk-owned.

## Rooms and Meetings

A Room is a durable domain under `rooms/` or `.desk/rooms/`. Each live Room has
`ROOM.md` and `inbox.md`. Rooms may be nested directly below another Room;
their slash-separated path is their ID. The same full ID cannot exist in both
Home and Desk scope.

```bash
node ./endroit.mjs room create product --scope home
node ./endroit.mjs room create product/api --scope home
```

The parent must already be a valid Room. `room list`, `inspect` and `doctor`
use the full scoped identity, for example `room:home/product/api`.

`meetings/<id>/MEETING.md` is reserved for an explicitly retained Meeting
record. Opening a chat does not create it. Endroit 0.8 does not persist chat
transcripts or provide a persistent Meeting runtime.

## Equipment

Equipment is a source-owned reusable way of working. `equipment.json` may
declare instructions, capabilities, provider accessors, Artifact contracts,
settings, setup functions and one runtime namespace.

Installation is transactional and does not execute the Equipment runtime.
First-party runtime bytes are `bundled`; third-party bytes must be approved by
their exact digest. Any byte change returns an approved runtime to `pending`.

Skills and Commands are projections of Equipment functions. They are not the
canonical Equipment source.

## Sites

A Site is a shared sovereignty declaration:

```text
sites/<site>/SITE.md
```

Required frontmatter: `$schema`, `id`, `kind: site`, and `status`. `repository`
and `source` are optional so an embedded or non-Git remote Site can still be
declared honestly.

`site add` accepts a remote source or an existing Git checkout. An existing
checkout is also bound as Route `main` when a Desk is configured. A remote URL
creates a remote-only Site until a Route is added.

`site remove` refuses a Site with Routes or additional Site-owned Material.

## Routes

A Route is a Desk-local JSON declaration:

```text
.desk/routes/<site>/<route>.json
```

```json
{
  "$schema": "https://endroit.org/schema/route.json",
  "id": "main",
  "site": "product",
  "mode": "existing",
  "path": "/absolute/local/checkout"
}
```

Supported modes:

| Mode | Physical form | Lifecycle |
|---|---|---|
| `embedded` | Home and Site share root `.` | existing repository |
| `existing` | checkout elsewhere | Endroit removes only Route metadata |
| `managed-clone` | `.desk/sites/<site>/<route>/` | explicit clean deletion |
| `managed-worktree` | `.desk/sites/<site>/<route>/` | explicit `git worktree remove` |
| `submodule` | user-managed submodule path | recognized, never lifecycle-managed |

`route worktree` uses only local refs. It never fetches, forces, copies working
tree changes, deletes branches, prunes, repairs or unlocks Git metadata.

`route remove --delete` is required for managed checkouts. Dirty, locked,
prunable, unavailable or dependent worktrees block deletion. Existing,
embedded and submodule Routes remove only their JSON declaration.

## Resolver and build

The resolver validates canonical sources, composes Home and Desk Equipment,
indexes Rooms, retained Meetings and Sites, validates runtime namespaces and
builds provider-neutral accessors.

`build` projects owned sources into Codex and Claude front doors. The Floor
Plan is static and authoritative. A configured Wake-up adds optional live
orientation; its failure cannot remove the Floor Plan.

## First-party Equipment

- `endroit/onboarding`: consent-first Home and Desk setup;
- `endroit/hud`: `show|prompt|json|activity` live orientation;
- `endroit/rooms`: `create|list|inspect|doctor`;
- `endroit/artifacts`: Room-owned validated results and promotion;
- `endroit/sites`: Site, Route and deterministic Git inspection;
- `endroit/research`, `planning`, `publishing`, `scratch`: optional methods;
- `endroit/project`: Endroit's own maintenance method.

## Alpha boundaries

- schemas and grammar may still break before 1.0;
- Codex and Claude are the qualified projections;
- no daemon, semantic index, graph or persistent agent is required;
- no automated 0.7 migration or submodule manager ships in 0.8;
- no generated Site symlink view ships in 0.8; Routes resolve checkouts directly;
- Endroit never infers remote success or upgrades model intelligence.
