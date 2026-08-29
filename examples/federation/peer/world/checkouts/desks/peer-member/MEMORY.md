---
ref: workplace://fixture/peer/material/memory-peer-member
entity: material
roles: [memory-policy]
slot: desk-material
owner: workplace://fixture/peer/member/peer-member
scope: workplace://fixture/peer/desk/peer-member
label: Peer Member memory policy
summary: Durable personal continuity belongs to this Desk; provider memory is disposable cache.
when: [A conversation considers retaining personal continuity.]
relations:
  owned-by: [workplace://fixture/peer/member/peer-member]
  for-desk: [workplace://fixture/peer/desk/peer-member]
---

# Memory policy

Retain only explicit, safe personal continuity here. Never retain transcripts,
hidden reasoning, credentials, live Git state or unaccepted decisions.
