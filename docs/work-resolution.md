# Work Resolution

> **Status:** experimental · **Owner:** `endroit/work` · **Contract:**
> `endroit/work/v1alpha1`

Work Resolution gives selected work a durable, inspectable contract without
turning an agent, transcript or workflow engine into the source of truth. A
Room owns the Work Item. `artifact.md` owns its Artifact metadata and lifecycle;
`WORK.json` owns the machine-readable work contract.

## Contract

| Field | Responsibility |
| --- | --- |
| `objective`, `workType`, `expectedEffect` | The useful form and intended effect |
| `sources` | Addressable authority, context, constraints and evidence |
| `claims` | Statements whose maturity and proof stay explicit |
| `obligations` | Required constraints and their evidence |
| `contradictions` | Incompatible readings that must remain visible |
| `assignments` | Bounded work packages with sources, destination and verification |
| `verification` | Checks and observed evidence |
| `observedResult` | Complete, partial or failed outcome |
| `review` | Human questions and explicit review outcomes |

The versioned schema is
[`schemas/work/v1alpha1.json`](../schemas/work/v1alpha1.json). Arrays may start
empty so the Work Item can be progressively resolved; the runtime reports the
missing contract instead of inventing it.

## Resolution Frontier

```text
event
  → object
  → contract
  → placement
  → execution-ready
  → closure-ready
```

- **Event:** the Artifact and `WORK.json` are structurally valid.
- **Object:** the objective is explicit.
- **Contract:** type, expected effect, authority source and obligations exist.
- **Placement:** every Assignment has an owned destination and any Site has an
  explicit Route.
- **Execution-ready:** required obligations carry evidence, claims are not
  overstated, contradictions are resolved and Assignments name their sources,
  effects and checks.
- **Closure-ready:** Assignments returned or blocked, checks ran, a result was
  observed and review no longer requests changes.

The frontier is diagnostic, not a lifecycle or authority machine.
`execution-ready` never grants permission to mutate a Site. `closure-ready`
never accepts, commits, delivers or publishes the result.

## CLI

```bash
node ./endroit.mjs artifact create item <id> --room <home/id|desk/id>
node ./endroit.mjs work inspect <selector>
node ./endroit.mjs work resolve <selector>
node ./endroit.mjs work review <selector>
node ./endroit.mjs work record-review <selector> <item> --status accepted
```

`record-review` atomically changes only the selected `WORK.json` review item.
The provider-projected `/click-and-review` command may open a file or Site
preview after explicit invocation and Route revalidation; the Work runtime
never runs that preview itself.

## Boundaries

- no persistent graph, daemon, scheduler, agent registry or universal memory;
- no agent identity or conversation transcript in `WORK.json`;
- no trust or AX score;
- no automatic extraction of claims or contradictions;
- no modification to `open-workplace/0.1`;
- no external effect inferred from a local diagnostic.
