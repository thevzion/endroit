# Endroit

> Give agentic work a place to compound.

**Not another harness. A place for the work.**

Endroit is a local-first, headless, file-based implementation of the
[Open Workplace](https://open-workplace.org/) model. It gives durable
human-agent work an owned place across sessions, tools and repositories.

It gives humans and the agents they already use a familiar place to work
across meetings, tools and repositories—without moving the work into a
persistent agent, proprietary memory service or orchestration runtime.

> **Alpha — usable, actively maintained and dogfooded.** Endroit is pre-1.0.
> Its ownership and safety contracts are deliberate; its public grammar and
> schemas may still change through explicit releases and migration notes.

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

Nothing here is inherently wrong. The problem is that a small number of
technical formats have become responsible for an entire work environment.

Endroit gives each responsibility an owner:

```text
Home       shared workplace and constitution
Desk       your preferences, continuity and local access
Room       one durable domain and its material
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

## Not workspace. Workplace.

Most current setups concentrate on two useful questions:

```text
Prompt-centric  What should I tell the model?
Agent-centric   What should the agent have?
```

Workplace-first adds a different architectural question:

> What should the durable workplace own?

These are composable centers of attention, not three formal paradigms or a
historical sequence. Agent-centric design equips the occupant.
Workplace-first makes the workplace first-class.

It makes the workplace first-class through identity, ownership, composition,
time and sovereignty.

The agent can change. The provider can change. The method can change. One
owned Home, its Material and its relationships remain inspectable by the
human.

> A workspace gives the agent somewhere to run. A workplace gives the work
> somewhere to belong.

Open Workplace defines the shared vocabulary and ownership model. Endroit
implements it through files, schemas, deterministic composition and provider
projections. A Home is one concrete workplace instance. “Endroit” means
“place” in French.

## Start a Home

Requirements: Git and Node.js 22 or newer. Endroit currently ships
first-class projections for Codex and Claude.

Create a standalone Home:

```bash
npx @endroit/cli create my-home
```

`create` adds a Home-owned Member and a Desk tracked with the Home. Use
`--desk separate` for a private nested Desk repository or `--desk later` to
defer the Desk.

Or add a Home to an existing repository:

```bash
cd my-existing-repository
npx @endroit/cli init
```

`init` defaults to a separate Desk repository under ignored `.desk/`. Both
commands accept `--desk tracked|separate|later`.

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
├── sites/
├── checkouts/        local and ignored when materialized
├── .desk/
│   ├── DESK.md
│   ├── rooms/
│   └── routes/        local and ignored
├── endroit.mjs
├── AGENTS.md        generated
├── CLAUDE.md        generated
├── .agents/         generated
├── .claude/         generated
└── .endroit/        local and rebuildable
```

The initial human-authored orientation is concentrated in five sources:

- `endroit.json` declares the Home and providers;
- `HOME.md` contains shared house rules;
- `members/owner/MEMBER.md` owns durable human identity and collaboration context;
- `rooms/home/ROOM.md` gives the first durable domain a purpose;
- `.desk/DESK.md` carries your personal continuity.

`create` and `init` also install seven inspectable foundation Equipment:
Onboarding, HUD, Artifacts, Rooms, Sites, Workplace and Hygiene. Additional Rooms, Sites and
optional Equipment appear only when the work earns them.

## The first experience

Say what you want to work on in normal conversation:

> Continue the Endroit hard reset.

The provider front door identifies the Home. Endroit’s static orientation
points the agent to the relevant Room, owned Material, available Equipment and
declared Sites. An optional live board can add current activity, but the Home
does not depend on it.

At the end of the Meeting, the result stays ephemeral unless you choose to:

- **retain** it for later inspection;
- **accept** it as current Room truth;
- **deliver** it to a Site through a Route;
- **archive** it when it leaves active context.

Open another session with another supported agent and name the same Room. The
place—not the previous chat—carries the continuity.

## How Endroit works

```text
owned Home, Desk, Room, Equipment and Site sources
                         ↓
              deterministic resolution
                         ↓
          provider front doors and projections
                         ↓
             optional live orientation
                         ↓
            humans and agents meet in a Room
                         ↓
        Material is retained, accepted or delivered
                         ↓
           the Site result is observed again
```

Endroit is headless. Its canonical state is ordinary files. Generated
`AGENTS.md`, `CLAUDE.md`, Skills and Commands are views for the provider you
already use.

Endroit does not make the agent smarter. It makes the situation clearer.

## The workplace model

### Home

One concrete, durable workplace instance and trust boundary. A Home owns
shared composition and house rules. `HOME.md` is one source inside the Home;
it is not the whole Home.

### Desk

Your place inside the Home. It owns personal preferences, staging and local
Routes. A team can share a Home without sharing machine paths or turning one
person’s preferences into house rules.

### Room

One durable domain and its Material. Rooms can contain Rooms when a subject
needs its own mission, continuity, decisions and Meetings. A Room is not
automatically a repository or project-management board.

### Meeting

A bounded event where humans, agents and Equipment work together. It owns hot
context, not automatic memory. No transcript or directory is retained merely
because a Meeting occurred.

### Equipment

A reusable way of working: its manual, controls, limits, optional runtime and
provider projections. A Skill may expose an Equipment function; removing the
Skill does not erase the Equipment’s responsibility or the Material created
with it.

### Material

Sources and results that can be addressed, inspected and deliberately
retained. Decisions and deliverables are authoritative forms of Material, not
every model output.

### Site

A sovereign system: repository, knowledge base, publishing platform, service
or other owner of external truth. A Site can live inside the Home filesystem
and still retain separate ownership.

### Route

A Desk-owned declaration of local Git access to a Site: path and
materialization mode. A remote-only Site has no Route. Non-Git Routes,
intended effects and observations are future work, and a Route never grants
permissions the Site has not granted.

## Repositories are Sites, not symlinks

Endroit supports several physical arrangements without changing the ownership
model:

| Mode | Example |
|---|---|
| Embedded | the current repository also contains the Home |
| Managed clone | real checkout under `checkouts/<site>/<route>/` |
| Managed worktree | real linked worktree under `checkouts/<site>/<route>/` |
| Existing checkout | repository kept in place, with an optional Mount under `checkouts/` |
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

Endroit 0.8 resolves each checkout from its Route directly. For an `existing`
Route, `route mount` can create a rebuildable symlink at
`checkouts/<site>/<route>/`; `route unmount` removes only that symlink. A Mount
is never the identity of the Site or Route and never grants new permissions.

## Core and optional Equipment

The Endroit Core resolves and validates the workplace, builds projections and
manages safe local Routes. For example:

```bash
node ./endroit.mjs site add https://github.com/acme/product.git --id product
node ./endroit.mjs route clone product --id main
node ./endroit.mjs route worktree product --id feature --from main --new-branch feature
node ./endroit.mjs route bind product ../product --id existing
node ./endroit.mjs route mount product --id existing
node ./endroit.mjs site doctor
```

First-party Equipment adds optional experiences such as research, planning,
publishing, orientation, inspection and maintenance. It is installed and
adapted independently. Endroit is opinionated about ownership, not about which
methodology you must use.

You can bring GSD, Spec Kit, BMAD, Superpowers, LifeOS-style practices or your
own Markdown conventions. They equip Rooms; they do not need to become the
Home’s ontology.

## Human gestures, optional protocol

Open Workplace provides nouns and ownership. Endroit's first-party Workplace
Equipment ships inspectable activation surfaces for the concrete gestures in
the 0.8 journey:

```text
call-the-researcher   add a temporary Occupant
work-as-an-engineer  adopt a Role for one Meeting
use-research         activate Equipment
retain-this          keep inspectable Material
accept-this          accept current Room truth
deliver-this         act through an explicit Route
archive-this         remove inactive Material from active context
```

Codex and Claude receive these as generated Skills and Commands. They operate
through provider-native tools and ordinary owned files; Endroit does not add a
persistent agent runtime. A missing native operation returns `blocked` rather
than simulating success.

[HACP](https://github.com/control-decks/human-agent-control-protocol) is an
independent draft semantic protocol. Endroit does not require it and never
infers a Card from ordinary conversation.

## What Endroit does not replace

- your agent or model;
- Codex, Claude or another runtime;
- Git and repository-native tooling;
- MCP servers and external permissions;
- your preferred planning or knowledge methodology;
- human judgment over what becomes durable or authoritative.

## Alpha boundaries

- Codex and Claude are the first qualified provider projections.
- The 0.8 workplace grammar is a breaking alpha change from 0.7.
- Submodules are recognized through their paths; Endroit does not manage their
  lifecycle.
- Remote delivery is confirmed only when the destination can be observed.
- Automated placement and semantic hygiene are not shipped in this alpha.
- Endroit makes no claim of improving model intelligence, hallucinations,
  costs or productivity.

The lock-in is intentionally low: the sources are files, Sites keep their own
repositories and generated projections can be discarded and rebuilt.

## Related reading

- [The Workplace-first Proposal](https://open-workplace.org/proposal/)
- [Harness engineering: leveraging Codex in an agent-first world](https://openai.com/index/harness-engineering/)
- [Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- [100 Tips & Tricks for building your own personal AI](https://www.reddit.com/r/ClaudeAI/comments/1thi6nh/100_tips_tricks_for_building_your_own_personal_ai/)

The external examples are related signals, not endorsements of Endroit.

## License

See the repository license.
