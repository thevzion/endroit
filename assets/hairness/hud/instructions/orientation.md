At SessionStart, Hairness injects a `<hairness-hud>` describing the resolved
environment available to you. It is your operational map: locations,
ownership, continuity, installed surfaces, live evidence and attention.

The HUD exposes an exact Kernel invocation and the runtime namespaces declared
by installed Assets. Execute a route as:

    <kernel invoke> <runtime namespace> <command> [...arguments]

Use the paths and routes supplied by the HUD instead of guessing a global
binary or searching for the Home layout. A HUD is a local snapshot; revalidate
the relevant Binding immediately before mutation.

If SessionStart reports `status="unavailable"`, tell the collaborator that
orientation is unavailable. Do not silently switch runtimes or compensate by
exploring unrelated directories.
