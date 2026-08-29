---
ref: workplace://fixture/restricted/material/memory-restricted-member
entity: material
roles: [memory-policy]
slot: desk-material
owner: workplace://fixture/restricted/member/restricted-member
scope: workplace://fixture/restricted/desk/restricted-member
label: Restricted Member memory policy
summary: Durable personal continuity belongs to this Desk; provider memory is disposable cache.
when: [A conversation considers retaining personal continuity.]
relations:
  owned-by: [workplace://fixture/restricted/member/restricted-member]
  for-desk: [workplace://fixture/restricted/desk/restricted-member]
---

# Memory policy

Retain only explicit, safe personal continuity here. Never retain transcripts,
hidden reasoning, credentials, live Git state or unaccepted decisions.
