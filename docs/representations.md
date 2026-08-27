# Acceptance representations

## Grammar

```text
Root
└── Node
    ├── identity: Ref + Revision
    ├── family: Place | Member | Agent | Work | Material | Meeting
    ├── Roles[]
    ├── owner
    ├── Slot
    └── Relations[]

Role → requirements + relations + lifecycle + locator + projections
Slot → owner + accepts + cardinality + locator + visibility
Affordance → position + intent/work + Equipment + Tools + Authority
CoordinationPolicy → structural roles + closed routes + dispatch envelope
Meeting → Room + lifecycle + Work relations + Occupants + next boundary
```

## Fresh personal instance

```text
Mount
├── Hall → open-room
│   └── Main coordination summary
├── resident operating contract
│   └── Constitution + Doctrine + CHANGE explicit resident sections
├── bound Member Card
├── Desk WELCOME + Memory Policy
├── Shared Root: Constitution + Doctrine + CHANGE + Member
│   └── coordination.json → portable CoordinationPolicy
└── private Desk Root: DESK + WELCOME + MEMORY
```

It deliberately contains no Room, Work or Site. A first subject discovers and
creates only the next necessary boundary.

## Smallest useful Standard instance

```text
workplace://demo/smallest
├── CONSTITUTION
├── DOCTRINE
├── CHANGE
├── CoordinationPolicy
├── Member Alexis
│   └── Desk Alexis
│       ├── WELCOME
│       └── MEMORY policy
├── Room Product
│   └── Work Demo
└── Route → sovereign Demo Site
```

No empty Inbox, parallel research database or runtime state is required.

## Rich reference instance

```text
Rich Studio
├── CHANGE + Constitution + Doctrine + CoordinationPolicy
├── Member Alexis ← bound Desk + WELCOME + Memory policy
├── Member Mira ← label/role/link only
├── Member Sam
│   └── Desk Sam --admits--> Alexis
│       └── WELCOME exposed through one read-only Key
├── Agent Researcher
├── Lab Room
│   ├── active Meeting → Main/Manager/Worker Occupants
│   ├── old Observation
│   ├── candidate Decision
│   └── Study Work
│       └── Research Workshop → Study method
└── Route → sovereign Lab Product Site
```

## Alternative Profile

```text
FieldLab
├── CoordinationPolicy
└── Station North
    ├── Trial Wind
    ├── Observation Baseline
    └── Observation Equipment → Inspect method
```

It compiles through the same kernel without Standard family or Role branches.

## Physical bound Flappy instance

```text
/tmp/endroit-flappy-manual/
├── FRONTDOOR.md                    provider-neutral local projection
├── AGENTS.md                       explicit Codex ProviderBinding target
├── rooms/, work/, sites/, desks/   progressively scoped local projections
├── rooms/product/meetings/...      Meeting-local Front Door
├── .agents/skills/                 explicit fundamental Skill targets only
├── .endroit/                       Entry/Provider bindings, IR and manifests
├── agents/                          local Manager/Worker contracts
├── workplace/                       Git Root: Workplace
│   ├── sources/                     canonical semantic sources
│   ├── .workplace/                  portable committed control plane
│   └── WORKPLACE.md                 portable human Front Door
├── checkouts/desks/alexis/          private Desk Git Root
│   ├── DESK.md
│   ├── WELCOME.md
│   └── MEMORY.md
└── checkouts/sites/flappy-bird/     sovereign Site Git Root
    ├── README.md
    ├── SPEC.md
    └── CONTRIBUTING.md
```

The provider opens the Mount. The shared Root and Site retain separate Git
histories. Compile, check and ready never mutate the Site.
