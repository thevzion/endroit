# Git witness and local guards

Endroit treats Git as the required temporal truth. A valid working program with
an invalid semantic history remains RED.

`check --staged` validates exact index bytes, source graph, owning Root and
source/projection separation. `--commit-message` adds the operation and trailer
contract. `check --history` replays first-parent commits, resolves Meeting state
and checks causal Build/Plan revisions.

`endroit new` installs marked `pre-commit` and `commit-msg` hooks in SharedRoot
and DeskRoot only. They call those public commands and block if the bound CLI is
missing. `ready` repairs a missing or changed Endroit-owned hook, but refuses a
foreign collision and never repairs invalid history.

Hooks are bypassable ergonomics, not machine-owner security. A bypassed commit
is still falsifiable by the public history check.
