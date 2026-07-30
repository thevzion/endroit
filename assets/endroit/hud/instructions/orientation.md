The generated Floor Plan is the static, authoritative entrypoint to this Home.
The optional Wake-up adds a live HUD: locations, continuity, installed
surfaces, local evidence and attention.

Use the tracked Home Console shown in the Floor Plan for every route:

    node ./endroit.mjs <runtime namespace> <command> [...arguments]

Use `hud show` for a human view, `hud prompt` for the agent-facing view and
`hud json` for tools. A HUD is a local snapshot; revalidate the relevant
Binding immediately before mutation.

If Wake-up is absent or degraded, keep operating from the Floor Plan. Report
that live orientation is unavailable; do not guess another runtime or explore
outside the Home to compensate.
