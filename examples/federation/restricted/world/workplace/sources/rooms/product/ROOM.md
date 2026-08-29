---
ref: workplace://fixture/restricted/room/product
entity: place
roles:
  - room
slot: rooms
owner: workplace://fixture/restricted/member/restricted-member
scope: workplace://fixture/restricted
summary: Own one tiny product Work.
when:
  - The intent concerns the demo Work.
relations:
  contains:
    - workplace://fixture/restricted/work/demo
    - workplace://fixture/restricted/meeting/demo-build
  routes-to:
    - workplace://fixture/restricted/site/demo
---

# Product Room

This Room contains one Work and links one sovereign Site.
