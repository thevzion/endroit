# Lifecycles

## Asset source

```text
review → add → clean
                  ├─ edit Home source → customized → sync blocked
                  └─ override → Desk variant → publish → Home diff/PR
```

`review` resolves and inventories a source without installation. `add` previews
and transactionally copies files. `status` is offline. `diff` and `sync` resolve
the recorded or selected source. `remove` deletes only declared source-owned
files and preserves unknown files.

An override records the Home base digests. Publishing replaces the Home Asset
only if those bytes are unchanged; no automatic merge occurs.

## Runtime trust

```text
installed static source
  → review entrypoint, namespace, commands and digest
  → trust exact digest locally
  → dispatch runtime
  → any byte changes
  → approval no longer matches
```

First-party runtimes are trusted only while they exactly match the bundled Asset
from the Home’s pinned CLI distribution.

## Artifact

```text
create/import at Desk → validate → publish to Home or Target
                              └── Desk source remains
```

An Artifact kind is declared by an Asset. The kind owns allowed owners, states,
schema and template. `--from <directory>` imports a tree atomically after
rejecting symbolic links and the reserved `artifact.md`.

Publishing preserves content, records lineage and never removes the Desk
source. Transformations create a new Artifact with `--derived-from`.

## Target

```text
declare remote identity
  ├─ clone → managed Binding
  └─ bind existing checkout → external Binding
          ↓
        map → Desk Target Map Artifact
```

A Target accepts multiple named Bindings. A unique Binding is inferred;
ambiguity requires `--binding`. Mapping reads tracked files and local Git
evidence, caps inspection at 5,000 paths, rejects secret-like output and never
writes into the Target.

## Session

The provider Bridge invokes `hud --prompt` at session start, resume, clear and
compaction. The HUD reads local evidence and the Resolved Home, then emits XML
for Ness. It executes no other Asset runtime.

The generated wrapper uses `.hairness/dev-cli` when it exists; otherwise it
invokes the exact `hairness.json#runtime` through `npx`. A present but failing
development launcher never falls back to npm. Failure or a 30-second timeout
returns a bounded unavailable HUD and lets the provider session continue.

## Hairness development

```text
dev:home → reconcile sibling team Home → bind repository → build → doctor
dev:session → open provider inside that Home → SessionStart HUD
dev:verify → contracts + persistent Home
dev:verify --full → release qualification
```

`dev:home:recreate` requires clean Home and Desk repositories. It qualifies a
staged replacement, moves the original Desk without transforming it, swaps the
Home and restores the previous instance after any failure.
