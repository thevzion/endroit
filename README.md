<div align="center">

# hairness

### Own the place where your agents work.

**A provider can host the agent. It shouldn't own the Home.**

Not another autonomous agent. A Home for the agents and workflows you already use.

<sub>A lightweight framework for source-owned, portable agent work environments.</sub>

[![npm next](https://img.shields.io/npm/v/%40hairness%2Fcli/next?label=npm%20next)](https://www.npmjs.com/package/@hairness/cli)
[![CI](https://github.com/thevzion/hairness/actions/workflows/ci.yml/badge.svg)](https://github.com/thevzion/hairness/actions/workflows/ci.yml)
[![MIT](https://img.shields.io/badge/license-MIT-d8996a.svg)](LICENSE)

<sub>0.5 is alpha software. Keep your Home in Git and review executable Assets before approving them.</sub>

</div>

## Ness needed a Home

Ness is the agent. You are the person who owns the Home.

Without Hairness, Ness arrives in a provider folder full of instructions,
commands and memory from previous sessions. You can use it, but you struggle to
answer basic questions: Which files define the agent's behavior? Which project
can it touch? What did your team share? What will survive a provider change?

Hairness creates a small, usable Home. Ness finds a floor plan, a welcome guide
and the tools required to improve it. Together, you decide what the Home
becomes.

```bash
npx --yes @hairness/cli@0.5.0-alpha.0 create ness-home
codex -C ness-home
# or: cd ness-home && claude
```

Invoke onboarding inside the agent:

```text
$hairness-onboarding
# Claude Code: /hairness-onboarding
```

```text
You: I work in French. My projects are ~/Projects/api,
     ~/Projects/web and ~/Projects/handbook.

Ness: I can save that preference in your Desk, declare the three
      repositories as shared Targets, create one local Binding for each
      checkout, map api, then rebuild and run Doctor.
      I will show you each change first. Shall I proceed?

You: Yes. Add Scratch too.
```

<details>
<summary><strong>What did Ness do?</strong></summary>

The onboarding Capability asked for consent, then called the exact runtime
declared by the Home:

```bash
npx --yes @hairness/cli@0.5.0-alpha.0 target add ~/Projects/api
npx --yes @hairness/cli@0.5.0-alpha.0 target add ~/Projects/web
npx --yes @hairness/cli@0.5.0-alpha.0 target add ~/Projects/handbook
npx --yes @hairness/cli@0.5.0-alpha.0 target map api
npx --yes @hairness/cli@0.5.0-alpha.0 asset add @hairness/scratch -y
npx --yes @hairness/cli@0.5.0-alpha.0 build
npx --yes @hairness/cli@0.5.0-alpha.0 doctor
```

Hairness installed no daemon. Asset installation copied and validated files;
it ran no Asset code.

</details>

In the examples below, `hairness` means the exact `npx --yes
@hairness/cli@0.5.0-alpha.0` runtime declared by the Home. Ness uses that exact
runtime; the shorter form keeps the examples readable.

## The model may be a black box. The Home doesn't have to be.

When Ness wakes up in the Home, the provider hook injects an XML HUD. Ness gets
its bearings before searching through folders or guessing what is available.
The agent can request it again as the session changes. The same state remains
human-readable from the terminal:

```bash
hairness hud
```

```text
HOME        ness-home · solo · @hairness/cli@0.5.0-alpha.0
DESK        alexis
PROVIDERS   codex · claude
ASSETS      3
SURFACES    instruction:1 · capability:5 · skill:5 · command:4 · cli:20 · artifact:2
ARTIFACTS   1 · desk:1
GIT         main · clean · +0/-0 · 1 worktrees · 2h ago
TARGETS     3 declared · 3 bindings · 3 worktrees
  api          api:bound/clean · map:current
  handbook     handbook:bound/clean · map:missing
  web          web:bound/clean · map:missing
CONTEXT     instructions:436B · desk:0B · skills:381B · hud:782B
HEALTH      ready
```

The formats have different jobs:

| Form | Consumer | Purpose |
|---|---|---|
| `hud` | Human | Dense, scannable orientation |
| `hud --prompt` | Agent | XML facts injected at session start |
| `hud --json` | Tools | Stable machine-readable state |
| `hud --full` | Human or agent | Owners, surfaces, projections and exact evidence |

The Kernel uses local, safe probes. It performs no network request and executes
no Asset while building the HUD.

The session hook calls `hud --prompt`. It gives Ness shared Home Instructions,
your Desk Instructions and live orientation without copying private Desk data
into `AGENTS.md` or `CLAUDE.md`.

## One tree, named owners

```text
ness-home/
├── hairness.json                         # shared Home composition
├── assets/
│   ├── hairness/
│   │   ├── home/asset.json               # onboarding, Desk, HUD, Artifacts
│   │   ├── targets/asset.json            # Target grammar and CLI
│   │   └── scratch/asset.json            # opt-in working memory
│   └── company/
│       └── engineering/asset.json         # your source-owned material
├── artifacts/
│   └── company/planning/plan/q3/artifact.md
├── AGENTS.md                              # tracked Codex projection
├── CLAUDE.md                              # tracked Claude projection
├── .agents/skills/                        # tracked Codex Skills
├── .claude/skills/                        # tracked Claude Skills
├── .codex/hooks.json
├── .claude/settings.json
│
├── .desk/
│   ├── desk.json                          # identity and personal settings
│   ├── assets/                            # local experiments
│   ├── artifacts/                         # private work in progress
│   └── targets/                           # ignored named Bindings
└── .hairness/
    ├── build.json                         # generated output ownership
    └── approvals.json                     # local executable trust by digest
```

Git tracks shared Assets and provider projections. A clone can open in Codex or
Claude before rebuilding. `.hairness/` stays local.

A solo Home tracks its Desk in the same repository. A team Home ignores
`.desk/` in the parent and lets each collaborator create or clone a private Desk
repository:

```bash
npx --yes @hairness/cli@0.5.0-alpha.0 create engineering-home --mode team
hairness desk init --id alexis
# or: hairness desk clone git@github.com:alexis/engineering-desk.git
```

**Ness lives in the Home. You work together from your Desk.**

The provider gives you a window to the agent. The Desk gives one collaborator
an owned place to resume that collaboration: preferences, experimental Assets,
private Artifacts and local Bindings. Ness can use those materials natively,
but they do not become team material until you publish them. The Home can be
ours. The Desk is yours. In Hairness terms: **Desk = Collaborator × Home**.

## The framework

Hairness draws one boundary:

> **The Kernel owns grammar, composition and safety. Assets own meaning, capabilities and surfaces.**

The architecture is deliberately small: **HAT — Home, Asset, Target**.

| Primitive | Owns |
|---|---|
| Home | The portable environment and shared agentic material |
| Asset | Reusable meaning, capability and surface |
| Target | Independent work that Hairness connects without polluting |

**Target Sovereignty** means the work repository keeps its own structure and
lifecycle. The Home connects to it through local Bindings; it does not turn the
Target into a Hairness repository.

**Projection Inversion** means provider files are outputs, never the canonical
source. Assets declare provider-neutral meaning and the Kernel projects only
what Codex, Claude or another host needs.

The Kernel ships in one package, `@hairness/cli`. It validates documents,
resolves the Home, applies file transactions, projects provider files and
confines approved executable output.

Assets define what the Home can do:

| Asset section | Purpose |
|---|---|
| `instructions` | Invariant context loaded for the session |
| `capabilities` | Provider-neutral procedures with an optional bounded contract |
| `skills` | Model access to a Capability |
| `commands` | Human access to a Capability |
| `references` and `files` | Material loaded when needed |
| `artifactKinds` | Schemas, states, owners and templates |
| `cli` | Namespaces and routes |
| `hud` | Safe Kernel probes shown in the HUD |
| `settings` and `setup` | Home or Desk configuration |
| `executables` | Approved code with staged, declared output |

`instructions/` and `capabilities/` are readable conventions. The manifest
declares their role; folder names carry no hidden behavior.

### One Capability, two invocation policies

A Capability contains the procedure once:

```json
{
  "$schema": "https://hairness.dev/schema/asset.json",
  "name": "company/security",
  "version": "1.2.0",
  "description": "Company security review material.",
  "prefix": "security",
  "capabilities": [
    {
      "id": "review",
      "source": "capabilities/review.md",
      "contract": {
        "inputs": ["target"],
        "requires": ["binding"],
        "produces": ["report"],
        "effects": ["read-target"]
      }
    }
  ],
  "skills": [
    {
      "id": "review",
      "capability": "review",
      "description": "Use when a change needs a security review."
    }
  ],
  "commands": [
    {
      "id": "review",
      "capability": "review",
      "summary": "Review a change against company security policy."
    }
  ]
}
```

The canonical identity is `company/security:review`. With the default Home
prefix, providers see `hairness-security-review`.

A Skill lets the model invoke a Capability. A Command reserves human
invocation. Declaring both supports both paths without duplicating the
procedure. Hairness warns when a provider cannot preserve the distinction and
omits the broader projection until you record consent.

### Assets stay source-owned

Install from a source you trust:

```bash
hairness asset add company/agentic-assets/assets/security#v1.2.0
hairness asset add company/agentic-assets/assets/security#8d31f3c7f05f4c6fd4a15ad31f4d23ff9d472312
hairness asset add https://assets.example.com/security/asset.json
hairness asset add ./security/asset.json
```

Hairness copies the Asset into your repository and records its origin and base
digests inside `asset.json`. You can open every source file:

```bash
$EDITOR assets/company/security/capabilities/review.md
git diff
hairness asset status company/security
```

```text
company/security: customized
```

`hairness asset sync` updates an intact Asset in one transaction. A local edit
blocks the sync and produces a diff. Hairness does not merge or overwrite that
edit without explicit consent.

A collaborator can create a new Asset under `.desk/assets/` or explicitly
override a shared Asset without changing the team source:

```bash
hairness asset override company/security
$EDITOR .desk/assets/company/security/capabilities/review.md
hairness asset diff company/security
hairness build
```

The Desk version is now provider-native for that collaborator. The HUD marks
the override and keeps the Home digest used as its base. To govern it:

```bash
hairness asset publish company/security --to home
git diff
```

Publication blocks if the Home changed since the override began. Otherwise it
replaces the Home source transactionally, removes the Desk override and leaves
the resulting diff to Git review. `hairness asset remove company/security`
abandons the Desk override and reveals the unchanged Home source again. There
is no automatic merge.

## Artifacts are work, Assets are reusable capability

Assets describe repeatable practice. Artifacts record what you produced:

```bash
hairness artifact create company/planning:plan q3-roadmap
hairness artifact create hairness/scratch:scratch api-notes --from .hairness/staging/api-notes
hairness artifact validate q3-roadmap
hairness artifact publish q3-roadmap --owner home
```

Each `artifact.md` carries a small envelope:

```yaml
---
$schema: https://hairness.dev/schema/artifact.json
id: q3-roadmap
kind: company/planning:plan
owner: desk
state: draft
createdBy: alexis
---
```

The owning Asset defines the kind's schema, states, templates and allowed
owners. A Desk Artifact can stay private, move into the Home or publish into a
bound Target. Publication preserves the Desk source and adds lineage. A
Capability can derive a new Artifact from an earlier one.

Teams compound their agentic material through this loop:

```text
work in the Desk → produce Artifacts → notice a repeated practice
→ write or improve an Asset → review it in Git → reuse it across Homes
```

This is **Context Mining**:

> Context is temporary. Knowledge should compound.

Do not hoard conversations. Distill what matters, own the Artifact, and turn
repeated value into an Asset. Over time, that source-owned material becomes
agentic capital: the organization's inspectable capacity to help agents
understand and act within its domain.

## Targets hold the work

The Home provides context. Targets remain independent Git repositories:

```bash
hairness target add ~/Projects/payments-api
hairness target add ~/Projects/customer-web
hairness target add ~/Projects/ops-handbook
hairness target bind payments-api ~/Worktrees/payments-auth --binding auth
hairness target map payments-api --binding auth
```

The Home stores normalized repository identities. A Target can remain
`declared`, be cloned as a `managed` Binding or connect to an existing checkout
as a `bound` Binding. One Target may have several named Bindings and worktrees;
operations require `--binding` only when the choice is ambiguous.

A Target needs no Hairness files, provider projections or agent instructions.
Those stay in the Home. Hairness writes into a Target only when you explicitly
publish an Artifact kind whose Asset declares a Target destination.

`target map` reads one Binding and creates a private Target Map Artifact with
STACK, INTEGRATIONS, ARCHITECTURE, STRUCTURE, CONVENTIONS, TESTING and
CONCERNS. The map records the exact commit, evidence and uncertainty. It never
writes into the Target.

## Bring the stack you already use

Hairness gives different tools a shared place and grammar:

| Existing layer | Examples | Hairness relationship |
|---|---|---|
| Agent provider | Codex, Claude | Hosts Ness and consumes projections |
| Autonomous runtime | OpenClaw and schedulers | Connects through an Asset and approved executable when needed |
| Methodology | GSD, Spec Kit, Superpowers | Keeps its workflow; an Asset maps its surfaces and outputs |
| Tool protocol | MCP | Connects as an Integration |
| Human-agent collaboration | HACP | Shapes collaboration without owning the Home |
| Skill or agent library | local Skills, team agent collections | Enters the Home as source-owned Assets |
| Work repository | service, game, handbook | Stays independent as a Target |

Hairness does not replace a provider, methodology or runtime. It gives your
agents one inspectable environment around those choices. Change provider and
keep the Home. Use two methodologies without forcing either one to organize the
whole repository.

## What you can inspect

```bash
hairness validate --json    # deterministic Resolved Home
hairness hud --full         # current surfaces and live orientation
hairness doctor --json      # contract, projection and binding health
hairness build --check      # tracked projections match the Home
```

The Resolved Home has no lockfile. `validate`, `build`, `hud` and `doctor` all
calculate the same model from the files you own. Optional byte budgets can cap
Instructions, model-facing descriptions and the HUD prompt.

Asset executables stay inert during install, sync, resolution, setup and HUD
rendering. Their first run requires approval for the current Asset digest.
Hairness runs Node executables with filesystem access limited to their Asset
and staging directory, promotes declared output and revokes approval after any
Asset change.

## Scope of the alpha

A provider Project may cover a small setup that stays with one provider.
Hairness serves people who need a portable Home, several Targets, personal and
shared layers, or an environment their team can inspect in Git.

The alpha has no marketplace, Registry, dependency solver, daemon, automatic
update or automatic merge. HTTPS and Git addresses distribute Assets. Git
provides history, review and recovery.

Read the [architecture](docs/architecture.md),
[lifecycles](docs/lifecycles.md), [technical reference](docs/reference.md) and
[security policy](SECURITY.md) before using Hairness with sensitive material.

## License

MIT
