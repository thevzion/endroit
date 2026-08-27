## Static procedure

1. Inspect `workplace/.workplace/workplace-map.json`; follow one matching Room instead of creating a duplicate.
2. If no Room matches and the subject needs independent continuity, expose the proposed id, owner and purpose before writing.
3. Resolve the provider Session to an explicit or unique active Meeting. With none, create local ephemeral presence; with several, ask once and write nothing.
4. Load the exact Room and Meeting Source Contracts linked below, substitute only their declared variables, and materialize `workplace/sources/rooms/<room-id>/ROOM.md` with its first `meetings/<meeting-id>/MEETING.md` as one establishment effect.
5. Substitute every placeholder below before commit. Literal angle-bracket tokens are invalid. Commit the source effect with a concrete Meeting Ref:

       open-room(place:<room-id>): declare owned Room

       Meeting: <resolved-meeting-ref>
       Authority: human-invoked

   Delegated integration uses `Authority: delegated` plus a fully qualified `Mandate`; a Worker never commits.
6. Run the bound `workplace.compile` command. If unavailable, report `degraded` with that exact command.
7. Commit portable projections separately with `Authority: projection` and `Build: <exact-room-and-meeting-source-oid>`.
8. Follow the new Room Front Door. Only there may `open-work` become visible.

No-op, stale, blocked or foreign-path effects produce no commit. This Operation creates no Work, Site, remote, hosting or delivery.
