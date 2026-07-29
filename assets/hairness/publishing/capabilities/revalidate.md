# Revalidate a published Handle

Open the local Publication and its Handle, then inspect the exact remote object.

Refresh `observed_at`, append dated metrics and compare remote content with the
recorded `content_digest`. Keep `active` when the projection is present and
consistent; use `drifted`, `removed`, `superseded` or `unknown` when current
evidence requires it.

Never overwrite `content.md` from remote drift. Import a deliberate remote edit
as an explicit local revision after human review.
