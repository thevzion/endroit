# Git witness and local guards

Endroit treats Git as the required temporal truth. A valid working program with
an invalid semantic history remains RED.

`check --staged` validates exact index bytes, source graph, owning Root and
source/projection separation. `--commit-message` adds the operation and trailer
contract. `check --history` replays first-parent commits, resolves Meeting state
and checks causal Build/Plan revisions.

The shared Git Root also owns **operational declarations**. The closed slots
are `.workplace/{setup,recovery,continuity,sites}.json` and the same filenames
under `.workplace/bootstrap/<anchor-id>/`. They reuse the Setup, Recovery,
ContinuityDescriptor and SiteRouteSetup request schemas. These author-owned
inputs use a normal `work` commit, never a fictitious `compile`/`Build` commit.
They remain outside the compiler's ProjectionManifest and semantic
`sourceRevision`: selecting another immutable checkpoint must not create a
self-referential Workplace revision. The operational Plan/package digest
tracks their bytes separately.

`check --staged` validates the exact indexed dependency closure, identities,
regular files and schemas without resolving machine Bindings or contacting a
remote. Portable Setup uses managed addresses and credential-free HTTPS/SSH
Product Remotes. Extra Root bindings, concrete ProviderBindings, external
Route targets and ContinuityBindings stay in explicit local inputs. Top-level
declarations belong to the owning Workplace; a private Bootstrap package can
target its named peer Anchor. Continuity capture/store paths stay under the
target Mount's ignored `.endroit`; the declared restore family is
`checkouts/sites`. This does not make the Workplace Git Root a Site or support
dirty replacement of `<Mount>/workplace`.
Checkpoint selections address the ignored local checkpoint store. A Recovery
`continuity[]` reference uses a Bootstrap descriptor whose relative paths are
interpreted at its `.endroit` installation destination, not the top-level
descriptor whose base remains `workplace/.workplace`.

`check` validates present declarations, while `ready` refuses invalid ones
before any hook repair or compilation. Unknown `.workplace` paths cannot be
committed as compiler output merely by placing them in that directory.
`.gitattributes` is an owned scaffold source; its effective Git rules keep
semantic JSON/Markdown, `.gitattributes`, `.gitignore` and `.workplaceignore`
in LF. Binary/checkpoint payloads remain byte-exact.

`endroit new` installs marked `pre-commit` and `commit-msg` hooks in SharedRoot
and DeskRoot only. They call those public commands and block if the bound CLI is
missing. `ready` repairs a missing or changed Endroit-owned hook, but refuses a
foreign collision and never repairs invalid history.

Hooks are bypassable ergonomics, not machine-owner security. A bypassed commit
is still falsifiable by the public history check.
