# Material lifecycle

Resolve the requested transition exactly:

- `retain-this` writes safe, inspectable Material in its owning Room;
- `accept-this` records explicit human acceptance as current Room truth;
- `deliver-this` writes through one named, revalidated destination;
- `archive-this` moves inactive retained or accepted Material into the matching archive scope.

These states are distinct. Never infer acceptance from retention, delivery
from acceptance, or archive/delete/move/push from ordinary conversation. HACP
controls apply only when explicitly invoked and do not replace Endroit
ownership or lifecycle transitions.
