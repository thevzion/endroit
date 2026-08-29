# Git State Portability format v1

These closed JSON Schemas describe the executor-independent local checkpoint
surface. The Endroit CLI is one reference executor; `CHECKPOINT.md`,
`MANIFEST.json`, `RESTORE.md`, component records and `RECEIPT.json` remain
ordinary files.

The current vertical implements local `capture`, `verify` and atomic `restore`.
It preserves declared repository refs and object closure, linked-worktree HEAD,
branch/detached state, normalized index stages and flags, tracked working bytes,
untracked files, selected ignored files and active Git-operation metadata.

Encryption, checkpoint remotes, `latest`, cross-OS qualification and real
Workplace dogfood are not part of this vertical. A successful Receipt means
physical fidelity only; it never means accepted, valid, ready or delivered.
