---
ref: workplace://demo/smallest/work/demo
entity: work
roles:
  - initiative
slot: room-work
owner: workplace://demo/smallest/member/alexis
scope: workplace://demo/smallest/room/product
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
    - workplace://demo/smallest/room/product
  targets:
    - workplace://demo/smallest/site/demo
---

# Demo Work

Produce only the declared outcome in the declared Site.
