# Manage Targets

A Target is an independent repository known by stable identity. Its declaration
is shared in Home settings. Each collaborator owns zero or more named Bindings
under `.desk/targets/<target>/<binding>`.

Resolve the intended Target and inspect its current declarations and Bindings
before proposing a change. When several Bindings exist, require an explicit
selection. Explain separately whether the operation changes shared Home state,
personal Desk state or a managed checkout.

Apply only the accepted declaration, bind, clone, worktree, unbind or removal
effect. The canonical managed root is
`.desk/targets/<target>/<binding>`. Keep Binding IDs and Git branches separate.

Use `target worktree` for a new linked worktree. It never fetches or copies
uncommitted changes: an existing local branch keeps its commit, while a new
branch starts from the selected local ref or the source Binding HEAD. Adopt an
external worktree only through an explicit `target bind`; never auto-bind
discovered worktrees.

Never remove a dirty, locked or prunable managed checkout, delete a branch,
persist a machine path in settings or invoke Git force, prune, repair or unlock
implicitly. A managed linked worktree must be removed through
`git worktree remove`, never through filesystem deletion. Revalidate the
selected Binding before any later Target mutation.
