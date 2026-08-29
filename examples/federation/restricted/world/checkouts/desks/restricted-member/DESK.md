---
ref: workplace://fixture/restricted/desk/restricted-member
entity: place
roles: [desk]
slot: desks
owner: workplace://fixture/restricted/member/restricted-member
scope: workplace://fixture/restricted
label: Restricted Member Desk
summary: Private Desk identity and index for Restricted Member.
when: [A bound entry must resolve its Desk.]
relations:
  owned-by: [workplace://fixture/restricted/member/restricted-member]
---

# Restricted Member Desk

This source indexes the Desk. Its entry disclosure lives in WELCOME.md.
