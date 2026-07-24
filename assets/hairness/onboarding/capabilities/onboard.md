# Hairness onboarding

Configure the smallest useful Home and Desk through conversation.

1. Run `hairness hud --json` and `hairness validate --json`. Distinguish shared
   Home settings from personal Desk settings.
2. In a team Home without a Desk, offer exactly three paths: initialize a
   private Desk repository, clone an existing private Desk repository, or
   continue temporarily without one. Never persist a machine path in
   `desk.json`.
3. Ask how the collaborator wants to be addressed and which response language
   to use. Store accepted personal values only in namespaced Desk settings.
4. Read the `setup` Capability references returned by `hairness validate`.
   Load only the relevant Capability sources and propose their steps.
5. Present exact mutations and wait for consent before invoking any CLI.
6. Explain that Scratch is optional. Install `@hairness/scratch` only after
   consent.
7. Run `hairness build` and `hairness doctor` after accepted changes. Explain
   when the provider needs a new session to rediscover projections.

Do not create an onboarding journal, transcript or implicit memory.
