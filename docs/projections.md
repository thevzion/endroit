# Projections

Endroit uses one kernel vocabulary for static compilation and adoption.

```text
Lens → Map → Target → Projection + Manifest
```

- **Lens** asks one bounded read-only question and declares evidence classes,
  exclusions and freshness.
- **Map** is the sourced answer. Assertions are observed, inferred, unknown or
  excluded.
- **Target** describes an output contract, representable relations, loss and
  verification.
- **Projection** is a rebuildable representation. It does not create truth,
  ownership, maturity or Authority.
- **Manifest** records source revisions, selections, omissions, compiler/Target
  versions and output digests.
- **View** is a Projection whose Target is human or agent comprehension.

Editing a View does not silently change its sources. A correction either routes
to an owned source or updates the request that produces a new Projection.

Front Doors are Views. Each section retains its semantic sources, scope,
visibility, disclosure reason and links. Disclosure Contracts make their
`mustShow`, `mayShow`, `mustHide` and required links inspectable per Position.

Coordination follows the same source/projection split:

```text
workplace/coordination.json
→ workplace/.workplace/coordination.json
→ .endroit/coordination-ir.json
→ agents/manager.md + agents/worker.md + situated Front Door links
```

The first file is owned. Every later surface is rebuilt and revision-bound.
