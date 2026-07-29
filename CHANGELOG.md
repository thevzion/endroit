# Changelog

## 0.5.0-alpha.2

- Preserve optional emoji metadata for Homes, Workspaces, Workstreams and
  Targets through the normalized HUD.
- Expand Asset Skill and Command accessors over resolved Workspaces,
  Workstreams or Targets with `forEach`.
- Bind each generated provider alias to its exact Home reference without
  duplicating Capability sources.

## 0.5.0-alpha.1

- Give Hairness a product-focused README and link the framework to its website
  and the independent Home-first proposal.
- Publish the CLI under npm's `latest` tag so the documented bootstrap command
  resolves to the qualified release.

## 0.5.0-alpha.0

- Rebuild Hairness as a Home-first microkernel with one CLI package.
- Move HUD, Artifacts and Targets behavior into inspectable first-party Assets.
- Introduce portable solo and team Desks.
- Preserve Skills and Commands as distinct access paths to Capabilities.
- Add deterministic Resolved Home composition and context footprints.
- Add digest-bound runtime trust and transparent stdio dispatch.
- Add source-owned Asset validation, override and guarded publication.
- Add typed Artifact creation, import, validation, publication and lineage.
- Add named Target Bindings and evidence-backed Target Map Artifacts.
- Add a fail-closed, provider-neutral Front Door.
- Add a repository-owned, rollback-safe Development Home recipe and Project
  plan Artifact.
- Add canonical `HOME.md` and `DESK.md` instruction sources with one-shot
  templates and fully owned provider projections.
- Introduce the Front Door and Progressive Orientation: a static Floor Plan,
  one optional Home-selected Wake-up route, generic provider Bridges and the
  tracked `hairness.mjs` Home Console.
- Separate Kernel provenance (`npm|development`) from Asset runtime trust
  (`bundled|approved|pending`).
- Move the HUD prompt budget into `settings["hairness/hud"].promptBytes`.
- Expand the HUD into an optional operational Wake-up with exact paths,
  invocation, surfaces, local evidence and severity-separated attention.
- Replace HUD flags with explicit `hud show|prompt|json` routes.
- Add standalone `asset validate <source>`, offline status digests and detailed
  `asset sync --check`.

## 0.4.0-alpha.1

- Keep GitHub Asset staging alive until every declared source file has been read.

## 0.4.0-alpha.0

- Introduce source-owned Assets and provider-independent Homes.
