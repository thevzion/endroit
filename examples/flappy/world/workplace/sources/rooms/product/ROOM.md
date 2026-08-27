---
ref: workplace://demo/flappy-studio/room/product
entity: place
roles:
  - room
slot: rooms
owner: workplace://demo/flappy-studio/member/alexis
scope: workplace://demo/flappy-studio
summary: Qualify and build small product demonstrations.
when:
  - The intent concerns a product experiment or its evidence.
relations:
  contains:
    - workplace://demo/flappy-studio/work/flappy-bird
    - workplace://demo/flappy-studio/meeting/flappy-qualification
  routes-to:
    - workplace://demo/flappy-studio/site/flappy-bird
  supported-by:
    - workplace://demo/flappy-studio/material/one-button-twist
---

# Product Room

Enter here for product experiments. Discover a local method only after the
intent and Work make it applicable.

## Local destinations

- [Flappy Bird with a twist](work/flappy-bird/WORK.md)
- [Declared Flappy Bird Site](../../sites/flappy-bird/SITE.md)
- [Older one-button evidence](material/one-button-twist.md)
