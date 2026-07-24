# Contributing

Read the [technical reference](docs/reference.md) and [security policy](SECURITY.md)
before changing public behavior.

Change canonical source under `src/`, `schemas/` or `assets/`. Keep the
README, reference, schemas, CLI and tests aligned. Add a durable test for a
recurring correction.

```bash
npm ci --ignore-scripts
npm run check
npm test
npm run conformance
npm run check:providers
npm run check:pack
npm run check:lab
```

Use Conventional Commits and keep changes focused. A new dependency, executable
Asset runtime or public contract change needs a concrete consumer and maintainer
agreement.
