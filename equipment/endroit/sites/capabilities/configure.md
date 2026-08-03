# Configure Sites

Inspect the current HUD and ask which repositories matter to this Home. Propose
the smallest useful set, separating shared Site declarations from personal
Routes and explaining which scope owns each change.

Discover repositories only inside a human-approved search root. Present the
exact declarations and Routes before requesting consent, persist machine paths
only in Desk-owned Routes and leave rejected discoveries untouched.

Offer three checkout choices:

1. **Use existing checkout** — recommended when a matching repository is
   already available; record its path in a Desk-owned Route without moving it.
2. **Create managed checkout** — clone it physically below
   `checkouts/<site>/<route>`.
3. **Pin a submodule** — only when the Home explicitly chooses a Git-owned
   composition; Endroit validates it but never runs submodule add/init/update.

Do not move an existing repository during onboarding. `checkout adopt`
preserves it and `checkout reconcile --apply` creates the conventional index
link. Linked worktrees remain an explicit Checkout operation.

Confirm the resulting Route is usable, then offer a Site Map as a separate
next outcome rather than creating one implicitly.
