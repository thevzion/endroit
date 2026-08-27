# Fresh Workplace manual trial

This trial creates a personal Workplace with no preinstalled subject.

```sh
fresh_target="/tmp/endroit-fresh-$(date -u +%Y%m%dT%H%M%SZ)"
test ! -e "$fresh_target"
bun src/cli.ts new "$fresh_target"
```

Review the Preview, choose Codex and consent. Open the printed unique Mount in a
fresh Codex task, then ask:

> Build a one-billion-dollar SaaS idea with a waitlist.

Expected macro Path:

```text
Hall → open-room → new Room → ready → Room → open-work → Work → declared Site
```

The Agent may reason freely inside that path. It must not create `/site`, a
remote, hosting or delivery. Judge the result explicitly as `pass` or
`changes-needed`; no provider run belongs to automated tests.

For a non-mutating deterministic Preview:

```sh
bun src/cli.ts new --request examples/fresh/request.json --preview --json
```

Governed qualification inputs live under
`tests/workplaces/cases/fresh-personal/`; local evidence belongs to one unique
ignored `checkouts/workplaces/fresh-personal/<run-id>/`, never a mutable latest.
