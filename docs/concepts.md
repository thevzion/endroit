# Endroit concepts

Endroit is a local compiler for a human-owned Workplace. It does not make an
agent, transcript or provider account the durable center of work.

## Protocol and Profile

Open Workplace defines implementation-independent responsibilities: durable
boundaries, ownership, authority, source versus projection, temporary
execution, explicit transitions and resolution states.

The Endroit Profile owns concrete names, files and commands such as
`WORKPLACE.md`, Member, Desk, Room, Equipment, Site, Route and Checkout. Another
Profile may represent the same Open Workplace responsibilities differently.

## Source, resolved state, observation and projection

These layers answer different questions:

| Layer | Question | Canonical? |
| --- | --- | --- |
| Source | What did the owner declare? | yes |
| `ResolvedWorkplace` | What relevant meaning resolves now? | derived |
| `ObservedWorkplace` | What does the host, Git or Checkout look like now? | volatile |
| Projection | What compact surface does this provider need? | rebuildable |

Editing `AGENTS.md`, `CLAUDE.md` or `.endroit/` never changes source truth.
Changing a branch, dirty state or symlink never changes a Route declaration.

## Material, Fragment and Artifact

- A Document is a readable owned source.
- A Fragment is an addressable typed section inside a Document. It inherits the
  Document owner and lifecycle.
- Material is durable content with an explicit owner and lifecycle.
- An Artifact is Material whose Endroit kind adds useful validation.

Creating text does not retain it. Retaining it does not accept it. Accepting it
does not complete, archive, deliver or publish it.

## Site, Route and Checkout

- A Site is a sovereign external authority, commonly a Git repository.
- A Route is one Desk's durable relationship to a Site.
- A Checkout is the derived local address used to inspect or work through that
  Route.
- Git remains authoritative for commits, branches and worktrees.

`checkout:<site>/<route>#<relative-path>` is an address, not ownership or
permission. Endroit revalidates the Route and Checkout before a Site effect;
the human and host still grant delivery authority separately.

## Resolution is not a score

`resolved`, `degraded` and `ambiguous` describe whether one responsibility can
be used safely. They do not rank an agent, assign trust or prove execution.
When authorities conflict, Endroit stops the affected operation instead of
choosing by file order or provider precedence.
