<div align="center">

# endroit

Endroit means “place” in French.

**You equipped the agent.**<br />
**Now own the place where you work together.**

Endroit is the open-source, local-first environment where you and the agents
you already use work from the same maps, decisions, methods and retained
results—across sessions and independent repositories.

**Different interfaces. Different runtimes. Same place. Same material.**

**Resume without starting over.** · **Change runtimes, keep the work.** ·
**Keep repositories independent.**

[Website](https://endroit.org) · [Home-first Proposal](https://thevzion.com/home-first/) · [Technical reference](docs/reference.md)

[![npm latest](https://img.shields.io/npm/v/%40endroit%2Fcli/latest?label=npm%20latest)](https://www.npmjs.com/package/@endroit/cli) [![CI](https://github.com/thevzion/endroit/actions/workflows/ci.yml/badge.svg)](https://github.com/thevzion/endroit/actions/workflows/ci.yml) [![MIT](https://img.shields.io/badge/license-MIT-d8996a.svg)](LICENSE)

<sub>Endroit 0.7 is an alpha. Keep each Home in a dedicated Git repository and inspect executable Asset runtimes before trusting them.</sub>

</div>

**Actively maintained and dogfooded.** Endroit is used to develop Endroit
itself. The [Roadmap](ROADMAP.md) separates what works today from what is being
qualified next.

## Why a Home

Plans get trapped in chats. Decisions must be explained again. Instructions
copied between repositories drift. Useful results lose their destination.

The workplace already exists. It forms accidentally from a working directory,
provider instructions, chat history, method-specific folders and whatever the
current repository has accumulated. Each addition can be reasonable while the
whole environment still has no explicit owner.

`AGENTS.md` and `CLAUDE.md` are good front doors into a repository. They become
insufficient when that repository is also expected to own the maps, decisions,
methods and retained work shared across sessions and other Targets. Adding
methodologies can help one workflow while giving each method another place for
plans, state and truth. The storage closet can be well organized and still be
the wrong owner for the whole workplace.

```text
Without a Home
repositories + copied setup + provider files + continuity in chats

With Endroit
one owned Home → your existing agents, methods and repositories
```

**Home-first** is the organizing paradigm. The Home owns the durable environment, Agent Runtimes own sessions and execution, and Targets retain product truth. Endroit is one open-source implementation of that model.

Plugins and MCP can give an agent access to systems. Memory can preserve
information. Endroit addresses a different layer: it makes the environment's
owners, routes, shared material and durable destinations explicit.

**A runtime gives the agent a working directory. A Home gives the work an
owned environment.**

**[Read the Home-first Proposal →](https://thevzion.com/home-first/)**

## What the environment owns

Home-first defines five responsibilities. Endroit gives them concrete,
inspectable owners without requiring another implementation to use its names.

| Home-first responsibility | Endroit implementation |
| --- | --- |
| **Places** | Home, Desk, Workspaces and Workstreams |
| **Orientation** | Front Door, Floor Plan, HUD and Maps |
| **Capabilities** | Assets, Capabilities and runtime Projections |
| **Material** | Documents, decisions and Artifacts |
| **Relationships** | Targets, Bindings, Handles and external systems |

**Material** is durable content that humans and agents can inspect and evolve
together. It is not every chat transcript and it never replaces live Target
truth. **Relationships** keep routes and authority explicit; a Target may own
source, history, actions and delivery rather than serving as only a
destination.

> Home-first defines what the environment must own. Endroit defines what those
> responsibilities are called and how they are implemented.

## Where Endroit fits

Products can span several layers. This is a responsibility map, not a call
stack. The examples clarify boundaries; they do not imply Endroit support or
endorsement.

```text
                                      HUMAN / TEAM
                         intent · judgment · approval · direction
                                            │
                                            ▼
┌──────────────────────────── 1. INTERACTION SURFACES ───────────────────────────┐
│ Desktop    Codex app · Claude Desktop · Hermes Desktop                        │
│ Editor     VS Code · Cursor · Windsurf · JetBrains                            │
│ Terminal   Codex CLI · Claude Code · Hermes TUI · Gemini CLI · Aider          │
│ Messaging  Web · Slack · Discord · Telegram · Linear                          │
└────────────────────────────────────────────┬──────────────────────────────────┘
                                             ▼
┌──────────────────────────── 2. AGENT RUNTIME / HOST ──────────────────────────┐
│ Codex · Claude Code · Hermes Agent · OpenCode · OpenClaw · Cline · Roo Code   │
│ session · permissions · sandbox · execution · tool dispatch · resume          │
└──────────────┬──────────────────────┬──────────────────────┬──────────────────┘
               │                      │                      │
               ▼                      ▼                      ▼
┌─ 3. MODEL / INFERENCE ─┐ ┌── 4. HARNESS / LOOP ──┐ ┌── 5. CONTEXT / MEMORY ─┐
│ GPT · Claude · Gemini  │ │ Codex/Claude/Hermes   │ │ chat history            │
│ Kimi · Llama · DeepSeek│ │ internal loops        │ │ compaction summaries    │
│ OpenAI · Anthropic     │ │ OpenAI Agents SDK     │ │ runtime memory          │
│ Google · OpenRouter    │ │ LangGraph · AutoGen   │ │ memory files · RAG      │
│ Ollama · vLLM          │ │ CrewAI · custom loops │ │ vector DB · context repo│
└────────────────────────┘ └───────────┬────────────┘ └─────────────────────────┘
                           ┌────────────┴─────────────┐
                           ▼                          ▼
              6. CAPABILITIES / ACCESS        7. METHODS / WORKFLOWS
              Agent Skills                    GSD
              plugins                         Spec Kit
              shell · Git · browser           Superpowers
              MCP · APIs · connectors         BMAD
              GitHub · Slack · Notion         HACP · team playbooks
                           \                          /
                            \ runtime applies these /
                             \ while working from  /
                                      ▼
╔═══════════════════════════════ 8. ENDROIT ═════════════════════════════════════╗
║ owned human-agent work environment                                            ║
║ Places · Orientation · Capabilities · Material · Relationships                ║
║ Home/Desk · Floor Plan/HUD/Maps · Assets · Documents/Artifacts · Bindings     ║
║ orientation · continuity · ownership · shared material · explicit authority   ║
╚══════════════════════════════════════╤════════════════════════════════════════╝
                                       │ routes to · maps · revalidates
                                       ▼
┌────────────────────── 9. TARGETS & EXTERNAL SYSTEMS ──────────────────────────┐
│ repositories · worktrees · GitHub/GitLab · databases · APIs · cloud          │
│ Jira · Notion · Slack · production systems · deployment platforms            │
│ live truth · authorization · product history · delivery                       │
└───────────────────────────────────────────────────────────────────────────────┘
```

> Humans direct. Interfaces mediate. Models reason. Runtimes execute.
> Harnesses loop. Skills equip. MCP connects. Memory recalls. Methods
> structure. Endroit orients and retains. Targets own the truth.

Distribution, automation and observability are lateral planes: they can cross
several layers without becoming Endroit's responsibility.

## Do you need a Home?

Endroit is worth trying when several of these feel familiar:

- you re-explain the same system map or accepted decisions in later sessions;
- the repository where a session starts is often not where the work belongs;
- provider instructions have been copied and now drift between repositories;
- changing Agent Runtime changes the apparent environment;
- plenty of context is reachable, but the agent still needs help choosing the
  relevant source;
- useful plans, maps or results have no obvious durable destination.

Endroit is probably unnecessary for one short session in one repository with
no continuity worth retaining. It may also cost more than it helps when a
second Git repository creates more ambiguity than the work itself.

If none of these signals sound familiar, keep your current setup. If several
do, try one subject and one Target before expanding the structure.

## Adopt without migrating your world

**Start by mapping, not migrating.**

```text
one Home → one existing Target → one current subject
         → one retained result → one resumed session
```

You do not migrate repositories into Endroit. Each Target keeps its source,
history and delivery. The Home gives the durable work between Targets an owner
and gives each retained result a destination.

Adoption is additive before it is transformative: the first useful outcome can
simply be a clearer map of the environment you already maintain. If the
structure does not earn its place, Endroit can disappear. Your Home remains
ordinary files and Git.

## Start with one Home

Requires Node.js 22 or newer, Git, and the Codex or Claude CLI.

```bash
npx --yes @endroit/cli@latest create my-home
cd my-home
codex
```

Use `claude` instead of `codex` if you prefer. The guided setup creates an ordinary Git repository:

```text
my-home/
├── HOME.md             shared constitution
├── workspaces/home/    decisions and improvements about this Home
├── assets/             installed capabilities
├── .desk/              personal continuity in Solo mode
├── AGENTS.md           generated Codex view
├── CLAUDE.md           generated Claude view
└── endroit.mjs         inspectable Home Console
```

Open the Home and describe your work in normal language. In a later session, reopen the same Home and name the subject again; its Floor Plan and Workspaces restore the context you chose to keep.

You do not need to reorganize existing repositories or design a methodology first. Run `$endroit-onboarding` in Codex or `/endroit-onboarding` in Claude when you want guided mapping.

## A map before the work

**Every session begins with a map, not a scavenger hunt.**

```text
human intent → Front Door → Floor Plan → HUD → relevant route → linked Material
```

The Front Door situates the agent in an owned environment; it does more than
attach instructions to a repository. The Floor Plan remains available without
live services. The optional HUD adds a current local snapshot; it is not
omniscient, and external truth is revalidated before mutation.

Humans and agents work from the same owned sources and contracts even when they use different interfaces. Models and runtimes may change without making the environment implicit again.

Endroit is **structurally explicit and conversational by default**. Open the
Home and describe the work normally. The agent can use the orientation it has,
discover the relevant Capability and propose durable continuity at a meaningful
milestone. Skills and commands remain precision surfaces when explicit control
is useful.

> A good abstraction hides mechanics—not ownership.

## Built for both sides of the work

**Skills make agents capable. A Home makes their work coherent.**

| Shared capability | For humans | For agents |
| --- | --- | --- |
| **Places** | Choose the owners and scopes of durable work | Return to a stable subject and route intent |
| **Orientation** | Inspect structure, local state and attention | Begin with a map and a bounded snapshot |
| **Capabilities** | Choose, install and approve what the Home can do | Discover actions without depending on one runtime surface |
| **Material** | Review and version durable shared work | Resume work and retain chosen results |
| **Relationships** | Keep independent systems and authority visible | Identify sources, actions and destinations |
| **Trust, Doctor and Projections** | Inspect executable code and diagnose drift | Know the limits and use a runtime-native interface |

Skills and commands remain useful runtime interfaces. Endroit keeps the underlying capability contract source-owned and projects the appropriate view for each qualified runtime.

## What you can do

The required first-party Assets provide Workspaces, guided Onboarding, the HUD,
inspectable Artifacts and explicit Targets. They let you organize durable
subjects, route work across existing repositories, keep chosen results and
diagnose the environment without turning the Home into a monorepo or remote
memory service.

Optional Assets add bounded kinds of work:

| Asset | Durable result |
| --- | --- |
| **Research** | Studies with findings, sources and revalidation triggers |
| **Planning** | Workspace Roadmaps and bounded Initiatives |
| **Publishing** | Exact Publications and observed external Handles |
| **Scratch** | Retained exploration that has earned continuity |

Assets equip the Home; they do not dictate an expertise methodology. BMAD,
Superpowers or another method can keep its own loops and files while using the
same owners, destinations and durable results.

**Endroit is opinionated about where work belongs, not about how every piece
of work must be done.**

The responsibility chain remains inspectable even when the interaction is
simple:

```text
Asset → Capability → Projection → Surface
      → conversation or command activation → Asset runtime → Artifact
```

The Asset owns reusable source. A Projection adapts it to a runtime. A Skill,
Command or instruction is a Surface, not the whole capability. The Artifact
retains a chosen result when the work has earned continuity.

## Bring the agents you already use

Runtime compatibility has two independent axes:

- **integration:** `native` uses a qualified runtime Projection or Bridge;
  `portable` uses the static Floor Plan, ordinary instruction files and the
  Home Console;
- **evidence:** `qualified` is maintained against the published gate;
  `observed` means a real workflow succeeded without a maintained-support
  guarantee; `candidate` has not produced that evidence yet.

| Agent Runtime | Integration | Evidence | What is known |
| --- | --- | --- | --- |
| Codex | `native` | `qualified` | Projection, Skills, hook and provider checks |
| Claude | `native` | `qualified` | Projection, Skills, hook and provider checks |
| [Hermes Agent](https://github.com/NousResearch/hermes-agent) 0.19.0 | `portable` | `observed` | A maintainer workflow used `AGENTS.md` and the Home Console on 2026-07-30 |
| [Kimi Code](https://www.kimi.com/code/) | to classify | `candidate` | No Endroit evidence yet |
| [OpenClaw](https://github.com/openclaw/openclaw) | to classify | `candidate` | No Endroit evidence yet |

An `observed` row is not a support promise. The Hermes observation is
anonymized and does not make it `qualified`.

Use another runtime? Try the portable path first, report the friction, then
open a
[Runtime support request](https://github.com/thevzion/endroit/issues/new?template=runtime-support.yml).
The [Roadmap](ROADMAP.md) defines the common qualification journey. Endroit
adds the smallest native adaptation only when evidence shows the portable path
is not enough.

## What lives where

| Place | What belongs there |
| --- | --- |
| **Home** | Shared rules, shared Workspaces, reusable capabilities and generated provider views |
| **Desk** | One collaborator's personal continuity and local repository links |
| **Workspace** | One durable subject, such as a product, research area or publication practice |
| **Target** | An independent repository that retains its source, history and delivery |

One Home means one coherent environment for a system of work, not one global Home for your entire life. The Home coordinates Targets without absorbing them into a monorepo.

Documents preserve ordinary continuity. Artifacts are chosen results. Assets equip future work.

**The Home keeps durable work and relationships locally addressable. Live truth, authorization and actions may remain in external systems.**

MCP servers and integrations provide live access and action. Endroit gives durable relationships an owned context and explicit authority; broader external references remain a direction beyond the contracts shipped today.

Agent Runtimes host sessions, models and tools. Endroit does not run, schedule or replace the agent; it owns the durable environment around its work.

Endroit is not a software-development, research or publishing methodology. Existing methods keep their loops and native files; the Home gives the material you retain an explicit owner and destination.

In **Solo** mode, personal continuity can share the Home Git history while local Bindings remain private. In **Team** mode, the Home is shared through Git and each collaborator can initialize or clone a private Desk.

## Endroit 0.7 today

The current alpha provides guided bootstrap, Workspaces, inspectable Artifacts, explicit Targets and Bindings, installable Assets, Publishing Handles, deterministic Codex and Claude views, a static Floor Plan, an optional live HUD and Doctor.

Generated provider files are rebuildable projections. Canonical sources remain ordinary files under your control. Digest trust detects changed runtime bytes; it is not a sandbox.

Endroit does not provide a model, scheduler, autonomous runtime, methodology, remote memory service, marketplace or live collaboration server. It does not claim measured improvements in reasoning quality, hallucinations, speed or cost.

The active [Roadmap](ROADMAP.md) is evidence-driven rather than date-driven.
Portable observations remain explicitly weaker than qualified, maintained
runtime paths.

## Engineer-first, not engineering-only

Engineers are natural early adopters because they can inspect ordinary files,
Git history, generated projections and executable runtimes. A Home can also
coordinate a research area, publication practice, operations domain or another
system of work.

Engineers can materialize the environment. Domain experts should still own the
rules, decisions and retained work of their domain.

## Go deeper

[Roadmap](ROADMAP.md) · [Technical reference](docs/reference.md) · [Architecture](docs/architecture.md) · [Lifecycles](docs/lifecycles.md) · [Security](SECURITY.md) · [Contributing](CONTRIBUTING.md)

MIT licensed.
