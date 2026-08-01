# Configure Sites

Inspect the current HUD and ask which repositories matter to this Home. Propose
the smallest useful set, separating shared Site declarations from personal
Routes and explaining which scope owns each change.

Discover repositories only inside a human-approved search root. Present the
exact declarations and Routes before requesting consent, never persist a
machine path in Home or Desk JSON and leave rejected discoveries untouched.

Offer three checkout choices:

1. **Use existing checkout** — recommended when a matching repository is
   already available; record its path in a Desk-owned Route without moving it.
2. **Create managed checkout** — clone it physically below
   `checkouts/<site>/<route>`.
3. **Mount existing checkout** — preserve it in place and explicitly create a
   rebuildable symlink at `checkouts/<site>/<route>`.

Do not move an existing repository during onboarding. Linked worktrees are a
later explicit Site management operation.

Confirm the resulting Route is usable, then offer a Site Map as a separate
next outcome rather than creating one implicitly.
