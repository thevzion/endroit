# Migrate Route v8 sources to v9

Endroit 0.10 reads Route v7/v8 JSON through its compatibility adapter and
writes pathless Route v9 Markdown. Every v9 Route also declares its operational
purpose. Migration never runs a Git mutation or moves a Checkout.

## Preconditions

- select the exact Workplace and Desk;
- make `node ./endroit.mjs validate` succeed except for the intended legacy
  source;
- make `checkout reconcile --check` current;
- inspect the exact Site/Route;
- preserve any dirty checkout as-is.

An `existing` or `submodule` Route whose target differs from its conventional
address must have a valid shared Desk binding. The canonical binding file is
`<commonGitDir>/endroit/desks/<desk>/checkout-bindings.json`; non-Git Homes use
the corresponding `.endroit/desks/<desk>/` fallback.

Purpose inference is deliberately closed: `main` and embedded Routes are
`primary`; `work--*`, `release--*`, `dogfood--*` and `recovery--*` map to their
matching purposes; `home-first-reset` and preserve candidates are `recovery`;
`integrated-main`, `qualification`, `managed-main` and `site-hard-reset` are
`integration`. Any other legacy ID requires an explicit mapping.

## Preview

```sh
node ./endroit.mjs route migrate --check --json
node ./endroit.mjs route migrate <site> --id <route> --check --json
```

Preview parses and validates every selected source, target declaration and
binding. It creates no lock, directory, journal or file change.

A run advances one compatibility step. If selected v7 Routes remain, they move
to v8 first. A later run moves v8 to v9.

## Apply

```sh
node ./endroit.mjs route migrate <site> --id <route> --json
```

For v8→v9, apply:

1. takes the exclusive Route writer lock;
2. stores the original bytes and mode under
   `.endroit/migrations/checkout-v9/<run-id>/`;
3. writes a durable journal;
4. removes `.desk/routes/<site>/<route>.json`;
5. writes `.desk/routes/<site>/<route>/ROUTE.md`;
6. verifies the destination digest and mode;
7. marks the run applied.

The Route ID, Site, owner, lifecycle, purpose, Checkout mode, supersession and
revision are preserved. The physical path is omitted from v9. The shared Desk
binding remains the local target authority.

If apply stops after crossing the source cutover, the error returns its run ID.
Resolution remains recoverable and rollback can resume from the journal.

## Rollback

```sh
node ./endroit.mjs route migrate --rollback <run-id> --json
```

Rollback accepts prepared, applying, applied or already rolling-back runs. It
refuses drift. For every Route it restores the original JSON bytes and file
mode, removes only the expected v9 document and empty declaration directory,
then records progress. Repeating a completed rollback is a zero-effect
`current` result.

## Invariants

Migration and rollback do not change:

- Checkout binding and index bytes;
- conventional Checkout link/physical directory;
- repository device or inode;
- Git HEAD, branch, status or worktree registration;
- Site declaration;
- remote state.

Unknown or unindexed links are never adopted as part of migration.

## Workplace upgrade core

The programmatic Workplace upgrade core plans direct v7/v8→v9 Route conversion
and v1/v2 Checkout-index extraction in one digest-bound operation. Its public
plan includes target version and optional source commit/package provenance,
source kinds, exact writes, invariants and rollback route.

Apply requires the exact `planDigest`, approval for `workplace:<id>`, a clean
Home Git worktree and a verification callback. It writes shared v1 bindings and
this Home's v3 projection, journals every before/after digest and mode, and
automatically restores exact state when a write or verification fails. Explicit
rollback is drift-refusing and idempotent. The core performs no commit, branch,
worktree, fetch, push or remote mutation.

This core does not itself claim migration of legacy Workplace, Desk or Member
declarations, first-party Equipment synchronization, CLI wiring or projection
rebuild. Those effects must be composed and verified by the product command
layer before a complete Workplace upgrade is reported.
