---
ref: workplace://demo/rich-studio/material/candidate-decision
entity: material
roles:
  - decision
slot: room-material
owner: workplace://demo/rich-studio/member/alexis
scope: workplace://demo/rich-studio/room/lab
summary: A candidate Decision that remains unaccepted.
when:
  - A human reviews the Study result.
status: candidate
claimMaturity: proposal
relations:
  contained-by:
    - workplace://demo/rich-studio/room/lab
  supports:
    - workplace://demo/rich-studio/work/choice
---

# Candidate Decision

This fixture does not infer acceptance from presence, status or machine success.
