# Endroit Technical Specification

## Scope

Endroit is a compiler for Static Workplaces. The supported API is the CLI. The
TypeScript modules under `src/` are internal.

## Product boundary

Endroit is a sovereign Site. It does not contain the private Workplace that
mounts it. Consumer concepts such as WORKPLACE, MEMBER, DESK, WELCOME,
CONSTITUTION and DOCTRINE are Standard source roles demonstrated in
`examples/`.

The compiler never writes into a Site reached through a Workplace Route.

## Standard

The first Standard defines six durable entity families:

- Place
- Member
- Agent
- Work
- Material
- Meeting

Room, Desk, Site, Study, Initiative, Decision, Artifact and Evidence
are closed Roles. Hall, Reception, Member Card, Keyring, Floor Plan, Workspace,
Workshop, Workbench and Noticeboard are resolved responsibilities or
projections.

## Source contract

Workplace Markdown begins with strict YAML frontmatter and a Markdown body.
Metadata owns identity, owner, Roles, placement, relations, lifecycle and
selection. The body owns the human content of that source responsibility.

The parser rejects duplicate keys, aliases, anchors, custom tags, directives,
multiple documents, cycles, prototype keys, unknown fields and budget
violations. Profile Package components, `composition.json`, `workplace.json`,
EntryBinding and ProviderBinding remain closed JSON.

`WELCOME.md` owns exactly what a Desk discloses at entry and is limited to
4096 UTF-8 bytes.

### Workplace Profile Package

`profiles/standard/profile.json` is the sole Package manifest. It explicitly
references Grammar, Lexicon, source responsibilities, Composition,
Coordination, Disclosure, Projections, `new` resolution, Markdown defaults and
the fundamental `onboard`, `enter`, `maintain` and `settle` affordances. No
component is discovered by scanning the directory.

The Standard Package is immutable by identity. A Workplace pins its Ref and
digest through `ProfileSelection`; a local semantic change requires a new
identity with `derivedFrom`, never a silent upgrade. The compiler kernel owns
only load, validate, resolve, select, project and manifest. Standard prose,
defaults, affordance selection and coordination policy remain Package data.

Resolution produces `.workplace/definition.json`, `.workplace/lexicon.json`
and `LEXICON.md`. Definition records the resolved nomenclature,
responsibilities, Equipment, affordance chain, provider targets, source
revisions and disclosure reasons. A projected Skill without a complete Package
→ Position → applicability → Authority → provider-target chain is invalid.

## Compilation

```text
configs + owned sources
→ validated semantic graph
→ scoped FrontDoor IR
→ portable control plane + local ordinary adapters
```

The provider opens a Mount, not a Git Root:

```text
MountRoot/
├── FRONTDOOR.md, provider adapters, scoped Front Doors, .endroit/
├── workplace/                    shared sovereign Git Root
│   ├── sources/                  owned semantic sources
│   └── .workplace/               portable control plane
├── checkouts/desks/<slug>/       private Desk Git Roots
└── checkouts/sites/<slug>/       sovereign Site Git Roots
```

`MountRoot`, `SharedRoot` and `SiteRoot` are the closed public names. Compile,
check and ready never initialize or write a Site Root.

`.workplace/` is portable and committed. `.endroit/`, `FRONTDOOR.md`,
`AGENTS.md`, `CLAUDE.md` and scoped variants are local, ignored and
reconstructible. Existing non-owned files are collisions and are never
overwritten.

FrontDoor IR sections retain source Ref/Revision, Position, scope, visibility,
reason-for-disclosure and required links. Profile selectors define the closed
disclosure grammar; Workplace policy selects selector IDs. No `.frontdoor`
file, user-authored regex or provider-global Skill selects semantics.

Neutral compilation reports `onboarding-required` and invents no identity.
Bound compilation renders a Member Card, the bound Desk’s WELCOME packet,
Authority limits and source revisions. It never claims to detect a “current
human”.

Constitution, Doctrine and CHANGE are complete generic owned sources; they do
not embed the founding Member. MEMORY is a complete Desk-owned policy. The Hall
projects only bounded summaries, provenance and links for those policies, while
WELCOME remains the exact Desk-selected resident packet within its 4 KiB
budget.

An `admits` relation derives a read/discovery Key for another Desk’s declared
WELCOME and shared Shelves. A Key is not filesystem access, mutation, Mandate or
Authority.

## Progressive discovery

The global graph is compiled once. Each scope exposes only its legitimate next
links and locally applicable Equipment. A Study method is discovered from a
Room/Workshop and is not a resident global Skill.

## Controls on the critical path

A rule that can change Root, Authority, Outcome or effect is compiled as a
`ControlClause`. Its closed placement is `Resident`, `RequiredRead`, `MayRead`
or `Guard`; it retains source revision, Position, trigger, criticality,
disclosure reason, missed consequence, required evidence and enforcement.

Before any write, the Hall exposes the closed resolution matrix:

```text
read-only    → Main
single-scope → Main → Worker → Main
multi-Root   → Main → Manager → Worker(s) → Manager → Main
ambiguous    → ask-once-zero-write
```

Every local method compiles a Context Contract with required and conditional
reads, forbidden scopes, search Root, stop condition, coordination route and
proof. For integration `open-work`, Coordination, Manager, active local Meeting
presence, Occupants and complete dispatch envelopes are mandatory. Main cannot
write the Site or inline the integration path. Missing provider subagents or
proof is RED; global Skills and provider memory remain forbidden trajectory
inputs rather than filesystem security claims.

## Commands

```text
endroit new <new-directory>
endroit new --request <file> --preview [--json]
endroit new --request <file> --apply <sha256> [--json]
endroit ready [path] [--json]
endroit compile --mount <path> [--entry <file>] [--provider <id>]
endroit check --mount <path> [--provider <id>] [--json]
endroit check <git-root> --staged [--commit-message <file>] [--json]
endroit check <git-root> --history [--json]
endroit preview <source> --out <new-directory> [--ignore <file>] [--json]
```

`new`, `compile`, `check` and `ready` also accept `--profile <package>`.

### Fresh Workplace creation

`new` creates one personal situated Workplace. Its closed
`NewWorkplaceRequest` contains the absent target, Workplace and Member
identities, Desk/WELCOME disclosure, selected providers and explicit Git
identity. Version 1 embeds the Standard Profile and core Equipment only.

The pure planning layer maps Request plus exact Profile to
`human/new-workplace-preview@1`. Its digest covers the normalized Request,
Profile revision, every planned path and source digest, every compiler-derived
projection path, four Git guards and the three planned commits. Any Request
change invalidates consent.

Apply builds in an adjacent temporary directory, validates sources, initializes
the shared and Desk Roots on `develop`, commits Desk sources, commits shared
sources, compiles, checks and commits portable projections separately. It
installs the consented Shared/Desk guards, then renames the completed Mount to
the target. Cancellation, collision, invalid
input or pre-rename failure leaves the target absent. Both Roots have no remote.

The bound Hall contains the Member Card, WELCOME, Memory Policy and a local
`open-room` method. `open-room` first resolves the Floor Plan; only a subject
needing distinct continuity may become an owned Room. After `ready`, that Room
reveals `open-work`. Neither method is a global Skill or delivery Authority.

Before that first routing decision, the Hall copies the explicit `## Resident`
sections of Constitution, Doctrine and CHANGE into one operating contract.
Their aggregate bytes must fit Profile `maxResidentBytes`; overflow or a missing
section fails compilation. Ref/Revision provenance stays in IR and HTML comments
instead of visible adapter prose or summary cards.

ProviderBindings contain the exact local recompilation command used by the
creator. If it later disappears, ordinary Front Doors remain readable and the
binding is inspectably degraded until that command is restored.

The local manifest digests both EntryBinding and the merged ProviderBindings.
A binding edit is `compile-required`; it cannot leave stale adapters falsely
reported as ready.

`ready` discovers the Mount upward from its Hall, shared Root or mounted Site,
checks it, rebuilds missing or stale projections and checks again. It never
adopts or creates semantic sources.

## Meeting and presence

Meeting is the present collaboration event; Work owns a durable Outcome. A
Meeting advances zero or more Works, a Work may cross many Meetings, and closing
a Meeting never completes Work. Portable lifecycle is
`active → settling → closed`; the preceding `ephemeral` presence is local only.

Session resolution is closed: join an explicit active Meeting, resume one
unique compatible active Meeting, create local ephemeral presence when none
exists, or ask once with zero writes when several match. Provider session IDs
are hashed into `.endroit/meetings/<opaque-id>/presence.json`. `MEETING.md` is
materialized under its Room only at the first durable effect. Main, Manager and
Worker are Occupant roles; subagents inherit `meetingRef`.

## Mutation and Site flow

`CHANGE.md` owns shared mutation policy. A direct local build intent may open
bounded Work, declare or reuse a Site and create local commits. It never grants
acceptance, hosting, publication or delivery. The observable chain is planning
commit → sovereign Site commit(s) → verification → Work completion commit.
Cross-Root causality uses explicit OIDs or Refs, never timestamps or latest
wins.

The projected affordance is the Git verb. Every Work mutation carries a fully
qualified Meeting and Authority; delegated integration also carries Mandate,
while projection commits carry the exact source OID as Build. Workers never
commit in the shared index. No-op, stale, blocked or foreign-path effects
produce no commit, and source commits precede projection commits.

### Git witness

`check --staged` validates exact indexed source bytes, graph integrity, Root
classification and source/projection separation. Partial-file staging is
rejected. `--commit-message` validates the operation subject and Meeting,
Authority, Mandate, Work, Plan-Revision and Build trailers. Room and its first
Meeting may be one establishment effect.

`check --history` replays first-parent history. Every post-bootstrap durable
commit resolves an active Meeting in the same causal state; a closing commit
may resolve the active parent. Projection Build equals the exact source parent
OID. Implicit merges, dangling/inactive Meetings and unpinned cross-Root
references are RED.

`new` installs marked `pre-commit` and `commit-msg` hooks only in SharedRoot and
DeskRoot. They call the public checks and fail closed when the compiler is
missing. Missing/altered hooks are `degraded`; `ready` repairs only marked or
manifest-owned hooks and never masks invalid history. Hooks are bypassable Git
ergonomics, not a security boundary.

## Settle

Settle inventories consequential Meeting Matters and deterministically routes
them to drop, Work, Material, Decision, Artifact, Desk or a separately prepared
Site effect. Decision requires explicit human judgment; Artifact remains a
Material Role. Source batches are separated per Root, retained items receive a
Shelf placement, and Register/Ledger/Views are rebuilt before close or resume.
Settle stores no transcript, reasoning or secret and cannot accept, publish,
host, deliver or create Authority.

## Static coordination

`workplace/coordination.json` is a closed `CoordinationPolicy` v1 source owned
by the consumer Workplace. It declares Main, Manager and Worker contracts; the
exact read-only, single-scope and integration routes; the dispatch-envelope
fields; and fail-closed fallbacks. It cannot contain expressions, loops, code
or an arbitrary DAG.

The compiler resolves policy plus Position, Work, Authority and ProviderBinding
into `.endroit/coordination-ir.json`, portable
`.workplace/coordination.json` and provider-neutral Manager/Worker contracts.
Hall disclosure is limited to Main. Work reveals Manager only for integration;
Site reveals Worker only at dispatch. Main is provider-bound facilitation, not
a durable Agent Node.

ProviderBinding `agent` targets qualify native dispatch. Missing support is
`degraded`; inline Worker execution is limited to an explicitly enabled single
scope. Worker never commits, dispatches, contacts the human or widens scope.
Global Skills cannot select a role or create Authority.

## Memory and provider targets

The Constitution owns shared memory boundaries. A Desk-owned `MEMORY.md` source
owns personal durable routing policy. The bound Hall compiles its summary and
link. A provider `MEMORY.md` is emitted only when a qualified ProviderBinding
selects that exact target. Installed global Skills and provider caches grant no
destination, mutation or delivery Authority.

## Determinism and qualification

Equal inputs produce equal bytes. A Scenario freezes Intent, Revisions,
expected observable Path, Outcome contributions and forbidden behavior. The
oracle stays outside the Agent-visible world. A playable result can still fail
when the path, evidence, Git history or Site boundary is wrong.

Governed cases live under `tests/workplaces/cases/<case>/`. Local runs live
under ignored `checkouts/workplaces/<case>/<utc>-<case>-<digest>/` with a fixed
RUN record, explicit Mount and evidence directory. There is no `latest`,
overwrite, automatic cleanup or implicit golden promotion.

Development-only `case:new`, `case:run`, `case:snapshot` and `case:verdict`
create a unique run, invoke an explicitly selected provider Scenario, append
timestamped evidence and perform the only terminal RUN transition.
Snapshots retain check/history, Heads, status, presence, compiled IR, observed
reads, selected Skills, dispatches and effects; they reject transcripts,
messages, hidden reasoning and secrets. `case:run` disables provider memory,
plugins and apps where supported and reports remaining capability exposure; it
does not claim filesystem isolation or decide the verdict.

## Trust boundary

Validation completes before writes. Projection writes are atomic. Portable
manifests contain no local path, secret or private Desk body. Compile, check and
ready grant no Authority.

The complete implementation contract and gates are tested in `tests/`.
