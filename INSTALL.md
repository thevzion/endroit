# Install Endroit 0.10

Endroit 0.10 is a local alpha candidate. The package version is
`0.10.0-alpha.0`, the Profile is `endroit/0.10`, the protocol target is
`open-workplace/0.2-draft`, and canonical Documents use schemas v9.

The agent guides. The CLI applies. The human approves.

## Requirements

- Node.js 22 or 24;
- Git for repository-backed Workplaces, Desks and Sites;
- an explicitly selected destination;
- human approval before creating or initializing that destination.

Do not install over an existing Endroit declaration. Follow [ADOPT.md](ADOPT.md)
first when the boundary has not been selected.

## Create a standalone Workplace

```sh
npx --yes --package @endroit/cli@0.10.0-alpha.0 \
  endroit create <directory> --desk tracked
```

Desk strategies:

- `tracked`: Desk sources share the Workplace repository;
- `separate`: `.desk/` is a nested private repository;
- `later`: create no Desk continuity or local Routes yet.

Optional Equipment can be selected with
`--with research,planning,publishing,scratch`. Codex and Claude are enabled
by default; use `--providers` to narrow them.

## Initialize a selected repository

```sh
npx --yes --package @endroit/cli@0.10.0-alpha.0 \
  endroit init <repository> --desk separate
```

This creates an embedded Site relationship for the selected repository. It
does not import other repositories or transfer their ownership.

## Verify

Use the tracked console generated inside the Workplace:

```sh
cd <directory>
node ./endroit.mjs validate
node ./endroit.mjs build --check
node ./endroit.mjs doctor
```

The canonical selector is `--workplace <path>` or
`ENDROIT_WORKPLACE_PATH`. The 0.10 compatibility window still reads
`--home` and `ENDROIT_HOME_PATH`; both aliases are scheduled for removal in
0.11.

## Provider projections

`build` writes `AGENTS.md`, `CLAUDE.md`, provider Skills, the tracked
console and `.endroit/build.json`. It does not install provider hooks, edit
host configuration or mutate `.git/info/exclude`.

Open Codex or Claude in the Workplace using the launch command printed by
`create` or `init`. Provider-specific host integration, when needed, is a
separate explicit operation and is not implied by installation.

## Existing 0.9 data

Endroit 0.10 reads frozen v7/v8 declarations through its compatibility adapter
and writes new v9 sources. Route conversion is explicit:

```sh
node ./endroit.mjs route migrate --check --json
node ./endroit.mjs route migrate --json
node ./endroit.mjs route migrate --rollback <run-id> --json
```

See [Route v8 to v9 migration](docs/migration-route-v9.md). Never move or clean
a checkout as part of source migration.
