---
$schema: "https://endroit.org/schema/v9/profile.json"
kind: "endroit/profile"
id: "endroit"
owner: "site:endroit"
version: "endroit/0.10"
protocol: "open-workplace/0.2-draft"
---

# Endroit Workplace Profile

Endroit is a local-first implementation of Open Workplace. It compiles
human-owned, readable sources into a resolved context and rebuildable provider
projections. It is not an agent runtime, universal memory, workflow engine or
authority broker.

## Responsibilities

Open Workplace defines the shared responsibilities. This Profile owns their
concrete Endroit representation:

- `WORKPLACE.md` declares the durable boundary and constitution.
- Member, Desk and Room Documents carry human continuity at explicit scopes.
- Equipment declares reusable Capabilities and their provider surfaces.
- Material remains with its declared owner; an Artifact is Material validated
  by an Endroit kind.
- Sites remain sovereign external authorities. A Route declares local access
  to one Site; a Checkout is only its derived local address.
- `AGENTS.md`, `CLAUDE.md`, Skills, Commands and local indexes are projections.

`Home` and `Instance` are legacy Endroit 0.8 terms. `Occupant`, durable `Role`
and `Mount` are not part of this Profile. A Meeting is an ephemeral work event,
not a required durable object.

## Source model

An Endroit Workplace is discovered from `WORKPLACE.md` in the selected
directory or its physical ancestors. A marked but invalid declaration stops
discovery. Endroit never searches children, follows a Route or crosses into a
different repository during discovery.

Human-owned durable meaning uses Markdown. Frontmatter owns identity,
ownership, resolution and contract metadata; the Markdown body owns human
substance. Typed Fragments provide addressable structure inside a Document and
inherit its owner and lifecycle. A Fragment that needs independent ownership
or lifecycle becomes Material; it becomes an Artifact only when a kind adds a
useful validation contract.

JSON is reserved for schemas, machine manifests, projection locks, build and
migration receipts, caches, CLI or API responses and externally imposed
formats. Endroit does not maintain a canonical JSON document beside a Markdown
summary of the same responsibility.

## Resolution

Resolution produces a `ResolvedWorkplace`: a derived, non-canonical
representation of the relevant owned sources, their provenance and digests.
Its revision is independent of absolute paths, timestamps, Git state and host
observations. Volatile evidence belongs to a separate `ObservedWorkplace`.

Resolution fails closed:

- `resolved` means the requested responsibility has one valid authority;
- `degraded` means readable sources remain usable but optional machinery is
  unavailable;
- `ambiguous` means competing authority prevents the affected action.

File order and provider precedence never silently resolve an ownership
conflict.

## Provider projections

The build compiles the same resolved meaning for every provider. A provider
adapter may change formatting and invocation metadata, but not ownership or
semantics. Provider bootstrap files carry their source revision and contain
only the constitution, routing rules, provenance, local console and degraded
behavior needed to enter the Workplace.

The full Profile, complete Room or Site inventories, inactive Capabilities and
absolute paths are never injected into a bootstrap. Generated outputs are
rebuild-only. A source digest change makes the corresponding projection stale;
editing a projection never changes its source.

Provider installation is distinct from projection build. Installing hooks or
host configuration requires an explicit provider operation. A build does not
silently mutate host integration or Git excludes.

## Material and work

Execution produces an ephemeral candidate, not durable continuity. Retention
and archival describe Material lifecycle. Acceptance records human authority
over an exact revision. Currentness describes whether a claim or decision is
current, superseded or withdrawn. Claim maturity describes evidence as
proposed, supported or demonstrated.

Completion is calculated for an exact `(contract, revision, evidence)` tuple
and is reported as complete, incomplete or blocked. It is invalidated when the
revision changes. Delivery records an observed Site effect as succeeded,
partial or failed. None of these axes implies another, and Endroit defines no
`final`, `accepted: true` or `delivered: true` field.

## Sites, Routes and Checkouts

A Site declaration identifies an external authority without copying its truth
into the Workplace. A Desk-owned Route declares the relationship to that Site.
Every non-embedded Route has the derived address
`checkouts/<site>/<route>`, represented by a physical checkout or symlink.

Durable references use `checkout:<site>/<route>#<relative-path>`. Route sources
never persist absolute paths, HEAD, dirty state or other observations. Git owns
repository and worktree truth. Endroit may inspect worktrees only through
already-known Site repositories and never scans arbitrary project roots.

Access is not authority. A valid Route neither grants host permission nor
human consent to mutate, commit, deliver, publish or deploy. Endroit revalidates
the exact Route and observes the resulting Site effect before recording
delivery.

## Compatibility

Endroit 0.10 reads the frozen 0.7 and 0.8 source contracts through one legacy
adapter. Native writers produce v9 Workplace, Member, Desk and Route Documents;
Work Resolution writes `WORK.md` v1alpha2. Bundled Room, Site and most Equipment
and Artifact operations retain their compatible source shapes in this alpha.
Only Route has an automated v7→v8→v9 migration. New and legacy declarations for
the same responsibility are ambiguous; there is no dual-write. Legacy aliases
and readers may be removed only after their remaining owners have explicit,
qualified migrations.

## Limits

Endroit does not prove provider execution, infer human consent, own Site
history, persist private provider state, schedule agents or require a daemon,
graph database, registry or hosted service. Other Open Workplace Profiles may
represent the shared responsibilities differently.
