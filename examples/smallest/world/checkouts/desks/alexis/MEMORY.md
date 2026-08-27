---
ref: workplace://demo/smallest/material/memory-alexis
entity: material
roles: [memory-policy]
slot: desk-material
owner: workplace://demo/smallest/member/alexis
scope: workplace://demo/smallest/desk/alexis
label: Alexis memory policy
summary: Durable personal continuity belongs to this Desk; provider memory is disposable cache.
when: [A conversation considers retaining personal continuity.]
relations:
  owned-by: [workplace://demo/smallest/member/alexis]
  for-desk: [workplace://demo/smallest/desk/alexis]
---

# Memory policy

Retain only explicit, safe personal continuity here. Never retain transcripts,
hidden reasoning, credentials, live Git state or unaccepted decisions.
