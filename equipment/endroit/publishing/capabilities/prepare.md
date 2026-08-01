# Prepare a Publication

Create or continue one `endroit/publishing:publication` Artifact in the
Room owning the editorial intent.

`artifact.md` carries intent, status, owner and lineage. `content.md` contains
the exact source to project. Keep `format`, `title`, `audience`, `language` and
`channel` in Artifact metadata before moving to `ready`.

Declare one `responsibility`, one `stability` contract and the
`update_triggers` that justify a future re-read. Use
`canonical_dependencies` for definitions owned elsewhere and
`related_publications` for optional reader navigation. `derived_from` remains
provenance.

Each channel adaptation is its own Publication derived from the closest
canonical source. Do not let a condensed post replace a Study, reference or
article as source of truth.

Use `outline`, `draft`, `ready`, `published` and `superseded`. Only explicit
human validation moves a Publication to `ready`.

A published Publication may return to `draft` when its source is deliberately
reopened. Preserve its append-only Publication record. Do not mutate or infer
the external Handle; revalidate that projection separately.
