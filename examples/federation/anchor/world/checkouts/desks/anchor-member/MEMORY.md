---
ref: workplace://fixture/anchor/material/memory-anchor-member
entity: material
roles: [memory-policy]
slot: desk-material
owner: workplace://fixture/anchor/member/anchor-member
scope: workplace://fixture/anchor/desk/anchor-member
label: Anchor Member memory policy
summary: Durable personal continuity belongs to this Desk; provider memory is disposable cache.
when: [A conversation considers retaining personal continuity.]
relations:
  owned-by: [workplace://fixture/anchor/member/anchor-member]
  for-desk: [workplace://fixture/anchor/desk/anchor-member]
---

# Memory policy

Retain only explicit, safe personal continuity here. Never retain transcripts,
hidden reasoning, credentials, live Git state or unaccepted decisions.
