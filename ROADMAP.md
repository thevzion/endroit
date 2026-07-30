# Hairness Roadmap

Hairness is actively maintained and dogfooded in the Home used to develop it.
This roadmap tracks evidence, not release dates. A candidate is an
investigation, not a promise of support.

## Today

Hairness 0.6 provides the Home-first foundation, guided bootstrap, Workspaces,
the Floor Plan and HUD, inspectable Artifacts, explicit Targets and Bindings,
installable Assets and Doctor.

Codex and Claude are qualified Agent Runtimes. The separate Hairness
Development Home exercises both provider projections against the same
source-owned Home and independent Hairness Target.

Community runtime work follows
[Runtime request → qualified pull request](CONTRIBUTING.md#runtime-support).

## Now: publish the first-Home activation proof

The continuity part of the journey has been observed locally across two
distinct Codex sessions in the same Home. That maintainer evidence is useful,
but it does not replace a public reproduction of the full newcomer path. The
next proof is to publish and reproduce this canonical journey:

```text
create a Home
→ complete onboarding
→ connect an existing Target
→ retain one durable result
→ close the session
→ reopen the same Home
→ recover the context and destination
```

This journey must remain understandable to the human, navigable by the agent
and reproducible without moving the Target into the Home.

## Runtime matrix

Integration and evidence are separate:

- `native` uses a runtime Projection or Bridge; `portable` uses the static
  Floor Plan, ordinary instruction files and Home Console;
- `qualified` is maintained against the full gate; `observed` records a real
  successful workflow without a support guarantee; `candidate` has no such
  evidence yet.

| Runtime | Integration | Evidence | Maintainer | Evidence note | Next proof |
| --- | --- | --- | --- | --- | --- |
| Codex | `native` | `qualified` | Hairness | Provider checks, Development Home and two-session maintainer journey | Public newcomer reproduction |
| Claude | `native` | `qualified` | Hairness | Provider checks and Development Home dogfood | Public newcomer reproduction |
| [Hermes Agent](https://github.com/NousResearch/hermes-agent) 0.19.0 | `portable` | `observed` | Hairness | Anonymized maintainer workflow using `AGENTS.md` and Home Console, 2026-07-30 | Independent reproduction and friction report |
| [Kimi Code](https://www.kimi.com/code/) | to classify | `candidate` | `unassigned` | No Hairness evidence yet | Try the portable path |
| [OpenClaw](https://github.com/openclaw/openclaw) | to classify | `candidate` | `unassigned` | No Hairness evidence yet | Try the portable path |

`Observed` is deliberately weaker than `qualified`. Maintenance is tracked
separately as Hairness, `community:<handle>` or `unassigned`.

## Qualification gate

A runtime becomes `qualified` only when dated evidence shows that:

- the Home remains canonical;
- its selected native or portable entry is deterministic and reconstructible;
- the Floor Plan remains available;
- the HUD works or declares a bounded degradation;
- one Capability completes end to end;
- a second session recovers the chosen context and destination;
- Doctor detects missing or stale Hairness-owned runtime surfaces when they
  exist;
- supported versions, limits and maintainership are explicit.

## Next: prove orientation value

Before adding another native runtime Projection, compare Home-first with a
Target-first start on the same work. Measure correct source and Target
selection, off-target inspections, human corrections, continuity recovery and
live revalidation. Track time, tool calls and context as secondary measures,
including the cost of preparing the Home.

Use a short mono-repository task as a negative control. Publish null or
negative results as well as improvements; this is a test of orientation and
continuity, not model intelligence.

Use a runtime Hairness does not qualify yet? Open a
[Runtime support request](https://github.com/thevzion/hairness/issues/new?template=runtime-support.yml).
Start with the portable path and report concrete friction. After the role and
scope are agreed, a contributor can implement the smallest justified
Projection or Bridge and submit the evidence through a pull request.

## Later

- Extract a portability kit only after multiple real runtime implementations
  expose the same missing contract.
- Treat MCP as a live access and action plane, not an Agent Runtime.
- Treat Notion and similar products as external systems with explicit
  authority, not as owners of Home continuity.
- Generalize external references only after several convergent use cases.
