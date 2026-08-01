# Endroit onboarding

Configure the smallest useful Home and Desk through conversation.

1. Start from the ready Wake-up already supplied by the provider. Do not fetch
   it again. When Wake-up is absent or degraded, use the generated Floor Plan
   and its tracked `node ./endroit.mjs` Console.
2. Explain the authority boundary only as needed: the Home owns Members,
   shared rules and Rooms; the Desk owns personal Rooms and local access;
   Sites own product sources; external systems are projections linked by
   Handles.
3. Only when structured verification is necessary, run
   `node ./endroit.mjs validate --json` at most once. For each
   `setup[].capability`, find the exact matching `capabilities[].id` and open
   only its `path`. Distinguish shared Home settings from personal Desk
   settings.
4. Confirm that `desk.json.member` resolves to a Home-owned human Member. When
   no Desk exists, offer exactly three paths: initialize a tracked or separate
   Desk, clone an existing Desk repository, or continue temporarily without
   one. Never persist a machine path, credential or agent identity in a Member
   or `desk.json`.
5. Ask how the collaborator wants to be addressed and which response language
   to use. Store accepted personal values only in namespaced Desk settings.
6. Only after the collaborator expresses an intention that may need additional
   Equipment, use `node ./endroit.mjs equipment catalog` and explain matching
   uninstalled native Equipment. Research, Planning, Publishing and Scratch
   remain optional and require consent.
7. Create the first personal Room only at the first durable milestone.
   Do not bootstrap a global Inbox or a catch-all `personal` Room.
8. Present exact mutations and wait for consent before invoking any mutating
   CLI.
9. Run `node ./endroit.mjs build` and `node ./endroit.mjs doctor` after
   accepted changes. Explain that provider hooks may require explicit approval
   through `/hooks`, and that a new session is required after Front Door or
   projected-surface changes.

Do not create an onboarding journal, transcript or implicit memory.
