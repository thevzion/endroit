import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createHome } from '../src/create.mjs'
import { removeTree } from '../src/lib/io.mjs'
import { dispatchRuntime } from '../src/runtime.mjs'
import { captureIo } from './helpers.mjs'

test('Work Resolution exposes progressive frontiers without inferring authority', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'endroit-work-resolution-'))
  try {
    const home = join(temporary, 'home')
    await createHome(home)
    const created = captureIo()
    assert.equal(await dispatchRuntime(home, 'artifact', [
      'create', 'item', 'public-proof', '--room', 'home/home', '--status', 'active', '--json',
    ], created.io), 0, created.stderr())
    const artifact = JSON.parse(created.stdout())
    assert.equal(artifact.kind, 'endroit/work:item')
    const workPath = join(home, 'rooms/home/working/item/public-proof/WORK.json')

    const unresolved = await command(home, ['resolve', artifact.ref, '--json'])
    assert.equal(unresolved.code, 0, unresolved.stderr)
    assert.equal(unresolved.value.frontier, 'event')
    assert.equal(unresolved.value.authority.inferred, false)
    assert.ok(unresolved.value.missing.some(({ code }) => code === 'objective_missing'))

    const work = completeWork()
    work.assignments[0].status = 'active'
    work.verification[0].status = 'not-run'
    work.observedResult = null
    work.review[0].status = 'pending'
    await writeFile(workPath, `${JSON.stringify(work, null, 2)}\n`)
    const executable = await command(home, ['resolve', artifact.ref, '--json'])
    assert.equal(executable.code, 0, executable.stderr)
    assert.equal(executable.value.frontier, 'execution-ready')
    assert.equal(executable.value.frontiers.executionReady, true)
    assert.equal(executable.value.frontiers.closureReady, false)
    assert.deepEqual(executable.value.authority.sources, ['decision:endroit/0007'])

    work.assignments[0].status = 'returned'
    work.verification[0].status = 'passed'
    work.observedResult = { status: 'complete', summary: 'All local surfaces qualified.', evidence: ['test:native-gates'] }
    work.review[0].status = 'accepted'
    await writeFile(workPath, `${JSON.stringify(work, null, 2)}\n`)
    const closed = await command(home, ['resolve', artifact.ref, '--json'])
    assert.equal(closed.code, 0, closed.stderr)
    assert.equal(closed.value.frontier, 'closure-ready')
    assert.equal(closed.value.lifecycle, 'active')

    work.contradictions.push({
      id: 'published-status',
      description: 'A candidate was presented as published.',
      sources: ['site:endroit'],
      status: 'open',
      resolution: null,
      evidence: [],
    })
    await writeFile(workPath, `${JSON.stringify(work, null, 2)}\n`)
    const contradicted = await command(home, ['resolve', artifact.ref, '--json'])
    assert.equal(contradicted.value.frontiers.executionReady, false)
    assert.ok(contradicted.value.missing.some(({ code }) => code === 'contradiction_open'))
  } finally {
    await removeTree(temporary, { force: true })
  }
})

test('click-and-review records one atomic outcome and refuses ambiguous or invalid Work Items', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'endroit-work-review-'))
  try {
    const home = join(temporary, 'home')
    await createHome(home)
    const first = await createWork(home, 'first')
    const workPath = join(home, 'rooms/home/working/item/first/WORK.json')
    const artifactPath = join(home, 'rooms/home/working/item/first/artifact.md')
    const work = completeWork()
    work.review[0].status = 'pending'
    await writeFile(workPath, `${JSON.stringify(work, null, 2)}\n`)
    const beforeArtifact = await readFile(artifactPath, 'utf8')

    const review = await command(home, ['review', first.ref, '--json'])
    assert.equal(review.code, 0, review.stderr)
    assert.equal(review.value.items[0].availability.status, 'available')
    assert.equal(review.value.items[0].owner, 'site:endroit')

    const recorded = await command(home, [
      'record-review', first.ref, '1', '--status', 'changes-requested', '--note', 'Tighten the maturity claim.', '--json',
    ])
    assert.equal(recorded.code, 0, recorded.stderr)
    assert.equal(recorded.value.lifecycleChanged, false)
    assert.equal(recorded.value.externalAuthorityInferred, false)
    assert.equal(JSON.parse(await readFile(workPath, 'utf8')).review[0].status, 'changes-requested')
    assert.equal(await readFile(artifactPath, 'utf8'), beforeArtifact)

    await createWork(home, 'second')
    const ambiguous = await command(home, ['review', '--json'])
    assert.equal(ambiguous.code, 2)
    assert.match(ambiguous.stderr, /work_ambiguous/)

    const invalid = { ...completeWork(), unexpected: true }
    await writeFile(workPath, `${JSON.stringify(invalid, null, 2)}\n`)
    const rejected = await command(home, ['inspect', first.ref, '--json'])
    assert.equal(rejected.code, 3)
    assert.match(rejected.stderr, /unexpected is not allowed/)
  } finally {
    await removeTree(temporary, { force: true })
  }
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
  return {
    code,
    stderr: result.stderr(),
    value: result.stdout() ? JSON.parse(result.stdout()) : null,
  }
}

function completeWork() {
  return {
    $schema: 'https://endroit.org/schema/work/v1alpha1.json',
    version: 'endroit/work/v1alpha1',
    objective: 'Qualify the public Endroit surface.',
    workType: 'endroit/public-proof',
    expectedEffect: 'Every claim is locally inspectable and correctly qualified.',
    sources: [
      { ref: 'decision:endroit/0007', role: 'authority' },
      { ref: 'site:endroit', role: 'context' },
    ],
    claims: [
      { id: 'local-proof', statement: 'The candidate passes local gates.', status: 'verified', evidence: ['test:native-gates'] },
    ],
    obligations: [
      { id: 'no-remote', description: 'Perform no remote effect.', required: true, status: 'satisfied', evidence: ['plan:authority-boundary'] },
    ],
    contradictions: [],
    assignments: [
      {
        id: 'endroit-core',
        objective: 'Implement and qualify the Work contract.',
        role: 'engineer',
        sources: ['decision:endroit/0007', 'site:endroit'],
        destination: { owner: 'site:endroit', site: 'endroit', route: 'integrated-main' },
        expectedEffect: 'The candidate passes Work Resolution tests.',
        verification: ['native-gates'],
        status: 'returned',
      },
    ],
    verification: [
      { id: 'native-gates', description: 'Run native Endroit gates.', status: 'passed', evidence: ['test:native-gates'] },
    ],
    observedResult: { status: 'complete', summary: 'The local candidate is qualified.', evidence: ['test:native-gates'] },
    review: [
      {
        id: 'endroit-readme',
        label: 'Endroit README',
        kind: 'file',
        target: 'HOME.md',
        question: 'Does the surface separate present behavior from the product thesis?',
        owner: 'site:endroit',
        status: 'accepted',
        note: null,
      },
    ],
  }
}
