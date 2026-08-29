---
ref: workplace://fixture/anchor/material/welcome-anchor-member
entity: material
roles: [welcome]
slot: desk-material
owner: workplace://fixture/anchor/member/anchor-member
scope: workplace://fixture/anchor/desk/anchor-member
label: Anchor Member welcome
summary: Exact entry disclosure for Anchor Member's Desk.
when: [Every conversation bound to this Desk.]
relations:
  owned-by: [workplace://fixture/anchor/member/anchor-member]
  for-desk: [workplace://fixture/anchor/desk/anchor-member]
---

# Welcome

Use English. Keep answers direct. Durable interaction changes belong here,
never in provider memory.
