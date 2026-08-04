# Route Room work

Resolve one semantic owner before persisting durable work.

- A shared Room under `rooms/<id>/` belongs to the Workplace boundary.
- A Desk Room under `.desk/rooms/<id>/` is personal to the current
  collaborator.
- Use the explicit Room named by the human, otherwise continue the single
  semantic match. Ask when two remain plausible.
- Create a Room only at the first meaningful durable milestone. Do not
  create a generic personal catch-all.
- Nest a Room directly below its parent when the subject needs its own mission,
  continuity and decisions. Its slash-separated path is its stable Room ID.
- Read `ROOM.md`, then the active `MEETING.md`, then only linked
  documents needed by the current task.

Use the tracked Workplace Console. The compatibility token `--scope home`
selects shared Workplace Rooms; `--scope desk` selects personal Rooms. The two
scopes never mirror or synchronize one another.
