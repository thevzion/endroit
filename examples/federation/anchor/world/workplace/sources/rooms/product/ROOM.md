---
ref: workplace://fixture/anchor/room/product
entity: place
roles:
  - room
slot: rooms
owner: workplace://fixture/anchor/member/anchor-member
scope: workplace://fixture/anchor
summary: Own one tiny product Work.
when:
  - The intent concerns the demo Work.
relations:
  contains:
    - workplace://fixture/anchor/work/demo
    - workplace://fixture/anchor/meeting/demo-build
  routes-to:
    - workplace://fixture/anchor/site/demo
---

# Product Room

This Room contains one Work and links one sovereign Site.
