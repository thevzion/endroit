# Manage Sites

A Site is an independent repository known by stable identity. Its declaration
is shared at `sites/<site>/SITE.md`. Each collaborator owns zero or more Route
declarations under `.desk/routes/<site>/<route>.json`; managed checkout
material lives separately under `checkouts/<site>/<route>/`.

Resolve the intended Site and inspect its current declarations and Routes
before proposing a change. Read Checkouts through `checkout list|inspect` so
declared lifecycle/configuration stays separate from fresh Git and Mount
observation. When several active Routes exist, require an explicit selection.
Explain separately whether the operation changes shared Home state,
personal Desk state or a managed checkout.

Apply only the accepted declaration, bind, clone, worktree, Mount, lifecycle,
migration, Route removal or Site removal effect. The canonical managed root is
`checkouts/<site>/<route>`. Keep Route IDs and Git branches separate.

For an `existing` Route, `mount` may create a rebuildable symlink at that
conventional address. `unmount` removes only that symlink. Refuse non-symlink
paths, report direct, ready, broken, divergent or conflicting Mounts, and require explicit unmount before
Route removal.

Parked and superseded Routes remain readable but are never operational or
implicit targets. `activate` may select one parked Route; supersession requires
an active same-Site successor. Refuse removing a successor while another Route
still names it. Read frozen v7 metadata, write v8 only, and use `route migrate
--check` before the metadata-only cutover. Rollback must restore exact Route
bytes without touching Git or Mount state.

Use `route worktree` for a new linked worktree. It never fetches or copies
uncommitted changes: an existing local branch keeps its commit, while a new
branch starts from the selected local ref or the source Route HEAD. Adopt an
external worktree only through an explicit `route bind`; never auto-bind
discovered worktrees.

Never remove a dirty, locked or prunable managed checkout, delete a branch,
persist a machine path in settings or invoke Git force, prune, repair or unlock
implicitly. A managed linked worktree must be removed through
`git worktree remove`, never through filesystem deletion. Revalidate the
selected Route before any later Site mutation.
