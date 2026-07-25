# Orient in the Home

Start with the generated Floor Plan. It contains the stable Home layout, the
tracked Console and every declared route. When live evidence matters, run:

    node ./hairness.mjs hud prompt

Use `hud json` for stable data or `hud show --full` for the complete human
inventory.

Treat HUD evidence as a local snapshot. Refresh once when relevant state may
have changed, then revalidate a Target immediately before mutating it.
