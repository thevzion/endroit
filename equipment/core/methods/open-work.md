## Static procedure

1. Classify this method as `integration`; Coordination Policy and Manager contract are RequiredReads.
2. Resolve existing Work and Site declarations. Ambiguous owner, visibility, Root or destination means one question and zero writes.
3. Require local Meeting presence, Manager and Worker Occupants, and complete dispatch envelopes inheriting the Meeting Ref. Missing subagents or proof is blocked. Main cannot write the Site or inline integration.
4. Manager loads the exact Work and Site Source Contracts linked below, substitutes only their declared variables, and creates or updates those declarations in the Work owner's Root. Product bytes remain in SiteRoot.
5. Commit planning before Site bytes:

       open-work(work:<work-id>): declare bounded Work and Site route

       Meeting: <resolved-meeting-ref>
       Authority: human-invoked
       Work: <resolved-work-ref>

6. Worker mutates and verifies only its Site scope without committing. Manager integrates one Site effect:

       open-work(site:<site-id>): implement <observed-effect>

       Meeting: <resolved-meeting-ref>
       Authority: human-invoked
       Work: <resolved-work-ref>
       Plan-Revision: <workplace-root-ref>@<exact-planning-oid>
7. Record exact Site and verification OIDs in Work, then commit `open-work(work:<work-id>): record verified Outcome candidate`.
8. Recompile and commit portable projections separately with `Authority: projection` and exact `Build`.

A delegated Worker returns changed paths and proof without committing; Manager integrates under the declared Mandate.

No-op, stale, blocked or foreign-path effects produce no commit. Acceptance, remote creation, hosting, publication and delivery remain separate human effects.
