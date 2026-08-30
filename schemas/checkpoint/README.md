# Git State Portability format v1

These closed JSON Schemas describe the executor-independent local checkpoint
surface. The Endroit CLI is one reference executor; `CHECKPOINT.md`,
`MANIFEST.json`, `RESTORE.md`, component records and `RECEIPT.json` remain
ordinary files.

The current vertical implements local `capture`, `verify` and atomic `restore`,
then explicit Git-native `publish` and `fetch` through a local
`ContinuityBinding`.
It preserves declared repository refs and object closure, linked-worktree HEAD,
branch/detached state, normalized index stages and flags, tracked working bytes,
untracked non-ignored files and active Git-operation metadata. Ignored files are
always excluded in v1.

Remote checkpoints are ordinary immutable Git commits under internal
`refs/endroit/checkpoints/owners/...` refs. A Member-owned line head advances by
compare-and-swap; concurrent divergence preserves every immutable checkpoint
and never merges dirty states. Core v1 adds no application encryption: readers
of the selected Git repository can read published checkpoint bytes.

Git owns authentication. `ContinuityBinding` explicitly distinguishes a
dual-role Product Remote from a separate Continuity Remote and never discovers
`origin`. A successful Receipt means physical
fidelity only; it never means accepted, valid, ready or delivered.

`TOOLCHAIN.json` declares the exact formats and commands of this distribution.
`node scripts/checkpoint-validate.mjs <checkpoint>` is a standalone Node + Git
validator that does not import Endroit and emits the same closed restore plan.
Omitting a checkpoint ID selects the Current Member's declared Checkpoint Line
head. There is no global checkpoint selector or ref.
