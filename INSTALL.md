# Install from source

Endroit `v0.1.0-rc.1` is a pre-release that currently runs from this checkout
with Bun 1.3.14. No npm package or binary distribution is published.

```sh
bun install --frozen-lockfile
bun run typecheck
bun run test
```

## Commands

```sh
bun src/cli.ts new ~/Workplaces/studio
bun src/cli.ts check --mount examples/smallest/world --json
bun src/cli.ts check --mount examples/smallest/world \
  --profile profiles/standard/profile.json --json
bun src/cli.ts check /path/to/shared-root --staged --json
bun src/cli.ts check /path/to/shared-root --history --json
bun src/cli.ts compile --mount examples/smallest/world \
  --entry bindings/entry.json --provider codex
bun src/cli.ts ready examples/smallest/world --json
bun src/cli.ts workplace list /path/to/anchor --json
bun src/cli.ts workplace enter workplace://example/peer \
  --anchor /path/to/anchor --json
bun src/cli.ts preview examples/brownfield/source \
  --out ./endroit-brownfield-preview --json
```

`new` is the interactive entry for a fresh personal Workplace. It previews the
exact Roots, files, adapters, Git guards and Git commits, then requires one confirmation.
It builds beside the target and moves the complete Mount into place only after
compile and check pass.

For deterministic automation, preview and Apply the same closed Request:

```sh
bun src/cli.ts new --request examples/fresh/request.json --preview --json
bun src/cli.ts new --request examples/fresh/request.json --apply <sha256> --json
```

Apply requires the current preview digest and an absent target. A changed
Request invalidates the digest. JSON mode has no prompts, ANSI, logo, spinner
or unstable prose.

`new`, `compile`, `check` and `ready` accept `--profile <package>`. A generated
Workplace pins the Package Ref and digest. If that exact Package is unavailable
or changed, existing projections remain readable while rebuild reports
`compile-required` with the repair action.

`compile` and `ready` require a declared shared Root and never create a Member,
Desk, WELCOME, Work, Site, repository, remote or deployment. Without an
EntryBinding they may compile the neutral entry, then return
`onboarding-required` with an exact next action.

`check --staged` validates the Git index; add `--commit-message <file>` for the
commit contract. `check --history` detects invalid commits even when hooks were
bypassed. A missing marked hook is degraded and `ready` can repair it; a foreign
hook or `core.hooksPath` collision is never overwritten.

`preview` is read-only with respect to its source. It creates only the new
output directory and does not Apply an adoption.

`workplace list` derives addressable peers from the Anchor's portable Links and
local Bindings. `workplace enter` resolves one exact bound Mount, verifies its
Workplace identity and returns its existing target-owned Front Door. Neither
command scans the machine, clones a repository or mutates the target.

`workplace setup` is the explicit materialization step. Its local Request names
every target, relation, Mount, EntryBinding and ProviderBinding. Preview emits a
digest without running Git; Apply accepts only that digest. A target with a Git
source is cloned into `<Mount>/workplace`; a target without one must already be
present at the exact declared Mount.

```sh
bun src/cli.ts workplace setup /path/to/anchor \
  --from /path/to/setup.json --preview --json

bun src/cli.ts workplace setup /path/to/anchor \
  --from /path/to/setup.json --apply sha256:<preview-digest> --json
```

Required target failure rolls back setup-owned Mounts and the Anchor Binding.
An unavailable optional target returns a partial Receipt and is not bound. The
Request and Receipt stay local; they contain no credentials. Setup transports
committed Git only. Dirty worktrees, local refs and untracked files belong to
the separate Git State Portability checkpoint contract.

The first Git State Portability vertical is local and request-driven:

From an official clone at `<Mount>/workplace`, the root facade can create its
local EntryBinding and Current Member state, consume the portable recovery
declaration, and materialize its declared peers:

```sh
cd /path/to/mount
bun /path/to/endroit/src/cli.ts setup --as operator --json
bun /path/to/endroit/src/cli.ts status --json
```

When the current Workplace intentionally carries no private peer locator, pass
one closed Bootstrap Ref. It contains a credential-free Git HTTPS locator, a
full ref and an exact relative Recovery Request path. Git owns authentication.

```sh
bun /path/to/endroit/src/cli.ts setup \
  --with 'git+https://example.test/private-workplace.git#refs/heads/develop:.workplace/recovery.json' \
  --as operator --json
```

`setup` resolves cwd ancestors only. It never scans the host, guesses
`origin`, accepts `HEAD`/`latest`, embeds credentials, captures state or pushes
a ref. It extracts only the Recovery Request's declared file closure from the
fetched commit, records a digest over that closure, and retains those files
only in ignored local state for replay.

The local-first root checkpoint surface is:

```sh
bun /path/to/endroit/src/cli.ts checkpoint --json
bun /path/to/endroit/src/cli.ts checkpoint push checkpoint:sha256:<digest> --json
bun /path/to/endroit/src/cli.ts checkpoint fetch checkpoint:sha256:<digest> --json
bun /path/to/endroit/src/cli.ts checkpoint restore checkpoint:sha256:<digest> --json
```

Local capture never pushes. Only explicit `checkpoint push` can publish the
selected immutable Member-line checkpoint. Root `setup` may fetch one exact
checkpoint selected by its closed Recovery Request through a declared
ContinuityBinding, verify it, then reuse the same Recovery Apply engine. It
never pushes. `remote:none` makes no remote contact; optional absence degrades
only its Position and required absence blocks only its Position.

For a not-yet-materialized peer, the local or private Bootstrap Recovery
Request may declare `continuity: [{ workplace, descriptor }]`. Each path names
one complete local `ContinuityDescriptor/1`; Setup verifies it, installs it at
that peer's `.endroit/continuity.json` inside the Recovery transaction and
receipts `created|unchanged` before the bounded fetch/replan pass. Portable
public Requests do not carry private ContinuityBinding locators.

The advanced request-driven surfaces remain available:

```sh
bun src/cli.ts checkpoint capture --from /path/to/capture-request.json --json
bun src/cli.ts checkpoint verify /path/to/checkpoint --json
bun src/cli.ts checkpoint restore /path/to/checkpoint --to /absent/target --json
bun src/cli.ts checkpoint publish /path/to/checkpoint --from /path/to/publish-request.json --json
bun src/cli.ts checkpoint fetch checkpoint:sha256:<digest> --from /path/to/fetch-request.json --to /absent/local-checkpoint --json
bun src/cli.ts checkpoint restore-remote checkpoint:sha256:<digest> --from /path/to/fetch-request.json --to /absent/target --json
node scripts/checkpoint-validate.mjs /path/to/checkpoint
```

### Exact Workplace recovery

To resume an entire captured Workplace, use a new, absent Mount. This does not
overwrite the clone or session you start from. Its parent directory must exist.
From an existing Mount (including a product clone with its declared continuity
configuration), the exact ID uses the declared local store first, then its
explicit ContinuityBinding:

```sh
bun /path/to/endroit/src/cli.ts setup \
  --checkpoint checkpoint:sha256:<digest> --to /path/to/new-mount \
  --as operator --json
```

On a cold machine without a Mount, use an already authored
`CheckpointFetchRequest/1` at an exact Git ref and file path. This reuses the
same closed request and normal Git authentication; no JSON must be invented on
the destination machine. The package owner supplies the immutable checkpoint
ID and this reference through an appropriately private channel:

```sh
bun /path/to/endroit/src/cli.ts setup \
  --checkpoint checkpoint:sha256:<digest> --to /path/to/new-mount \
  --checkpoint-from 'git+https://example.test/private-bootstrap.git#refs/heads/develop:fetch.json' \
  --as operator --json
```

`--checkpoint-from` also accepts a local Fetch Request file. With an already
verified local package, use `--checkpoint /path/to/package` and omit it. No
command above captures or pushes. Fetch extracts only the declared file from
the selected Git commit, records URL/ref/OID/path/digest provenance, and verifies
the immutable package before installation.

The checkpoint declares exactly one shared Root worktree at `workplace`, plus
Site worktrees at `checkouts/sites/<site>/<route>`. The captured portable
`.workplace/recovery.json` supplies setup and peer declarations; advanced
`--from <recovery.json>` remains available. Checkpoint-covered Site Routes are
not cloned again or reset to a Product Remote branch. Other declared Routes
and managed peers use the existing setup engines. External peer attachments
and a second checkpoint overlay are rejected before installation.

Restore verifies the portable fingerprint in staging, preflights identity,
Member and declarations, then installs the new Mount. It creates local
Entry/Current Member/Route Bindings and compiles local Front Doors only. It
never repairs the captured Root's hooks, compiles its portable files or changes captured source bytes,
index stages, branches, refs, detached HEADs or conflicts. The Receipt at
`.endroit/checkpoint-setup.json` separates `restored-equivalent` from semantic
readiness. Valid sources have a local `FRONTDOOR.md`, including the local Route
Binding index with exact checkout paths; stale portable projections still
report `degraded`/`compile-required`. `workplace enter <workplace-ref> --anchor
<restored-mount>` admits `entryMode: preserved-local` only after verifying all
local projection bytes against the current sources, Member, Provider and
adjacency with the normal renderer, plus a non-invalid Git witness. This is
usable local entry, not a claim that portable projections or Git guards are
ready. The same command can enter the Anchor itself. Invalid sources or
altered local Front Doors/Bindings are refused. Clean peers use ordinary setup
and their own ready gate. Without `--as` or
an explicitly remembered Member from the source context, physical restoration
is `pending-member` rather than inferred identity.

Include `--as` on the first recovery command when you want an operational
entry. This slice does not upgrade a `pending-member` Receipt in place. The
safe route is the same checkpoint into another absent Mount with `--as`:

```sh
bun /path/to/endroit/src/cli.ts setup --checkpoint /path/to/package \
  --to /path/to/another-new-mount --as operator --json
```

The earlier pending restoration stays untouched. For an ID, retain the same
`--checkpoint-from` or declared source context. Do not use ordinary `setup` or
`ready` to personalize an exact dirty restoration: those are not byte-preserving
recovery operations.

Rerun the same command against its own exact restored target to verify an
`unchanged` replay. Other existing targets, changed recovery declarations or
divergent restored Git state are refused; neither source nor existing target
is overwritten. Resolving stale source/projection work remains an explicit
later action, not a side effect hidden inside recovery.

Capture resolves only explicitly declared Roots and worktrees. The immutable
package includes static recovery documents and closed schemas under
`schemas/checkpoint/`. Restore reconstructs into an adjacent temporary target,
proves the same portable fingerprint, then renames atomically. Raw restore never invokes
`check`, `compile` or `ready`. Git-native checkpoint refs are scoped by owner
Member and line; no global `latest` exists. Private product repositories may
declare an explicit dual role, while public product repositories require a
separate private continuity repository. Endroit stores no credential and
imposes no application encryption layer. Divergence preserves every immutable
checkpoint and never auto-merges dirty states.

Generated semantic Markdown/JSON uses canonical LF. Checkpoint payload bytes
remain byte-exact. Windows directory links use junctions, while a checkpoint
requiring a true file symlink fails capability preflight before target
mutation. The local cross-platform suite covers these contracts, but actual
Windows fresh-machine qualification remains a separate acceptance gate.

Windows checkpoint placement also requires each **Git working directory** to
be shorter than 260 UTF-16 units after resolving existing junctions/short names.
This is the qualified Git for Windows 2.55 startup capability, not a limit on
payload file paths: `core.longpaths` does not enlarge Git's fixed `getcwd` buffer.
Admission checks final worktrees, adjacent staging, common Git directories and
worktree administration paths, reserving a finite collision suffix, before
verification or installation can create destination directories. An unsupported
placement returns `checkpoint-git-cwd-unsupported`; choose a shorter explicit
Mount (or store for a verification-directory failure). No alias or system setting
is created. Remote acquisition can precede the manifest-dependent check and may
leave a verified local cache, but a refused destination is not materialized.

## Try the demonstrations

- [ADOPT.md](ADOPT.md) explains the shipped static brownfield Preview and the
  not-yet-shipped Apply boundary.
- [examples/fresh/TRY.md](examples/fresh/TRY.md) creates a fresh Workplace with
  no preinstalled subject.
- [examples/flappy/TRY.md](examples/flappy/TRY.md) creates a disposable mounted
  Workplace and three human trials.

No provider run is part of installation or tests.

## Remove Endroit

Compiled Front Doors and portable maps remain navigable after removing this
checkout, Bun and `.endroit/`. New guarded owned-Root commits fail closed until
the bound CLI is restored; recompilation and stale repair also require it.
