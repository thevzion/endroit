# Route Workspace work

Resolve one semantic owner before persisting durable work.

- A Home Workspace under `workspaces/<id>/` is shared with the inhabitants of
  the Home.
- A Desk Workspace under `.desk/workspaces/<id>/` is personal to the current
  collaborator.
- Use the explicit Workspace named by the human, otherwise continue the single
  semantic match. Ask when two remain plausible.
- Create a Workspace only at the first meaningful durable milestone. Do not
  create a generic personal catch-all.
- Read `workspace.md`, then the active `workstream.md`, then only linked
  documents needed by the current task.

Use the tracked Home Console and pass `--scope home` or `--scope desk`
explicitly. A Home and Desk never mirror or synchronize one another.
