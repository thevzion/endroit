# Endroit

> Give agentic work a place to compound.

Endroit is a local-first, headless framework for durable human-agent
workplaces.

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

Technical formats tell agents what to read or execute. Home-first names who
owns each responsibility before it is projected.

> `AGENTS.md` guides an agent. Skills equip it. Endroit gives the work a
> place, an owner and a destination.

The pieces were already there. They just needed a place.

## Make the workplace first-class

Most current setups concentrate on two useful questions:

```text
Prompt-centric  What should I tell the model?
Agent-centric   What should the agent have?
```

Home-first adds a different architectural question:

> What should the durable workplace own?

These are composable centers of attention, not three formal paradigms or a
historical sequence. Agent-centric design equips the occupant. Home-first
equips the place.

It makes the workplace first-class through identity, ownership, composition,
time and sovereignty.

The agent can change. The provider can change. The method can change. The
owned workplace, its material and its relationships remain inspectable by the
human.

## Start a Home

Requirements: Git and Node.js 22 or newer. Endroit currently ships
first-class projections for Codex and Claude.

Create a standalone Home:

```bash
npx @endroit/cli create my-home
```

Or add a Home to an existing repository:

```bash
cd my-existing-repository
npx @endroit/cli init
```

The standalone bootstrap is intentionally small:

```text
my-home/
├── endroit.json
├── HOME.md
├── rooms/
│   └── home/
│       ├── ROOM.md
│       └── inbox.md
├── equipment/
├── sites/
├── .desk/
│   ├── DESK.md
│   ├── rooms/
│   ├── routes/        local and ignored
│   └── sites/         local and ignored
├── endroit.mjs
├── AGENTS.md        generated
├── CLAUDE.md        generated
├── .agents/         generated
├── .claude/         generated
└── .endroit/        local and rebuildable
```

The initial human-authored orientation is concentrated in four sources:

- `endroit.json` declares the Home and providers;
- `HOME.md` contains shared house rules;
- `rooms/home/ROOM.md` gives the first durable domain a purpose;
- `.desk/DESK.md` carries your personal continuity.

`create` and `init` also install five inspectable foundation Equipment:
Onboarding, HUD, Artifacts, Rooms and Sites. Additional Rooms, Sites and
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

The durable workplace and trust boundary. A Home owns shared composition and
house rules. `HOME.md` is one source inside the Home; it is not the whole Home.

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
| Managed clone | checkout stored under `.desk/sites/` |
| Managed worktree | linked worktree stored under `.desk/sites/` |
| Existing checkout | repository already present elsewhere |
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

Endroit 0.8 resolves each checkout from its Route directly. It neither requires
nor generates a symlink as the identity of a Site.

## Core and optional Equipment

The Endroit Core resolves and validates the workplace, builds projections and
manages safe local Routes. For example:

```bash
node ./endroit.mjs site add https://github.com/acme/product.git --id product
node ./endroit.mjs route clone product --id main
node ./endroit.mjs route worktree product --id feature --from main --new-branch feature
node ./endroit.mjs site doctor
```

First-party Equipment adds optional experiences such as research, planning,
publishing, orientation, inspection and maintenance. It is installed and
adapted independently. Endroit is opinionated about ownership, not about which
methodology you must use.

You can bring GSD, Spec Kit, BMAD, Superpowers, LifeOS-style practices or your
own Markdown conventions. They equip Rooms; they do not need to become the
Home’s ontology.

## HACP: explicit verbs, optional protocol

The workplace provides nouns and ownership. HACP can provide explicit verbs.

```text
call-researcher   add an occupant
work-as-engineer  adopt a role
use-research      activate equipment
retain            keep material
accept            accept room truth
deliver           act through a route
```

[HACP](https://github.com/control-decks/human-agent-control-protocol) is an
independent draft semantic protocol. Endroit does not require it and never
infers a Card from ordinary conversation.

The verbs above are illustrative Home-native vocabulary. Neither Endroit nor
HACP ships those commands today.

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

- [The Home-first Proposal](https://thevzion.com/home-first/)
- [Harness engineering: leveraging Codex in an agent-first world](https://openai.com/index/harness-engineering/)
- [Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- [100 Tips & Tricks for building your own personal AI](https://www.reddit.com/r/ClaudeAI/comments/1thi6nh/100_tips_tricks_for_building_your_own_personal_ai/)

The external examples are related signals, not endorsements of Endroit.

## License

See the repository license.
