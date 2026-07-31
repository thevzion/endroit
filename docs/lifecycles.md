# Lifecycles

## Home bootstrap

```text
standalone: create <directory> → initialize Git → source files → Equipment → build → doctor → initial commit
embedded:   init [repository]  → source files → Site self → Route embedded:. → build → doctor
```

`create` refuses an existing destination. `init` requires an existing Git
repository and refuses an existing Home, Desk or canonical instruction source.
It preserves existing product files.

## Desk

```text
solo Home → local Desk in Home Git
team Home → no Desk required → desk init or desk clone
```

The Desk owns personal Guidance and Routes. Team Desk paths are never promoted
to Home settings.

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
       ├─ no durable outcome
       ├─ retain safe Material
       ├─ accept Material as Room truth
       └─ deliver through a Route
retained or accepted Material → archive explicitly when inactive
```

Chat creation alone writes nothing. `meetings/` is reserved for explicitly
retained records. Transcripts, hidden reasoning and credentials are never
canonical Material.

The 0.8 Core exposes Room creation and inspection. Retention, acceptance and
delivery remain explicit Equipment or human workflows; they are not silently
performed by the Kernel.

## Site and Route

```text
site add remote                  → remote-only Site
site add existing checkout       → Site + existing Route main
route bind                       → existing | embedded | submodule
route clone                      → managed-clone under .desk/sites
route worktree                   → managed-worktree under .desk/sites
route inspect                    → deterministic Git evidence
route remove                     → metadata only
route remove --delete            → guarded managed-checkout deletion
site remove                      → only after all Routes are gone
```

Managed worktree creation resolves local refs and revalidates repository,
branch and HEAD. It never fetches or copies dirty source changes.

Managed removal refuses dirty, locked, prunable, unavailable or dependent
checkouts. Endroit does not delete branches or manage submodule lifecycle.

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
