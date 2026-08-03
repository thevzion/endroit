# Endroit 0.8 reference

Endroit is the local-first, headless, file-based application framework for
building and operating Open Workplaces. This reference describes the local
`0.8.0-alpha.2` candidate and labels its unobserved publication explicitly;
the [migration guide](migration-0.8.md) is the only 0.7 → 0.8 vocabulary map.

## Framework contract

The framework composes four independently owned concerns:

- `open-workplace/0.1` defines the protocol;
- `endroit/0.8` defines the Endroit Workplace Profile;
- a Resolved Home instantiates that Profile from Home, Member, Desk, Room,
  Equipment, Site and Route sources;
- generated Front Doors and optional Equipment runtimes let humans and
  temporary agents use the instance without becoming its owner.

This is an application framework for the Workplace around agentic work. It is
not a web framework, model runtime, agent registry or replacement for the
sovereign applications represented as Sites.

## Requirements

- Node.js 22 or newer;
- Git;
- Codex and/or Claude for L1 Projection-qualified provider surfaces.

## Workplace profile

The [WORKPLACE.md](../WORKPLACE.md) release candidate is the
self-contained `endroit/0.8` alpha Profile of `open-workplace/0.1` for an existing Home:
Workplace-centered continuity, temporary Occupants, owned objects, Front Door
entry, sovereign Sites, explicit lifecycle transitions and a static file-based
foundation. `endroit/workplace` injects its canonical Instruction once into
both generated provider contracts and is included in the local
`0.8.0-alpha.2` package candidate.

## Adoption guide

The [ADOPT.md](../ADOPT.md) release candidate is the portable pre-Home
entrypoint included in the local `0.8.0-alpha.2` package candidate.
It first detects an existing Home from an explicitly selected directory and
its parents. Otherwise it guides **Start fresh** or **Bring what you have**.

Brownfield recognition is agent-led and read-only: approved roots, shallow
inventory, multiple candidates, one evidence-backed recommendation, candidate
selection for deeper analysis, then a separately approved **Apply this map**.
It adds no `adopt` command, automatic scanner, runtime or schema. [INSTALL.md](../INSTALL.md)
is the deterministic CLI appendix.

## CLI surfaces

Core commands:

```text
create <directory> [--desk tracked|separate|later] [--member <id>] [--with <ids|all|none>]
init [repository] [--desk tracked|separate|later] [--member <id>] [--with <ids|all|none>]
member create|list|inspect|doctor
desk init|clone
equipment validate|add|status|sync|remove|override|promote|catalog|trust
validate
build [--check]
doctor
```

Bundled foundation Equipment is available through the same console:

```text
room create|list|inspect|doctor
site add|list|inspect|doctor|remove
route bind|clone|worktree|mount|unmount|list|inspect|remove
artifact <command>
hud show|prompt|json|activity
hygiene maintain|repair
<Equipment runtime namespace> <arguments...>
```

After bootstrap, prefer the tracked Home Console:

```bash
node ./endroit.mjs doctor
```

`--home <path>` selects a Home for direct CLI use. Core responses support
`--json`; Equipment runtimes own their stdout, stderr and exit codes. Root
`room`, `site` and `route` commands are façades over their foundation
Equipment runtimes, not duplicate Kernel implementations.

## Sources and projections

Canonical sources:

```text
endroit.json
HOME.md
rooms/<room>/ROOM.md
members/<member>/MEMBER.md
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
checkouts/<site>/<route>/
```

`checkouts/` contains ignored managed Git checkouts and optional Mounts. It is
physical access, not Route metadata or Site identity.

## Home, Member and Desk

`endroit.json` declares the Home name, runtime, providers, optional prefix,
Front Door and namespaced Equipment settings. `HOME.md` contains shared house
rules. Endroit 0.8 has no `solo|team` mode; a legacy `mode` field is rejected
with a migration error.

A Member is a human represented by Home-owned
`members/<id>/MEMBER.md`. Frontmatter contains `id`, `name`, `status` and
non-secret external accounts `{ service, scope, identifier, handle? }`; the
Markdown body owns durable responsibilities and shared collaboration context.
Credentials never belong in a Member.

Every `desk.json` names both an independent Desk `id` and its required
`member`. Agents remain temporary Occupants and may receive a Role for one
Meeting; neither becomes a Member or a registry entry.

A Desk contains local instructions, Rooms, Equipment overrides and Routes.
`create` defaults to a Desk tracked in the Home Git repository. `init` defaults
to a separate nested Git repository under ignored `.desk/`. Either accepts
`--desk tracked|separate|later`; `later` creates the Member but no Desk.
Machine paths stay Desk-owned in every topology. For embedded `init --desk
later`, Site `self` is declared immediately but its embedded Route is deferred;
after `desk init`, bind it explicitly with `route bind self . --id embedded`.

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
canonical Equipment source. An accessor may declare a literal `projectedName`
or a template containing `{route}`. The resolver expands the final name and
rejects provider-surface collisions before build; omitted names retain the
prefix composition fallback.

The first-party Workplace Equipment projects human gestures such as
`enter-the-home`, `enter-the-<room>-room`, `work-on-<site>`,
`call-the-researcher`, `work-as-an-engineer`, `use-research`, `retain-this`,
`advance-this`, `accept-this`, `deliver-this` and `archive-this`. Entry reloads authoritative
sources and creates no global active-Room state. Provider-hosted call and Role
operations return `blocked` when the mechanism is unavailable; they never
simulate an Occupant.

`advance-this` consumes the current actionable result, resolves its Room,
Sites, Routes and owners, delegates independent boundaries when the provider
supports it, then integrates and verifies. It never infers continuity or a
retain, accept, deliver, commit or push transition.

## Versioned contracts

The 0.8 package validates offline from its bundled v7 schemas. Their immutable
public identifiers are:

```text
https://endroit.org/schema/v7/home.json
https://endroit.org/schema/v7/desk.json
https://endroit.org/schema/v7/member.json
https://endroit.org/schema/v7/equipment.json
https://endroit.org/schema/v7/site.json
https://endroit.org/schema/v7/route.json
https://endroit.org/schema/v7/runtime.json
https://endroit.org/schema/v7/artifact.json
```

Equipment runtimes receive protocol `endroit.org/runtime/v2alpha1`. Public
schema URLs identify and document contracts; the CLI never needs network
access to validate a Home. Historical unversioned 0.7 contracts remain frozen
at `home.json`, `desk.json`, `asset.json`, `runtime.json` and `artifact.json`;
they are not aliases for v7.

## Sites

The first-party `endroit/sites` Equipment owns Site and Route lifecycle behind
the root CLI façade. Core validates and resolves the resulting sources but
does not implement these lifecycle operations.

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
  "$schema": "https://endroit.org/schema/v7/route.json",
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
| `managed-clone` | `checkouts/<site>/<route>/` | explicit clean deletion |
| `managed-worktree` | `checkouts/<site>/<route>/` | explicit `git worktree remove` |
| `submodule` | user-managed submodule path | recognized, never lifecycle-managed |

The Home Git repository owns a submodule's Gitlink commit pin and
`.gitmodules` declaration. Checkout initialization and submodule lifecycle
remain user-owned; the Route only records how the Desk addresses it.

An `existing` Route may be exposed at the same root address with `route mount`.
The result is a rebuildable symlink called a Mount, not a new Route or owner.
`route unmount` refuses non-symlink paths and removes only the Mount. Route
removal is blocked while a Mount remains, and Doctor reports broken, invalid
or mismatched Mounts.

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

- `endroit/onboarding`: consent-first fresh and existing-environment adoption;
- `endroit/hud`: `show|prompt|json|activity` live orientation;
- `endroit/rooms`: `create|list|inspect|doctor`;
- `endroit/artifacts`: Room-owned validated results and promotion;
- `endroit/sites`: Site, Route and deterministic Git inspection;
- `endroit/workplace`: provider-projected entry, Occupant, Role, method,
  advance and lifecycle gestures;
- `endroit/work`: `inspect|resolve|review|record-review` for proof-carrying,
  Room-owned Work Items;
- `endroit/hygiene`: read-only `maintain-the-home` inspection and one exactly
  approved bounded repair;
- `endroit/publishing`: optional `list|inspect|validate` Work graph operations
  plus the explicit `editorial-work-v1` migration;
- `endroit/research`, `planning`, `scratch`: optional methods;
- `endroit/project`: Endroit's own maintenance method.

## Alpha boundaries

- `0.8.0-alpha.2` is a local release candidate; registry availability is not
  claimed until the exact artifact is observed;
- schemas and grammar may still break before 1.0;
- Codex and Claude are L1 Projection-qualified first-party targets; L2–L4 live
runtime qualification remains unclaimed until provider-hosted smoke evidence;
- provider status and portability levels are recorded in [providers](providers.md);
- no daemon, semantic index, graph or persistent agent is required;
- Work Resolution remains an experimental Endroit extension; see
  [Work Resolution](work-resolution.md);
- no automatic environment scanner, automated 0.7 migration or submodule
  manager ships in 0.8;
- Mounts are optional explicit views for `existing` Routes; Routes always
  resolve their source checkout directly;
- Endroit never infers remote success or upgrades model intelligence.
