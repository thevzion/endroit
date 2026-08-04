# Endroit 0.10 architecture

Endroit is a local compiler for owned workplace context. Open Workplace defines
shared responsibilities; the `endroit/0.10` Profile owns their concrete file,
resolution, validation, query and projection model.

## Ownership

| Authority | Owns |
| --- | --- |
| Open Workplace | Cross-implementation responsibilities and resolution states. |
| Endroit | Profile vocabulary, schemas, resolver, CLI, projections and migration. |
| Workplace | Its declaration, Members, shared Rooms and Equipment sources. |
| Desk | Local continuity, local Rooms, Routes and Checkout bindings. |
| Site/Git | Repository source, branches, worktrees, history and remote effects. |

Filesystem containment never transfers ownership.

## Canonical representations

```mermaid
flowchart TD
  S["Owned Documents and manifests"] --> P["Document parser"]
  P --> V["Single AJV registry"]
  V --> R["Targeted resolver"]
  R --> RW["ResolvedWorkplace"]
  RW --> B["Projection build"]
  B --> O["AGENTS.md / CLAUDE.md / Skills"]
  RW --> Q["Queries"]
  G["Git + host observations"] --> OW["ObservedWorkplace"]
  OW --> Q
```

`ResolvedWorkplace` is derived in memory. It includes identity, Profile,
runtime, source refs/owners/relative paths/digests, resolved Documents and
Fragments, Equipment, Capabilities, surfaces and Artifact kinds.

Its revision is the digest of the Profile, runtime and sorted
`(relative_path, source_digest)` pairs. Host paths, timestamps, Git state,
projection freshness and other observations are excluded.

`ObservedWorkplace` contains volatile facts: current Desk, projection
freshness, runtime availability, Git/Checkout state and diagnostics. Neither
representation is Material or an Artifact.

## Document pipeline

One parser handles human-owned v9 Documents:

- UTF-8 regular files only; symlinks are rejected;
- one `key: value` frontmatter pair per line;
- structured values use inline JSON;
- bare scalars are strings;
- duplicate keys, YAML nesting, anchors and tags are rejected;
- deterministic rendering sorts non-identity keys and serializes structure as
  JSON.

One AJV registry validates v9 Documents, Work contracts and legacy adapter
inputs. Public source/schema fields use `snake_case`. Historical camelCase
exists only inside the compatibility adapter or internal normalized shape.

Contract availability is broader than writer availability. The 0.10 candidate
writes v9 Workplace, Member, Desk and Route Documents. It validates the full v9
schema family as a product contract, but bundled Room and Site writers and most
Equipment and Artifact owners still use their compatible source shapes. A
schema existing in the registry is not evidence that an in-place migration or
writer exists. The exact matrix lives in the
[reference](reference.md#source-format-support).

A Markdown section may contain one first `endroit` fenced block. The block
types the Fragment; its substance runs to the next heading of equal or higher
level. Fragments inherit owner and lifecycle. Independent content is Material;
schema-validated autonomous Material is an Artifact.

## Discovery

`findWorkplace` walks physical parents from the explicitly selected starting
path. It ignores an ordinary `WORKPLACE.md` without the Endroit kind. The
first marked candidate stops discovery even when invalid. Discovery never
walks children, follows Routes, crosses repositories or scans global project
roots.

The legacy adapter reads `endroit.json` only when no v9 declaration competes
for the same boundary.

## Build

```text
resolve
→ validate fixed context budgets
→ render provider projections
→ detect path/owner collisions
→ write atomically
→ write .endroit/build.json
```

The receipt records the Workplace revision, input digests and each output's
path, kind/provider, owner, sources and digest. It is local, deterministic and
disposable.

Build does not install provider hooks, mutate host configuration or edit Git
excludes. Generated paths are protected: an unrecognized file or a generated
file changed since its receipt causes a collision/divergence error.

## Provider context

Codex and Claude use the same semantic source. Provider adapters only select
paths and provider syntax. Each bootstrap is at most 4,096 bytes and carries:

- Workplace, Profile, protocol and revision;
- concise Constitution;
- source/projection rule;
- minimum routing and authority constraints;
- local console and degraded behavior.

The Profile, complete inventories, unrelated Rooms/Sites and absolute paths are
excluded. Foundation Skills are the six explicit gestures declared by
`endroit/workplace`; Rooms and Sites do not generate their own Skills.

## Route and Checkout topology

A v9 Route owns no physical path. Its address is derived as
`checkouts/<site>/<route>`. The Desk-owned
`.endroit/checkout-index.json` is versioned and partitioned by Desk ID. Each
partition maps a conventional address/ref to the explicitly adopted absolute
local target and a digest.

Only the active Desk partition drives resolution and reconciliation. A lost
generated symlink can be rebuilt from that partition. Switching Desks may
replace a conventional symlink only when its observed target is already owned
by another valid Desk partition. An unindexed symlink is a conflict; reconcile
does not adopt or delete it.

Managed clones/worktrees remain physical at their address. Existing checkouts
may use a generated symlink; submodules and explicitly direct checkouts may
occupy the address. Removing a Route updates only its Desk partition and never
removes a physical link currently owned by another Desk.

Git observations are read from the resolved repository. Extra worktrees are
enumerated only through the common Git directory of known Site repositories.

## Compatibility and migration

0.10 uses `read_old, write_new` only where a native v9 writer exists:

- v7 declarations and Route v8 are accepted only through the legacy adapter;
- v9 plus legacy for one identity is `ambiguous_sources`;
- ordinary mutation of legacy sources is refused;
- Route migration advances v7→v8 first, then v8→v9;
- v8→v9 changes only the declaration shape and preserves the Checkout index;
- apply is journaled under `.endroit/migrations/`;
- rollback restores source bytes and mode exactly;
- migration runs no Git mutation.

There is no general 0.9→0.10 mutation. Room, Site, most Equipment and Artifact,
and `WORK.json` sources remain read-only or owner-managed compatibility
surfaces until an explicit migration is implemented and qualified. Compatibility
aliases and readers are removable only after that condition and zero observed
legacy usage.

## Documentation delivery

Files in this repository are Endroit-owned product source. A documentation
repository or public site is a projection owner, not a second canon. A
projection lock records source repository, ref/commit, source digest,
transform version and output digest. Public “current release” pages advance
only after the release effect has been observed; candidates render as previews
identified by commit and digest.
