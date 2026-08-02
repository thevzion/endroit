# Provider qualification

Endroit separates readable files from qualified runtime behavior. A provider
status applies only to the evidence named here.

| Provider | Level | Status | Evidence |
|---|---:|---|---|
| Codex | L1 | Projection-qualified | deterministic Skills, Front Door wrapper shape, static parity and package gates |
| Claude | L1 | Projection-qualified | deterministic Skills, Front Door wrapper shape, static parity and package gates |
| Other runtimes | L0 | Unqualified | ordinary Markdown may be readable, but Static-compatible requires observed evidence |

`npm run check:providers` proves static semantic parity between generated
Codex and Claude projections. The Node 22/24, package and Development Home
gates prove deterministic generation and execute wrapper scripts outside the
provider hosts. They do not prove that a provider accepted its hook, performed
provider-hosted delegation or completed the full workplace journey. This
includes the static `advance-this` Skill/Command projection, not a claim that a
host actually spawned subagents.

## Status vocabulary

- **Static-compatible**: a runtime can read the authoritative files or a
  generated static projection. This says nothing about provider-hosted
  invocation or continuity.
- **Projection-qualified**: Endroit deterministically generates and packages
  the first-party projection, and its static contract passes parity tests.
  This is an L1 claim, not runtime qualification.
- **Observed**: one named workflow succeeded on a named runtime/version, with a
  dated evidence record and known limits.
- **Qualified**: the provider passes the complete current release journey and
  is maintained as a first-party projection.

When a required host mechanism is unavailable, a projected operation returns
`blocked` and names the missing capability. It never simulates a spawn or
upgrades Static-compatible evidence to Qualified.

Plan modes, subagent APIs, control protocols and workflow harnesses remain
provider or third-party responsibilities. `advance-this` propagates their
already-authorized scope when present; Endroit does not implement them.

L2–L4 remain unclaimed. Advancing Codex or Claude requires a dated smoke in the
real provider host, from the packed candidate, covering entry/Wake-up and the
`call`/`work-as`/`use` journey through retain, accept, deliver and Hygiene. The
evidence must distinguish successful provider-hosted behavior from an expected
`blocked` result.
