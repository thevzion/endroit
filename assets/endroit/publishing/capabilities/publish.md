# Publish an external projection

Publish only a `ready` Publication after showing the exact content, assets,
links, account, destination, community and metadata to the human.

Approval is scoped to that one effect and never authorizes cross-posting. Check
current destination rules immediately before mutation.

When a suitable connector is available, use it only after approval, verify the
remote result, then create
`publishing/handles/<system>/<slug>.md` from the Handle template and mark the
Publication `published`. Record remote ID, URL, publication time, observation
time and the digest of `content.md`.

For a new revision of an existing projection, show both the current observed
Handle and the exact replacement. Update the Handle only after the new remote
content is observed. If the remote projection is withdrawn, record `removed`
after observing its absence; never infer withdrawal from a local route change.

Without a connector, provide a precise manual handoff. Do not create the Handle
or claim publication until the remote object is observed. If the external
effect succeeds but local recording fails, report the partial result and
resume reconciliation before any further publication.
