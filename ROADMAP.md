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

## Now: prove first-Home activation

The next proof is one canonical newcomer journey:

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

| Runtime | Role | Status | Maintainer | Evidence | Next proof |
| --- | --- | --- | --- | --- | --- |
| Codex | CLI Agent Runtime | `qualified` | Hairness | 0.6 provider checks and Development Home dogfood | Keep the activation journey green |
| Claude | CLI Agent Runtime | `qualified` | Hairness | 0.6 provider checks and Development Home dogfood | Keep the activation journey green |
| [Kimi Code](https://www.kimi.com/code/) | Terminal and IDE Agent Runtime | `candidate` | `unassigned` | No Hairness qualification yet | Map native instructions, Skills and ACP before choosing Projection or Bridge |
| [Hermes Agent](https://github.com/NousResearch/hermes-agent) | Agent Runtime | `candidate` | `unassigned` | No Hairness qualification yet | Map its native capability and continuity surfaces |
| [OpenClaw](https://github.com/openclaw/openclaw) | Persistent personal Agent Runtime | `candidate` | `unassigned` | No Hairness qualification yet | Map workspace, wake-up and continuity boundaries |

Documentary statuses are `candidate`, `prototyping`, `qualified`, `blocked`
and `retired`. Maintenance is tracked separately as Hairness,
`community:<handle>` or `unassigned`.

## Qualification gate

A runtime becomes `qualified` only when dated evidence shows that:

- the Home remains canonical;
- its Projection or Bridge is reconstructible;
- the Floor Plan remains available;
- the HUD works or declares a bounded degradation;
- one Capability completes end to end;
- a second session recovers the chosen context and destination;
- Doctor detects a missing or stale runtime surface;
- supported versions, limits and maintainership are explicit.

## Next

Classify the candidates, select one third runtime from real user demand and
available maintainership, then run it through the same activation journey.
Supporting more logos without this proof is not progress.

Use a runtime Hairness does not qualify yet? Open a
[Runtime support request](https://github.com/thevzion/hairness/issues/new?template=runtime-support.yml).
After the role and scope are agreed, a contributor can implement the smallest
Projection or Bridge and submit the evidence through a pull request.

## Later

- Extract a portability kit only after multiple real runtime implementations
  expose the same missing contract.
- Treat MCP as a live access and action plane, not an Agent Runtime.
- Treat Notion and similar products as external systems with explicit
  authority, not as owners of Home continuity.
- Generalize external references only after several convergent use cases.

