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

`asset publish` moves a Desk Asset into the Home, removes source provenance and
leaves review to Git. Hairness rejects Home and Desk Assets with the same name.

## Artifact lifecycle

```text
template → Desk draft → validate → Home or Target publication
                   ↘ derive another Artifact with lineage
```

The Kernel enforces the Artifact envelope. The owning Asset validates business
fields, states and owners. Publication copies the Artifact, preserves the Desk
source and adds lineage. Transformation requires a Capability to create a new
Artifact with `--derived-from`.

## Build lifecycle

`build` resolves the Home, asks provider projectors for outputs and reconciles
them against `.hairness/build.json`. It rejects owner collisions and edits to
generated output.

`build --check` writes nothing. It fails when projections or prior executable
output no longer match the Resolved Home.

An executable runs after digest-bound approval. Hairness gives it the Asset as
read-only input and a temporary output directory, then promotes declared files.

## Team Home lifecycle

The team commits `hairness.json`, shared Assets, Artifacts and provider
projections. Each collaborator creates or clones `.desk/` during onboarding.
The parent repository ignores the full Desk. The Desk repository ignores
physical Target bindings.

A collaborator develops an Asset in `.desk/assets`, tests it against local
Targets and publishes it into the Home. The resulting Git diff enters the
team's normal review process.
