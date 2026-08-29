---
ref: workplace://fixture/peer/member/peer-member
entity: member
roles:
  - owner
slot: members
owner: workplace://fixture/peer/member/peer-member
scope: workplace://fixture/peer
label: Peer Member
language: en
summary: Human owner of this smallest Instance.
when:
  - Ownership or consent must be resolved.
responsibilities:
  - Own direction, judgment, acceptance and delivery consent.
authorityLimits:
  - Agents never accept or deliver on this Member's behalf.
durableChanges:
  - Interaction defaults belong in the bound Desk WELCOME.
relations:
  owns:
    - workplace://fixture/peer/room/product
    - workplace://fixture/peer/desk/peer-member
---

# Peer Member

Human direction, judgment, acceptance and delivery consent remain explicit.
