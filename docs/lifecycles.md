# Lifecycles

## Asset lifecycle

```text
source → validate → preview → transactional copy → owned source
                                            ↓
                         status / diff / cautious sync
                                            ↓
                           Desk Asset → Git-reviewed Home Asset
```

`asset add` accepts bundled, local, HTTPS and GitHub sources. It rejects
escaping paths, symlinks, duplicate ids and collisions before promotion.

`asset status` runs offline. It reports `clean`, `customized`, `missing`,
`invalid` or `local`.

`asset sync --check` compares the installed origin with its source and writes
nothing. A normal sync updates an intact Asset in one transaction. Local
divergence blocks the write unless the caller passes `--overwrite`. Undeclared
files survive.

`asset override <id>` copies one Home Asset into the Desk and records the Home
digest as its base. The Desk variant becomes locally effective and
provider-native. `asset publish <id> --to home` blocks if that base moved; otherwise it
replaces the Home transactionally, removes Desk provenance and leaves review
to Git. `asset remove <id>` abandons the Desk override and reveals the unchanged
Home source. No automatic merge is attempted.

## Artifact lifecycle

```text
template or staged files → Desk draft → validate → Home or Target publication
                   ↘ derive another Artifact with lineage
```

The Kernel enforces the Artifact envelope. The owning Asset validates business
fields, states and owners. Publication copies the Artifact, preserves the Desk
source and adds lineage. Transformation requires a Capability to create a new
Artifact with `--derived-from`.

`artifact create --from <directory>` imports a multi-file result atomically.
Symlinks, escaping paths, reserved `artifact.md` and missing required files are
rejected. A successful import removes a source under `.hairness/staging/`; a
failed import preserves it for inspection.

## Build lifecycle

`build` resolves the Home, asks provider projectors for outputs and reconciles
them against `.hairness/build.json`. Each output retains its Home or Desk
scope. Solo Desk projections are versionable; team Desk projections are
provider-native but excluded locally from the Home repository.

`build --check` writes nothing. It fails when projections or prior executable
output no longer match the Resolved Home.

An executable runs after digest-bound approval. Hairness gives it the Asset as
read-only input and a temporary output directory, then promotes declared files.

## Team Home lifecycle

The team commits `hairness.json`, shared Assets, Artifacts and provider
projections. Each collaborator creates or clones `.desk/` during onboarding.
The parent repository ignores the full Desk. The Desk repository ignores
physical Target Bindings.

A collaborator develops an Asset in `.desk/assets`, tests it against local
Targets and publishes it into the Home. The resulting Git diff enters the
team's normal review process.

## Target lifecycle

```text
shared declaration → zero or more named Bindings → safe Git probes
                                         └──────→ Target Map Artifact
```

A Target can remain declared, be cloned as a managed Binding or connect to an
existing checkout as a bound Binding. There is no active Target. An operation
infers the Binding when unique and otherwise requires `--binding`.

`target map` reads one Binding and imports seven focused documents into a Desk
Artifact. It never writes to the Target. Publishing the map to the Home is a
separate, reviewable action.
