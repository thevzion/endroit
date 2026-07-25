# Hairness onboarding

Configure the smallest useful Home and Desk through conversation.

1. Use the generated Floor Plan and its tracked `node ./hairness.mjs` Console.
   The Home remains operable when Wake-up is absent or degraded.
2. Run `node ./hairness.mjs validate --json`. If the configured `hud` namespace
   is available, `node ./hairness.mjs hud json` may add live local evidence.
   Distinguish shared Home settings from personal Desk settings.
3. In a team Home without a Desk, offer exactly three paths: initialize a
   private Desk repository, clone an existing private Desk repository, or
   continue temporarily without one. Never persist a machine path in
   `desk.json`.
4. Ask how the collaborator wants to be addressed and which response language
   to use. Store accepted personal values only in namespaced Desk settings.
5. Read the `setup` Capability references returned by `validate --json`.
   Load only the relevant Capability sources and propose their steps.
6. Present exact mutations and wait for consent before invoking any CLI.
7. Explain that Scratch is optional. Install `@hairness/scratch` only after
   consent.
8. Run `node ./hairness.mjs build` and `node ./hairness.mjs doctor` after
   accepted changes. Explain that provider hooks may require explicit approval
   through `/hooks`, and that a new session is required after Front Door or
   projected-surface changes.

Do not create an onboarding journal, transcript or implicit memory.
