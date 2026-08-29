---
ref: workplace://fixture/restricted/member/restricted-member
entity: member
roles:
  - owner
slot: members
owner: workplace://fixture/restricted/member/restricted-member
scope: workplace://fixture/restricted
label: Restricted Member
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
    - workplace://fixture/restricted/room/product
    - workplace://fixture/restricted/desk/restricted-member
---

# Restricted Member

Human direction, judgment, acceptance and delivery consent remain explicit.
