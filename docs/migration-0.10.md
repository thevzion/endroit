# Upgrade from Endroit 0.9 to 0.10

Endroit 0.10 is a local alpha candidate. It can read the frozen 0.9 contracts,
but it does not provide a whole-Workplace migration. Preserve the last valid
0.9 commit and inspect every owner before changing a source.

## Supported boundary

| Source | 0.10 behavior | Automatic migration |
| --- | --- | --- |
| `endroit.json` and `HOME.md` | readable through the legacy adapter | none |
| Member and Desk legacy declarations | readable through the legacy adapter | none |
| Route v7 JSON | readable | one step to v8 |
| Route v8 JSON | readable | one step to v9 `ROUTE.md` |
| Room and Site sources | compatible readers and writers remain available | none |
| Equipment and Artifact sources | owner-specific compatibility | none |
| Work v1alpha1 `WORK.json` | read-only inspection and resolution | none |
| Work v1alpha2 `WORK.md` | current Work source | not required |

The v9 schema family being published does not expand this matrix. In
particular, the Room and Site v9 schemas are contract surfaces in this candidate,
not proof of a matching writer or in-place migration.

## Safe upgrade sequence

1. Commit or otherwise preserve every owned source and record the current Git
   state. Do not clean or relocate a Checkout as part of this upgrade.
2. Run the 0.10 CLI against the legacy Workplace in read-only mode:

   ```sh
   node ./endroit.mjs validate
   node ./endroit.mjs doctor
   node ./endroit.mjs site doctor
   ```

3. Preview Route migration. Preview creates no lock, journal or source change:

   ```sh
   node ./endroit.mjs route migrate --check --json
   ```

4. If the preview is exact, apply one Route step and retain its `runId`:

   ```sh
   node ./endroit.mjs route migrate --json
   node ./endroit.mjs route migrate --rollback <run-id> --json
   ```

   A v7 Route requires one run to reach v8 and a later run to reach v9. Route
   migration never moves a Checkout or changes Git.

5. Leave root, Room, Site, Equipment and Artifact sources in their compatible
   formats. Do not create a v9 sibling beside a legacy declaration; competing
   sources are ambiguous.
6. For retained Work, create and review a new `WORK.md` v1alpha2 source
   explicitly before removing `WORK.json`. There is no automatic converter.
   Verify it with `work inspect` and `work resolve`; keep the legacy source in
   version history.

## Moving to a native v9 root

There is no supported in-place `endroit.json` → `WORKPLACE.md` command in this
candidate. A new native 0.10 Workplace must be created at an explicitly selected
empty boundary, then populated owner by owner. Do not merge, rename or delete
the legacy Workplace merely because the new root validates.

This limitation is intentional release information. A future migration must
define preview, provenance, verification and rollback before it can replace
the compatibility reader.
