<div align="center">

# hairness

### Own the place where your agents work.

**A provider can host the agent. It shouldn’t own the Home.**

A lightweight framework for source-owned, portable agent work environments.

[![npm latest](https://img.shields.io/npm/v/%40hairness%2Fcli/latest?label=npm%20latest)](https://www.npmjs.com/package/@hairness/cli)
[![CI](https://github.com/thevzion/hairness/actions/workflows/ci.yml/badge.svg)](https://github.com/thevzion/hairness/actions/workflows/ci.yml)
[![MIT](https://img.shields.io/badge/license-MIT-d8996a.svg)](LICENSE)

<sub>0.5 is an alpha. Use a dedicated Git repository and review every Asset runtime before trusting it.</sub>

</div>

## The missing layer isn’t another agent.

Context gets scattered across provider projects, chat history, hidden
configuration and methodology-specific folders. An agent starts by searching
for its bearings. Tools add files to product repositories. Useful outcomes
disappear with the session, and changing provider means rebuilding the working
environment.

Hairness gives that environment an owned, local structure:

| Without a Home | With Hairness |
|---|---|
| Implicit context | A source-owned Home |
| Startup exploration | A static Floor Plan plus optional Wake-up |
| Tool files inside projects | Independent Targets |
| Ephemeral results | Inspectable Artifacts |
| One-off practices | Reusable Assets |
| Provider-bound configuration | Reconstructible projections |

Hairness is a lightweight framework for owned agent work environments and a
local, Git-backed coordination layer. Agent execution, scheduling, reasoning,
methodologies and package resolution stay with the tools that own them.
**Hairness orchestrates the environment around the agent, not the agent
itself.**

The Home and its Floor Plan remain readable from local files without a network.
Executable operations require the exact npm package named in `hairness.json`
from the npm cache or registry, or an explicit development backing. After
creation, every documented operation passes through:

```bash
node ./hairness.mjs <namespace> <command> [...arguments]
```

## Ness needed a Home

Ness is the agent. A provider wakes Ness up, but the provider is not where the
work environment should live.

Hairness gives Ness a small, usable Home: an owned place with explicit
instructions, capabilities and continuity. You create it once, then work with
Ness instead of operating a framework.

```bash
npx --yes @hairness/cli@latest create studio-home
codex -C studio-home
# or: cd studio-home && claude
```

`latest` is used only for bootstrap. The generated Home pins the exact runtime
in `hairness.json`; every subsequent operation goes through
`node ./hairness.mjs`.

Invoke `$hairness-onboarding` in Codex or `/hairness-onboarding` in Claude.
Ness explains the proposed setup, asks for consent and completes it through the
tracked Home Console and runtime pinned by the Home.

`HOME.md` is the shared constitution. `.desk/DESK.md` holds one collaborator’s
preferences and conventions. Both are ordinary Markdown, owned in Git and
editable after bootstrap. Assets add reusable capabilities without taking
ownership away from the Home.

## Ness enters through the Front Door

Every provider first loads the same static Floor Plan. It names the Home,
ownership boundaries, canonical relative paths, the exact Console and every
available route. It works from the first clone and remains usable when hooks or
runtimes do not.

When Wake-up is configured and approved, the provider Bridge then asks the
selected Asset route for live context. The default `hairness/hud:prompt` route
gives Ness a dense local snapshot before any work begins:

```text
HAIRNESS    studio-home · team · codex+claude · ready
ROOT        /workspace/studio-home
KERNEL      npm · node ./hairness.mjs
DESK        maya · /workspace/studio-home/.desk · clean
SURFACES    6 assets · 8 skills · 9 commands · artifact,hud,target
TARGETS     2 declared · 3 bindings · payments:clean · website:dirty
ARTIFACTS   3 · draft:1 · accepted:2
CONTEXT     instructions:1712B · desk:386B · model:742B
ATTENTION   0 blocking · 1 warning · 2 advisory
```

This is **Progressive Orientation**: the Floor Plan is the reliable static
entrypoint; Wake-up improves it without becoming a single point of failure.
The Console is primarily Ness’s execution channel. Humans can use it directly,
but the canonical path is conversation.

<details>
<summary><strong>What did Ness receive?</strong></summary>

The provider Bridge invoked:

```bash
node ./hairness.mjs hud prompt
```

It transported stdout without interpreting HUD or XML. A representative
agent-facing response:

```xml
<hairness-hud version="1" status="ready" event="wake-up">
  <home name="studio-home" mode="team" root="/workspace/studio-home"
        providers="codex,claude" />
  <kernel runtime="@hairness/cli@0.5.0-alpha.0" source="npm"
          invoke="node ./hairness.mjs" />
  <desk configured="true" id="maya"
        root="/workspace/studio-home/.desk" git="clean" />
  <surfaces assets="6" skills="8" commands="9"
            namespaces="artifact,hud,target" />
  <targets declared="2" bindings="3" />
  <attention blocking="0" warning="1" advisory="2" />
</hairness-hud>
```

If Wake-up fails, the Bridge adds only:

```xml
<hairness-front-door version="1" status="degraded"
  reason="wake-up-unavailable" />
```

The Floor Plan is still present, so Ness can use the Console, explain the
missing live evidence and continue safely. On demand, `hud show --full` expands
the human inventory and `hud json` exposes stable data for tools.

</details>

> **The model may be a black box. The Home doesn’t have to be.**

## What you own, what Hairness projects

Hairness separates canonical sources, generated provider views and the
repositories where real work happens.

**1. The canonical Home: yours**

```text
studio-home/
├── hairness.json
├── HOME.md
├── assets/
│   ├── hairness/
│   └── company/security/
├── artifacts/
└── .desk/
    ├── desk.json
    ├── DESK.md
    ├── assets/
    ├── artifacts/
    └── targets/
```

In a solo Home, the Desk can be versioned with the Home. In a team Home,
`.desk/` can be a private nested Git repository: the shared environment stays
governed while each collaborator keeps personal continuity.

**2. Generated provider views: reconstructible**

```text
studio-home/
├── hairness.mjs                 # tracked Home Console
├── AGENTS.md
├── CLAUDE.md
├── .agents/skills/
├── .claude/
│   ├── skills/
│   ├── hooks/
│   └── settings.json
└── .codex/
    ├── hooks/
    └── hooks.json
```

These files contain the Floor Plan and complete projections of `HOME.md`, Asset
Instructions, Skills and Commands. `hairness.mjs` is the single documented
execution channel. Editing a projection is a detectable divergence; canonical
material remains provider-neutral.

**3. An independent Target: unchanged**

```text
payments-api/
├── src/
├── tests/
└── package.json
```

Hairness binds the Target from the Desk. It does not insert `hairness.json`,
provider files or a methodology into the repository.

`.hairness/` is ignored local state for builds and runtime approvals; it is
reconstructible and is not part of the canonical Home.

This is **Projection Inversion**: owned sources project outward into providers.
It also preserves **Target Sovereignty**: projects keep their own structure,
history and delivery loop.

## How work compounds

```text
Target → work → Artifact → recurring pattern → Asset → better future work
```

Ness works through a named Binding to an independent Target. A Target Map can
capture its stack, architecture, conventions, tests, concerns and source SHA as
a Desk Artifact without writing into that Target. Useful outcomes can then be
validated and published to the Home while their Desk source remains intact.

When a pattern proves reusable, it can become an Asset:

```text
assets/company/security/
├── asset.json
├── instructions/policy.md
├── capabilities/review.md
└── references/checklist.md
```

An installed Asset is copied source, not a remote black box. The short
lifecycle is inspectable:

```bash
node ./hairness.mjs asset validate ./security/asset.json
node ./hairness.mjs asset add ./security/asset.json
$EDITOR assets/company/security/capabilities/review.md
git diff
node ./hairness.mjs asset status company/security
node ./hairness.mjs asset sync company/security --check
# sync stops: the installed source was customized
```

Ness can map and publish work through the same pinned runtime:

```bash
node ./hairness.mjs target map payments --binding refactor
node ./hairness.mjs artifact publish api-redesign --to home
```

Git diff and an ordinary pull request provide governance. Hairness does not
hide the source, invent a merge engine or force a methodology.

This loop is **Context Mining**: useful work becomes inspectable material that
improves later work. Over time, those owned Assets and Artifacts become
agentic capital.

## The Hairness grammar

The microkernel owns grammar, composition, source lifecycle, projection safety
and trust. Assets own meaning, capabilities, surfaces and runtime behavior.

| Primitive | What it means |
|---|---|
| **Home** | Shared, portable environment governed by `HOME.md` |
| **Desk** | One collaborator’s continuity and conventions in that Home |
| **Asset** | Source-owned collection of reusable agentic material |
| **Capability** | Provider-neutral procedure owned by an Asset |
| **Skill** | Model access to a Capability |
| **Command** | Human access to a Capability |
| **Artifact** | Inspectable outcome with kind, owner, state and lineage |
| **Target** | Independent repository where real work remains sovereign |
| **Projection** | Generated provider-native view; never canonical source |
| **Front Door** | Static Floor Plan plus one optional Home-selected Wake-up route |
| **Floor Plan** | Deterministic static orientation projected into every provider |
| **Home Console** | Tracked `hairness.mjs` channel for Kernel and Asset routes |
| **Wake-up** | Optional dynamic enrichment delivered by a provider Bridge |
| **HUD** | First-party Asset that can provide Wake-up and on-demand local evidence |

An Asset can expose both a Skill and a Command for the same Capability.
Hairness preserves that distinction. When a provider cannot, the projection
warns instead of silently making a user-only Command model-invokable.

## Bring the stack you already use

**Not another autonomous agent. A Home for the agents and workflows you already use.**

Hairness does not replace an agent, runtime, methodology, skill library or
package manager. It gives them a legible place to meet without absorbing their
loops.

| Existing layer | What it can contribute to a Home |
|---|---|
| Codex, Claude and future providers | A host for Ness through a provider Bridge |
| GSD, Spec Kit, Superpowers and other methods | Assets, Skills, Commands, Artifact kinds or runtimes |
| OpenClaw and other autonomous runtimes | Runtime behavior exposed by an Asset |
| HACP and conversation protocols | Capabilities for human–agent collaboration |
| Company tools and knowledge | Source-owned Assets linked to independent Targets |

Hairness 0.5 does not ship every integration in this table. Providers keep
their native surfaces, methods keep their own loops and Targets keep their
repositories. Projection is one brick in the framework, not its definition.

## Trust, alpha boundaries and next steps

Static Assets execute no code. Before trusting a third-party Asset runtime,
inspect its source-owned files and offline status, then approve its exact
digest:

```bash
node ./hairness.mjs asset status company/security --json
$EDITOR assets/company/security/runtime.mjs
node ./hairness.mjs asset trust company/security --digest sha256:…
node ./hairness.mjs security audit
```

Runtime trust is explicit: `bundled` means byte-for-byte equality with the
Asset shipped by the exact npm package, `approved` means a matching local
digest approval and `pending` blocks execution. Changing any byte turns an
approved runtime back into `pending`. An approved runtime executes with the
user’s rights; Hairness does not provide an operating-system sandbox.

The alpha has no Registry, marketplace, dependency solver, daemon, automatic
merge or update, public Adapter contract, Integration framework, Capsule
abstraction or agent scheduler. A provider-native Project may still be enough
for one provider, one repository and a small context.

The complete CLI and contracts live in the [technical reference](docs/reference.md).
See also the [architecture](docs/architecture.md),
[lifecycles](docs/lifecycles.md), [security policy](SECURITY.md) and
[contribution guide](CONTRIBUTING.md).

Hairness develops itself through a separate Development Home:

```bash
npm run dev:home
npm run dev:session -- --provider codex
npm run dev:verify
```

## License

MIT
