import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createHome } from '../src/create.mjs'
import { removeTree } from '../src/lib/io.mjs'
import { dispatchRuntime } from '../src/runtime.mjs'
import { captureIo } from './helpers.mjs'

test('WORK.md resolves typed fragments and derives completion from its contract revision', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'endroit-work-resolution-'))
  try {
    const home = join(temporary, 'home')
    await createHome(home)
    const artifact = await createWork(home, 'public-proof')
    const workPath = join(home, 'rooms/home/working/item/public-proof/WORK.md')

    const unresolved = await command(home, ['resolve', artifact.ref, '--json'])
    assert.equal(unresolved.code, 0, unresolved.stderr)
    assert.equal(unresolved.value.frontier, 'event')
    assert.equal(unresolved.value.completion.status, 'incomplete')
    assert.equal(unresolved.value.completion.contract, 'endroit/work/v1alpha2')
    assert.match(unresolved.value.completion.revision, /^sha256:[a-f0-9]{64}$/)
    assert.equal(unresolved.value.source.format, 'WORK.md')

    await writeFile(workPath, completeWorkMarkdown({ assignment: 'active', verification: 'not-run', observed: false, review: 'pending' }))
    const executable = await command(home, ['resolve', artifact.ref, '--json'])
    assert.equal(executable.code, 0, executable.stderr)
    assert.equal(executable.value.frontier, 'execution-ready')
    assert.equal(executable.value.frontiers.closureReady, false)
    assert.equal(executable.value.completion.status, 'incomplete')
    assert.deepEqual(executable.value.authority.sources, ['decision:desk/demo/0001'])

    await writeFile(workPath, completeWorkMarkdown())
    const closed = await command(home, ['resolve', artifact.ref, '--json'])
    assert.equal(closed.code, 0, closed.stderr)
    assert.equal(closed.value.frontier, 'closure-ready')
    assert.equal(closed.value.lifecycle, 'active')
    assert.equal(closed.value.completion.status, 'complete')
    assert.equal('final' in closed.value.completion, false)

    await writeFile(workPath, completeWorkMarkdown({ contradiction: 'open' }))
    const contradicted = await command(home, ['resolve', artifact.ref, '--json'])
    assert.equal(contradicted.value.frontiers.executionReady, false)
    assert.equal(contradicted.value.completion.status, 'blocked')
    assert.ok(contradicted.value.missing.some(({ code }) => code === 'contradiction_open'))
  } finally {
    await removeTree(temporary, { force: true })
  }
})

test('record-review mutates only addressable WORK.md metadata and preserves prose', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'endroit-work-review-'))
  try {
    const home = join(temporary, 'home')
    await createHome(home)
    const first = await createWork(home, 'first')
    const workPath = join(home, 'rooms/home/working/item/first/WORK.md')
    const artifactPath = join(home, 'rooms/home/working/item/first/artifact.md')
    await writeFile(workPath, completeWorkMarkdown({ id: 'first', review: 'pending' }))
    const beforeWork = await readFile(workPath, 'utf8')
    await assert.rejects(readFile(artifactPath, 'utf8'), { code: 'ENOENT' })

    const review = await command(home, ['review', first.ref, '--json'])
    assert.equal(review.code, 0, review.stderr)
    assert.equal(review.value.items[0].availability.status, 'available')
    assert.equal(review.value.items[0].owner, 'site:demo')

    const recorded = await command(home, [
      'record-review', first.ref, 'demo-readme', '--status', 'changes-requested', '--note', 'Tighten the maturity claim.', '--json',
    ])
    assert.equal(recorded.code, 0, recorded.stderr)
    assert.equal(recorded.value.lifecycleChanged, false)
    assert.equal(recorded.value.completion.status, 'incomplete')
    assert.equal(recorded.value.externalAuthorityInferred, false)
    assert.match(recorded.value.revision, /^sha256:[a-f0-9]{64}$/)
    const afterWork = await readFile(workPath, 'utf8')
    assert.match(afterWork, /status: "changes-requested"/)
    assert.match(afterWork, /note: "Tighten the maturity claim\."/)
    assert.ok(afterWork.includes('Does the surface separate present behavior from the product thesis?'))
    assert.equal(stripReviewOutcome(afterWork), stripReviewOutcome(beforeWork))
    await assert.rejects(readFile(artifactPath, 'utf8'), { code: 'ENOENT' })

    await createWork(home, 'second')
    const ambiguous = await command(home, ['review', '--json'])
    assert.equal(ambiguous.code, 2)
    assert.match(ambiguous.stderr, /work_ambiguous/)

    await writeFile(workPath, completeWorkMarkdown({ id: 'first' }).replace('contract:', 'final: false\ncontract:'))
    const rejected = await command(home, ['inspect', first.ref, '--json'])
    assert.equal(rejected.code, 3)
    assert.match(rejected.stderr, /final is not allowed/)
  } finally {
    await removeTree(temporary, { force: true })
  }
})

test('WORK.json v1alpha1 is an explicit read-only compatibility path', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'endroit-work-legacy-'))
  try {
    const home = join(temporary, 'home')
    await createHome(home)
    const artifact = await createWork(home, 'legacy')
    const directory = join(home, 'rooms/home/working/item/legacy')
    await rm(join(directory, 'WORK.md'))
    await writeFile(join(directory, 'artifact.md'), legacyArtifactMarkdown('legacy'))
    await writeFile(join(directory, 'WORK.json'), `${JSON.stringify(legacyWork(), null, 2)}\n`)

    const resolved = await command(home, ['resolve', artifact.ref, '--json'])
    assert.equal(resolved.code, 0, resolved.stderr)
    assert.equal(resolved.value.source.format, 'WORK.json')
    assert.equal(resolved.value.source.compatibility.status, 'deprecated-read-only')
    assert.equal(resolved.value.completion.contract, 'endroit/work/v1alpha1')

    const mutation = await command(home, ['record-review', artifact.ref, '1', '--status', 'accepted', '--json'])
    assert.equal(mutation.code, 3)
    assert.match(mutation.stderr, /work_legacy_read_only/)

    await writeFile(join(directory, 'WORK.md'), completeWorkMarkdown({ id: 'legacy' }))
    const collision = await command(home, ['inspect', artifact.ref, '--json'])
    assert.equal(collision.code, 3)
    assert.match(collision.stderr, /work_source_collision/)
  } finally {
    await removeTree(temporary, { force: true })
  }
})

test('published and bundled Work v1alpha2 schemas stay aligned', async () => {
  const published = JSON.parse(await readFile(new URL('../schemas/work/v1alpha2.json', import.meta.url), 'utf8'))
  const bundled = JSON.parse(await readFile(new URL('../equipment/endroit/work/schemas/v1alpha2.schema.json', import.meta.url), 'utf8'))
  assert.deepEqual(bundled, published)
  assert.equal(Object.hasOwn(published.properties, 'final'), false)
})

async function createWork(home, id) {
  const result = captureIo()
  const code = await dispatchRuntime(home, 'artifact', ['create', 'item', id, '--room', 'home/home', '--status', 'active', '--json'], result.io)
  assert.equal(code, 0, result.stderr())
  return JSON.parse(result.stdout())
}

async function command(home, argv) {
  const result = captureIo()
  const code = await dispatchRuntime(home, 'work', argv, result.io)
  return { code, stderr: result.stderr(), value: result.stdout() ? JSON.parse(result.stdout()) : null }
}

function stripReviewOutcome(value) {
  return value.replace(/^status: (?:"[^"]*"|[^\n]*)$/gm, 'status: <state>').replace(/^note: (?:"[^"]*"|null)$/gm, 'note: <note>')
}

function completeWorkMarkdown(options = {}) {
  const id = options.id ?? 'public-proof'
  const assignment = options.assignment ?? 'returned'
  const verification = options.verification ?? 'passed'
  const review = options.review ?? 'accepted'
  const contradiction = options.contradiction
  const observed = options.observed ?? true
  return `---
$schema: "https://endroit.org/schema/work/v1alpha2.json"
contract: "endroit/work/v1alpha2"
kind: "endroit/work:item"
id: "${id}"
owner: "room:home/home"
work_type: "demo/public-proof"
work_state: "active"
derived_from: []
---

# Public proof

## Objective

Qualify a public demo product surface.

## Expected effect

Every claim is locally inspectable and correctly qualified.

## Authority source

\`\`\`endroit
kind: "source"
id: "authority"
ref: "decision:desk/demo/0001"
role: "authority"
\`\`\`

## Context source

\`\`\`endroit
kind: "source"
id: "site"
ref: "site:demo"
role: "context"
\`\`\`

## Local proof

\`\`\`endroit
kind: "claim"
id: "local-proof"
currentness: "current"
maturity: "supported"
evidence: ["test:native-gates"]
\`\`\`
The candidate passes local gates.

## No remote effect

\`\`\`endroit
kind: "obligation"
id: "no-remote"
required: true
status: "satisfied"
evidence: ["plan:authority-boundary"]
\`\`\`
Perform no remote effect.
${contradiction ? `
## Published status conflict

\`\`\`endroit
kind: "contradiction"
id: "published-status"
sources: ["site:demo"]
status: "${contradiction}"
resolution: null
evidence: []
\`\`\`
A candidate was presented as published.
` : ''}
## Demo site assignment

\`\`\`endroit
kind: "assignment"
id: "demo-site"
role: "engineer"
sources: ["decision:desk/demo/0001", "site:demo"]
destination: {"owner":"site:demo","site":"demo","route":"main"}
expected_effect: "The candidate passes Work Resolution tests."
verification: ["native-gates"]
status: "${assignment}"
\`\`\`
Implement and qualify the Work contract.

## Native gates

\`\`\`endroit
kind: "verification"
id: "native-gates"
status: "${verification}"
evidence: ["test:native-gates"]
\`\`\`
Run the demo product gates.
${observed ? `
## Observed result

\`\`\`endroit
kind: "observed_result"
id: "local-candidate"
status: "succeeded"
evidence: ["test:native-gates"]
\`\`\`
The local candidate is qualified.
` : ''}
## Demo README review

\`\`\`endroit
kind: "review"
id: "demo-readme"
label: "Demo README"
target_kind: "file"
target: "WORKPLACE.md"
owner: "site:demo"
status: "${review}"
note: null
\`\`\`
Does the surface separate present behavior from the product thesis?
`
}

function legacyArtifactMarkdown(id) {
  return `---
$schema: "https://endroit.org/schema/v7/artifact.json"
id: "${id}"
kind: "endroit/work:item"
status: "active"
owner: "room:home/home"
created_at: "2026-08-04T00:00:00.000Z"
updated_at: "2026-08-04T00:00:00.000Z"
derived_from: []
---

# Legacy Work Item
`
}

function legacyWork() {
  return {
    $schema: 'https://endroit.org/schema/work/v1alpha1.json',
    version: 'endroit/work/v1alpha1',
    objective: 'Qualify a public demo product surface.',
    workType: 'demo/public-proof',
    expectedEffect: 'Every claim is locally inspectable and correctly qualified.',
    sources: [{ ref: 'decision:desk/demo/0001', role: 'authority' }],
    claims: [],
    obligations: [{ id: 'no-remote', description: 'Perform no remote effect.', required: true, status: 'satisfied', evidence: ['plan:authority-boundary'] }],
    contradictions: [],
    assignments: [],
    verification: [],
    observedResult: { status: 'complete', summary: 'The local candidate is qualified.', evidence: ['test:native-gates'] },
    review: [{ id: 'demo-readme', label: 'Demo README', kind: 'file', target: 'HOME.md', question: 'Is it clear?', owner: 'site:demo', status: 'accepted', note: null }],
  }
}
