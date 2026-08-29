---
ref: {{WORK_REF}}
entity: work
roles: [initiative]
slot: room-work
owner: {{OWNER_REF}}
scope: {{ROOM_REF}}
summary: {{WORK_SUMMARY}}
when: [{{WORK_WHEN}}]
status: ready
outcomes: [{{WORK_OUTCOME}}]
verification: [{{WORK_VERIFICATION}}]
relations:
  contained-by: [{{ROOM_REF}}]
  targets: [{{SITE_REF}}]
---

# Work

This Work owns one explicit Outcome and its verification contract. It does not imply acceptance or delivery.
