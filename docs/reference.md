# Endroit 0.10 reference

This reference describes the local `@endroit/cli@0.10.0-alpha.0` candidate.
It does not imply registry publication.

## Version contract

| Surface | Version |
| --- | --- |
| Package | `0.10.0-alpha.0` |
| Profile | `endroit/0.10` |
| Protocol target | `open-workplace/0.2-draft` |
| Canonical schemas | `https://endroit.org/schema/v9/*` |
| Work contract | `endroit/work/v1alpha2` |
| Legacy read window | v7 declarations plus Route v8 through 0.10 |
| Legacy removal target | 0.11 |

## Source format support

The schema registry describes valid contracts. The writer column describes
what this candidate can actually create or migrate; do not infer writer support
from the presence of a schema file.

| Responsibility | Current source | 0.10 writer or migration |
| --- | --- | --- |
| Workplace | v9 `WORKPLACE.md`; legacy `endroit.json` readable | create/init writes v9; no in-place root migration |
| Member | v9 `MEMBER.md`; compatible legacy readable | create writes v9; no bulk migration |
| Desk | v9 `DESK.md`; compatible legacy readable | init writes v9; no bulk migration |
| Route | v7/v8 JSON or v9 `ROUTE.md` | writes v9; journaled v7→v8→v9 migration |
| Work | v1alpha2 `WORK.md`; v1alpha1 `WORK.json` readable | new Work uses v1alpha2; no automatic Work migration |
| Room | compatible Room Markdown | bundled Room writer remains compatible; v9 schema is contract-only |
| Site | compatible Site Markdown | bundled Site writer remains compatible; v9 schema is contract-only |
| Equipment | mostly v7 JSON; Work Equipment uses v9 | owner-managed; no bulk migration |
| Artifact | compatible owner-specific Markdown | owner-managed; no general v9 migration |

See [Upgrade from 0.9 to 0.10](migration-0.10.md) for the safe boundary.

## Root declaration

`WORKPLACE.md` must be a regular, non-symlink UTF-8 file.

```markdown
---
$schema: "https://endroit.org/schema/v9/workplace.json"
kind: "endroit/workplace"
id: "studio"
owner: "member:alexis"
profile: "endroit/0.10"
protocol: "open-workplace/0.2-draft"
runtime: "@endroit/cli@0.10.0-alpha.0"
providers: ["codex","claude"]
---

# Studio

## Purpose

Why this Workplace exists.

## Constitution

Short provider-facing rules.

## Boundaries

What the Workplace owns and relates to.

## Limits

What it cannot authorize or prove.
```

The four sections are mandatory and non-empty. The owner must resolve to a
Member.

## Selection

Canonical selectors:

```text
--workplace <path>
ENDROIT_WORKPLACE_PATH=<path>
```

Deprecated 0.10 aliases:

```text
--home <path>
ENDROIT_HOME_PATH=<path>
```

If both CLI flags are present, they must identify the same directory.

## Kernel commands

```text
endroit create <workplace> [--desk tracked|separate|later]
endroit init [repository] [--desk tracked|separate|later]

endroit member create|list|inspect|doctor
endroit desk init|clone
endroit equipment validate|add|status|sync|remove|override|promote|catalog|trust
endroit room create|list|inspect|doctor
endroit site add|list|inspect|doctor|remove
endroit route list|inspect|park|activate|supersede|migrate|remove
endroit checkout list|inspect|resolve|adopt|clone|worktree|reconcile|delete

endroit validate
endroit build [--check]
endroit doctor
```

The tracked invocation is always:

```sh
node ./endroit.mjs <command> [...arguments]
```

JSON output is selected with `--json`. Public JSON fields use
`snake_case`; compatibility-only responses may retain historical fields until
0.11.

## Files and owners

| Path | Owner | Role |
| --- | --- | --- |
| `WORKPLACE.md` | Workplace | Declaration source |
| `members/<id>/MEMBER.md` | Workplace | Member source |
| `.desk/DESK.md` | Desk | Desk source |
| `rooms/**/ROOM.md` | Workplace/Desk | Room source |
| `sites/<id>/SITE.md` | Site identity | Site declaration |
| `.desk/routes/<site>/<route>/ROUTE.md` | Desk | Route source |
| `equipment/**/equipment.json` | Equipment owner | Machine manifest |
| `WORK.md` | Declared Material owner | Work source |
| `AGENTS.md`, `CLAUDE.md` | build | Provider projection |
| `.agents/skills/`, `.claude/skills/` | build | Provider projection |
| `endroit.mjs` | build | Tracked console |
| `.endroit/build.json` | build | Local receipt |
| `.endroit/checkout-index.json` | Desk partitions | Local binding index |
| `.endroit/migrations/` | migration command | Local rollback receipt |

## Routes and Checkouts

Route states:

```text
active | parked | superseded
```

Checkout modes:

```text
embedded | existing | managed-clone | managed-worktree | submodule
```

A managed worktree requires a branch or commit revision. A submodule cannot
declare one because its parent Gitlink owns the pin.

Commands:

```sh
node ./endroit.mjs checkout adopt <site> <path> --id <route>
node ./endroit.mjs checkout clone <site> --id <route> [--branch <name>]
node ./endroit.mjs checkout worktree <site> --id <route> --from <route> \
  (--branch <existing> | --new-branch <name> | --detach <ref>)
node ./endroit.mjs checkout inspect checkout:<site>/<route>
node ./endroit.mjs checkout reconcile --check
node ./endroit.mjs checkout reconcile --apply
```

`reconcile --apply` may create or replace a generated link only from a valid
Desk partition. It reports `checkout_index_conflict` for an unindexed link
and leaves both the link and index unchanged.

Logical references:

```text
checkout:<site>/<route>
checkout:<site>/<route>#<relative-path>
```

Absolute suffixes, `..` and symlink escapes outside the Checkout are rejected.

## Route migration

`route migrate` advances one compatibility step per run:

```sh
node ./endroit.mjs route migrate [site] [--id <route>] --check --json
node ./endroit.mjs route migrate [site] [--id <route>] --json
node ./endroit.mjs route migrate --rollback <run-id> --json
```

v7→v8 normalizes the existing JSON document. v8→v9 writes
`<route>/ROUTE.md` and removes the old JSON source. Preview creates no lock,
journal or source change. Apply and rollback never run Git mutations.

## Work

A v1alpha2 `WORK.md` frontmatter declares identity, owner, contract, work type,
activity and derivation. The first `endroit` block in a section types its
Fragment.

Runtime commands:

```text
endroit work inspect
endroit work resolve
endroit work review
endroit work record-review
```

The v1alpha1 `WORK.json` reader is compatibility-only and read-only. Recording
new review state requires explicit migration to `WORK.md`.

## Build receipt

`.endroit/build.json` records:

- `revision`;
- sorted input source paths, owners and digests;
- each output path, provider, owner, sources and digest.

`build --check` does not write. It fails when an output or receipt is missing,
stale, divergent or colliding with an unowned file.

## Resolution and diagnostics

Main resolution states:

```text
candidate | resolved | degraded | ambiguous
```

Representative errors:

| Code | Meaning |
| --- | --- |
| `document_frontmatter_duplicate` | A metadata key appears twice. |
| `schema_version_mismatch` | The source contract is unsupported. |
| `ambiguous_sources` | Legacy and v9 sources claim one identity. |
| `route_source_collision` | Two Route documents claim one Route. |
| `checkout_unbound` | A pathless Route has no current Desk binding. |
| `checkout_index_conflict` | A physical address is not owned by the applicable index state. |
| `route_migration_drift` | A migration input changed after validation. |
| `generated_output_collision` | Build would overwrite an unowned path. |
| `build_stale` | A projection or receipt needs rebuilding. |
| `context_budget_exceeded` | A provider context exceeds a fixed limit. |

Exit code 2 indicates usage/selection errors; validation and runtime errors use
their declared non-zero codes. Callers should consume the JSON error object
rather than parse human text.

## Fixed provider budgets

| Output/context | Maximum |
| --- | ---: |
| `AGENTS.md` | 4,096 bytes |
| `CLAUDE.md` | 4,096 bytes |
| HUD prompt | 4,096 bytes |
| Constitution section | 2,048 bytes |
| Desk guidance | 1,024 bytes |
| Model-facing descriptions | 4,096 bytes total |
