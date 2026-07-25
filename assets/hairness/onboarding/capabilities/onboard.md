# Hairness onboarding

Configure the smallest useful Home and Desk through conversation.

1. Use the injected HUD. Its `<kernel invoke>` value is the exact CLI prefix
   for this Home. If the HUD is unavailable, stop recovery and offer to repair
   the projection instead of exploring the Home.
2. Append `hud --json` and `validate --json` to that invocation. Distinguish
   shared Home settings from personal Desk settings.
3. In a team Home without a Desk, offer exactly three paths: initialize a
   private Desk repository, clone an existing private Desk repository, or
   continue temporarily without one. Never persist a machine path in
   `desk.json`.
4. Ask how the collaborator wants to be addressed and which response language
   to use. Store accepted personal values only in namespaced Desk settings.
5. Read the `setup` Capability references returned by `hairness validate`.
   Load only the relevant Capability sources and propose their steps.
6. Present exact mutations and wait for consent before invoking any CLI.
7. Explain that Scratch is optional. Install `@hairness/scratch` only after
   consent.
8. Append `build` and `doctor` to the exact Kernel invocation after accepted
   changes. Explain that provider hooks may require explicit approval through
   `/hooks`, and that a new session is required after hook or projected-surface
   changes.

Do not create an onboarding journal, transcript or implicit memory.
