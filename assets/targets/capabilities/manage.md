Treat each Target as an independent Git repository that owns its product work.

- Declare repository identity in the shared Home.
- Keep named machine-specific Bindings under `.desk/targets/<target>/<binding>`.
- Use a managed clone or bind an existing checkout; declare a Target without a
  Binding when no local work is needed.
- Verify each Binding by normalized remote identity before using it.
- Inspect branch, worktree state, commit date and remotes as live evidence.
- When several Bindings exist, name the intended one explicitly.
- Never move Target-owned work into the Home merely for convenience.
