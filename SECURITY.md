# Security

## Trust boundaries

Endroit compiles untrusted local configuration and Markdown. Parsing fails
closed before any projection write. The source boundary rejects YAML features
that can create aliases, cycles, custom types or prototype keys.

EntryBinding and ProviderBinding are local associations, not Authority.
Keys derived from `admits` grant discovery/reading metadata only.

Portable `.workplace/` output must contain no secret, local physical path or
private Desk body. Local projections must be ignored and are written only when
their ownership marker and collision contract are valid.

Compile, check and ready never write through Site Routes.

Shared/Desk Git hooks fail closed through the same public staged validator, but
are not a security boundary against a machine owner: Git permits
`--no-verify`. Historical witness validation therefore remains mandatory and
`ready` will not hide an invalid history. Endroit never installs Site,
post-commit, prepare-commit-msg or pre-push hooks.

`new --apply` accepts only a current digest and an absent, non-symlink target.
It builds in an adjacent temporary directory and publishes the Mount with one
rename only after Git initialization, compilation and verification succeed. It
never creates a remote.

## Reporting

Report issues privately to the repository owner. Do not include credentials,
private Workplace content or exploit payloads from third parties.
