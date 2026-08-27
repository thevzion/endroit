# Coordination policy

Every Workplace owns `workplace/coordination.json`. `endroit new` copies the
Standard default as an ordinary committed source; editing it invalidates only
the dependent projections until `ready` recompiles them.

Version 1 is deliberately closed. It defines Main, Manager and Worker
structural roles, three resolution routes, one mandatory dispatch envelope and
fail-closed fallbacks. It is not a workflow engine and contains no expression,
loop, code or arbitrary graph.

Every dispatch envelope carries the resolved `meetingRef`. Manager and Worker
are Occupants of that Meeting; a subagent inherits it and cannot silently open
another collaboration event.

```text
read-only                    → Main
one bounded write scope      → Main → Worker → Main
multiple Roots/integration   → Main → Manager → Worker(s) → Manager → Main
```

Main is provider-bound facilitation, not a durable Agent Node. Manager owns one
Work goal, integration, gates and commits. Worker may read, mutate and verify
one exclusive scope, but never commits, dispatches, contacts the human or
widens scope. Specialized Agents remain separate owned sources.

The compiler emits a normalized portable policy, local Coordination IR and
provider-neutral `agents/manager.md` and `agents/worker.md` contracts. The Hall
shows only the Main summary. A Work reveals Manager when integration applies; a
Site reveals Worker only at dispatch.

ProviderBinding uses closed `agent` targets. Missing or unqualified subagents
produce `degraded`; a single-scope inline Worker is permitted only when the
owned policy explicitly allows it. Skills, bindings and provider capabilities
never create Authority.
