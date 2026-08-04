# Manage Sites

A Site is an independent authority known by stable identity. Its declaration
is shared at `sites/<site>/SITE.md`. A Desk owns Route Documents at
`.desk/routes/<site>/<route>/ROUTE.md`. Every non-embedded Route has the local
address `checkouts/<site>/<route>`, as a direct checkout, symlink or relational
self projection. Every v9 Route declares a purpose; implicit operations use
only the single active `primary` Route.

Resolve the intended Site and inspect its current Route before proposing a
change. Read Checkouts through `checkout list|inspect|resolve` so declared
lifecycle stays separate from fresh Git and host observation. Non-primary
Routes require an explicit selection.

The shared Git storage records one v1 binding document per Desk below
`<commonGitDir>/endroit/desks/`; `.endroit/checkout-index.json` v3 records only
this Home worktree's reconstructible projections. If a generated link is lost,
`checkout reconcile` rebuilds it from the validated binding. An unindexed link
is never adopted or removed implicitly, and Endroit never scans the global
filesystem for a target. A durable file reference uses
`checkout:<site>/<route>#<relative-path>` and must stay inside that Checkout.

Parked and superseded Routes remain readable but are not implicit operational
targets. Read v7/v8 Route metadata only through the legacy adapter and write
v9 `ROUTE.md` only. Migration preview and rollback preserve exact bytes and
modes without touching Git state.

Use `checkout worktree` for a new linked worktree. It uses local refs and does
not fetch, force, copy working changes, delete branches, prune, repair or unlock
Git metadata. Managed checkouts live below the shared Git storage and project
their conventional Home address. Worktrees discovered through already-declared Site repositories
are reported, never auto-bound; associate one only through explicit
`checkout adopt`.

Never remove a dirty, locked or prunable managed checkout. A managed linked
worktree is removed through `git worktree remove`, never recursive filesystem
deletion. `route remove` removes only the relationship and its symlink;
`checkout delete` is the approval-gated managed-checkout deletion path.
Revalidate the exact Route immediately before a Site mutation.
