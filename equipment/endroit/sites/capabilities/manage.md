# Manage Sites

A Site is an independent repository known by stable identity. Its declaration
is shared at `sites/<site>/SITE.md`. Each collaborator owns zero or more Route
declarations under `.desk/routes/<site>/<route>.json`; managed checkout
material lives separately under `checkouts/<site>/<route>/`.

Resolve the intended Site and inspect its current declarations and Routes
before proposing a change. Read Checkouts through `checkout list|inspect|resolve` so
declared lifecycle/configuration stays separate from fresh Git and index
observation. When several active Routes exist, require an explicit selection.
Explain separately whether the operation changes shared Home state,
personal Desk state or a managed checkout.

Apply only the accepted declaration, adoption, clone, worktree, lifecycle,
migration, Route removal or Site removal effect. The canonical managed root is
`checkouts/<site>/<route>`. Keep Route IDs and Git branches separate.

`checkouts/` is the physical index for every non-embedded Checkout. Existing
repositories stay in place and appear through generated symlinks; managed
checkouts and canonical submodules are direct. `checkout reconcile` is
read-only unless `--apply` is explicit and may only change links recorded in
`.endroit/checkout-index.json`. Refuse unknown paths and report direct, linked,
missing, broken, divergent or conflicting entries.

Parked and superseded Routes remain readable but are never operational or
implicit targets. `activate` may select one parked Route; supersession requires
an active same-Site successor. Refuse removing a successor while another Route
still names it. Read frozen v7 metadata, write v8 only, and use `route migrate
--check` before the metadata-only cutover. Rollback must restore exact Route
bytes without touching Git or index state.

Use `checkout worktree` for a new linked worktree. It never fetches or copies
uncommitted changes: an existing local branch keeps its commit, while a new
branch starts from the selected local ref or the source Route HEAD, and
`--detach` records the resolved commit constraint. Adopt an
external worktree only through explicit `checkout adopt`; never auto-bind
discovered worktrees.

Never remove a dirty, locked or prunable managed checkout, delete a branch,
persist a machine path in settings or invoke Git force, prune, repair or unlock
implicitly. A managed linked worktree must be removed through
`git worktree remove`, never through filesystem deletion. `route remove`
removes only the relationship and generated link; `checkout delete` is the
approved managed-checkout deletion path and never removes a branch. Revalidate
the selected Route before any later Site mutation.
