# Resolve Work

Resolve one `endroit/work:item` from its owned `WORK.md` contract.

1. Select the Work Item explicitly. When a provider surface permits omission,
   continue only if exactly one Work Item is available.
2. Run `node ./endroit.mjs work inspect <selector>` to read it or
   `node ./endroit.mjs work resolve <selector>` to calculate its frontier.
3. Load only the sources named by the Work Item and respect their declared
   roles. A reference is not permission to mutate its owner.
4. Report the last resolved frontier, contract revision, missing contracts,
   open contradictions, bounded Assignments and pending review.
5. Revalidate every Site Route immediately before a Site mutation. Endroit
   never derives external authority from `execution-ready` or
   `closure-ready`.

Each typed fragment is an addressable `##` section whose first block is fenced
as `endroit` and declares `kind` plus `id`. Its prose owns the human
substance; its block owns only the queryable fields. Do not persist an agent
identity, transcript, hidden reasoning, trust score or implicit lifecycle
transition in the Work Item.
