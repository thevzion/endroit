# Creating a fresh Workplace

`endroit new` creates a personal building, not a sample project.

```text
MountRoot/
├── FRONTDOOR.md                 neutral Hall
├── AGENTS.md or CLAUDE.md       selected local adapters
├── methods/open-room.md         Hall-local method
├── .endroit/                    local Entry and Provider bindings
├── Git guards                   consented Shared/Desk pre-commit + commit-msg
├── workplace/                   shared Git Root
│   ├── sources/                 Constitution, Doctrine, CHANGE, Member
│   ├── coordination.json        owned closed coordination policy
│   └── .workplace/              committed portable projections
└── checkouts/desks/<id>/        private Desk Git Root
    ├── DESK.md
    ├── WELCOME.md
    └── MEMORY.md
```

The initial Floor Plan has no Room, Work or Site. The Hall can still explain
who owns judgment, what the bound Desk discloses, where durable interaction
changes belong and how to open a Room when a new subject needs continuity.

The generic Constitution, Doctrine and CHANGE bodies are complete owned
policies and never contain the founding Member's identity. The Desk owns its
WELCOME and MEMORY bodies. The Hall renders their bounded summaries,
provenance and links; only the exact WELCOME packet is resident in full.

## Consent

Interactive mode shows the exact Preview before its final confirmation.
Automation separates the same boundary into `--preview` and digest-bound
`--apply`. The target must not exist. No mode creates a remote, launches an
Agent, hosts, publishes or delivers.

## Git Roots

The private Desk receives one source commit. The shared Root receives one
source commit and one projection commit. Initial commits use the confirmed Git
identity and carry an explicit `Authority` trailer. Both Roots start on
`develop` and remain sovereign.

After those bootstrap commits, Endroit installs four marked hooks named in the
Preview. They call the public staged/message checks. They never target a Site,
push or deliver; historical checking remains authoritative after bypass.

## After creation

Open the printed MountRoot—not `workplace/` and not the Desk checkout—in the
selected Agent. `endroit ready` is immediately a no-op. The compiled building
remains readable after removing Bun, the CLI and `.endroit/`; only rebuilding
requires the compiler.
