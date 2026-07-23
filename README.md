<div align="center">

# hairness

### Own the place where your agents work.

**A provider can host the agent. It shouldn't own the Home.**

Not another autonomous agent. A Home for the agents and workflows you already use.

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
      repositories as shared Targets, bind these checkouts on this machine,
      select api as the active Target, then rebuild and run Doctor.
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
npx --yes @hairness/cli@0.5.0-alpha.0 target use api
npx --yes @hairness/cli@0.5.0-alpha.0 asset add @hairness/scratch -y
npx --yes @hairness/cli@0.5.0-alpha.0 build
npx --yes @hairness/cli@0.5.0-alpha.0 doctor
```

Hairness installed no daemon. Asset installation copied and validated files;
it ran no Asset code.

</details>

## The model may be a black box. The Home doesn't have to be.

Run the HUD at session start or ask for it at any point:

```bash
hairness hud
```

```text
HOME        ness-home · solo
DESK        alexis
PROVIDERS   codex · claude
ASSETS      3
SURFACES    instruction:1 · skill:4 · command:3 · cli:19 · artifact:1
GIT         main · clean · 1 worktrees
TARGETS     3/3 bound
ACTIVE      api · main · clean
HEALTH      ready
```

`hairness hud --full` lists the Assets, Instructions, Skills, Commands, CLI
routes, Artifact kinds, owners, provider-by-provider projections and context
footprint.
`hairness hud --json` exposes the same resolved state to tools. The Kernel reads
safe probes and never executes Asset code while it builds the HUD.

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
│   └── targets/                           # ignored machine bindings
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

The Home gives the team one shared environment. Each Desk holds one
collaborator's preferences, experimental Assets, private Artifacts and local
repository bindings.

## The framework

Hairness draws one boundary:

> **The Kernel owns grammar, composition and safety. Assets own meaning, capabilities and surfaces.**

The Kernel ships in one package, `@hairness/cli`. It validates documents,
resolves the Home, applies file transactions, projects provider files and
confines approved executable output.

Assets define what the Home can do:

| Asset section | Purpose |
|---|---|
| `instructions` | Invariant context loaded for the session |
| `capabilities` | Provider-neutral procedures |
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
    { "id": "review", "source": "capabilities/review.md" }
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

A collaborator can test an Asset under `.desk/assets/`, then publish it into
the shared Home:

```bash
hairness asset publish personal/security-improvement
git diff
```

The move removes local provenance. Git review and your team governance take
over.

## Artifacts are work, Assets are reusable capability

Assets describe repeatable practice. Artifacts record what you produced:

```bash
hairness artifact create company/planning:plan q3-roadmap
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

## Targets hold the work

The Home provides context. Targets remain independent Git repositories:

```bash
hairness target add ~/Projects/payments-api
hairness target add ~/Projects/customer-web
hairness target add ~/Projects/ops-handbook
hairness target use payments-api
```

The shared Home stores normalized repository identities. Your Desk stores
symlinks to local checkouts. The HUD reports the active Target, branch,
worktree count and dirty state, but Hairness does not import Target source into
the Home.

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
