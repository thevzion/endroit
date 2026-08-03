# Install Endroit

Endroit is installed **agent-led, CLI-backed and human-approved**.

This is the deterministic CLI appendix to the
[ADOPT.md](https://endroit.org/adopt.md) adoption guide. Use that guide first
when the human has existing repositories, instructions or methods to
recognize. The [Endroit Workplace
Profile](https://endroit.org/WORKPLACE.md) defines the semantic contract used
after entry. This file applies only after a Home destination and operation have
been selected.

The commands below target the local `@endroit/cli@0.9.0-alpha.0` release
candidate, which includes `ADOPT.md` and `WORKPLACE.md`. Do not run the npm
commands until that exact registry artifact has been observed. The last
observed published release is `0.8.0-alpha.1`.

If you are an agent reading this file, guide the human through the following
contract. The CLI applies the changes; you do not reorganize their files
yourself.

## 1. Inspect without changing anything

Confirm that Git and Node.js 22 or newer are available. Inspect the requested
destination and determine which operation fits:

- use `create` for a new standalone Home in a new directory;
- use `init` when the current Git repository should also contain the Home;
- use neither when the human has not identified the intended destination.

Do not move or rewrite existing `AGENTS.md`, `CLAUDE.md`, Skills, memory,
source files or checkouts during bootstrap.

If either canonical instruction filename already exists at the destination,
stop on the CLI collision. Do not merge, overwrite or rename it implicitly.

## 2. Present the exact plan

Before any mutation, tell the human:

- whether you propose `create` or `init` and why;
- the exact destination;
- the Desk strategy: `tracked`, `separate` or `later`;
- that Endroit will add owned source files, first-party Equipment and generated
  provider projections;
- that existing product files will stay in place.

Show the exact command and ask for approval. A refusal or missing approval
ends the installation without effects.

## 3. Apply only the approved command

Use the pinned alpha package:

```bash
npx --yes --package @endroit/cli@0.9.0-alpha.0 endroit create <directory> --desk tracked
```

or, from the existing repository:

```bash
npx --yes --package @endroit/cli@0.9.0-alpha.0 endroit init . --desk separate
```

Change arguments only when the human approved the corresponding destination,
providers, Member or Desk strategy. Do not substitute another installer,
script, package version or direct file mutation.

## 4. Verify and continue onboarding

From the resulting Home, run:

```bash
node ./endroit.mjs doctor
```

Report the observed result. If Doctor is not ready, stop and explain the
limits; do not repair or migrate unrelated files implicitly.

When the Home is ready, use its generated Front Door and onboarding Equipment.
The human can continue in normal conversation, inspect the Home, and adopt
explicit workplace gestures only when useful.

> **The agent guides. The CLI applies. The human approves.**
