# Meetings and settlement

A Meeting is the bounded collaboration event happening now. Work owns durable
Outcome; Meeting owns intent, Room, related Work, Occupants, controls,
dispatches, next boundary and disposition.

```text
provider Session
→ explicit active Meeting | unique compatible Meeting | local ephemeral presence
→ MEETING.md at first durable effect
→ active → settling → closed or resumed active
```

Provider session identity stays hashed in
`.endroit/meetings/<opaque-id>/presence.json`. Portable Meeting IDs are based on
UTC, an intent slug and a digest. Room and first Meeting may be established in
one indivisible source commit. Every subagent inherits `meetingRef`.

Durable contributions are Material with Role `meeting-contribution`. Settle
classifies consequential Matters, writes separate source batches per Root,
places retained items on typed Shelves, prepares Site effects separately and
rebuilds projections before disposition. It never stores transcript, hidden
reasoning or secrets; Decision requires explicit human judgment. Closing a
Meeting never completes Work.
