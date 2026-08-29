# Git State Portability format v1

These closed JSON Schemas describe the executor-independent local checkpoint
surface. The Endroit CLI is one reference executor; `CHECKPOINT.md`,
`MANIFEST.json`, `RESTORE.md`, component records and `RECEIPT.json` remain
ordinary files.

The current vertical implements local `capture`, `verify` and atomic `restore`,
then encrypted `publish` and `fetch` through an explicit Git remote.
It preserves declared repository refs and object closure, linked-worktree HEAD,
branch/detached state, normalized index stages and flags, tracked working bytes,
untracked files, selected ignored files and active Git-operation metadata.

Remote payloads use `age/1`. Each ciphertext decrypts to one JSON header line
conforming to `envelope-record-v1.schema.json`, followed by its exact raw file
bytes. `CONTROL.json` exposes only the checkpoint ID, recipient Refs and opaque
ciphertext digests/sizes; package paths and content remain encrypted.

Network credential policy, `latest`, cross-OS qualification and real Workplace
dogfood are not part of this vertical. A successful Receipt means physical
fidelity only; it never means accepted, valid, ready or delivered.

`TOOLCHAIN.json` declares the exact formats and commands of this distribution.
`node scripts/checkpoint-validate.mjs <checkpoint>` is a standalone Node + Git
validator that does not import Endroit and emits the same closed restore plan.
