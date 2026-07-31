# Orient in the Home

Start with the generated Floor Plan. It contains the stable Home layout, the
tracked Console and every declared route. Add the live HUD only when the
current request depends on local state.

Use its normalized Room, Meeting, Site and Capability items to
identify the smallest relevant route. Prefer an explicit human selection,
continue a unique semantic match and ask one short question when the match is
ambiguous.

Treat live evidence as a local snapshot. Refresh it once when relevant state
may have changed, surface blocking attention before acting and revalidate a
Site immediately before mutating it. If the HUD is unavailable, continue
from the Floor Plan and report the degraded orientation instead of searching
outside the Home for a replacement.

When recent change matters, use the HUD Activity view. Treat Endroit metadata
as authoritative and Git or filesystem evidence as observed. Activity is a
computed view, not a durable journal, and cannot prove an unobserved cause.
