<div align="center">

# hairness

### Own the place where your agents work.

**A provider can host the agent. It shouldn’t own the Home.**

**Not another autonomous agent. A Home for the agents and workflows you already use.**

[![npm next](https://img.shields.io/npm/v/%40hairness%2Fcli/next?label=npm%20next)](https://www.npmjs.com/package/@hairness/cli)
[![CI](https://github.com/thevzion/hairness/actions/workflows/ci.yml/badge.svg)](https://github.com/thevzion/hairness/actions/workflows/ci.yml)
[![MIT](https://img.shields.io/badge/license-MIT-d8996a.svg)](LICENSE)

<sub>0.5 is an alpha. Use a dedicated Git repository and review every Asset runtime before trusting it.</sub>

</div>

## Ness needed a Home

Ness is the agent. The provider wakes Ness up, but the provider is not where
Ness should keep the work environment.

Hairness gives Ness a small, usable Home: a floor plan, a welcome guide and the
tools required to improve it. You work with Ness from your Desk. Together you
decide what the Home becomes.

```bash
npx --yes @hairness/cli@0.5.0-alpha.0 create ness-home
codex -C ness-home
# or: cd ness-home && claude
```

Then invoke `$hairness-onboarding` in Codex or `/hairness-onboarding` in Claude.
The onboarding is a source file in the Home—not a remote wizard. It explains
the proposed changes, asks for consent, and lets Ness call the exact runtime
pinned by the Home.

When a session starts, the provider Bridge injects a compact XML HUD into
Ness’s context. Ness wakes up knowing which Home and Desk exist, which Assets
are available, what the Git state is, which Targets are bound, which Target
Maps are stale, and what needs attention. Ness can ask for the full HUD later.

```text
HAIRNESS    agentic-tools · team · codex+claude · @hairness/cli@0.5.0-alpha.0
DESK        alexis · Alexis · fr · recent:5
SURFACES    7 assets · 9 skills · 12 commands · artifact,hud,target
ARTIFACTS   4 · active:2 current:2
GIT         main · clean · 51b88db1 · 1 worktree · 2026-07-24
TARGETS     3 declared · 4 bindings
  hairness           main:clean · map:current
  hacp               main:clean · experiment:dirty · map:stale
  think-it-through   main:clean · map:current
CONTEXT     instructions:1820B · desk:640B · model:1094B
```

The human-readable HUD is useful for inspection. `hud --prompt` is the
agent-facing XML contract. `hud --json` is the stable tool-facing form.

> **The model may be a black box. The Home doesn’t have to be.**

## One Home, explicit ownership

```text
ness-home/
├── hairness.json                         # shared Home contract
├── assets/
│   ├── hairness/
│   │   ├── onboarding/asset.json
│   │   ├── hud/asset.json
│   │   ├── artifacts/asset.json
│   │   └── targets/asset.json
│   └── company/security/asset.json       # source-owned team Asset
├── artifacts/                            # shared, governed outcomes
├── AGENTS.md · CLAUDE.md                 # tracked provider projections
├── .agents/ · .claude/ · .codex/         # tracked provider projections
├── .desk/
│   ├── desk.json                         # Collaborator × Home
│   ├── assets/                           # personal Assets and overrides
│   ├── artifacts/                        # personal work and continuity
│   └── targets/                          # local Target Bindings
└── .hairness/
    ├── build.json                        # local projection ownership
    └── approvals.json                    # local runtime trust by digest
```

The Home is shared. The Desk is where one human resumes work with Ness in that
Home.

- In a `solo` Home, the Desk can be versioned with the Home.
- In a `team` Home, `.desk/` is a private nested Git repository ignored by the
  shared Home. A fresh clone works without it; onboarding can clone one,
  initialize one, or continue without one.

Targets remain independent repositories. Hairness links them; it does not
pollute them with `AGENTS.md`, `.planning/`, provider state or a Hairness
configuration.

## The grammar

Hairness is a lightweight framework for source-owned, portable agent work
environments. Its microkernel owns grammar, composition, source lifecycle,
projection safety and trust. Assets own meaning, capabilities, surfaces and
runtime behavior.

| Primitive | What it owns |
|---|---|
| **Home** | Shared composition and provider-independent contract |
| **Desk** | One collaborator’s continuity, overrides, Artifacts and Bindings |
| **Asset** | Source-owned agentic material and optional runtime behavior |
| **Capability** | One provider-neutral procedure |
| **Skill** | Model access to a Capability |
| **Command** | Human access to a Capability |
| **Artifact** | An inspectable outcome with kind, owner, state and lineage |
| **Target** | Independent repository where real work remains sovereign |
| **Projection** | Generated provider-native view; never canonical source |
| **HUD** | Live, local orientation generated at wake-up and on demand |

An Asset can expose both a Skill and a Command for the same Capability. Hairness
keeps the distinction; a lossy provider projection warns instead of silently
making a user-only Command model-invokable.

## Assets are source, not packages

An Asset is an ordinary directory with one `asset.json`:

```json
{
  "$schema": "https://hairness.dev/schema/asset.json",
  "name": "company/security",
  "version": "1.2.0",
  "description": "Company security context and review capability.",
  "files": ["capabilities/review.md", "references/policy.md"],
  "capabilities": [
    { "id": "review", "path": "capabilities/review.md" }
  ],
  "skills": [
    {
      "id": "review",
      "capability": "review",
      "description": "Use when a change needs a company security review."
    }
  ],
  "commands": [
    {
      "id": "review",
      "capability": "review",
      "description": "Review a change against company security policy."
    }
  ],
  "references": [
    { "id": "policy", "path": "references/policy.md" }
  ]
}
```

Install from local files, HTTPS, or Git:

```bash
hairness asset review company/agentic-assets/assets/security#v1.2.0
hairness asset add company/agentic-assets/assets/security#v1.2.0
hairness asset add https://assets.example.com/security/asset.json
hairness asset add ./security/asset.json
```

Hairness previews writes, copies the files transactionally and records origin
plus base digests in the installed manifest. `add`, `sync`, `build`, `doctor`
and resolution never execute an Asset runtime.

The installed source is yours:

```bash
$EDITOR assets/company/security/capabilities/review.md
git diff
hairness asset status company/security
hairness asset diff company/security
```

A sync stops at local divergence. For personal experimentation:

```bash
hairness asset override company/security
# edit .desk/assets/company/security/
hairness asset publish company/security --to home
```

Publishing succeeds only while the Home base has not changed. Git diff and a
normal pull request provide governance; Hairness does not invent a merge engine.

## Artifacts turn work into capital

Assets help produce work. Artifacts make useful outcomes tangible:

```bash
hairness asset add @hairness/scratch
hairness artifact create hairness/scratch:scratch api-redesign
hairness artifact validate api-redesign
hairness artifact publish api-redesign --to home
```

Each Artifact has a kind, owner, state, creator and optional lineage. The Asset
that declares the kind owns its schema and template. Drafts can live at the
Desk; accepted outcomes can move to the Home or a Target without deleting the
Desk source.

Repeated useful outcomes reveal reusable patterns. Those patterns can become
Assets:

```text
work → Artifact → recurring pattern → Asset → better future work
```

This is **Context Mining**: turn explicit work into source-owned agentic assets
instead of repeatedly rebuilding context in prose. The accumulated, inspectable
material is agentic capital.

## Targets stay sovereign

Declare repositories once and bind whatever checkout exists on this machine:

```bash
hairness target add ~/Projects/payments-api --id payments
hairness target bind payments ~/Worktrees/payments-refactor --binding refactor
hairness target list
```

A Target may be only declared, cloned and managed by the Desk, or bound to one
or more external checkouts. There is no hidden “active Target.” Ness selects the
Target and Binding required by the work; ambiguity requires `--binding`.

Create an evidence-backed map without writing into the Target:

```bash
hairness target map payments --binding refactor
```

The resulting Desk Artifact records the Target SHA, date, evidence,
uncertainties, stack, structure, integrations, conventions, tests and concerns.
The HUD reports whether it is current or stale.

This separation is **Target Sovereignty**: project repositories keep their own
methodology and history. The Home provides the environment around them.

## Bring the stack you already use

Hairness does not replace an agent, autonomous runtime, workflow methodology,
skill library or package manager. It gives those tools a legible place to meet.

| Existing layer | What it can contribute to a Home |
|---|---|
| Codex, Claude and future providers | A host for Ness through a Bridge |
| GSD, Spec Kit, Superpowers and other methods | Assets, Commands, Skills, Artifact kinds or runtimes |
| OpenClaw and other autonomous runtimes | A runtime connected through an Asset |
| HACP and conversation protocols | Capabilities that govern human–agent collaboration |
| Company tools and knowledge | Source-owned Assets and independent Targets |

Hairness 0.5 does not ship all of those integrations. The point is the boundary:
methods keep their loops, Targets keep their repositories, providers keep their
native surfaces, and the Home keeps ownership.

This is **Projection Inversion**: canonical sources do not live inside provider
folders. Hairness projects owned sources outward into each provider.

## Runtime trust is explicit

Static Assets need no executable code. When an Asset does declare a runtime,
its namespace and commands remain inspectable in `asset.json`:

```json
{
  "runtime": {
    "namespace": "security",
    "entry": "runtime.mjs",
    "commands": [
      { "name": "audit", "description": "Audit a bound Target." }
    ]
  }
}
```

Before a third-party runtime runs:

```bash
hairness asset review company/security
hairness asset trust company/security --digest sha256:…
hairness security audit
```

Approval is local and bound to the complete Asset digest. Any changed byte
revokes it. An approved runtime executes with the user’s rights and owns its
stdio, arguments and exit code—Hairness is not an operating-system sandbox.
Exact first-party runtimes copied from the pinned CLI tarball inherit that
tarball’s trust.

## Kernel surface

```text
create · init
desk init|clone|status
asset review|add|status|diff|sync|remove|validate
asset override|publish|trust
validate · build · doctor
<Asset runtime namespace> <arguments...>
```

The four Assets installed by `create` add `hud`, `artifact` and `target`.
Scratch is bundled but opt-in. `hairness/project` remains an external source so
the product repository stays an independent Target rather than becoming a Home.

## Alpha boundaries

A provider-native Project may be enough when one provider, one repository and a
small context are enough. Hairness is for environments that must be owned,
inspected, shared, composed or carried across providers.

The alpha has no Registry, marketplace, dependency solver, daemon, automatic
merge, automatic update, public Adapter contract, Integration framework,
Capsule abstraction or agent scheduler. Codex and Claude Bridges are internal.
Git provides history and restoration.

Read the [architecture](docs/architecture.md),
[lifecycles](docs/lifecycles.md), [technical reference](docs/reference.md) and
[security policy](SECURITY.md).

## License

MIT
