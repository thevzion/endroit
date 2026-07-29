<div align="center">

# hairness

## Get more from the agents you already use.

**Own the place where your agents work.**

**One Home. Your agents. Your methods. Your repositories.**

Hairness is the open-source framework and CLI that makes the missing environment around the Agent Runtimes you already use—not another agent.

**The local-first environment for durable human-agent collaboration.**

Hairness does not change the model. It gives the agents you already use an owned environment they can navigate and return to.

[Website](https://hairness.dev) · [Home-first Proposal](https://thevzion.com/home-first/) · [Technical reference](docs/reference.md)

[![npm latest](https://img.shields.io/npm/v/%40hairness%2Fcli/latest?label=npm%20latest)](https://www.npmjs.com/package/@hairness/cli) [![CI](https://github.com/thevzion/hairness/actions/workflows/ci.yml/badge.svg)](https://github.com/thevzion/hairness/actions/workflows/ci.yml) [![MIT](https://img.shields.io/badge/license-MIT-d8996a.svg)](LICENSE)

<sub>Hairness 0.6 is an alpha. Keep each Home in a dedicated Git repository and inspect executable Asset runtimes before trusting them.</sub>

</div>

**Actively maintained and dogfooded.** Hairness is used to develop Hairness
itself. The [Roadmap](ROADMAP.md) separates what works today from what is being
qualified next.

## Why a Home

Agent instructions, personal context, reusable methods and useful results tend to scatter across repositories, chats and provider-specific files.

```text
Without a Home
repositories + copied setup + provider files + continuity in chats

With Hairness
one owned Home → your existing agents, methods and repositories
```

**Home-first** is the organizing paradigm. The Home owns the durable environment, Agent Runtimes own sessions and execution, and Targets retain product truth. Hairness is one open-source implementation of that model.

**[Read the Home-first Proposal →](https://thevzion.com/home-first/)**

## Start with one Home

Requires Node.js 22 or newer, Git, and the Codex or Claude CLI.

```bash
npx --yes @hairness/cli@latest create my-home
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
└── hairness.mjs        inspectable Home Console
```

Open the Home and describe your work in normal language. In a later session, reopen the same Home and name the subject again; its Floor Plan and Workspaces restore the context you chose to keep.

You do not need to reorganize existing repositories or design a methodology first. Run `$hairness-onboarding` in Codex or `/hairness-onboarding` in Claude when you want guided mapping.

## A map before the work

**Every session begins with a map, not a scavenger hunt.**

```text
human intent → Floor Plan → HUD → relevant route → linked Documents
```

The Floor Plan remains available without live services. The optional HUD adds a current local snapshot; it is not omniscient, and external truth is revalidated before mutation.

Humans and agents work from the same owned sources and contracts even when they use different interfaces. Models and runtimes may change without making the environment implicit again.

## Built for both sides of the work

**Skills make agents capable. A Home makes their work coherent.**

| Shared capability | For humans | For agents |
| --- | --- | --- |
| **Home and Workspaces** | Understand the environment and choose its owners | Return to a stable starting point and route intent |
| **Floor Plan and HUD** | Inspect structure, local state and attention | Begin with a map and a bounded snapshot |
| **Assets and Capabilities** | Choose, install and approve what the Home can do | Discover the actions available in this environment |
| **Documents and Artifacts** | Review, version and promote durable results | Resume work and persist it at the right destination |
| **Targets and Bindings** | Keep repositories independent and locally controlled | Identify the relevant sources and destinations |
| **Trust, Doctor and Projections** | Inspect executable code and diagnose drift | Know the limits and use a runtime-native interface |

Skills and commands remain useful runtime interfaces. Hairness keeps the underlying capability contract source-owned and projects the appropriate view for each qualified runtime.

## What you can do

The required first-party Assets provide Workspaces, guided Onboarding, the HUD,
inspectable Artifacts and explicit Targets. They let you organize durable
subjects, connect existing repositories, keep chosen results and diagnose the
environment without turning the Home into a monorepo or remote memory service.

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

## Bring the agents you already use

Codex and Claude are qualified today. [Kimi Code](https://www.kimi.com/code/),
[Hermes Agent](https://github.com/NousResearch/hermes-agent) and
[OpenClaw](https://github.com/openclaw/openclaw) are being evaluated as
different Agent Runtime shapes, but they are not supported integrations.

Use another runtime? Open a
[Runtime support request](https://github.com/thevzion/hairness/issues/new?template=runtime-support.yml).
The [Roadmap](ROADMAP.md) defines the common qualification journey and shows
which candidates have evidence. `Candidate` never means promised support.

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

MCP servers and integrations provide live access and action. Hairness gives durable relationships an owned context and explicit authority; broader external references remain a direction beyond the contracts shipped today.

Agent Runtimes host sessions, models and tools. Hairness does not run, schedule or replace the agent; it owns the durable environment around its work.

Hairness is not a software-development, research or publishing methodology. Existing methods keep their loops and native files; the Home gives the material you retain an explicit owner and destination.

In **Solo** mode, personal continuity can share the Home Git history while local Bindings remain private. In **Team** mode, the Home is shared through Git and each collaborator can initialize or clone a private Desk.

## Hairness 0.6 today

The current alpha provides guided bootstrap, Workspaces, inspectable Artifacts, explicit Targets and Bindings, installable Assets, Publishing Handles, deterministic Codex and Claude views, a static Floor Plan, an optional live HUD and Doctor.

Generated provider files are rebuildable projections. Canonical sources remain ordinary files under your control. Digest trust detects changed runtime bytes; it is not a sandbox.

Hairness does not provide a model, scheduler, autonomous runtime, methodology, remote memory service, marketplace or live collaboration server. It does not claim measured improvements in reasoning quality, hallucinations, speed or cost.

The active [Roadmap](ROADMAP.md) is evidence-driven rather than date-driven.
Runtime candidates remain unsupported until they pass the same activation and
continuity gate as the qualified runtimes.

## Go deeper

[Roadmap](ROADMAP.md) · [Technical reference](docs/reference.md) · [Architecture](docs/architecture.md) · [Lifecycles](docs/lifecycles.md) · [Security](SECURITY.md) · [Contributing](CONTRIBUTING.md)

MIT licensed.
