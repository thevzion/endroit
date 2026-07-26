<div align="center">

# hairness

### Own the place where your agents work.

Hairness gives the agents you already use a Home you own. Keep working in Codex
or Claude while your repositories stay where they are. The Home keeps context
stable and capabilities reusable across independent repositories, while
results remain inspectable.

**A provider can host the agent. It shouldn’t own the Home.**

Codex and Claude today. Provider-neutral sources by design.

[![npm latest](https://img.shields.io/npm/v/%40hairness%2Fcli/latest?label=npm%20latest)](https://www.npmjs.com/package/@hairness/cli)
[![CI](https://github.com/thevzion/hairness/actions/workflows/ci.yml/badge.svg)](https://github.com/thevzion/hairness/actions/workflows/ci.yml)
[![MIT](https://img.shields.io/badge/license-MIT-d8996a.svg)](https://github.com/thevzion/hairness/blob/main/LICENSE)

<sub>Hairness 0.5 is an alpha. Keep the Home in a dedicated Git repository and inspect an Asset runtime before trusting it.</sub>

</div>

Create one Home beside your existing repositories, then bind the checkouts you
need as Targets. Their history and delivery process stay with them. The
built-in Floor Plan and HUD provide value before you design a custom Asset.

Ness is the character in these illustrations: the first agent to get a Home.

![Nine comic frames show target-first agent work becoming a source-owned Home with a Front Door, personal Desks, reusable Assets, inspectable Artifacts, independent Targets and accumulated agentic capital.](https://raw.githubusercontent.com/thevzion/hairness/main/docs/assets/hairness-home-first-journey.webp)

## Most agent sessions start inside a repository

You open Codex or Claude in a repository. The provider starts a session there,
loads local instructions and treats that working directory as the agent’s
environment.

That path works for one repository. Across an API, an application and
documentation, each repository becomes an accidental Home. Collaborators copy
methods between projects, rebuild context and leave useful results in separate
sessions.

```text
Target-first

Provider ──> agent inside payments-api
Provider ──> agent inside product-app
Provider ──> agent inside documentation
```

![Three collaborators and three Ness sessions work inside separate API, web application and documentation repositories while methods move between them by hand.](https://raw.githubusercontent.com/thevzion/hairness/main/docs/assets/hairness-target-first.webp)

Hairness gives the environment its own source-owned repository. Providers
bring the agent to the Home’s Front Door. Each collaborator uses a personal
Desk, equips shared Assets and reaches product repositories through explicit
Bindings.

```text
Home-first

Providers ──> Front Door ──> Home
                              ├── shared Assets
                              ├── Home Artifacts
                              ├── active Desk
                              └── Bindings ──> independent Targets
```

![Three collaborators and Ness work inside one source-owned Home with a Front Door, Floor Plan, HUD, personal Desks, shared Assets, governed Artifacts, human curation and explicit Bindings to independent Targets.](https://raw.githubusercontent.com/thevzion/hairness/main/docs/assets/hairness-home-first.webp)

| Target-first setup | Home-first contract |
| --- | --- |
| Agent starts inside each repository | Providers bring the agent to one **Front Door** |
| Context gets rebuilt for each project | The **Home** owns shared orientation |
| Personal continuity follows chats and working directories | Each collaborator owns a **Desk** |
| Methods get copied between repositories | The Home installs reusable **Assets** |
| Results stay with sessions or local folders | **Artifacts** carry owner, state and lineage |
| Repositories hold agent infrastructure | **Targets** remain independent |
| Provider configuration becomes the entrypoint | Provider files remain reconstructible **Projections** |

A Target is where the agent works. It should not own how the agent works.
Hairness centralizes ownership and coordination while product code, history
and delivery stay with each Target. It provides the missing ownership layer
between provider sessions and independent Targets.

## Useful in minutes

Create a Home, then open it with a supported provider:

```bash
npx --yes @hairness/cli@latest create studio-home
codex -C studio-home

# Or:
cd studio-home
claude
```

The bootstrap command initializes Git, installs the first-party Assets, builds
the Codex and Claude projections, runs Doctor and commits the result. The Home
pins its exact runtime in `hairness.json`. Later operations pass through the
tracked Home Console:

```bash
node ./hairness.mjs <namespace> <command> [...arguments]
```

Invoke `$hairness-onboarding` in Codex or `/hairness-onboarding` in Claude.
Your agent explains the setup, asks for consent and configures your Desk. You
can start without writing provider configuration or designing an Asset.

| Horizon | You do | Hairness provides |
| --- | --- | --- |
| **First minutes** | Create the Home and complete onboarding | Owned sources, a Desk and stable orientation |
| **Each session** | Enter through the Front Door | Static Floor Plan and optional live context |
| **As you work** | Bind repositories and keep useful results | Target Maps, Artifacts and personal continuity |
| **As work repeats** | Curate methods, tools and knowledge | Reusable Assets under stable contracts |
| **Over time** | Reuse Assets across projects and providers | Source-owned agentic capital |

After onboarding, you own ordinary files. `HOME.md`, `DESK.md`, Asset sources
and Artifacts are canonical. `AGENTS.md`, `CLAUDE.md` and provider directories
are generated views.

## One Home, many Desks, independent Targets

A team Home supports any number of collaborators. Each collaborator uses a
separate checkout of the shared Home and attaches one private `.desk/`
repository. One checkout loads one active Desk.

The team shares Home sources through Git. Hairness 0.5 does not provide
presence, live Desk synchronization or a real-time collaboration service.
Each Desk keeps personal continuity and local Target Bindings out of the
shared Home.

The Home declares Targets. Each Desk binds the checkouts it uses. A Target
keeps its repository, history, test suite and delivery process.

## The agent enters through the Front Door

The provider starts the session. Its projection carries the same Home-owned
entry contract:

```text
Provider starts the agent
    ↓
Front Door
├── static Floor Plan
├── Home Console
├── provider Bridge
└── optional Wake-up route
    ↓
active Desk and local evidence
```

The Front Door names this composition even when the Home selects no Wake-up
route. The Floor Plan and Home Console remain available. A configured Bridge
can invoke one Home-selected command at SessionStart.

The default route, `hairness/hud:prompt`, asks the first-party HUD Asset for
current paths, Git evidence, Targets, Bindings, Artifacts and attention. The
visual metaphor treats HUD as a pair of glasses at the entrance:

- the HUD Asset is reusable equipment;
- `hud prompt`, `hud show` and `hud json` are rendered views;
- each view combines shared Home state, the active Desk and local evidence.

If Wake-up fails, the agent keeps the static Floor Plan and reports that live
orientation is unavailable. The Home stays readable from tracked files.
Executable operations still require the pinned runtime from the local npm
cache, registry or an explicit development backing.

> **The model may be a black box. The Home doesn’t have to be.**

## Assets are products for work

An Asset packages a reusable capability that the Home can locate, inspect,
trust, specialize and project through a stable contract.

```text
Asset
├── asset.json            identity and public surfaces
├── instructions/        knowledge and operating guidance
├── capabilities/        provider-neutral procedures
├── references/          supporting material
└── runtime.mjs           optional executable behavior
```

Assets can package a method, domain knowledge, a validator, a mapping tool or
an executable runtime. A manifest names the source-owned files and public
surfaces. The Asset contains the capability itself.

Hairness gives each session orientation, named equipment, ownership boundaries
and inspectable failure modes. Humans can design and review that Agent
Experience without claiming that the framework makes the underlying model more
intelligent.

## Artifacts are products of work

An Artifact records a result that a human or agent chose to keep. It carries a
kind, owner, state, source files and lineage. It may remain a draft, become an
accepted decision or serve as a final deliverable.

```text
Assets are products for work.
Artifacts are products of work.
```

A session response does not become an Artifact by default. A recurring pattern
does not become an Asset by accident. A human chooses which results deserve
persistence and which patterns deserve a reusable contract.

```text
Asset
  ↓ used during work
Artifact
  ↓ human selection and manual curation
new or improved Asset
```

Hairness 0.5 ships both source lifecycles. It does not ship an
`artifact promote` command or an automatic Artifact-to-Asset transformation.

## A concrete multi-Target workflow

Start with repositories that already exist:

```bash
node ./hairness.mjs target add ../payments-api --id payments
node ./hairness.mjs target add ../product-app --id app
node ./hairness.mjs target add ../public-site --id site
node ./hairness.mjs target list
```

The Home stores shared Target declarations. The active Desk stores local
Bindings. Hairness installs no provider entrypoint or methodology in those
repositories.

Ask the HUD for the current environment and map one Target:

```bash
node ./hairness.mjs hud show --full
node ./hairness.mjs target map payments
```

A Target Map records repository structure and source SHA as a Desk Artifact.
Revalidate the Binding before a mutation because the map describes evidence
from a point in time.

Scratch is optional. Install it after reviewing the preview and consenting to
the source changes:

```bash
node ./hairness.mjs asset add @hairness/scratch
node ./hairness.mjs build
node ./hairness.mjs doctor
```

Keep uncertain work resumable:

```bash
node ./hairness.mjs artifact create hairness/scratch:scratch api-redesign --owner desk
node ./hairness.mjs artifact inspect api-redesign
```

After review, validate and publish the result to the owner that should maintain
it:

```bash
node ./hairness.mjs artifact validate api-redesign
node ./hairness.mjs artifact publish api-redesign --to home
```

Publishing preserves the Desk source and records lineage. A compatible
Artifact kind can also publish to a named Target. That explicit delivery does
not install Hairness, provider files or a methodology in the Target.

When a pattern proves reusable, a human can author a new Asset from the useful
material:

```text
assets/company/api-review/
├── asset.json
├── instructions/policy.md
├── capabilities/review.md
└── references/checklist.md
```

Git diff and an ordinary pull request provide governance.

## Agentic capital belongs in the Home

An organization owns physical equipment, software and operating knowledge.
Agentic capital names the source-owned capabilities and governed knowledge that
let its agents perform useful work again.

```text
Work
  ↓
Artifact
  ↓ human curation
Asset
  ↓ reuse across sessions, collaborators and Targets
Agentic capital
```

The Home organizes ownership, trust and contracts for those productive units.
Provider sessions consume that capital without owning its canonical source.
Private Desk continuity joins shared company capital only when a collaborator
publishes selected material through an explicit contract.

Hairness does not claim a measured productivity gain. Sustained projects still
need to show how often teams curate patterns, reuse them and improve later
work.

This direction relates to
[Every's Compound Engineering](https://github.com/EveryInc/compound-engineering-plugin):
completed work should reduce effort in later work. Hairness applies that
principle to the source-owned environment around human-agent collaboration.
The reference does not imply an official integration.

## Hairness 0.5 today

| Shipped contract | Inspectable evidence |
| --- | --- |
| Source-owned Home | `hairness.json`, `HOME.md` and Git history |
| Solo and team Desks | `.desk/desk.json`, `DESK.md`, `desk init` and `desk clone` |
| Codex and Claude Bridges | Generated Instructions, Skills, Commands and SessionStart transports |
| Progressive Orientation | Static Floor Plan plus optional selected Wake-up |
| Independent Targets | Shared declarations, local Bindings and source-backed Target Maps |
| Inspectable Artifacts | Kind, owner, state, source files and lineage |
| Reusable Assets | Validation, installation, overrides, sync, publication and trust |
| Reconstructible projections | Deterministic build, `build --check` and divergence detection |
| Pinned execution channel | Tracked `hairness.mjs` and an exact runtime in `hairness.json` |

## Bring the stack you already use

Hairness provides value without a third-party methodology. Existing tools can
join a Home when their ownership and runtime boundaries become explicit.

| Existing layer | Current relationship |
| --- | --- |
| Codex and Claude | Supported providers that host the agent |
| GSD, Spec Kit, Superpowers and similar methods | Candidates for Asset-based adaptation; no official integration ships |
| Compound Engineering | Related practice; no official integration ships |
| MCP servers and company tools | External authorities that a provider or trusted Asset runtime may call |
| Product repositories | Independent Targets |
| Future providers | Separate Bridges remain an architectural direction |

Mentioned tools are compatibility targets or related work. Their presence in
this table does not claim support.

## Open proof questions

Hairness has a useful core. Broader claims still need evidence:

| Question | Current state |
| --- | --- |
| Can a complex method such as GSD or Spec Kit fit cleanly into a Home? | No official integration or public Adapter contract exists |
| Can one Asset contract cover diverse tool integrations? | Real adaptations must test the current instructions, capabilities, surfaces and runtime contract |
| Does Artifact-to-Asset curation improve later sessions? | Both lifecycles ship; curation remains manual and long-running evidence does not exist |
| How does collaboration behave in larger team Homes? | The multi-Desk model ships; sustained team use must validate governance and ergonomics |
| Can another provider reuse the same canonical sources? | Codex and Claude do; a third Bridge has not tested the generality |
| Can teams migrate large existing environments safely? | Humans can move material by owner; guided migration needs documented cases |

The alpha has no Registry, marketplace, dependency solver, daemon, automatic
merge, public Adapter framework, Integration SDK, operating-system sandbox or
agent scheduler.

## Inspect before you trust

Static Assets execute no code. A trusted Asset runtime executes with your user
rights. Inspect its source and approve the exact digest:

```bash
node ./hairness.mjs asset status company/security --json
$EDITOR assets/company/security/runtime.mjs
node ./hairness.mjs asset trust company/security --digest sha256:…
node ./hairness.mjs doctor
```

Changing one byte returns an approved runtime to `pending`. Hairness records
the trust decision and blocks unapproved execution. It does not provide an
operating-system sandbox.

## Hairness grammar

<details>
<summary><strong>Show the core concepts</strong></summary>

| Primitive | Meaning |
| --- | --- |
| **Home** | Shared, portable environment governed by `HOME.md` |
| **Desk** | One collaborator's continuity and conventions in that Home |
| **Asset** | Source-owned package of reusable agentic capability |
| **Capability** | Provider-neutral procedure owned by an Asset |
| **Skill** | Model access to a Capability |
| **Command** | Human access to a Capability |
| **Artifact** | Inspectable result with kind, owner, state and lineage |
| **Target** | Independent repository where product work remains sovereign |
| **Binding** | Desk-local relationship to a Target checkout |
| **Projection** | Generated provider-native view, never a canonical source |
| **Front Door** | Floor Plan, optional selected Wake-up, Bridge transport and Console |
| **Floor Plan** | Deterministic static orientation projected into each provider |
| **Home Console** | Tracked `hairness.mjs` channel for Kernel and Asset routes |
| **Wake-up** | Optional dynamic enrichment delivered by a provider Bridge |
| **HUD** | First-party Asset that provides local orientation and evidence |

</details>

Read the
[technical reference](https://github.com/thevzion/hairness/blob/main/docs/reference.md),
[architecture](https://github.com/thevzion/hairness/blob/main/docs/architecture.md),
[lifecycles](https://github.com/thevzion/hairness/blob/main/docs/lifecycles.md),
[security policy](https://github.com/thevzion/hairness/blob/main/SECURITY.md)
and [contribution guide](https://github.com/thevzion/hairness/blob/main/CONTRIBUTING.md).

## License

MIT
