---
ref: workplace://demo/rich-studio/room/lab
entity: place
roles:
  - room
slot: rooms
owner: workplace://demo/rich-studio/member/alexis
scope: workplace://demo/rich-studio
summary: Qualify evidence and retain explicit results.
when:
  - The intent needs a bounded Study.
relations:
  contains:
    - workplace://demo/rich-studio/work/choice
    - workplace://demo/rich-studio/meeting/choice-review
    - workplace://demo/rich-studio/material/old-observation
    - workplace://demo/rich-studio/material/candidate-decision
  routes-to:
    - workplace://demo/rich-studio/site/lab-product
---

# Lab Room

The Noticeboard and Workbench remain projections; this Room source owns neither.
