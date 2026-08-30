# Endroit

Endroit compiles a Workplace into ordinary files that humans and Agents can
navigate without a running service.

`v0.1.0-rc.1` is a source-only pre-release. Its static compiler and examples
are usable now; fresh-Agent convergence remains qualification work rather than
an accepted product claim.

It currently provides:

- a private-package Bun + TypeScript CLI installed from source;
- a consent-first `endroit new` wizard for a fresh personal Workplace;
- a digest-bound `workplace setup` command for cloning or attaching declared peer Workplaces;
- Git-state checkpoints that round-trip dirty, detached and conflicted declared Roots locally or through explicit Git-native internal refs;
- a pinned Workplace Profile Package whose Grammar, Lexicon, defaults,
  affordances and policies are inspectable data;
- a provider-opened Mount separated from portable and sovereign Git Roots;
- neutral and Desk-bound Front Doors with progressive local discovery;
- explicit ProviderBinding allowlists, Definition/Lexicon IR and inspectable
  Disclosure/Context Contracts;
- owned CoordinationPolicy compiled into progressive Main/Manager/Worker contracts;
- durable Meeting sources with local opaque provider presence and bounded settlement;
- fail-closed owned-Root Git hooks backed by staged and historical witness checks;
- observable Path/Outcome and deterministic static Adoption Preview qualification;
- immutable fresh-personal, arbitrary-SaaS, Flappy and viral-game qualification
  cases with append-only evidence capture;
- a dev-only, explicitly invoked Codex replay that retains sanitized trajectory
  evidence and leaves the human verdict open.

## Try it

```sh
bun install --frozen-lockfile
bun run typecheck
bun run test
bun src/cli.ts new /tmp/endroit-fresh
```

The wizard previews every file, adapter, Git guard and commit before consent. It creates one
sovereign Workplace Git Root on `develop`; the Member's situated Desk is a subtree of that
Root. It creates no Room, Work, Site, remote, hosting or delivery. Open the exact Mount path
printed at the end.

The compiler and tests never automatically launch a provider or deliver a Site. Git hooks are
ergonomic guards, while `check --history` detects bypassed invalid commits. Cross-Workplace
access remains explicit through local Bindings; it never merges Git ownership or authority.
Fresh and Flappy manual trials are in [examples/fresh/TRY.md](examples/fresh/TRY.md) and
[examples/flappy/TRY.md](examples/flappy/TRY.md).

## Read by responsibility

- [LANDING.md](LANDING.md): product promise and demonstrations.
- [INSTALL.md](INSTALL.md): installation and current commands.
- [ADOPT.md](ADOPT.md): consent-first adoption from an existing environment.
- [SPEC.md](SPEC.md): normative technical contract.
- [ROADMAP.md](ROADMAP.md): Now, Next and Later.
- [CONTRIBUTING.md](CONTRIBUTING.md): Site change discipline and gates.
- [docs/](docs): concepts, source formats and qualification.

Endroit is static-first. Runtime services, provider automation and delivery are
not required or included in these commands.
