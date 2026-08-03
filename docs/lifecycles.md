# Lifecycles

## Workplace adoption

The portable source for this pre-Home process is [ADOPT.md](../ADOPT.md).

```text
approved starting directory
  ├─ find endroit.json in current directory or parents → enter Front Door
  └─ no Home
       ├─ Start fresh → proposed create
       └─ Bring what you have
            → approve roots
            → shallow read-only inventory
            → compare candidates
            → select candidate (analysis only)
            → provenance-backed map
            → "Apply this map"
            → existing CLI operations → build → doctor → fresh session
```

Recognition and application are separate authority boundaries. Adoption never
moves existing Site sources or checkouts merely to match the proposed map.

## Home bootstrap

```text
standalone: create <directory> → Git → Member → tracked Desk → Equipment → build → doctor → commit
embedded:   init [repository]  → Member → separate Desk → Site self/Route embedded:. → build → doctor
deferred:   init --desk later  → Member → Site self → desk init → explicit checkout adopt → build
```

`create` refuses an existing destination. `init` requires an existing Git
repository and refuses an existing Home, Desk or canonical instruction source.
It preserves existing product files.

## Desk

```text
--desk tracked  → Desk sources share the Home Git; Routes/checkouts stay ignored
--desk separate → .desk is an ignored nested Git repository
--desk later    → Member exists; desk init or desk clone later
```

Every Desk references one Home-owned human Member. The Desk ID identifies the
workstation/context, not the person. Desk paths are never promoted to Home
settings.

An embedded Route is Desk-owned, so `init --desk later` cannot create it.
After `desk init`, adopt it explicitly with `checkout adopt self . --id embedded`.

## Equipment

```text
validate → preview → explicit install → build
                          ├─ edit source → customized
                          ├─ sync --check → upstream diff
                          ├─ override → Desk variant → promote
                          └─ remove declared files only
```

Runtime trust is separate:

```text
exact bundled bytes → bundled
exact local approval → approved
changed bytes        → pending
```

## Room, Meeting and Material

```text
Room persists
  └─ Meeting begins with hot context
       ├─ leave candidate ephemeral
       ├─ retain safe Material → add relative active link
       ├─ accept decision → update Current truth
       └─ deliver through a revalidated local Route → truth unchanged
retained or accepted Material → archive explicitly → remove active link
```

Chat creation alone writes nothing. `meetings/` is reserved for explicitly
retained records. Transcripts, hidden reasoning and credentials are never
canonical Material.

`ROOM.md` separates accepted `Current truth` from relative links under
`Active retained Material`. Candidate notes have no persistent section or
file.

The Workplace Equipment exposes provider-targeted gestures for all four
transitions. Endroit objects and operations remain their owners; the provider
projection only activates them. They are never silently performed by the
Core.

## Advancing work

```text
actionable result or plan → resolve owners and Routes
                          → revalidate before mutation
                          → delegate independent boundaries when available
                          → integrate → verify → report
```

`advance-this` is an optional provider projection of the same behavior normal
conversation can request. It does not imply a lifecycle transition, commit,
push or delivery. Durable multi-Site continuity composes optional Planning
Equipment only with human authority.

## Home Hygiene

```text
maintain → read-only findings by category
repair --finding <id> --approve <same-id> → existing operation → maintain again
```

Inspection never moves, deletes, archives, pushes or delivers. No daemon or
periodic cleanup is created.

## Site and Route

```text
site add remote                  → remote-only Site
site add existing checkout       → Site + existing Route main
checkout adopt                   → existing | embedded | submodule
checkout clone                   → managed-clone under checkouts/
checkout worktree                → managed-worktree under checkouts/
checkout reconcile --check       → preview the physical index
checkout reconcile --apply       → reconcile owned symlinks only
route park                       → active Route metadata becomes parked
route activate                   → one parked Route becomes active
route supersede --by <route>     → active Route names its active successor
checkout list|inspect|resolve    → declared metadata + fresh Git observation
route migrate --check            → preview v7 → v8 metadata only
route migrate                    → v8 cutover + exact local rollback run
route inspect                    → deterministic Git evidence
route remove                     → metadata only
checkout delete --approve        → guarded managed-checkout deletion
site remove                      → only after all Routes are gone
```

These operations belong to first-party `endroit/sites`; the root `site` and
`route` commands are CLI façades over that Equipment runtime. For a submodule,
the Home Git repository owns the Gitlink pin and `.gitmodules`, while checkout
initialization and lifecycle remain user-owned.

Managed worktree creation resolves local refs and revalidates repository,
branch and HEAD. It never fetches or copies dirty source changes.

Managed removal refuses dirty, locked, prunable, unavailable or dependent
checkouts. Endroit does not delete branches or manage submodule lifecycle.
Removing a Route removes only its generated index link; an unknown path is
never touched.

Parked and superseded Routes remain declared and inspectable but are excluded
from implicit or operational selection. Lifecycle writes, Route migration and
rollback do not change a checkout, branch, HEAD, working tree or repository.

## Build and Front Door

```text
owned sources → resolve → static Floor Plan → provider projections
                                      └────→ optional Wake-up/HUD
```

Build is deterministic. The HUD is observational and executes no other
Equipment runtime. Its absence degrades live orientation, not the Home.

## Artifact promotion

```text
create/import in Room → validate → promote to broader Room or Site
                                   └─ source remains
```

Promotion records lineage and never deletes the source. Remote publication is
complete only after an external result is observed.

## Publishing Work migration

```text
resolved Rooms → discover editorial-work-v1 mapping.json files
               → inspect → prepare → apply → verify → cutover
                                             └──────→ rollback
```

The migration derives its Rooms, scopes and counts from the resolved Home and
the discovered mappings. `prepare` snapshots only mapped Publications and the
Handles that point to them. Unmapped legacy Publications and their Handles are
reported as retained and are neither rejected nor modified. `rollback`
restores the mapped snapshot and removes only paths recorded by the migration.

`publishing list|inspect|validate` exposes the resulting Work, Candidate and
Publication graph. These local operations do not grant publication consent or
claim an external effect.
