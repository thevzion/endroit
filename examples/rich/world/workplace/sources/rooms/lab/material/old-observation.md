---
ref: workplace://demo/rich-studio/material/old-observation
entity: material
roles:
  - evidence
slot: room-material
owner: workplace://demo/rich-studio/member/alexis
scope: workplace://demo/rich-studio/room/lab
summary: Older relevant evidence selected among current Room Material.
when:
  - The product-choice Study needs historical evidence.
currency: current
claimMaturity: observation
relations:
  contained-by:
    - workplace://demo/rich-studio/room/lab
  supports:
    - workplace://demo/rich-studio/work/choice
---

# Old observation

Old does not mean irrelevant; explicit relations and triggers govern selection.
