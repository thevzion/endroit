# Endroit Workplace Profile

- **Profile identifier:** `endroit`
- **Profile version:** `0.8`
- **Canonical profile address:** `endroit/0.8`
- **Publisher:** The VZion
- **Target protocol:** `open-workplace/0.1`
- **Status:** local alpha release candidate
- **Release availability:** not included in the published
  `@endroit/cli@0.8.0-alpha.1` package

This self-contained Endroit Profile specializes the Open Workplace protocol for an
Endroit Home. It defines the representation, discovery, resolution and
degraded behavior an agent needs inside that Home. It is not an installation
prompt, workflow harness or runtime. A Workplace remains legible from its
owned files when no agent or optional runtime is present.

The center of gravity is the Workplace, not the agent. Agents enter as
temporary Occupants. The Home, its responsibilities and its relationships
persist across providers, sessions and people.

## Invariants

1. **The human keeps direction and authority.** The human chooses intent,
   judges results and grants retention, acceptance and delivery consent.
2. **The Workplace carries continuity.** Identity, place, ownership, time,
   methods and reach belong to explicit Workplace objects, not to an agent's
   memory or a transcript.
3. **An agent is present, not resident.** It may enter, work and leave without
   becoming the owner of the Home, a Room, Material or a Site.
4. **Sources are canonical; projections are rebuildable.** `HOME.md`,
   `DESK.md`, `ROOM.md`, Equipment manifests and Site declarations own their
   meaning. `AGENTS.md`, `CLAUDE.md`, Skills, Commands and local indexes are
   generated views.
5. **Sites stay sovereign.** A Site keeps its repository, source, history,
   permissions and delivery lifecycle. A Route grants bounded local access; it
   never transfers ownership to the Home.
6. **Lifecycle transitions are explicit.** Conversation and production alone
   do not retain, accept, archive or deliver a result.

## Discovery

Starting from the directory selected by the human, Endroit looks for
`endroit.json` in that directory and then its parents. The first declaration
found is the candidate Home root. Loading and schema validation must succeed
before the Profile treats it as a declared Instance; an invalid declaration is
a limit, not permission to search past it for another Home.

Discovery stops at the filesystem root. It does not search child directories,
follow a Route, inspect a remote Site or widen into another repository merely
because that source is reachable. The pre-Home
[ADOPT.md](https://endroit.org/adopt.md) adoption
guide applies its own approved-root and symlink boundaries before a Home
exists.

## Instance identity

`endroit.json` identifies the Home, the required Endroit runtime and enabled
providers. The directory containing it is the Home root; the Home declarations
define its trust boundary. Colocated Site files remain Site-owned. `HOME.md`
owns the shared constitution. At least one `members/<id>/MEMBER.md` source must
identify a human Member.

When a Desk exists, `.desk/desk.json` identifies it and references its Member;
`.desk/DESK.md` owns personal continuity and local Guidance. A Home without a
Desk remains valid but reports that local continuity and Routes are
unavailable. Invalid schemas, missing required identity sources or conflicting
object identifiers prevent a resolved status. The agent reports the concrete
validation error or `ambiguous` when authority cannot be established.

## Object and relationship mapping

| Open Workplace object | Endroit source or representation | Owner and lifetime | Resolution or projection |
| --- | --- | --- | --- |
| Workplace | The Resolved Home composed from the sources below | Home; durable | Floor Plan and provider Front Doors |
| Home | `endroit.json` plus `HOME.md` | Home; durable | Home identity and shared Guidance |
| Member | `members/<id>/MEMBER.md` | Home; durable human belonging | Member list and HUD orientation |
| Desk | `.desk/desk.json` plus `.desk/DESK.md` | One Member; durable local continuity | Desk-aware HUD and local Routes |
| Room | `rooms/<path>/ROOM.md` or `.desk/rooms/<path>/ROOM.md` | Home or Desk; durable domain | Floor Plan, HUD and generated Room accessors |
| Meeting | Current provider session; optionally retained as Room Material | Room; ephemeral by default | HUD continuity only when retained explicitly |
| Occupant | Current human or agent participation in a Meeting | Meeting; temporary | Provider execution or a projected `call` accessor |
| Role | Temporary mandate supplied to an Occupant | Meeting; temporary and not a durable record | Provider execution or a projected `work-as` accessor |
| Equipment | `equipment/<id>/equipment.json` or `.desk/equipment/<id>/equipment.json` and declared files | Home or Desk; durable reusable method | Instructions, Skills, Commands and runtime namespaces |
| Material | Addressable files inside the Home, Desk or owning Room; Site-native files remain Site-owned | Declared owner; ephemeral, retained, accepted or archived | Linked from the owning Room or exposed by Equipment |
| Site | `sites/<site>/SITE.md` | Site; durable external identity and sovereignty | Floor Plan, HUD and generated Site accessors |
| Route | `.desk/routes/<site>/<route>.json` | Desk; durable local relationship | Resolved checkout, optional Mount and Route accessors |

Relationships remain source-backed:

- directory containment and each `ROOM.md` establish nested Room membership;
- `.desk/desk.json` relates one Desk to one Member;
- Meeting scope relates Occupants and temporary Roles to one Room;
- Equipment manifests relate Instructions, Capabilities and projections to
  their Equipment owner;
- a Route document relates one Desk to one declared Site and one local access
  mode;
- active links in `ROOM.md` relate retained Material or accepted Decisions to
  the Room that owns them.

No file's proximity transfers ownership. A checkout under `checkouts/` remains
Site-owned, and a generated provider file remains a projection.

## Authority and composition

Endroit composes Guidance by distinct responsibility, owner, audience and
lifetime: Home constitution, current Member and Desk Guidance, the smallest
relevant Room, then activated Equipment and current Meeting instructions. A
later projection position does not override an earlier owner. Unrelated Rooms,
archives and reachable Sites are not loaded by default.

The resolver fails closed on incompatible claims it can detect: duplicate Room
identities, an undeclared Desk override, duplicate runtime namespaces,
projection surface collisions, invalid schemas and generated-output
collisions. When two owned sources make incompatible claims to the same
responsibility beyond deterministic validation, the agent reports `ambiguous`
and does not act on that responsibility.

Provider projections carry source comments or owner footers back to their Home
or Equipment sources. If a projection and an owned source differ, the source
wins; `build --check` reports drift, and the projection must be rebuilt rather
than edited as truth.

## Enter through the Front Door

When a valid `endroit.json` exists in the current directory or a parent, enter
through the generated Front Door. Read the Floor Plan before broad
exploration. Use the ready Wake-up when present; otherwise use the static Floor
Plan and its tracked `node ./endroit.mjs` Console.

Resolve the active Room from the human's explicit wording or the single
semantic match. Ask when multiple Rooms remain plausible. Read `ROOM.md`, then
only the Material needed for the current question. Do not treat provider
memory, the previous transcript or physical file containment as ownership.

When no Home exists, stop entry. Creating or recognizing a Workplace is the
separate, consent-gated process in
[ADOPT.md](https://endroit.org/adopt.md).

## Work from the Workplace

1. Locate the current Meeting inside its owning Room.
2. Resolve the relevant Material, Equipment, Sites and Routes before acting.
3. Revalidate a Route immediately before mutating its Site.
4. Delegate only independent boundaries and pass the same scope, constraints
   and approvals to every temporary Occupant.
5. Integrate and verify work in the place that owns it.
6. Report the observed result and remaining limits.

Normal conversation is the interface. A provider feature, Skill or Command may
make one action easier, but it does not replace the Open Workplace protocol,
this Profile or human authority.

## Material lifecycle

Each execution result begins as an ephemeral candidate in the current Meeting
and has no durable file merely because it was produced.

- **Retain** creates inspectable Material under the accepted Home, Desk or Room
  destination and links it from the owning Room without making it truth.
- **Accept** records current Room truth, normally as an owned Decision, without
  implying an external effect.
- **Archive** moves inactive retained or accepted Material into its matching
  archive boundary and removes the active Room link without erasing history.
- **Deliver** crosses a revalidated Route and records only an effect observed
  in the sovereign Site.

The human must identify the Material, destination owner, requested state and
mutation scope. Failure or a partial effect is reported without advancing the
lifecycle state. Never infer retain, accept, archive, deliver, commit, push,
publication or deployment from ordinary conversation. Never turn a Meeting
transcript or hidden reasoning into Workplace truth.

## Sites and Routes

A Site declaration names external identity; it does not copy Site truth into
the Home. A Desk Route names the Site, local path and access mode. Supported
materializations are embedded repositories, existing checkouts, managed
clones, managed worktrees, user-managed submodules and optional rebuildable
Mounts. A remote-only Site has no local Route.

Immediately before a Site mutation, run the tracked Console's `route inspect`
for the exact Site and Route. Stop on a path, repository, branch, worktree or
dirty-state mismatch. Route validity does not grant host permission or human
delivery consent. Site-native source, Git history and permissions remain under
the Site's lifecycle.

## Projections

Endroit generates `AGENTS.md`, `CLAUDE.md`, `.agents/skills/`,
`.claude/skills/`, provider hook wrappers, the tracked `endroit.mjs` Console,
the Floor Plan and local `.endroit/` build state. A provider projection names
its source or owner and is rebuildable from the Home, Desk and Equipment
sources.

`node ./endroit.mjs build` rebuilds projections. `build --check` detects a
missing, stale or diverged output. Endroit refuses to overwrite an
unrecognized file at a generated path and refuses multiple owners for one
surface. Projection edits never become source truth; edit the named owner and
rebuild.

## Degraded mode

The static Markdown and JSON sources remain readable when Wake-up, HUD or an
optional Equipment runtime is unavailable. Use the static Floor Plan and the
tracked Console's read-only `room list`, `site list` and `equipment catalog`
when those commands remain available. Report `degraded`, name the missing
capability and preserve source provenance.

If the tracked Console or matching runtime is unavailable, validation,
projection generation, Doctor, Route revalidation and Equipment runtime
operations are unavailable. Continue only with read-only source interpretation
whose owner is clear. Stop structural mutation, generated-file repair and
Route-mediated external effects until the required tooling returns. If static
sources cannot establish one owner or destination, report `ambiguous` and
stop the affected work instead of reconstructing truth from provider memory.

## Validation

From the declared Home, the tracked Console provides these checks:

```bash
node ./endroit.mjs validate
node ./endroit.mjs build --check
node ./endroit.mjs doctor
node ./endroit.mjs room doctor
node ./endroit.mjs site doctor
node ./endroit.mjs route inspect <site> --id <route>
```

`validate` checks declared contracts; `build --check` checks source-to-
projection freshness without rewriting; Doctors report structural and
semantic findings; Route inspection re-observes the exact external boundary.
A resolved result requires the checks relevant to the current work to succeed.
Unavailable optional checks produce `degraded`; conflicting authority produces
`ambiguous`.

## Limits and extensions

Endroit does not represent a durable Occupant registry, durable Role
assignment or canonical live Meeting. A retained Meeting is Material, not a
record of provider-private state. The Profile cannot establish host tool
permissions, prove provider execution, schedule agents, supply universal
memory or claim a remote effect before observing the Site. It defines no
Profile registry, adapter API or lossless cross-Profile conversion.

Endroit extensions are explicitly implementation-owned:

- **Floor Plan and HUD** provide static and optional live orientation;
- **Equipment runtimes and projected accessors** expose reusable operations;
- **Artifact kinds** validate selected Material forms;
- **Route modes, managed checkouts and Mounts** materialize local Site access;
- **`.endroit/` state and provider hooks** are local rebuildable machinery.

These extensions do not redefine Open Workplace objects, grant authority or
become canonical when their source owner says otherwise. Codex and Claude have
L1 Projection-qualified evidence only; provider-hosted invocation,
delegation and full journey execution remain unqualified. No daemon, graph,
persistent agent or hosted service is required.
