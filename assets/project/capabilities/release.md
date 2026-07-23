Prepare a resumable Hairness prerelease without crossing an approval boundary.

1. Require a clean, qualified candidate and record its exact commit.
2. Pack the single CLI artifact and record npm integrity plus SHA-256.
3. Verify an already published version by integrity; never republish it.
4. Stop before push, merge, npm publication, tag, prerelease or communication
   unless the matching checkpoint is explicitly approved.
5. Keep downstream Home migrations and public posts outside the product
   repository.
