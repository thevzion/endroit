# endroit-standard Profile

Entity families: `agent`, `material`, `meeting`, `member`, `place`, `work`.

## Closed Roles

- `artifact` — authored, target entity-family
- `belief` — authored, target entity-family
- `change-policy` — authored, target entity-family
- `constitution` — authored, target entity-family
- `constraint` — authored, target entity-family
- `decision` — authored, target entity-family
- `desk` — authored, target entity-family
- `doctrine` — authored, target entity-family
- `evidence` — authored, target entity-family
- `exploration` — authored, target entity-family
- `front-door` — resolved, target projection
- `goal` — authored, target entity-family
- `initiative` — authored, target entity-family
- `meeting` — authored, target entity-family
- `meeting-contribution` — authored, target entity-family
- `memory-policy` — authored, target entity-family
- `noticeboard` — resolved, target projection
- `operator` — authored, target entity-family
- `owner` — authored, target entity-family
- `pattern` — authored, target entity-family
- `preference` — authored, target entity-family
- `principle` — authored, target entity-family
- `publication-source` — authored, target entity-family
- `room` — authored, target entity-family
- `shelf` — authored, target slot
- `site` — authored, target entity-family
- `study` — authored, target entity-family
- `welcome` — authored, target entity-family
- `workbench` — resolved, target projection
- `workshop` — resolved, target entity-family
- `workspace` — resolved, target entity-family

## Slots

- `desk-material` — 1..*, linked, locator `self/{node.id}`
- `desks` — 0..1, linked, locator `members/{relation.owned-by.id}/desk`
- `governance` — 1..*, listed, locator `{node.id}`
- `members` — 1..*, listed, locator `members/{node.id}`
- `room-material` — 0..*, listed, locator `material/{node.id}`
- `room-meeting` — 0..*, listed, locator `meetings/{node.id}`
- `room-work` — 0..*, listed, locator `work/{node.id}`
- `rooms` — 0..*, listed, locator `rooms/{node.id}`
- `sites` — 0..*, linked, locator `sites/{node.id}`
