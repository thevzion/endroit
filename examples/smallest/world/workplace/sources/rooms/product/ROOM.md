---
ref: workplace://demo/smallest/room/product
entity: place
roles:
  - room
slot: rooms
owner: workplace://demo/smallest/member/alexis
scope: workplace://demo/smallest
summary: Own one tiny product Work.
when:
  - The intent concerns the demo Work.
relations:
  contains:
    - workplace://demo/smallest/work/demo
    - workplace://demo/smallest/meeting/demo-build
  routes-to:
    - workplace://demo/smallest/site/demo
---

# Product Room

This Room contains one Work and links one sovereign Site.
