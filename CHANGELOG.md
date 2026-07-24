# Changelog

## 0.5.0-alpha.0

- Define Hairness as a Home-first framework with one deterministic Resolved
  Home shared by validate, build, HUD and Doctor.
- Replace Overlay with the solo or team Desk and keep machine Target bindings
  outside shared configuration.
- Give Assets typed Instructions, Capabilities, Skills, Commands, references,
  Artifact kinds, CLI routes, HUD probes, settings, setup and executables.
- Replace Asset `hairness.json` with `asset.json` and reject the 0.4 layout.
- Add explicit model, user and combined invocation policies with
  provider-specific projection warnings.
- Add generic Artifact creation, validation, publication and lineage.
- Import multi-file Artifact results atomically from bounded staging.
- Replace Prologue with an inspectable HUD and context footprint.
- Project Desk Skills and Commands natively while keeping team outputs local.
- Add explicit Desk overrides with stale-base protection before Home
  publication.
- Replace the active Target with named one-to-many Bindings, managed clones and
  a native, read-only Target Map Artifact.
- Bind executable approval to the full Asset digest and restrict filesystem
  access to Asset input and staging output.
- Bundle Home, Targets, Integrations and Scratch in the single CLI tarball.

## 0.4.0-alpha.1

- Keep GitHub Asset staging alive until every declared source file has been read.

## 0.4.0-alpha.0

- Make the provider-agnostic Home the primary Hairness product.
- Reduce publication to the single on-demand `@hairness/cli` Kernel.
- Bundle source-owned onboarding and opt-in Scratch Assets in the CLI.
- Add local, HTTPS, official and GitHub Asset resolution.
- Give each installed Asset one autonomous manifest with provenance and base digests.
- Add offline status, diff, cautious sync and source-aware remove.
- Keep Git as history; remove Registries, Catalogs, package dependencies and Hairness locks from Homes.
- Track Codex and Claude projections so a clone works without a build.
- Require explicit staging approval for executable Adapters.
- Preserve independent Targets, credential-free Integrations and explicit
  `.overlay/` memory.
- Add the source-owned `hairness/project` Asset for dogfood from an independent Home.

This alpha has no in-place migration from the removed 0.3 model or superseded
0.4 candidates.
