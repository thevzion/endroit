# Changelog

## 0.7.0-alpha.0

- Rename Hairness to Endroit: the owned, local-first environment implementing
  the Home-first proposal.
- Replace every public package, binary, config, state, Asset, provider,
  diagnostic and schema contract without runtime compatibility aliases.
- Move the public schema authority to `https://endroit.org/schema/*` and
  provide explicit errors for unsupported schema versions.
- Clarify where Endroit fits alongside interfaces, models, runtimes, harnesses,
  memory, capabilities, methods and independent Targets.

## 0.6.0-alpha.0

- Make Home and Desk Workspaces the canonical owners of durable work, with
  globally unique IDs, required orientation and Inbox documents, sparse
  Workstreams and Decisions, and an explicit Workspace runtime.
- Move new Artifacts under their owning Workspace and Asset namespace, add
  guarded promotion to Home Workspaces or Targets, and retain legacy roots as
  read-only compatibility surfaces.
- Add the instruction-only Research, Planning and Publishing Assets plus
  opt-in Scratch, with shared document envelopes and explicit source lineage.
- Add Publication sources and external Handles without treating publication
  state as confirmed before an observable result exists.
- Add a local first-party Asset catalogue and `workspaceNamespace` collision
  validation.
- Replace the basic `create` prompt with a Clack wizard for mode, optional
  Assets, preview, confirmation and launch guidance.
- Add a packed-runtime `dev:bootstrap` path for qualifying the exact first-user
  experience before publication.
- Preserve optional emoji metadata for Homes, Workspaces, Workstreams and
  Targets through the normalized HUD.
- Expand Asset Skill and Command accessors over resolved Workspaces,
  Workstreams or Targets with `forEach`, binding every generated provider alias
  to its exact Home reference without duplicating Capability sources.
- Keep command-only Capabilities out of the agent HUD while preserving them in
  the normalized JSON inventory.
- Manage linked Git worktrees as explicit Target Bindings without deleting
  branches, forcing removal or hiding unbound worktrees.
- Position Hairness as the local-first logistics layer around existing Agent
  Runtimes, methods and repositories, with Codex and Claude as the qualified
  provider surfaces.

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
