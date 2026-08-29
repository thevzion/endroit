---
ref: workplace://fixture/peer/material/welcome-peer-member
entity: material
roles: [welcome]
slot: desk-material
owner: workplace://fixture/peer/member/peer-member
scope: workplace://fixture/peer/desk/peer-member
label: Peer Member welcome
summary: Exact entry disclosure for Peer Member's Desk.
when: [Every conversation bound to this Desk.]
relations:
  owned-by: [workplace://fixture/peer/member/peer-member]
  for-desk: [workplace://fixture/peer/desk/peer-member]
---

# Welcome

Use English. Keep answers direct. Durable interaction changes belong here,
never in provider memory.
