# Material lifecycle

The current Meeting and its candidate results are ephemeral by default. At a
meaningful boundary, state that nothing has been persisted, name the candidate
and offer only relevant transitions, including leaving it ephemeral.

Resolve an explicitly authorized transition exactly:

- `retain-this` creates safe, inspectable Material in its owning Room and adds
  one relative link under `Active retained Material` in `ROOM.md`;
- `accept-this` updates `Current truth` after explicit human acceptance without
  confusing supporting Material with the accepted decision;
- `deliver-this` acts only through one named, locally available Route
  revalidated immediately before mutation and does not update Room truth;
- `archive-this` moves inactive retained or accepted Material into the matching
  archive scope and removes its active link from `ROOM.md`.

These states are distinct. Never infer acceptance from retention, delivery
from acceptance, or archive/delete/move/push from ordinary conversation. HACP
controls apply only when explicitly invoked and do not replace Endroit
ownership or lifecycle transitions.

Never create a candidate-notes section or file. `Active retained Material`
contains only relative links to active retained Material.
