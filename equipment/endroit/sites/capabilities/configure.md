# Configure Sites

Inspect the current HUD and ask which repositories matter to this Workplace.
Separate shared Site declarations from Desk-owned Routes and explain which
scope owns each proposed change.

Use only repositories named explicitly by the human or already reachable from
a declared Site repository. Never scan an arbitrary projects directory.
Present exact declarations and Routes before requesting consent and leave
rejected discoveries untouched.

Offer three Checkout choices:

1. **Use an existing checkout** — create a Route and bind its conventional
   Checkout address without moving it or persisting its host path.
2. **Create a managed checkout** — clone it physically below
   `checkouts/<site>/<route>`.
3. **Use a submodule** — recognize a user-managed Git composition at the same
   address; Endroit never runs submodule add, init or update.

`checkout adopt <site>/<route> <path>` is the only explicit association of an
existing repository. It records the validated target in the Desk-local
Checkout index. A missing generated link is repaired only by explicit
`checkout reconcile`; an unindexed Route remains `unbound`. Linked worktrees
remain an explicit Checkout operation.

Confirm the resulting Route is usable, then offer a Site Map as a separate
outcome rather than creating one implicitly.
