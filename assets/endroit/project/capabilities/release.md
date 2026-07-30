# Prepare an Endroit prerelease

1. Require a clean, qualified candidate and record its exact commit.
2. Pack the single CLI artifact and record npm integrity plus SHA-256.
3. Verify an already published version by integrity; never republish it.
4. Stop before push, PR merge, npm publication, tag, GitHub prerelease or
   external communication unless the matching checkpoint is approved.
5. Keep downstream Home migrations and public posts outside the product Target.
