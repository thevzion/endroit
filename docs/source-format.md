# Workplace source format

Workplace sources use strict YAML frontmatter followed by Markdown:

```markdown
---
ref: workplace://demo/member/alexis
entity: member
roles: [owner]
slot: members
owner: workplace://demo/member/alexis
scope: workplace://demo
label: Alexis
summary: Owns product direction.
when: [A human owner must be identified.]
relations: {}
---

# Alexis
```

Metadata is machine selection and responsibility. The body is human content.
Unknown metadata is rejected rather than ignored.

JSON remains the format for Profile, Composition, Workplace,
CoordinationPolicy, EntryBinding and ProviderBinding because those are closed
machine contracts. `coordination.json` rejects duplicate and unknown fields,
invalid routes and incomplete dispatch envelopes.

WELCOME is special only by Role: its Markdown body is copied into a bound Front
Door and cannot exceed 4096 UTF-8 bytes.
