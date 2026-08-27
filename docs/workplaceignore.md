# `.workplaceignore`

`.workplaceignore` limits implicit discovery during compilation and adoption.
It uses line-oriented gitignore/glob patterns with comments, negation and
directory patterns. User-authored regex is unsupported.

It is not access control: a readable ignored file remains readable to an actor
that already has filesystem access. Endroit simply will not infer it as a
source. If a retained source relation requires an ignored source, graph
validation fails instead of silently weakening the contract.

The exact policy bytes are a Manifest dependency. Changing the file makes the
affected discovery and Preview stale.
