# Adopt an existing environment

Adoption is a consent-first conversation over explicit evidence. It is not a
filesystem migration command and it does not assume that another Workplace is
needed.

## 1. Bound Source A

Name the exact directory or files Endroit may inspect and what stays excluded.
`.workplaceignore` and request include/exclude patterns limit implicit
discovery; they are not access control. Credentials, provider memory,
dependencies, caches and source-control internals remain excluded.

## 2. Discuss the target contract

Profile, Composition, ownership and target Mount are decisions for a future
Apply. The current command does not infer or write them. The Standard is one
option, not a universal interpretation of every environment.

## 3. Produce a Preview without effect

```sh
bun src/cli.ts preview <source> --out <new-directory> [--ignore <file>] --json
```

The command applies a read-only Lens and renders a
`human/workplace-preview@1` View containing:

- the exact Source A path and file digests;
- the observed Lens kind and label;
- the proposed sovereign Site locator;
- explicit no-copy, no-absorption and no-delivery boundaries;
- a Manifest digest.

Stopping with the Preview is a successful Outcome.

## 4. Correct by reprojection

Correct Source A or its explicit ignore input and regenerate the Preview rather
than editing generated prose. A future AdoptionRequest will own Profile,
Composition, ownership and exact target files. Unknown ownership or Authority
never becomes an inferred write.

## 5. Consent to an exact Apply (not shipped)

The future Apply may run only after explicit human consent naming the Preview digest and target
Mount. Revalidate Source A, Profile, Composition, Preview and destination. A
stale digest or collision blocks with zero writes.

Apply creates only the declared owned Workplace sources. It does not move
Source A, absorb repositories, create remotes or deliver Sites.

## 6. Compile and verify fresh

Compile the new Mount, check it, then open a fresh provider session at the
MountRoot. Verify identity, Room and Work discovery, sovereign Site links and
Authority boundaries without relying on the adoption conversation.

See [docs/adoption.md](docs/adoption.md) for the typed contracts and
[examples/brownfield/](examples/brownfield) for the deterministic Preview
fixture.
