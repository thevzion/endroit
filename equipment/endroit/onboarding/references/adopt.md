# Adopt Endroit 0.10

This guide is the portable entrypoint used before an Endroit Workplace has
been selected. It does not authorize filesystem, Git, provider or remote
changes.

The agent guides. The CLI applies. The human approves.

## 1. Select the boundary

Start from the directory explicitly selected by the human. Search that
directory and its physical parents for `WORKPLACE.md`. Stop at the first file
whose frontmatter declares `kind: "endroit/workplace"`, whether it is valid or
invalid.

Do not search children, follow symlinks, inspect unrelated repositories or scan
a projects directory. A same-named Markdown file without the Endroit kind is
not a declaration.

During the 0.10 compatibility window, a legacy `endroit.json` may be read only
when no v9 declaration claims the same boundary. Competing v9 and legacy
sources are ambiguous and must be migrated explicitly.

## 2. Choose one operation

When no Workplace exists, offer one of these bounded operations:

- `endroit create <directory>` creates a standalone Workplace in a new
  directory.
- `endroit init <repository>` declares a Workplace inside the selected
  repository.
- Stop leaves the selected directories unchanged.

Existing repositories normally stay sovereign Sites reached through
Desk-owned Routes. Their physical proximity does not make them part of the
Workplace.

Before applying, state:

- the exact destination;
- whether the operation is `create` or `init`;
- the Desk strategy: `tracked`, `separate` or `later`;
- the enabled providers;
- the files and Git repositories that may be created;
- that no repository outside the destination will be moved, committed, pushed,
  published or deployed.

## 3. Apply through the CLI

For a new standalone Workplace:

```sh
npx --yes --package @endroit/cli@0.10.0-alpha.0 \
  endroit create <directory> --desk tracked
```

For a selected repository that should also contain the Workplace:

```sh
npx --yes --package @endroit/cli@0.10.0-alpha.0 \
  endroit init <repository> --desk separate
```

Use `--desk later` when no local continuity or Routes should be created yet.
Use `--no-interactive --yes` only after the exact operation is already
approved.

## 4. Verify the result

From the declared Workplace, use the tracked console:

```sh
node ./endroit.mjs validate
node ./endroit.mjs build --check
node ./endroit.mjs doctor
```

A successful adoption has one valid `WORKPLACE.md`, at least one Member,
optional Desk continuity according to the chosen strategy, deterministic
provider projections and no unreported external effect.

`AGENTS.md`, `CLAUDE.md`, Skills, the local console and
`.endroit/build.json` are projections or local receipts. They are rebuilt
from owned sources and never become a parallel canon.

## Limits

Adoption does not infer retention, acceptance, delivery, commits, provider
installation, publication or deployment. It never imports transcripts,
credentials, provider-private state or arbitrary files as Workplace truth.
