# Endroit

> A more intuitive way to work with agents.

## New session. Same workplace.

Your way of working stays. Each agent adapts at the door.

**Places make intent legible. Gestures make it explicit.**

Say what you want to work on in normal conversation:

> Continue the Endroit 0.8 launch.

The provider Front Door exposes the Home Floor Plan and its routing rules. The
agent can resolve the relevant Room or ask when the subject is ambiguous, then
inspect retained Material, available Equipment and declared Sites.

**The place layer for agentic work.**

Endroit is a lightweight, local-first framework for building and operating
file-based [Open Workplaces](https://open-workplace.org/proposal/). It is also
a local-first, headless, file-based implementation of the Open Workplace
model.

It gives human-agent work an owned place across sessions, tools and
repositories without moving that work into a persistent agent, proprietary
memory service or orchestration runtime.

> **Alpha — usable, actively maintained and dogfooded.** Endroit is pre-1.0.
> Its ownership and safety contracts are deliberate; its public grammar and
> schemas may still change through explicit releases and migration notes.

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
- **Keep:** retain, accept or archive Material.
- **Reach:** revalidate a Site Route and deliver explicitly.
- **Maintain:** inspect the Home read-only and approve a bounded repair.

Endroit makes placement inferable, explainable and correctable. It does not
infer intent, personalize the model or organize work without human authority.

## Start a Home

Requirements: Git and Node.js 22 or newer. Endroit currently ships L1
Projection-qualified surfaces for Codex and Claude.

### Install with your agent

Give Codex or Claude this instruction:

```text
Read https://endroit.org/install.md and set up Endroit here.
Explain the plan and ask before changing anything.
```

The versioned source of that public contract is [INSTALL.md](INSTALL.md). The
agent inspects and explains; the pinned Endroit CLI applies only the approved
operation.

> **Agent-led. CLI-backed. Human-approved.**
>
> The agent guides. The CLI applies. The human approves.

### Use the terminal

Create a standalone Home:

```bash
npx --yes --package @endroit/cli@0.8.0-alpha.0 endroit create my-home
```

`create` adds a Home-owned Member and, by default, a Desk tracked with the
Home. Use `--desk separate` for a private nested Desk repository or
`--desk later` to defer the Desk.

Or add a Home to an existing repository:

```bash
cd my-existing-repository
npx --yes --package @endroit/cli@0.8.0-alpha.0 endroit init .
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

`create` and `init` install seven inspectable foundation Equipment packages:

- `endroit/onboarding` — consent-first setup and explanation;
- `endroit/hud` — live orientation over the static Floor Plan;
- `endroit/workplace` — entry and workplace gestures;
- `endroit/artifacts` — durable Artifact lifecycle;
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

For an `existing` Route, `route mount` can create a rebuildable symlink at
`checkouts/<site>/<route>/`; `route unmount` removes only that symlink. A Mount
is never the identity of the Site or Route and never grants new permissions.

For a submodule, the Home Git repository owns the Gitlink commit pin and its
`.gitmodules` declaration. Checkout initialization and submodule lifecycle
remain user-owned.

Example guarded operations:

```bash
node ./endroit.mjs site add https://github.com/acme/product.git --id product
node ./endroit.mjs route clone product --id main
node ./endroit.mjs route worktree product --id feature --from main --new-branch feature
node ./endroit.mjs route bind product ../product --id existing
node ./endroit.mjs route mount product --id existing
node ./endroit.mjs site doctor
```

## Explicit Workplace gestures

The bundled Workplace Equipment projects inspectable activation surfaces for
the 0.8 journey:

```text
call-the-researcher   add a temporary Occupant when the provider can do so
work-as-an-engineer  adopt a Role for one Meeting
use-research         activate Equipment
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
