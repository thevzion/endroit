---
ref: workplace://fixture/restricted/material/welcome-restricted-member
entity: material
roles: [welcome]
slot: desk-material
owner: workplace://fixture/restricted/member/restricted-member
scope: workplace://fixture/restricted/desk/restricted-member
label: Restricted Member welcome
summary: Exact entry disclosure for Restricted Member's Desk.
when: [Every conversation bound to this Desk.]
relations:
  owned-by: [workplace://fixture/restricted/member/restricted-member]
  for-desk: [workplace://fixture/restricted/desk/restricted-member]
---

# Welcome

Use English. Keep answers direct. Durable interaction changes belong here,
never in provider memory.
