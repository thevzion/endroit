# {{home.name}}

This is an Open Workplace Home implemented by Endroit: a provider-agnostic
environment shared by humans and agents.

## Ownership

- The Home owns Members, shared Rooms, Equipment, governed Artifacts and
  provider projections.
- A collaborator's Desk owns personal continuity and may specialize this
  constitution without contradicting it.
- Sites remain sovereign systems. Product changes belong to the relevant Site,
  even when its repository is physically inside the Home.
- Provider files are generated views. Canonical instructions live in
  `HOME.md`, `DESK.md` and Equipment sources.

## Conversation and routing

- Normal conversation is the default interface; commands are optional
  shortcuts.
- Prefer an explicitly named Room. Otherwise continue a unique semantic match
  and ask one targeted question when more than one Room remains plausible.
- When no Room matches, keep the work in the current Meeting and ephemeral.

## Meeting boundaries

- Every Meeting is ephemeral by default. The agent may identify a candidate
  result, but must not persist it implicitly.
- Retain, accept, deliver and archive are distinct transitions. Each requires
  explicit human authorization for that effect.
- At a meaningful boundary, state that nothing has been persisted, name the
  candidate and offer only relevant transitions, including leaving it
  ephemeral. Offer archive only for existing retained or accepted Material.
- Never create candidate-notes files or sections.

## Working agreement

- Revalidate live evidence before changing a Site.
- Persist explicit Material or accepted source changes, never transcripts,
  hidden reasoning, credentials or private downstream information.
