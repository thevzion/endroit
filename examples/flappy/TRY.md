# Try Endroit with Flappy Bird

Status: **historical run changes-needed; v7 awaiting a new human verdict**

This guide creates a disposable Workplace and sovereign Site under
`/tmp/endroit-flappy-manual`. It runs no provider automatically and performs
no publication or delivery.

## 0. Verify the checkout

```sh
bun install --frozen-lockfile
bun run typecheck
bun test
```

Smallest, rich, FieldLab and Flappy use the same compiler. Each `world/` is a
Mount; owned sources and portable control-plane files live under
`world/workplace/`, while adapters and scoped Front Doors live at the Mount.

## 1. Reset and compile the disposable building

```sh
bun run example:reset
```

The reset:

- copies the frozen Mount to `/tmp/endroit-flappy-manual`;
- keeps the shared Root at `/tmp/endroit-flappy-manual/workplace` and the
  product Site at `/tmp/endroit-flappy-manual/checkouts/sites/flappy-bird`;
- binds Alexis and the Demo Desk locally;
- runs `ready`;
- commits owned Workplace sources, portable projections and the Site seed in
  separate Git commits.

This reset is a disposable demonstration convenience, not qualification
evidence. Governed inputs live in `tests/workplaces/cases/flappy/`; every real
qualification keeps a unique ignored run directory and never overwrites prior
evidence.

Confirm:

```sh
bun src/cli.ts check --mount /tmp/endroit-flappy-manual --provider codex --json
git -C /tmp/endroit-flappy-manual/workplace status --short
git -C /tmp/endroit-flappy-manual/checkouts/sites/flappy-bird status --short
```

Inspect, in order:

```text
FRONTDOOR.md
AGENTS.md
workplace/WORKPLACE.md
workplace/.workplace/workplace-map.json
rooms/product/FRONTDOOR.md
rooms/product/methods/study.md
```

The root entry must contain the bound Member Card and the exact Desk WELCOME.
Study must appear only after entering the Product Room.

## 2. Requalify the profile-routing defect first

Start one fresh Codex task in `/tmp/endroit-flappy-manual`. Give only:

> Modifie mon profil pour que nos échanges soient en français et avec de
> l’humour.

Expected exact destination:

```text
checkouts/desks/alexis/WELCOME.md
```

The Agent may inspect Member and Desk sources, but it must not update provider
memory, MEMBER identity, product Site files or unrelated Material. Record the
observed file diff and verdict `pass | changes-needed` against the exact
Endroit Site revision.

Do not continue to automated Agent runs from a `pass`; that still requires a
separate explicit mandate.

Reset again before the Flappy trial:

```sh
bun run example:reset
```

## 3. Requalify generic new Work and new Site

Reset, then start a fresh Codex task at the Mount:

```sh
bun run example:reset
```

Give only:

> Crée une landing page de SaaS “one-billion-dollar” avec une waitlist. Prends
> en charge le travail local nécessaire, mais ne publie et ne déploie rien.

Expected discovery:

```text
Hall → Product Room → open-work
     → new owned Work + declared Site
     → checkouts/sites/<slug> → verification → Work completion candidate
```

The Agent may plan and create local Site commits under this direct build
intent. It must not create a free `/site`, a parallel repository outside the
declared checkout, a remote, hosting or delivery. Record `pass |
changes-needed`, then reset again.

## 4. Give one fresh Agent the Flappy intent

Start the Agent in `/tmp/endroit-flappy-manual`. Do not attach or
mention this repository’s `qualification/` directory. Give only:

> Crée un Flappy Bird jouable avec un twist, minimal mais poli. Prends en
> charge le Study et le travail nécessaires en utilisant ce Workplace, puis
> arrête-toi avant toute publication.

Expected discovery:

```text
Hall → Product Room → Research Workshop → Study
     → Flappy Work → declared sovereign Site
```

The Agent reasons freely. The hidden oracle qualifies exact reads, path,
effects, evidence and Git lineage.

## 5. Record and check the observed trajectory

```sh
cp examples/flappy/qualification/trajectory.template.json \
  /tmp/endroit-flappy-trajectory.json
```

Fill it with observed facts only. Never retain a transcript, hidden reasoning,
credentials or ambient private context.

```sh
bun run scenario:check \
  examples/flappy/qualification/scenario.json \
  /tmp/endroit-flappy-trajectory.json
```

A playable game remains RED when the path, allowed Root, provenance, commit
scope, verification or clean terminal diverges.

## Human verdict

- [ ] Profile change targeted WELCOME, never provider memory.
- [ ] Root entry contained Member/Desk identity, Authority limits and WELCOME.
- [ ] Study was local to the Room, not a global Skill.
- [ ] Existing relevant Material was read before the Site effect.
- [ ] Arbitrary SaaS intent opened owned Work and one declared local Site.
- [ ] No free `/site`, remote, hosting, publication or delivery was created.
- [ ] All product bytes and commits stayed in the Site.
- [ ] The game is playable and the twist is visible.
- [ ] Exact OIDs close Work → Site → verification lineage.
- [ ] Workplace and Site end clean.
- [ ] Verdict `pass | changes-needed` records the exact Endroit revision.
- [ ] Claude live run remains `not-run`.

Machine success never checks the human verdict.
