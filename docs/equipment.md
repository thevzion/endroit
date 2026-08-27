# Equipment, methods and Tools

Equipment is a reusable way of working. It may carry a Playbook, templates,
Outcome contracts, checks, required Operations and projection fragments.

A Study is a Work form, not a global Skill. It becomes available when a Room,
current Work, Research Equipment, local evidence, Tool availability and
Authority make a Workshop applicable.

An Operation is a provider-neutral semantic action. A Tool is a concrete,
bounded invocation surface with inputs, effects and proof. Determinism,
volatility and availability are Tool properties; “Tool” does not mean
deterministic by definition.

Static files can express methods, required Operations and invocation guidance.
A future runtime may register/invoke Tools or enforce Effects, but it cannot
invent semantics absent from the static Equipment.

Core Equipment exposes `open-room` only in the Hall. Its local method first
checks the Floor Plan, then gives the exact minimal Room source contract and
the bound `workplace.compile` command. After compilation, the new Room exposes
`open-work`. Neither method is installed as a global Skill.

ProviderBindings may attach an exact `command` to an Operation. A missing
executable makes `check` report `degraded` with that command; it does not make
the compiled building unreadable and does not authorize a substitute Tool.

Every method also declares a Context Contract: the reads required before its
effect, conditional reads, forbidden scopes, bounded search Root, stop
condition, coordination route and expected evidence. Integration methods fail
closed when Manager/Worker dispatch cannot be proved; Main has no inline
multi-Root fallback.
