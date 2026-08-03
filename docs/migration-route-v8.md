# Migrate Route metadata to v8

Endroit 0.9 reads frozen v7 Route documents and v8 Route documents, but every
new Route write uses v8. The migration changes only Desk metadata. It does not
move, initialize, modify or delete a Git checkout or Mount.

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
other Route or Mount mutation. The writer refreshes the lock mtime every five
seconds. A lock is active only while its PID is live and its heartbeat is at
most 30 seconds old; stale recovery is itself serialized by a distinct
exclusive reaper lock and revalidates the writer token and file identity. The
journal moves through `prepared`, `applying` and `applied`; every Route records
its progress atomically after its v8 bytes are durably verified.

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
of overwriting it. A stale lock left by a terminated process is recovered by
the next migration command; a live concurrent migration remains blocked.

The v8 declaration separates lifecycle and Checkout configuration:

```json
{
  "$schema": "https://endroit.org/schema/v8/route.json",
  "id": "main",
  "site": "product",
  "status": "active",
  "checkout": {
    "mode": "existing",
    "path": "/absolute/local/checkout",
    "expectedBranch": "main"
  }
}
```

`embedded` resolves from the Home context. `managed-clone` and
`managed-worktree` derive `checkouts/<site>/<route>` and therefore persist no
path. `existing` and `submodule` persist their path. v8 has no `sourceRoute`
and never stores observed Git state.
