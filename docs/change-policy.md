# Change policy

`CHANGE.md` is an owned Workplace source. It defines where durable changes go,
the local commit boundary, verification and effects that still require separate
human consent.

Discovery is progressive:

- Hall receives only universal mutation limits and a source link;
- Room, Desk and Work Front Doors reveal applicable local rules;
- Site Front Doors link the Site’s sovereign `CONTRIBUTING.md`;
- no Site contribution or delivery policy is copied into the Hall.

Git is the required temporal witness. A commit records an observed source
mutation; it does not create acceptance, Authority or delivery consent.

The declared local affordance is the commit verb:

```text
<affordance>(<kind>:<slug>): <observed effect>

Meeting: <fully-qualified-meeting-ref>
Authority: human-invoked | delegated | prepared | projection
Mandate: <fully-qualified-mandate-ref>   # delegated only
Build: <source-oid>                      # projection only
```

`open-room` and `open-work` compile exact source, Site, verification and
projection commit templates into their local method surfaces. Workers return
proof without committing; Main or Manager integrates. No-op, stale, blocked or
foreign-path effects produce no commit.
