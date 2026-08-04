# Migrate Route metadata to v8

Endroit 0.10 preserves the frozen 0.9 v7→v8 migration as the first
compatibility step. New sources use v9; after this run, use the separate
[v8→v9 migration](migration-route-v9.md). This step changes only Desk metadata.
It does not move, initialize, modify or delete a Git checkout or index link.

Preview every v7 Route without writing:

```bash
node ./endroit.mjs route migrate --check --json
```

Scope the preview or cutover to one Site or Route when needed:

```bash
node ./endroit.mjs route migrate product --check --json
node ./endroit.mjs route migrate product --id main --json
```

Without `--check`, `route migrate` writes v8 documents and returns a migration
run ID. Endroit stores the exact original bytes, file modes and digests under
`.endroit/migrations/checkout-v8/<run-id>/`. The journal contains Route
metadata only; it persists no observed HEAD, branch status or dirty state.
One local exclusive Route-writer lock serializes migration, rollback and every
other Route or Checkout topology mutation. The lock is created exclusively and has no
lease expiry: Endroit never steals it from a live writer. A lock owned by a
stopped process is reported as `route_writer_lock_stale` and left untouched;
inspect that process and `.endroit/locks/routes.lock` before removing it and
retrying. The journal moves through `prepared`, `applying` and `applied`;
every Route records its progress atomically after its v8 bytes are durably
verified.

Rollback the exact run:

```bash
node ./endroit.mjs route migrate --rollback <run-id> --json
```

Rollback accepts a `prepared`, `applying`, `rolling-back` or `applied` run. It
classifies every current Route as either the exact original or exact migrated
bytes before changing any file, then records progress Route by Route and ends
at `rolled-back`. This makes an interrupted apply or rollback resumable. A
second rollback of a `rolled-back` run is a current, zero-effect operation.

Rollback fails closed if any Route has a third digest, if an original no longer
matches its recorded bytes, or if a declaration, ancestor, journal or original
is replaced by a symlink. Inspect and reconcile that drift explicitly instead
of overwriting it. A stale or live concurrent writer lock remains blocked
until its ownership is reconciled explicitly.

The v8 declaration separates lifecycle and Checkout configuration:

```json
{
  "$schema": "https://endroit.org/schema/v8/route.json",
  "id": "main",
  "site": "product",
  "status": "active",
  "checkout": {
    "mode": "managed-worktree"
  },
  "revision": {
    "kind": "branch",
    "name": "feature/topology"
  }
}
```

`embedded` resolves from the Workplace context. `managed-clone` and
`managed-worktree` derive `checkouts/<site>/<route>` and therefore persist no
path. `existing` and `submodule` persist their path. v8 has no `sourceRoute`
and never stores observed Git state. A legacy `branch` becomes a branch
`revision` only for `managed-worktree`; it is discarded as observation for
every other mode. Rollback restores exact v7 bytes.
