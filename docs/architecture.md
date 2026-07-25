# Architecture

## Boundary

> Assets provide. The Home composes. The Kernel enforces. Bridges deliver.

```mermaid
flowchart LR
  source["Local · HTTPS · Git"] --> lifecycle["Kernel Asset lifecycle"]
  lifecycle --> home["HOME.md + DESK.md + Asset sources + frontDoor"]
  home --> resolve["Resolved Home"]
  resolve --> floor["Static Floor Plan"]
  floor --> projection["Tracked provider entrypoints"]
  resolve --> console["Tracked Home Console"]
  projection --> bridge["Codex / Claude Bridges"]
  console --> wake["Optional selected Wake-up runtime"]
  wake --> bridge
  resolve --> trust["Digest trust"]
  trust --> runtime["Approved Asset runtime"]
  target["Independent Targets"] --- home
```

`@hairness/cli` is the only package. There is no public Core package, Registry,
Adapter layer or package dependency graph.

## Kernel

The Kernel contains:

- Home and Desk loading;
- strict loading of the canonical `HOME.md` and `DESK.md` sources;
- JSON schema validation;
- source resolution and transactional Asset lifecycle;
- deterministic Resolved Home composition;
- Front Door route validation and the provider-neutral Floor Plan;
- tracked Home Console generation;
- projection ownership and provider Bridges;
- runtime digest trust and dispatch;
- static Doctor checks.

It does not know the output format or business behavior of HUD, Artifacts or
Targets. It does not author behavioral instructions. It only validates, orders,
attributes and projects explicit sources.

## Front Door and Progressive Orientation

The Front Door is a composition, not an Asset:

```text
Front Door
├── Floor Plan        static, deterministic, always available
├── Wake-up           one optional <asset-id>:<command> route
├── provider Bridge   bounded stdout transport
└── Home Console      node ./hairness.mjs …
```

`hairness.json#frontDoor.wakeUp` selects at most one command already provided
by an effective Asset runtime. The Resolved Home verifies the owner, namespace
and command. Asset mutations that would break the selected route fail before
writing.

Build projects `HOME.md → Floor Plan → Home Asset Instructions`. The Floor Plan
contains only stable relative facts. Wake-up can add absolute paths, Git state,
dates, trust and attention, but its failure cannot remove static orientation.
This is Progressive Orientation.

Bridges do not parse HUD, XML or another Asset protocol. At SessionStart they
invoke the selected route through `hairness.mjs`, cap it at 30 seconds and
256 KiB, discard stderr and transport stdout in the provider-native envelope.

## First-party Assets

First-party sources live under `assets/hairness/*`, exactly where third-party
Assets live in a Home. Their `asset.json` manifests declare every public
surface. Runtime code lives beside the manifest that owns it.

HUD intentionally understands the official Artifact and Target contracts so it
can render a coherent first-party view without executing other runtimes. Generic
third-party HUD contributions are outside 0.5.

## Ownership

- Home sources and shared projections are Git-tracked.
- Desk sources are personal to `Collaborator × Home`.
- Artifacts name their owner and lineage.
- Targets retain independent repositories.
- Provider projections are derived views.
- `.hairness/` contains local rebuildable state and approvals only.

This arrangement keeps the Home legible while leaving methods and project
repositories sovereign.

`HOME.md` is the shared constitution. `DESK.md` specializes it for one
collaborator without replacing it. Home Asset Instructions follow `HOME.md` in
deterministic Asset and instruction order, after the generated Floor Plan.
`DESK.md` and Desk Asset Instructions may be supplied by the selected Wake-up
route rather than written into shared files. `AGENTS.md` and `CLAUDE.md` are
fully owned projections: a direct edit is reported as divergence.

## Self-hosted development

The Hairness repository remains a Target, not a colocated Home. Its
repository-local orchestrator builds a sibling team Home and binds this checkout
as `hairness/main`:

```text
Agentic Tools Home ──Target──> Hairness repository
Agentic Tools Home ──Target──> Hairness Development Home
Hairness Development Home ──Binding──> Hairness repository
```

The Development Home installs `hairness/project` through that Binding.
Its ignored regular `.hairness/dev-cli` file points the tracked Home Console at
the source checkout. The Console alone selects `development|registry`; a broken
development launcher never falls back. This keeps product sources clean while
exercising the same Home, Desk, Asset, Front Door and Target contracts shipped
to users.
