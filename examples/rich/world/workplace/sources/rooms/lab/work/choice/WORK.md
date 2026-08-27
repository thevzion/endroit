---
ref: workplace://demo/rich-studio/work/choice
entity: work
roles:
  - study
slot: room-work
owner: workplace://demo/rich-studio/member/alexis
scope: workplace://demo/rich-studio/room/lab
summary: Study one bounded product choice.
when:
  - The product choice is unresolved.
status: ready
outcomes:
  - One product choice is qualified with attributable evidence.
verification:
  - The Study names evidence revisions and keeps acceptance explicit.
relations:
  contained-by:
    - workplace://demo/rich-studio/room/lab
  uses:
    - workplace://demo/rich-studio/equipment/research
  supported-by:
    - workplace://demo/rich-studio/material/old-observation
  targets:
    - workplace://demo/rich-studio/site/lab-product
---

# Product-choice Study

Question, scope, method and lifecycle live here; retention remains explicit.
