# Migrate Route v8 sources to v9

Endroit 0.10 reads Route v8 JSON through its compatibility adapter and writes
pathless Route v9 Markdown. Migration changes only the Desk-owned declaration;
it never runs a Git mutation or moves a Checkout.

## Preconditions

- select the exact Workplace and Desk;
- make `node ./endroit.mjs validate` succeed except for the intended legacy
  source;
- make `checkout reconcile --check` current;
- inspect the exact Site/Route;
- preserve any dirty checkout as-is.

An `existing` or `submodule` Route whose target differs from its conventional
address must have a valid binding in the active Desk partition of
`.endroit/checkout-index.json`.

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

The Route ID, Site, owner, lifecycle, Checkout mode, supersession and revision
are preserved. The physical path is omitted from v9. The existing Desk
partition remains the local binding authority.

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

- Checkout index bytes;
- conventional Checkout link/physical directory;
- repository device or inode;
- Git HEAD, branch, status or worktree registration;
- Site declaration;
- remote state.

Unknown or unindexed links are never adopted as part of migration.
