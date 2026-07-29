<div align="center">

# hairness

## Own the place where your agents work.

**One Home. Your agents. Your methods. Your repositories.**

Hairness is the missing environment layer around the Agent Runtimes you already use—not another agent.

Every agent already works in an environment. Without a Home, that environment forms accidentally across repositories, sessions and provider settings. Hairness makes it explicit, inspectable and yours.

Hairness is the local-first logistics layer for durable human-agent work.

[Website](https://hairness.dev) · [Home-first Proposal](https://thevzion.com/home-first/) · [Technical reference](docs/reference.md)

[![npm latest](https://img.shields.io/npm/v/%40hairness%2Fcli/latest?label=npm%20latest)](https://www.npmjs.com/package/@hairness/cli) [![CI](https://github.com/thevzion/hairness/actions/workflows/ci.yml/badge.svg)](https://github.com/thevzion/hairness/actions/workflows/ci.yml) [![MIT](https://img.shields.io/badge/license-MIT-d8996a.svg)](LICENSE)

<sub>Hairness 0.6 is an alpha. Keep each Home in a dedicated Git repository and inspect executable Asset runtimes before trusting them.</sub>

</div>

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

## What lives where

| Place | What belongs there |
| --- | --- |
| **Home** | Shared rules, shared Workspaces, reusable capabilities and generated provider views |
| **Desk** | One collaborator's personal continuity and local repository links |
| **Workspace** | One durable subject, such as a product, research area or publication practice |
| **Target** | An independent repository that retains its source, history and delivery |

One Home means one coherent environment for a system of work, not one global Home for your entire life. The Home coordinates Targets without absorbing them into a monorepo.

Documents preserve ordinary continuity. Artifacts are chosen results. Assets equip future work.

## Where Hairness fits

```text
Human
  ↓
Agent Runtime
  ↓
Hairness Home
  ↓
Repositories and external systems
```

Agent Runtimes host sessions, models and tools. Hairness does not run, schedule or replace the agent; it owns the durable environment around its work.

Codex and Claude are qualified today. [OpenClaw](https://github.com/openclaw/openclaw) and [Hermes](https://github.com/NousResearch/hermes-agent) fit the Agent Runtime role in this topology, but they are not supported integrations. Supporting another runtime requires a dedicated, qualified Projection or Bridge.

Hairness is not a software-development, research or publishing methodology. Existing methods keep their loops and native files; the Home gives the material you retain an explicit owner and destination.

## Solo and team

In **Solo** mode, personal continuity can share the Home Git history while local Bindings remain private. In **Team** mode, the Home is shared through Git and each collaborator can initialize or clone a private Desk. A Team Home remains usable before a Desk is configured.

## Hairness 0.6 alpha

The current alpha provides guided bootstrap, Workspaces, inspectable Artifacts, explicit Targets and local Bindings, installable Assets, deterministic Codex and Claude views, a static Floor Plan, an optional live HUD and Doctor.

Generated provider files are rebuildable projections. Canonical sources remain ordinary files under your control.

Digest trust detects changed runtime bytes; it is not a sandbox. Approved Asset runtimes and provider sessions execute with your user permissions.

Hairness does not provide a model, scheduler, autonomous runtime, methodology, remote memory service, marketplace or live collaboration server. It does not claim measured improvements in reasoning quality, hallucinations, speed or cost.

## Go deeper

[Technical reference](docs/reference.md) · [Architecture](docs/architecture.md) · [Lifecycles](docs/lifecycles.md) · [Security](SECURITY.md) · [Contributing](CONTRIBUTING.md)

MIT licensed.
