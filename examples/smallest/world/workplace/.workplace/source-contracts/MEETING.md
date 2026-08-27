---
ref: {{MEETING_REF}}
entity: meeting
roles: [meeting]
slot: room-meeting
owner: {{OWNER_REF}}
scope: {{ROOM_REF}}
label: {{MEETING_LABEL}}
summary: {{MEETING_SUMMARY}}
when: [{{MEETING_WHEN}}]
intent: {{MEETING_INTENT}}
relatedWorks: []
occupants:
  - id: main
    role: main
controls: [no-delivery]
dispatches: []
nextBoundary: {{NEXT_BOUNDARY}}
lifecycle: active
relations:
  contained-by: [{{ROOM_REF}}]
---

# Meeting

This active Meeting situates the current collaboration. Closing it never completes a Work.
