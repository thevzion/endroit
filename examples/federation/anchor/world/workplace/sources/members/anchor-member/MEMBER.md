---
ref: workplace://fixture/anchor/member/anchor-member
entity: member
roles:
  - owner
slot: members
owner: workplace://fixture/anchor/member/anchor-member
scope: workplace://fixture/anchor
label: Anchor Member
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
    - workplace://fixture/anchor/room/product
    - workplace://fixture/anchor/desk/anchor-member
---

# Anchor Member

Human direction, judgment, acceptance and delivery consent remain explicit.
