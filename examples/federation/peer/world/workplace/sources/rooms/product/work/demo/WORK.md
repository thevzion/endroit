---
ref: workplace://fixture/peer/work/demo
entity: work
roles:
  - initiative
slot: room-work
owner: workplace://fixture/peer/member/peer-member
scope: workplace://fixture/peer/room/product
summary: Produce one bounded demo outcome.
when:
  - The demo outcome is requested.
status: ready
outcomes:
  - A bounded demo exists in the declared Site.
verification:
  - Site checks pass and the Site remains clean.
relations:
  contained-by:
    - workplace://fixture/peer/room/product
  targets:
    - workplace://fixture/peer/site/demo
---

# Demo Work

Produce only the declared outcome in the declared Site.
