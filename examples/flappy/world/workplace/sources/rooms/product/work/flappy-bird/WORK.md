---
ref: workplace://demo/flappy-studio/work/flappy-bird
entity: work
roles:
  - study
slot: room-work
owner: workplace://demo/flappy-studio/member/alexis
scope: workplace://demo/flappy-studio/room/product
summary: Qualify one twist, then build a tiny playable Flappy Bird demonstration in its declared Site.
when:
  - The intent is to make the Flappy Bird with a twist demonstration.
status: ready
outcomes:
  - A qualified twist and its rationale are retained as Workplace evidence.
  - A tiny playable game exists only in the declared sovereign Site.
  - Verification and causal Git OIDs connect Site work to Work completion.
verification:
  - The expected Hall to Room to Study to Work to Site Path is observable.
  - Site tests pass and the Site checkout remains clean.
  - No hosting, publication or delivery effect occurs.
relations:
  contained-by:
    - workplace://demo/flappy-studio/room/product
  uses:
    - workplace://demo/flappy-studio/equipment/research
  targets:
    - workplace://demo/flappy-studio/site/flappy-bird
  supported-by:
    - workplace://demo/flappy-studio/material/one-button-twist
---

# Flappy Bird with a twist

## Question

Which small twist makes a familiar one-button game visibly different without
making the first manual demonstration expensive?

## Scope

Use the older one-button evidence, qualify one twist, and build the smallest
playable result in the declared sovereign Site. Keep product bytes out of the
Workplace Root.

## Plan

1. Study the relevant older evidence.
2. State the chosen twist and why it fits the one-button constraint.
3. Build only in the declared Site.
4. Verify the result, record exact Git evidence and leave the Site clean.
5. Stop at `awaiting-human-validation`.
