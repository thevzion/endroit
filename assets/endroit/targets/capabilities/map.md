# Map a Target

Produce one inspectable `endroit/targets:target-map` Artifact for each selected
Target.

A single explicitly requested Target is mapped directly. When the human names
several independent Targets, announce the coordination and use one isolated
worker per Target when delegation is available. Otherwise map them
sequentially. If additional Targets are inferred rather than requested,
propose the expanded scope and wait before including them. Never combine
several Targets into one aggregate Map.

For each Target:

1. Resolve the intended Binding and revalidate its repository identity.
2. Collect deterministic, read-only evidence about its current version,
   working tree, files, manifests, scripts, tests and scanner limits.
3. Explore only the sources needed to interpret that evidence.
4. Prepare a registered Temp payload with `EVIDENCE.json` plus `STACK.md`,
   `ARCHITECTURE.md`, `STRUCTURE.md`, `INTEGRATIONS.md`, `CONVENTIONS.md`,
   `TESTING.md` and `CONCERNS.md`.
5. Cite sources, attribute uncertainty and keep observations physically
   separate from interpretation.
6. Revalidate the Target version. Stop rather than preserving a mixed-version
   result when it changed during the work.
7. Create and validate one Target Map under the owning Desk Workspace's
   `targeting/` namespace. Its lineage names the observed Target version.

Each worker inherits the same read-only boundary and result contract. Never
write mapping files into a Target.
