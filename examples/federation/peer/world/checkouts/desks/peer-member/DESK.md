---
ref: workplace://fixture/peer/desk/peer-member
entity: place
roles: [desk]
slot: desks
owner: workplace://fixture/peer/member/peer-member
scope: workplace://fixture/peer
label: Peer Member Desk
summary: Private Desk identity and index for Peer Member.
when: [A bound entry must resolve its Desk.]
relations:
  owned-by: [workplace://fixture/peer/member/peer-member]
---

# Peer Member Desk

This source indexes the Desk. Its entry disclosure lives in WELCOME.md.
