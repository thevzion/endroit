# Endroit

> THE WORKPLACE-FIRST APPLICATION FRAMEWORK

## Build the place where humans and agents work.

Everyone is building better agents. We gave the work a place.

**Owned by places. Resolved for agents. Readable by humans. Versioned with
Git.**

> Know what is true. See what is missing. Prove what moves.

## New session. Same workplace.

Your way of working stays. Each agent adapts at the door.

**Places make intent legible. Gestures make it explicit.**

Say what you want to work on in normal conversation:

> Continue the Endroit 0.9 Checkout launch.

The provider Front Door exposes the Home Floor Plan and its routing rules. The
agent can resolve the relevant Room or ask when the subject is ambiguous, then
inspect retained Material, available Equipment and declared Sites.

**The application framework around temporary agents.**

Endroit is a lightweight, local-first application framework for building and
operating file-based [Open Workplaces](https://open-workplace.org/proposal/).
It implements the Open Workplace model as owned sources, deterministic
resolution, provider projections and optional operations.

It gives human-agent work an owned place across sessions, tools and
repositories without moving that work into a persistent agent, proprietary
memory service or orchestration runtime.

> **0.9.0-alpha.0 release candidate — local and not yet published by this working
> tree.** The candidate is usable, actively maintained and dogfooded, but the
> last observed npm release remains `0.8.0-alpha.1`. Endroit is pre-1.0; its
> public grammar and schemas may still change through explicit releases and
> migration notes.

At the end of the Meeting, the result stays ephemeral unless you choose to:

- **retain** it for later inspection;
- **accept** it as current Room truth;
- **deliver** it through a revalidated Route, with human approval and an
  observed Site result;
- **archive** it when it leaves active context, without deleting history.

Start a new Codex or Claude session and name the same subject. The owned
Workplace—not the previous transcript—carries the continuity.

```text
Provider / Harness
model · tools · sandbox · execution · hot state
                       ↓ temporary Occupant
Human ↔ Endroit Home ↔ Meeting
                       ↓ candidate
Human transition → Room / Desk Material
                       ↓ approved Route
                 sovereign Site
```

**Responsibilities, not a required stack.** Providers supply execution. The
Workplace owns continuity. A harness runs the agent; a Workplace holds the
work.

## One Home. Several sessions. More to build on.

Claude can enter a Room, produce a candidate and leave. You can retain the
useful result without accepting it as truth. Later, Codex enters the same owned
Home, reads the retained Material and prepares the next candidate. It never
needs Claude's private memory.

Home Hygiene can then report an ambiguous owner or destination without moving
anything. An accepted result reaches a Site only through an approved,
revalidated Route.

Each useful session can leave the Home better prepared for the next. Endroit
compounds retained Material, accepted decisions, stabilized Equipment,
verified Routes and observed Site results. It does not retain every transcript
or output.

## Start with conversation. Add precision when it matters.

```text
Talk naturally
      ↓
Inspect the shared workplace
      ↓
Use explicit gestures when authority matters
      ↓
Use the CLI for deterministic operations
```

Commands are optional. They help you steer, retain, accept and deliver without
surrendering control of the session. A natural sentence with the same explicit
meaning works too. An acknowledgement alone never retains, accepts, archives,
delivers, repairs or calls another Occupant.

- **Enter:** recover or recenter the Home and Room.
- **Equip:** call an Occupant, adopt a Role or activate a method.
- **Advance:** place, delegate and verify an actionable result across its
  owning Room and sovereign Sites.
- **Keep:** retain, accept or archive Material.
- **Reach:** revalidate a Site Route and deliver explicitly.
- **Maintain:** inspect the Home read-only and approve a bounded repair.

Endroit makes placement inferable, explainable and correctable. It does not
infer intent, personalize the model or organize work without human authority.

## Resolve the work, not the agent

The experimental `endroit/work` Equipment turns selected Room-owned work into
an inspectable contract. `WORK.json` keeps objective, sources, claims,
obligations, contradictions, bounded Assignments, verification, observed
result and human review distinct. The runtime reports the last resolved
frontier and the exact missing contracts:

```text
event → object → contract → placement → execution-ready → closure-ready
```

```bash
node ./endroit.mjs artifact create item public-proof --room desk/endroit
node ./endroit.mjs work resolve public-proof
node ./endroit.mjs work review public-proof
```

`execution-ready` never means authorized. Work Resolution does not retain an
agent identity, run a Site preview, change Artifact lifecycle or infer commit,
delivery or publication consent. See [Work Resolution](docs/work-resolution.md).

## Bring what you already have

Consider a product split across an application repository, a documentation
repository and a personal folder of agent instructions. The useful pieces are
already there, but a new session has to rediscover which source owns what and
where a result may go.

Give an agent the portable [ADOPT.md](ADOPT.md) adoption guide. It first asks
which local roots it may inspect, takes a shallow read-only inventory and
presents plausible Workplace boundaries. For a multi-repository environment,
the usual recommendation is one standalone Home with the existing repositories
left in place as sovereign Sites:

```text
Before                              After adoption
app repo ─┐                         standalone Home
docs repo ├─ implicit relationships   ├─ Room: product
methods ──┘                           ├─ Equipment: existing methods
                                     ├─ Site + Route: app repo
                                     └─ Site + Route: docs repo
```

Choosing a candidate authorizes deeper analysis, not mutation. The agent then
shows a provenance-backed map and expected diff. Only **Apply this map**
authorizes the existing Endroit CLI operations. Nothing in the Site repositories
is moved merely to make the Workplace tidy.

This is general adoption of an existing environment. It is different from the
version-specific [0.7 → 0.8 migration](docs/migration-0.8.md).

## Adopt or start a Home

Requirements: Git and Node.js 22 or newer. Endroit currently ships L1
Projection-qualified surfaces for Codex and Claude.

### Install the alpha.2 candidate after publication

The repository prepares the `0.9.0-alpha.0` installation contract below. Do
not treat it as available until the npm artifact is observed; the last
observed registry release remains `0.8.0-alpha.1`.

```text
Read https://endroit.org/install.md and set up Endroit here.
Explain the plan and ask before changing anything.
```

The candidate sources are [INSTALL.md](INSTALL.md), [ADOPT.md](ADOPT.md) and
[WORKPLACE.md](WORKPLACE.md). They are included in the local package candidate;
publication remains a separate observed effect. The agent inspects and
explains; the pinned Endroit CLI applies only the approved operation.

> **Agent-led. CLI-backed. Human-approved.**
>
> The agent guides. The CLI applies. The human approves.

### Use the terminal

Create a standalone Home:

```bash
npx --yes --package @endroit/cli@0.9.0-alpha.0 endroit create my-home
```

`create` adds a Home-owned Member and, by default, a Desk tracked with the
Home. Use `--desk separate` for a private nested Desk repository or
`--desk later` to defer the Desk.

Or add a Home to an existing repository:

```bash
cd my-existing-repository
npx --yes --package @endroit/cli@0.9.0-alpha.0 endroit init .
```

`init` defaults to a separate Desk repository under ignored `.desk/`. Both
commands accept `--desk tracked|separate|later`.

Bootstrap does not move existing instructions, Skills, memory, product files
or checkouts. Read the preview and approve only the destination and Desk
strategy you intend.

### Continue onboarding

In an existing Home, ask the agent to inspect the generated Front Door and
continue onboarding. Normal conversation remains the default interface. You
can inspect the Home first, then use explicit workplace gestures when they
become useful.

## What `create` gives you

The standalone bootstrap is intentionally small:

```text
my-home/
├── endroit.json
├── HOME.md
├── members/
│   └── owner/
│       └── MEMBER.md
├── rooms/
│   └── home/
│       ├── ROOM.md
│       └── inbox.md
├── equipment/
├── .desk/
│   ├── desk.json
│   └── DESK.md
├── endroit.mjs
├── AGENTS.md        generated
├── CLAUDE.md        generated
├── .agents/         generated
├── .claude/         generated
└── .endroit/        local and rebuildable
```

Directories such as `sites/`, `.desk/routes/` and `checkouts/` appear only
when their owning operations need them. `--desk later` omits `.desk/` until
`desk init` or `desk clone`.

The initial human-authored orientation is concentrated in these sources:

- `endroit.json` declares the Home and providers;
- `HOME.md` contains shared house rules;
- `members/owner/MEMBER.md` owns durable human identity and collaboration
  context;
- `rooms/home/ROOM.md` gives the first durable domain a purpose;
- `.desk/DESK.md` carries personal continuity.

`create` and `init` install eight inspectable foundation Equipment packages:

- `endroit/onboarding` — consent-first setup and explanation;
- `endroit/hud` — live orientation over the static Floor Plan;
- `endroit/workplace` — entry and workplace gestures;
- `endroit/artifacts` — durable Artifact lifecycle;
- `endroit/work` — experimental Work Resolution and bounded review;
- `endroit/rooms` — Room inspection and diagnostics;
- `endroit/sites` — Site and Route operations with destructive guards;
- `endroit/hygiene` — read-only Home maintenance and approved repairs.

Additional Rooms, Sites and optional Equipment appear only when the work earns
them.

## How the framework works

```text
owned Home, Desk, Room, Equipment and Site sources
                         ↓
              deterministic resolution
                         ↓
          provider Front Doors and projections
                         ↓
             optional live orientation
                         ↓
            humans and agents meet in a Room
                         ↓
        Material is retained, accepted or delivered
                         ↓
           the Site result is observed again
```

Endroit Core loads and validates sources, resolves the Workplace, manages
Equipment composition and builds deterministic projections. The bundled
`endroit/sites` Equipment—not Core—owns guarded Site and Route operations,
deterministic Git inspection, managed clones and managed worktrees. The root
`site` and `route` commands are CLI façades over that installed runtime.

First-party Equipment adds bounded ways of working without becoming the owner
of their results. Additional Equipment can add research, planning or
publishing methods. Endroit is opinionated about ownership, not about the
methodology you must use.

Endroit is headless. Its canonical state is ordinary files. Generated
`AGENTS.md`, `CLAUDE.md`, Skills and Commands are provider views built from the
same owned Home.

The static files, resolver, Floor Plan and projections are the foundation. The
HUD and other Equipment runtimes are optional capabilities; no daemon or
orchestration runtime is required for the Workplace to remain legible.

[WORKPLACE.md](WORKPLACE.md) is the self-contained `endroit/0.8` alpha Profile
for the `open-workplace/0.1` protocol. The existing
`endroit/workplace` Equipment injects the candidate into generated Codex and
Claude Front Doors in this working tree. It tells a temporary Agent how to
enter, resolve ownership, work through Workplace objects and preserve explicit
lifecycle boundaries. It is deliberately separate from adoption and is
included in the local `0.9.0-alpha.0` package candidate.

Endroit does not make the agent smarter. It makes the situation clearer.

## The missing vocabulary

Most agentic setups begin with useful primitives:

```text
AGENTS.md
├── shared constitution
├── personal preferences
├── repository map
├── product rules
├── current decisions
└── working state

Skills/
├── procedures
├── domain knowledge
├── methods
├── specialized agents
├── state
└── outputs
```

Nothing here is inherently wrong. The problem appears when a small number of
technical formats become responsible for an entire work environment.

Open Workplace gives each responsibility an owner:

```text
Home       shared workplace and constitution
Desk       personal preferences, continuity and local access
Room       one durable domain and its Material
Meeting    the work happening now
Equipment  a reusable way of working
Site       sovereign external truth
Route      how this Desk reaches that Site
```

Technical formats tell agents what to read or execute. Open Workplace names
who owns each responsibility before Endroit projects those formats.

> `AGENTS.md` guides an agent. Skills equip it. Endroit gives the work a
> place, an owner and a destination.

The pieces were already there. They just needed a place.

## The Workplace model

### Home

One concrete, durable Workplace instance and trust boundary. A Home owns
shared composition and house rules. `HOME.md` is one source inside the Home;
it is not the whole Home.

### Member and Desk

A Member is a Home-owned human identity and durable collaboration context. A
Desk is that Member's place inside the Home. It owns personal preferences,
staging and local Routes. Multiple Desks can share a Home without sharing
machine paths or turning one person's preferences into house rules.

### Room and Meeting

A Room owns one durable domain and its Material. Rooms can contain Rooms when
a subject earns its own mission, continuity and decisions. A Meeting is the
bounded event happening now; it owns hot context, not automatic memory.

### Equipment and Material

Equipment is a reusable way of working: manual, controls, limits, optional
runtime and provider projections. A Skill or Command may activate it, but the
Equipment remains the method and the Room, Desk or Site owns the resulting
work. Material is retained only through an explicit human-controlled
transition.

### Site and Route

A Site is a sovereign system: repository, knowledge base, publishing platform
or other owner of external truth. A Route is a Desk-owned declaration of local
Git access to that Site. A remote-only Site has no Route. A Route never grants
permissions the Site has not granted.

## Repositories are Sites, not symlinks

Endroit supports several physical arrangements without changing ownership:

| Mode | Example |
|---|---|
| Embedded | the current repository also contains the Home |
| Managed clone | real checkout under `checkouts/<site>/<route>/` |
| Managed worktree | real linked worktree under `checkouts/<site>/<route>/` |
| Existing checkout | repository kept in place, indexed by symlink under `checkouts/` |
| Submodule | user-managed submodule addressed by a Route |
| Remote-only | declared Site with no local checkout |

Site declarations are shared:

```text
sites/<site>/SITE.md
```

Local, ignored access declarations stay with the Desk:

```text
.desk/routes/<site>/<route>.json
```

Endroit 0.9 reads frozen v7 and current v8 Route documents and writes v8 only.
The v8 document owns `active|parked|superseded` lifecycle, a nested `checkout`
configuration and an optional branch or commit `revision`. A Checkout is addressed as
`checkout:<site>/<route>` and is inspectable as declared metadata plus fresh
observation; it is not another Open Workplace object.

`checkouts/` is the conventional physical index of every non-embedded local
Checkout. Existing repositories stay in place and appear through generated
symlinks; provider-created worktrees may appear under `_observed/` without
becoming Routes. `.endroit/checkout-index.json` records only generated links,
so reconciliation never removes an unknown path.

`settings.endroit/sites.pinnedSites` opts individual Sites into a Home-owned
submodule composition. `settings.endroit/sites.observedWorktrees` on the Desk
chooses `report` or `_observed/` symlink surfaces. Endroit validates both and
never initializes or updates a submodule implicitly.

For a submodule, the Home Git repository owns the Gitlink commit pin and its
`.gitmodules` declaration. Checkout initialization and submodule lifecycle
remain user-owned.

Example guarded operations:

```bash
node ./endroit.mjs site add https://github.com/acme/product.git --id product
node ./endroit.mjs checkout clone product --id main
node ./endroit.mjs checkout worktree product --id feature --from main --new-branch feature
node ./endroit.mjs checkout adopt product ../product --id existing
node ./endroit.mjs checkout reconcile --check
node ./endroit.mjs checkout inspect checkout:product/main --json
node ./endroit.mjs route migrate product --check --json
node ./endroit.mjs site doctor
```

Parked and superseded Routes are excluded from operational and implicit
selection. Route v7-to-v8 migration and rollback are metadata-only; see the
[migration guide](docs/migration-route-v8.md).

## Explicit Workplace gestures

The bundled Workplace Equipment projects inspectable activation surfaces for
the 0.8 journey:

```text
call-the-researcher   add a temporary Occupant when the provider can do so
work-as-an-engineer  adopt a Role for one Meeting
use-research         activate Equipment
advance-this         place, delegate and verify the current actionable result
retain-this          keep inspectable Material
accept-this          accept current Room truth
deliver-this         act through an explicit, revalidated Route
archive-this         remove inactive Material from active context
```

Codex and Claude receive generated first-party Skills and Commands. Endroit's
package gates prove deterministic generation, static parity and wrapper shape;
they do not prove provider-hosted execution. A missing host mechanism returns
`blocked` rather than simulating success. See [Provider qualification](docs/providers.md).

[HACP](https://github.com/control-decks/human-agent-control-protocol) is an
independent optional draft semantic protocol. Endroit does not require it and
never infers a Card from ordinary conversation.

Provider Plan modes, subagent APIs, HACP, MAIN-SESSION, White Card, Grill Me,
Think It Through, GSD and Impeccable remain external capabilities or harness
features. Endroit can carry their results without absorbing their controls.

## What Endroit does not replace

- your agent or model;
- Codex, Claude or another runtime;
- Git and repository-native tooling;
- MCP servers and external permissions;
- your preferred planning or knowledge methodology;
- human judgment over what becomes durable or authoritative.

## Alpha boundaries

- Codex and Claude are L1 Projection-qualified; hosted invocation and live
  Presence are not qualified by this release.
- The 0.8 Workplace grammar is a breaking alpha change from 0.7.
- Public grammar and schemas may change through explicit releases and
  migration notes.
- Submodules are recognized, but Endroit does not manage their lifecycle.
- `maintain-the-home` is read-only. A bounded repair requires an exact finding
  and matching human approval.
- Workplace verbs are provider projections, not a hidden transactional
  engine.
- Non-Git Routes and delivery remain future work.
- Open Workplace is an open proposal, not a standard or required service.
- Endroit makes no claim about model intelligence, hallucinations, cost,
  performance, scheduling or universal provider compatibility.

The lock-in is intentionally low: the sources are files, Sites keep their own
repositories and generated projections can be discarded and rebuilt.

## Related reading

- [The Workplace-first Proposal](https://open-workplace.org/proposal/)
- [Harness engineering: leveraging Codex in an agent-first world](https://openai.com/index/harness-engineering/)
- [Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- [100 Tips & Tricks for building your own personal AI](https://www.reddit.com/r/ClaudeAI/comments/1thi6nh/100_tips_tricks_for_building_your_own_personal_ai/)

The external examples are related signals, not endorsements of Endroit.

## License

See [LICENSE](LICENSE).
