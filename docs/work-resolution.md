# Work Resolution

> **Status:** experimental · **Owner:** `endroit/work` · **Contract:**
> `endroit/work/v1alpha2`

Work Resolution gives selected work a durable, inspectable contract without
turning an agent, transcript or workflow engine into source truth. A Room owns
the Work Item. `artifact.md` declares its Artifact identity and lifecycle;
`WORK.md` is the single human-owned Work source.

`WORK.json` with contract `endroit/work/v1alpha1` is accepted only by the
temporary legacy reader. It cannot be mutated. A directory containing both
`WORK.md` and `WORK.json` is ambiguous and rejected.

## `WORK.md`

The frontmatter uses snake_case and declares the Work Item contract:

````markdown
---
$schema: "https://endroit.org/schema/work/v1alpha2.json"
kind: "endroit/work:item"
id: "public-proof"
owner: "room:desk/demo"
contract: "endroit/work/v1alpha2"
work_type: "demo/public-proof"
work_state: "active"
derived_from: []
---

# Public proof

## Objective

Prove the public positioning from owned sources.

## Expected effect

Readers can distinguish demonstrated behavior from proposal.

## Workplace positioning

```endroit
kind: "claim"
id: "workplace-positioning"
currentness: "current"
maturity: "supported"
evidence: ["decision:desk/demo/0001"]
```

Endroit compiles human-owned Markdown into provider context.
````

Exactly one `## Objective` and one `## Expected effect` section are required.
Every other `##` section begins with one `endroit` block. The block types the
Fragment; the prose after it carries the human substance until the next `##`
heading.

Initial Fragment kinds are:

- `source`;
- `claim`;
- `obligation`;
- `contradiction`;
- `assignment`;
- `verification`;
- `observed_result`;
- `review`.

A Fragment has no owner or lifecycle independent from `WORK.md`. A review
becomes a separate Artifact only when it needs independent mutation,
acceptance or duration of life.

The schema is
[`schemas/work/v1alpha2.json`](../schemas/work/v1alpha2.json). Empty Fragment
collections are valid while a Work Item is being resolved; the runtime reports
the missing contract instead of inventing it. Durable Site paths should use
`checkout:<site>/<route>#<relative-path>`, never an absolute host path.

## Resolution Frontier

```text
event
  → object
  → contract
  → placement
  → execution-ready
  → closure-ready
```

- **Event:** the Artifact and its single Work source are structurally valid.
- **Object:** the objective is explicit.
- **Contract:** type, expected effect, authority source and obligations exist.
- **Placement:** every Assignment has an owned destination and any Site has an
  explicit Route.
- **Execution-ready:** required obligations carry evidence, claims are not
  overstated, contradictions are resolved and Assignments name their sources,
  effects and checks.
- **Closure-ready:** Assignments returned or blocked, checks ran, a result was
  observed and review no longer requests changes.

The frontier is diagnostic. `execution-ready` never authorizes a Site
mutation. `closure-ready` never accepts, commits, delivers or publishes a
result.

## Completion

Completion is calculated for the tuple `(contract, exact_revision, evidence)`:

- `complete` when the closure contract is satisfied;
- `blocked` when an open contradiction or explicit blocked Assignment or
  review prevents closure;
- `incomplete` otherwise.

The source digest is the exact revision. Any edit invalidates the previous
completion result. Completion is never stored in `WORK.md` and does not change
`work_state`, lifecycle, currentness, claim maturity, human acceptance or
observed delivery.

## CLI

```bash
node ./endroit.mjs work inspect <selector>
node ./endroit.mjs work resolve <selector>
node ./endroit.mjs work review <selector>
node ./endroit.mjs work record-review <selector> <item> --status accepted
```

`inspect`, `resolve` and `review` are read-only. `record-review` atomically
changes only the selected review Fragment metadata in `WORK.md`; its prose and
the Artifact lifecycle remain unchanged. It rejects legacy `WORK.json`.

The provider-projected `click-and-review` Skill may open a file or Site preview
after explicit invocation and Route revalidation. The Work runtime does not
run that preview itself.

## Boundaries

- Work Resolution is an Endroit extension, not an Open Workplace object;
- no persistent graph, daemon, scheduler, agent registry or universal memory;
- no agent identity or conversation transcript in `WORK.md`;
- no trust or AX score;
- no automatic extraction of claims or contradictions;
- no external effect inferred from a local diagnostic.
