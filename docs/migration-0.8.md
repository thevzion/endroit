# Migrate Endroit 0.7 to 0.8

Endroit 0.8 is an intentional alpha break. There are no permanent command or
schema aliases. Migrate in Git, keep the last valid 0.7 commit and preserve
meaning before renaming files.

This guide upgrades an Endroit 0.7 Home. It is not the general adoption path
for an existing non-Endroit environment; use the portable
[ADOPT.md](../ADOPT.md) guide for that.

All active 0.8 documents use `https://endroit.org/schema/v7/<type>.json`.
Historical unversioned schema URLs remain 0.7 contracts and never redirect to
v7. Runtime Equipment moves from `endroit.org/runtime/v1alpha1` to
`endroit.org/runtime/v2alpha1`.

## Vocabulary

| 0.7 | 0.8 |
|---|---|
| Workspace | Room |
| Workstream | nested Room, retained Meeting record or Material |
| Asset | Equipment |
| Document / Artifact | Material or an Equipment-owned validation contract |
| Target | Site |
| Binding | Route |
| provider Skill / Command | Equipment projection |

## Procedure

1. Inventory shared and Desk-owned Workspaces, Assets, Targets and Bindings.
2. Commit the last valid 0.7 Home.
3. Create `members/<id>/MEMBER.md` for each human and remove `mode` from
   `endroit.json`; 0.8 intentionally rejects Homes while `mode` remains.
4. Add required `member` to `.desk/desk.json`. Keep or rename the Desk ID based
   on the Desk's own identity, not the person's name.
5. Choose the real Git boundary: tracked Desk, separate nested Desk or later.
6. Convert each durable domain to a Room with `ROOM.md` and `inbox.md`.
7. Keep a Workstream as a nested Room only when it owns a mission, continuity,
   decisions, Material and repeated Meetings; otherwise retain it as Material.
8. Convert Assets to Equipment and regenerate provider projections.
9. Create `sites/<id>/SITE.md` for every Target.
10. Resolve every Binding to its real Git root and write a Desk Route JSON.
11. Classify each Route as embedded, existing, managed clone, managed worktree
   or submodule. A Target without a checkout becomes remote-only.
12. Keep existing checkouts in place. Adopt them and reconcile their generated
   index links; create new managed clones and worktrees under ignored
   `checkouts/` paths.
13. Rebuild, run Doctor and inspect every Route before retiring 0.7 sources.

Do not import a symlink as Site identity. Do not move a checkout merely to make
the migration look tidy. Paths are Desk state; ownership is the durable part.

## Embedded repository

For a repository that should also contain its Home, run:

```bash
npx --yes --package @endroit/cli@0.8.0-alpha.2 endroit init .
```

This creates Site `self` and Route `embedded` at `.`. The Home owns only its
workplace sources and projections; the Site continues to own product truth and
Git history.

## No automatic migrator

`0.8.0-alpha.2` ships this written procedure first. An automated migration pass
would need read-only inventory, explainable placement and explicit approval;
it is not included in this release.
