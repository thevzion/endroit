# Change policy

## Resident

- Resolve one semantic Operation, its owning Root, Authority and expected proof before writing.
- Commit one indivisible semantic effect at a time; commit owned sources before projections.
- Keep Shared, Desk and Site histories separate and link cross-Root effects by Ref and OID.
- Verify the effect before recording Work completion; leave every touched Root clean or explicitly blocked.
- Never create a remote, publish, host or deliver without separate human consent.

## Commit witness

Every durable mutation uses the declared affordance verb:

    <affordance>(<kind>:<slug>): <observed effect>

    Meeting: <fully-qualified-meeting-ref>
    Authority: human-invoked | delegated | prepared | projection
    Mandate: <fully-qualified-mandate-ref>   # delegated only
    Work: <fully-qualified-work-ref>          # Work and Site mutations
    Plan-Revision: <root-ref>@<oid>           # cross-Root Site mutation
    Build: <source-oid>                       # projection only

One commit carries one verb and one indivisible effect. A delegated Worker does
not commit; its parent integrates and commits. No-op, stale, blocked or foreign
effects produce no commit. Bootstrap adopt/compile commits precede any Meeting;
every later durable commit names a resolved active Meeting. Local pre-commit and
commit-msg guards call the public staged validator; history validation remains
authoritative after bypass.
