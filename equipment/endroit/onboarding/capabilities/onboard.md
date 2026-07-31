# Endroit onboarding

Configure the smallest useful Home and Desk through conversation.

1. Explain the authority boundary: the Home owns shared rules and Rooms,
   the Desk owns personal Rooms, Sites own product sources and external
   systems are projections linked by Handles.
2. Use the generated Floor Plan and its tracked `node ./endroit.mjs` Console.
   The Home remains operable when Wake-up is absent or degraded.
3. Run `node ./endroit.mjs validate --json`. If the configured `hud` namespace
   is available, `node ./endroit.mjs hud json` may add live local evidence.
   Distinguish shared Home settings from personal Desk settings.
4. In a team Home without a Desk, offer exactly three paths: initialize a
   private Desk repository, clone an existing private Desk repository, or
   continue temporarily without one. Never persist a machine path in
   `desk.json`.
5. Ask how the collaborator wants to be addressed and which response language
   to use. Store accepted personal values only in namespaced Desk settings.
6. Read the `setup` Capability references returned by `validate --json`.
   Load only the relevant Capability sources and propose their steps.
7. Use `node ./endroit.mjs equipment catalog` to explain uninstalled native Equipment
   by use. Research, Planning, Publishing and Scratch are optional; install
   only those matching an expressed intention and only after consent.
8. Create the first personal Room only at the first durable milestone.
   Do not bootstrap a global Inbox or a catch-all `personal` Room.
9. Present exact mutations and wait for consent before invoking any CLI.
10. Run `node ./endroit.mjs build` and `node ./endroit.mjs doctor` after
   accepted changes. Explain that provider hooks may require explicit approval
   through `/hooks`, and that a new session is required after Front Door or
   projected-surface changes.

Do not create an onboarding journal, transcript or implicit memory.
