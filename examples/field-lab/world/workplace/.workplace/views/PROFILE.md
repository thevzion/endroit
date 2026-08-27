# field-lab Profile

Entity families: `experiment`, `instrument`, `researcher`, `specimen`, `zone`.

## Closed Roles

- `board` — resolved, target projection
- `observation` — authored, target entity-family
- `observer` — authored, target entity-family
- `rack` — authored, target slot
- `sensor` — authored, target entity-family
- `station` — authored, target entity-family
- `trial` — authored, target entity-family

## Slots

- `observations` — 0..*, listed, locator `observations/{node.id}`
- `stations` — 1..*, listed, locator `stations/{node.id}`
- `trials` — 0..*, listed, locator `trials/{node.id}`
