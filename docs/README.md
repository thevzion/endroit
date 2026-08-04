# Endroit documentation

Endroit documentation is source-owned by this repository. Public docs are a
commit-pinned projection, not a second canon. Every current-behavior claim must
be supported by code, a schema and a test or be labelled as a limit or roadmap
item.

## Start

- [Install](../INSTALL.md) — create a new Workplace and run the first checks.
- [Adopt](../ADOPT.md) — select a boundary without taking over existing work.
- [Upgrade from 0.9 to 0.10](migration-0.10.md) — know what migrates and what
  must remain intact.

## Understand

- [Concepts](concepts.md) — ownership, sources, projections and authority.
- [Profile](../PROFILE.md) — normative Endroit representation of Open Workplace.
- [Architecture](architecture.md) — parser, resolver, observations and build.
- [Lifecycles](lifecycles.md) — independent state axes and explicit effects.

## Operate

- [CLI and file reference](reference.md) — commands, files and diagnostics.
- [Work Resolution](work-resolution.md) — `WORK.md` and its calculated frontier.
- [Providers](providers.md) — supported provider surfaces and evidence level.
- [Security](../SECURITY.md) — report vulnerabilities and preserve boundaries.

## Upgrade and release

- [Route v7 → v8](migration-route-v8.md)
- [Route v8 → v9](migration-route-v9.md)
- [0.10.0-alpha.0 release candidate](releases/0.10.0-alpha.0.md)
- [Changelog](../CHANGELOG.md)
- [Roadmap](../ROADMAP.md)

## Evidence hierarchy

Use the narrowest owner for a claim:

1. schemas own accepted document shapes;
2. `src/` and bundled Equipment runtimes own implemented behavior;
3. tests own repeatable qualification evidence;
4. `PROFILE.md` owns the Endroit representation and limits;
5. this documentation explains those sources without expanding them.

A retained Workplace note may motivate a change, but it is not product truth
until the Endroit owner accepts and implements it here.
