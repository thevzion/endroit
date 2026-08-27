# Static adoption

Adoption reuses the projection kernel while keeping recognition and mutation
separate.

```text
recognize → describe → map → propose → apply → verify
```

An `AdoptionRequest` names approved roots, include/exclude patterns, exact
Profile/Composition revisions and the proposed TargetWorkplaceMap. The Lens
produces evidence-classed observations. `WORKPLACE-PREVIEW.md` is the human
View of that map, not an owned Workplace source.

Apply is not shipped. Its candidate contract requires explicit consent and the
expected Preview digest, revalidates all dependencies, refuses stale evidence
and collisions, and keeps existing repositories in their own Git roots.

The shipped implementation is a deterministic, read-only Preview. It adds no
second semantic engine and no adoption journal. Preview without Apply is a
valid Outcome; mutation waits for repeated use to prove the interface.
