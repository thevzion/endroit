# Path and Outcome qualification

The compiler is deterministic. An Agent is probabilistic. Endroit qualifies
predictability by freezing an Intent and Workplace revision, then comparing the
observed trajectory with an expected Path and Outcome contract hidden from the
Agent.

Three layers stay distinct:

1. deterministic tests validate parsing, graph resolution and output bytes;
2. semantic tests validate reads, links, path, lineage and Outcome presence;
3. live Agent tests validate that the static building actually causes the
   expected behavior.

Exact reads and ordering may be required when missing one Decision or old
Material would change reasoning. A functional result remains RED when the path,
provenance, Site boundary or Git history is invalid.

The first human regression asks an Agent to change the bound human’s interaction
profile to French and humor. The correct source is WELCOME; provider memory is
forbidden. A provider run requires explicit invocation and never supplies its
own human verdict.

Governed inputs are immutable:

```text
tests/workplaces/cases/<case>/{request,scenario,expected}.json
checkouts/workplaces/<case>/<utc>-<case>-<digest>/{RUN.json,mount,evidence}
```

There is no mutable `latest`, automatic cleanup or implicit golden promotion.
The initial cases are fresh-personal, arbitrary-saas, Flappy and viral-game.
`case:new` creates a unique prepared run, `case:run` bootstraps and observes one
committed Scenario, `case:snapshot` appends sanitized evidence, and
`case:verdict` alone records `pass` or `changes-needed`. The runner retains
paths, Skills, dispatches and effects but discards raw JSONL, messages and
reasoning. It disables Codex memory/plugins/apps where the installed CLI permits
and reports remaining exposure instead of claiming isolation. Unit tests never
launch Codex.
