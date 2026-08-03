---
$schema: "https://endroit.org/schema/v9/workplace.json"
kind: "endroit/workplace"
id: "{{workplace.id}}"
owner: "member:{{workplace.owner}}"
profile: "endroit/0.10"
protocol: "open-workplace/0.2-draft"
runtime: "@endroit/cli@0.10.0-alpha.0"
providers: {{workplace.providers}}
---

# {{workplace.title}}

## Purpose

Give humans and agents one durable, local and inspectable place to work from.

## Constitution

- Human direction, judgment, acceptance and delivery consent remain explicit.
- Owned sources are canonical; provider files and indexes are rebuildable projections.
- Conversation and generated results remain ephemeral until an explicit transition.
- A Site keeps its own source, history, permissions and delivery lifecycle.

## Boundaries

Resolve only this declared Workplace and the sources required for the current question.
External access through a Route never grants authority to mutate its Site.

## Limits

Do not retain transcripts, hidden reasoning, credentials or private downstream
information as Workplace truth.
