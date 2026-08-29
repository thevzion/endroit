---
ref: workplace://fixture/restricted/work/demo
entity: work
roles:
  - initiative
slot: room-work
owner: workplace://fixture/restricted/member/restricted-member
scope: workplace://fixture/restricted/room/product
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
    - workplace://fixture/restricted/room/product
  targets:
    - workplace://fixture/restricted/site/demo
---

# Demo Work

Produce only the declared outcome in the declared Site.
