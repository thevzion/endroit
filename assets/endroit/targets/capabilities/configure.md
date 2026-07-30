# Configure Targets

Inspect the current HUD and ask which repositories matter to this Home. Propose
the smallest useful set, separating shared Target declarations from personal
Bindings and explaining which scope owns each change.

Discover repositories only inside a human-approved search root. Present the
exact declarations and Bindings before requesting consent, never persist a
machine path in Home or Desk JSON and leave rejected discoveries untouched.

Offer two checkout choices:

1. **Use existing checkout** — recommended when a matching repository is
   already available; bind it by symlink without moving it.
2. **Create managed checkout** — clone it physically below
   `.desk/targets/<target>/<binding>`.

Do not move an existing repository during onboarding. Linked worktrees are a
later explicit Target management operation.

Confirm the resulting Binding is usable, then offer a Target Map as a separate
next outcome rather than creating one implicitly.
