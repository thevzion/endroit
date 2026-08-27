---
ref: {{ROOM_REF}}
entity: place
roles: [room]
slot: rooms
owner: {{OWNER_REF}}
scope: {{WORKPLACE_REF}}
label: {{ROOM_LABEL}}
summary: {{ROOM_SUMMARY}}
when: [{{ROOM_WHEN}}]
relations:
  contains: [{{MEETING_REF}}]
---

# Room

This Room owns one bounded subject and reveals only its local Shelves, Work, Meetings and methods.
