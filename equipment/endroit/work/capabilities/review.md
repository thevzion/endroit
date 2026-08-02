# Click and Review

Present the review projection of one owned `endroit/work:item`.

1. Use an explicit Work selector, or continue only when
   `node ./endroit.mjs work review --json` resolves exactly one Work Item.
2. Render the returned order unchanged. Show each item's owner, question,
   target, provenance and current status.
3. Revalidate the declared Route before opening a Site preview. A local file
   may be opened and a Site-native preview may be started only because the
   human invoked this command; the Work runtime itself never executes it.
4. Interpret `1 OK` as `accepted`, `2 changes: <note>` as
   `changes-requested`, and `3 blocked: <note>` as `blocked`. Record only the
   named item through `node ./endroit.mjs work record-review`.
5. Present the updated review list and remaining pending items.

Review never accepts the Artifact, changes its lifecycle, commits, pushes,
delivers, publishes or infers that an external effect is authorized.
