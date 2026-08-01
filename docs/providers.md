# Provider qualification

Endroit separates readable files from qualified runtime behavior. A provider
status applies only to the evidence named here.

| Provider | Level | Status | Evidence |
|---|---:|---|---|
| Codex | L4 | Qualified | provider projections, SessionStart bridge, package gates and Development Home dogfood |
| Claude | L4 | Qualified | provider projections, SessionStart bridge, package gates and Development Home dogfood |
| Other runtimes | L0–L1 | Static-compatible only when observed | ordinary Markdown and the tracked Home Console; no native call, Role or Wake-up claim |

The Codex and Claude evidence is refreshed by `npm run check:providers`, the
Node 22/24 suites and `npm run dev:verify -- --full` for each release
candidate. The release record carries the dated commit and gate result.

## Status vocabulary

- **Static-compatible**: a runtime can read the authoritative files or a
  generated static projection. This says nothing about native invocation or
  continuity.
- **Observed**: one named workflow succeeded on a named runtime/version, with a
  dated evidence record and known limits.
- **Qualified**: the provider passes the complete current release journey and
  is maintained as a first-party projection.

When a required native mechanism is unavailable, a projected operation returns
`blocked` and names the missing capability. It never simulates a spawn or
upgrades Static-compatible evidence to Qualified.
