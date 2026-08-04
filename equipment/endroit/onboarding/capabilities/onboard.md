# Endroit onboarding

Configure or adopt the smallest useful Workplace and Desk through conversation.

1. When no Workplace exists yet, follow the source-owned `ADOPT.md` candidate
   guide when it is available. Do not turn adoption into a new CLI command.
2. In an existing Workplace, start from the ready Wake-up already supplied by the
   provider. Do not fetch it again. When Wake-up is absent or degraded, use the
   generated Floor Plan and its tracked `node ./endroit.mjs` Console.
3. Explain the authority boundary only as needed: the Workplace owns its
   declaration and shared Rooms; the Desk owns personal Rooms and local access;
   Sites own product sources; external systems are projections linked by
   Handles.
4. Only when structured verification is necessary, run
   `node ./endroit.mjs validate --json` at most once. For each
   `setup[].capability`, find the exact matching `capabilities[].id` and open
   only its `path`. Distinguish shared Workplace settings from personal Desk
   settings.
5. Confirm that `DESK.md` owns a reference to a Workplace Member. When
   no Desk exists, offer exactly three paths: initialize a tracked or separate
   Desk, clone an existing Desk repository, or continue temporarily without
   one. Never persist a machine path, credential or agent identity in a Member
   or `desk.json`.
6. Ask how the collaborator wants to be addressed and which response language
   to use. Store accepted personal values only in namespaced Desk settings.
7. Only after the collaborator expresses an intention that may need additional
   Equipment, use `node ./endroit.mjs equipment catalog` and explain matching
   uninstalled native Equipment. Research, Planning, Publishing and Scratch
   remain optional and require consent.
8. For existing repositories, reuse Site Maps and the existing Room, Site and
   Route operations. Prefer a standalone Workplace with Sites and Routes for a
   multi-repository environment; reserve `init` for a repository that should
   also contain the Workplace.
9. Create the first personal Room only at the first durable milestone.
   Do not bootstrap a global Inbox or a catch-all `personal` Room.
10. Present exact mutations and wait for consent before invoking any mutating
   CLI.
11. Run `node ./endroit.mjs build` and `node ./endroit.mjs doctor` after
   accepted changes. Explain that provider hooks may require explicit approval
   through `/hooks`, and that a new session is required after Front Door or
   projected-surface changes. Confirm the result from a fresh session without
   relying on the adoption conversation.

Do not create an onboarding journal, transcript or implicit memory.
