# Release plane

Endroit separates release intent from delivery machinery. A Site owns each
public export in `surfaces/<id>/SURFACE.md`; the Workplace composes logical
exports in `releases/<id>/RELEASE.md`. The source does not record a Route,
checkout path, branch, commit, host command or observed effect.

```text
RELEASE.md -> resolve / preview -> release.lock.json
                                      |
                              external delivery
                                      |
                              release observe
                                      |
                            release.receipt.json
```

## Public Surfaces

A `public-surface` contains exactly one `surface_contract`, one `site_export`
and at least one `content` Fragment. The Site keeps its native renderer,
layout, assets and design tokens. `site_export.qualification` stores argv
arrays, never shell strings; an optional preview command runs in the
foreground.

Create a Surface directly in one revalidated Site Route:

```sh
node ./endroit.mjs artifact create public-surface home \
  --site example.org --route main
```

## Releases

A `release` is owned directly by the Workplace. `release_contract` owns the
decision question; `review_gate` names each required human check;
`release_dogfood` requires a matching passed `dogfood.receipt.json`. Its
ordered `release_site` Fragments name a Site, logical export such as `./` or
`./surfaces/home`, intended `effects`, `expected_handle` and dependencies on
earlier Sites.

```sh
node ./endroit.mjs artifact create release ecosystem-2026-08 --workplace
node ./endroit.mjs release inspect ecosystem-2026-08
node ./endroit.mjs release lock ecosystem-2026-08 --check \
  --route example.org=main
node ./endroit.mjs release lock ecosystem-2026-08 \
  --route example.org=main
node ./endroit.mjs release verify ecosystem-2026-08
```

`inspect` renders a human decision view containing the release question,
review gates, dogfood state, expected effects, handles and blockers. When a
Site has several active Routes, Endroit selects exactly one Route declaring
`purpose=release`; otherwise the caller must pass `--route`.

`lock --check` requires the dogfood receipt, resolves every Route, refuses
dirty or conflicted repositories, validates the declared qualification argv
and reports the deterministic plan without running builds or writing. `lock`
runs the qualifications, re-resolves the evidence and writes it atomically.
`verify` detects source, dogfood, commit, Route or export drift. `watch` polls
those read-only observations and remote branch heads until drift or timeout.
It reports `degraded` instead of `ready` when no generic CI observer is
available; host-specific delivery Equipment owns that evidence.

`preview` runs only a command declared by the Site Surface and forwards the
process in the foreground. Its observed URL is local rebuildable state under
`.endroit/`.

## Observation is not delivery

Endroit never pushes, merges, publishes or deploys a Release. After a separate
authorized system performs an effect, record its observed public handle:

```sh
node ./endroit.mjs release observe ecosystem-2026-08 \
  --site example.org --status observed --handle https://example.org/
```

The first observation creates `release.receipt.json`. Further observations
update only their Site entry and remain bound to the exact lock digest.
