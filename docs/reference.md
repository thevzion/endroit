# Hairness 0.5 reference

Hairness 0.5 is an alpha and a clean break from 0.4. JSON schemas under
`schemas/v5` define the machine contracts.

## Home

`hairness.json` requires:

```json
{
  "$schema": "https://hairness.dev/schema/home.json",
  "name": "engineering-home",
  "runtime": "@hairness/cli@0.5.0-alpha.0",
  "mode": "team",
  "providers": ["codex", "claude"]
}
```

`projection.prefix` changes provider-facing names. Optional byte budgets cover
`instructionsBytes`, `deskInstructionsBytes`, `skillDescriptionsBytes` and
`hudPromptBytes`.
`settings` uses full Asset names as keys.

The Home contains no machine path, Target or Integration field. Assets own
those settings.

## Desk

`.desk/desk.json` contains an id and namespaced personal settings:

```json
{
  "$schema": "https://hairness.dev/schema/desk.json",
  "id": "alexis",
  "settings": {
    "hairness/home": {
      "addressAs": "Alexis",
      "responseLanguage": "fr"
    }
  }
}
```

Solo Homes track `.desk/` in the Home repository while `.desk/targets/` stays
ignored. Team Homes ignore `.desk/` in the parent repository. `desk init`
creates an independent Git repository there; `desk clone <repository>` connects
an existing private Desk.

## Asset

An Asset lives at `assets/<namespace>/<name>/asset.json` or
`.desk/assets/<namespace>/<name>/asset.json`. Its `name` must match those two
path segments.

Supported source addresses:

```text
@hairness/home
@hairness/targets
@hairness/integrations
@hairness/scratch
owner/repository/path#tag
owner/repository/path#40-character-commit
owner/repository/path
https://example.com/path/asset.json
./path/to/asset.json
```

`asset add` validates and copies source files. It adds `origin` with the source,
requested reference, resolved commit, mobility, source manifest digest and file
digests. `origin.kind` distinguishes a source installation from a Desk
override. The lifecycle remains inert.

Asset sections:

- `instructions`: invariant session context;
- `capabilities`: provider-neutral procedures with optional bounded contracts;
- `skills` and `commands`: model and human invocation paths;
- `references` and `files`: on-demand material;
- `artifactKinds`: schemas, templates, states and owners;
- `cli`: typed Kernel operations or approved executables;
- `hud`: safe Kernel probes;
- `settings`: Home and Desk JSON Schemas;
- `setup`: Commands offered during onboarding;
- `executables`: approved code with declared outputs.

The Kernel ignores folder names. Each section points to source paths.

Provider-facing names combine the Home prefix, optional Asset prefix and local
surface id. Canonical ids remain `<namespace>/<asset>:<local-id>`.

## Resolved Home

`validate` loads and validates the Home, Desk and every Asset. It rejects
canonical, projected and CLI route collisions before writing files. It
calculates settings, capabilities, surfaces, Artifact kinds, warnings, byte
footprints and a stable digest.

`validate --json` exposes the public part of this model. Hairness persists no
resolved lockfile. `build`, `hud` and `doctor` resolve the same inputs.

## Kernel CLI

```text
create <home> [base-asset] [--mode solo|team]
init [--mode solo|team]

asset add <addresses...> [--desk] [--dry-run] [--overwrite] [-y]
asset status [id] [--desk]
asset diff <id> [--to <address>] [--desk]
asset sync <id>|--all [--check] [--to <address>] [--overwrite]
asset remove <id> [--overwrite] [--desk]
asset validate <id> [--desk]
asset override <id>
asset publish <id> --to home

validate [--json]
build [--check] [--allow-executable <canonical-id>]
doctor [--json]
```

Bundled Assets contribute:

```text
hud [--full] [--json] [--prompt]
desk init|clone|status
artifact create|list|inspect|validate|publish [--from <directory>]
command render
target list|discover|doctor|add|bind|clone|unbind|remove|map
integration list|doctor|add|bind|unbind|remove
scratch create
```

Removing the declaring Asset removes its namespace.

## Provider projections

`build` writes managed regions in `AGENTS.md` and `CLAUDE.md`, Skills under
`.agents/skills` and `.claude/skills`, and session hooks under `.codex` and
`.claude`.

Codex receives model-facing Skills. A command-only surface is omitted because
Codex cannot preserve user-only invocation. The HUD records a warning. Home
settings can record provider-specific lossy consent.

Claude receives model-facing Skills and command-only Skills with
`disable-model-invocation: true`.

Desk Instructions enter `hud --prompt`; they never enter shared managed
regions. Desk Skills and Commands remain provider-native. Solo projections are
versionable with the Home. Team projections are generated into native paths
and excluded locally from the parent Home repository.

## HUD and Doctor

The compact HUD reports Home, Desk, providers, surface counts, Artifacts, Git
state, named Target Bindings, worktrees, meaningful commit dates, context and
health. There is no active Target. `--full` adds every resolved surface, owner,
projection, exact evidence, context footprint and warning. `--json` returns
the HUD schema. `--prompt` renders XML session orientation.

HUD probes call Kernel readers. They execute no Asset code.

Doctor validates runtime, resolution, Asset state, projections, Targets and
Integrations. It reports `ready` or `partial` and gives repair routes.

## Targets and Bindings

The `hairness/targets` settings store shared identities and clone sources
without machine paths. A Target can be:

- `declared`, with no local checkout;
- `managed`, with a clone under `.desk/targets/<target>/<binding>`;
- `bound`, with a symlink at that location pointing to an existing checkout.

One Target can have several named Bindings. Commands infer a unique Binding and
otherwise require `--binding`.

`target map` reads tracked paths, Git evidence and bounded package metadata. It
creates `hairness/targets:target-map` in the Desk with seven required mapping
documents. Output is secret-scanned in staging and the Target remains
unchanged.
