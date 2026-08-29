---
ref: workplace://fixture/peer/room/product
entity: place
roles:
  - room
slot: rooms
owner: workplace://fixture/peer/member/peer-member
scope: workplace://fixture/peer
summary: Own one tiny product Work.
when:
  - The intent concerns the demo Work.
relations:
  contains:
    - workplace://fixture/peer/work/demo
    - workplace://fixture/peer/meeting/demo-build
  routes-to:
    - workplace://fixture/peer/site/demo
---

# Product Room

This Room contains one Work and links one sovereign Site.
