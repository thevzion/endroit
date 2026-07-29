# Develop Hairness

Hairness is developed from the Hairness Development Home while the product
repository remains an independent Target.

1. Run `npm run dev:home` from the Hairness Target to create or reconcile the
   reference Home.
2. Confirm that `hairness/main` is bound to the intended checkout and that the
   HUD reports the `development` runtime source.
3. Use a `hairness/planning:initiative` in the Workspace owning the product
   change. Propose the optional Planning Asset when it is not installed.
   Existing `hairness/project:plan` Artifacts are legacy read-only sources.
4. Use `npm run dev:session -- --provider codex` or `claude` for provider
   dogfood.
5. Run `npm run dev:verify` during iteration and `npm run dev:verify -- --full`
   before a merge checkpoint.

The repository scripts never commit, push, publish or create remote
repositories. Present those effects separately for consent.
