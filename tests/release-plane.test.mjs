import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const project = dirname(dirname(fileURLToPath(import.meta.url)))
const artifactRuntime = join(project, 'equipment/endroit/artifacts/runtime.mjs')
const releaseRuntime = join(project, 'equipment/endroit/release/runtime.mjs')
const releaseRoot = join(project, 'equipment/endroit/release')

test('Artifact creation writes direct Workplace and Site owners', () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'endroit-release-create-')))
  const site = join(home, 'site')
  mkdirSync(site)
  const kinds = artifactKinds()
  const resolvedHome = {
    home: { id: 'fixture' },
    artifactKinds: kinds,
    routes: [{ id: 'main', site: 'example', declaredPath: site, declared: { status: 'active' } }],
  }
  try {
    const createdRelease = run(artifactRuntime, {
      argv: ['create', 'release', 'demo', '--workplace', '--json'],
      homeRoot: home,
      resolvedHome,
    })
    assert.equal(createdRelease.owner, 'workplace:fixture')
    assert.equal(createdRelease.path, 'releases/demo')
    assert.match(readFileSync(join(home, 'releases/demo/RELEASE.md'), 'utf8'), /kind: "endroit\/release:release"/)

    const createdSurface = run(artifactRuntime, {
      argv: ['create', 'public-surface', 'home', '--site', 'example', '--route', 'main', '--json'],
      homeRoot: home,
      resolvedHome,
    })
    assert.equal(createdSurface.owner, 'site:example')
    assert.equal(createdSurface.path, 'site/surfaces/home')
    assert.match(readFileSync(join(site, 'surfaces/home/SURFACE.md'), 'utf8'), /owner: "site:example"/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('Release lock is deterministic, effect-free in check mode and receipt follows observation', () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'endroit-release-plane-')))
  const site = join(home, 'site')
  const releasePath = join(home, 'releases/demo')
  mkdirSync(site, { recursive: true })
  mkdirSync(releasePath, { recursive: true })
  writeFileSync(join(site, 'README.md'), '# Site\n')
  writeFileSync(join(site, '.gitignore'), 'generated/\n')
  git(site, ['init', '--quiet', '--initial-branch=main'])
  git(site, ['add', 'README.md', '.gitignore'])
  git(site, ['-c', 'user.name=Endroit', '-c', 'user.email=local@endroit.org', 'commit', '--quiet', '-m', 'fixture'])
  const source = releaseArtifact(releasePath)
  const input = {
    homeRoot: home,
    resolvedHome: { routes: [
      { id: 'main', site: 'example', declaredPath: site, declared: { status: 'active' } },
      { id: 'release', site: 'example', declaredPath: site, declared: { status: 'active', purpose: 'release' } },
    ] },
    inspection: { artifacts: [source] },
  }
  try {
    const blocked = run(releaseRuntime, { ...input, argv: ['inspect', 'demo', '--json'] })
    assert.equal(blocked.state, 'blocked')
    assert.deepEqual(blocked.decision.blockers, ['dogfood:missing'])
    assert.match(runFailure(releaseRuntime, { ...input, argv: ['lock', 'demo', '--check', '--json'] }), /release_dogfood_required/)

    const dogfood = { version: 1, release: 'demo', sourceDigest: source.source_digest, status: 'passed' }
    writeFileSync(join(releasePath, 'dogfood.receipt.json'), `${JSON.stringify(dogfood, null, 2)}\n`)
    const inspection = run(releaseRuntime, { ...input, argv: ['inspect', 'demo', '--json'] })
    assert.equal(inspection.state, 'resolved')
    assert.equal(inspection.decision.readyForLock, true)
    assert.equal(inspection.decision.reviewGates[0].id, 'final-review')
    assert.equal(inspection.sites[0].export, './')
    assert.equal(inspection.sites[0].route, 'release')

    const preview = run(releaseRuntime, { ...input, argv: ['lock', 'demo', '--check', '--json'] })
    assert.equal(preview.status, 'lock-ready')
    assert.equal(existsSync(join(releasePath, 'release.lock.json')), false)
    assert.equal(run(releaseRuntime, { ...input, argv: ['lock', 'demo', '--check', '--json'] }).lockDigest, preview.lockDigest)
    mkdirSync(join(site, 'generated'))
    writeFileSync(join(site, 'generated/output.html'), '<p>ignored build</p>\n')
    assert.equal(run(releaseRuntime, { ...input, argv: ['lock', 'demo', '--check', '--json'] }).lockDigest, preview.lockDigest)

    const locked = run(releaseRuntime, { ...input, argv: ['lock', 'demo', '--json'] })
    assert.equal(locked.lockDigest, preview.lockDigest)
    assert.equal(run(releaseRuntime, { ...input, argv: ['verify', 'demo', '--json'] }).status, 'verified')
    writeFileSync(join(releasePath, 'dogfood.receipt.json'), `${JSON.stringify({ ...dogfood, evidence: 'changed' }, null, 2)}\n`)
    assert.deepEqual(run(releaseRuntime, { ...input, argv: ['verify', 'demo', '--json'] }).drift, ['dogfood'])
    writeFileSync(join(releasePath, 'dogfood.receipt.json'), `${JSON.stringify(dogfood, null, 2)}\n`)
    assert.equal(existsSync(join(releasePath, 'release.receipt.json')), false)
    assert.match(runFailure(releaseRuntime, { ...input, argv: ['observe', 'demo', '--site', 'example', '--status', 'observed', '--handle', 'https://wrong.example/', '--json'] }), /observation_handle_mismatch/)
    const watch = run(releaseRuntime, { ...input, argv: ['watch', 'demo', '--timeout', '0', '--json'] })
    assert.notEqual(watch.status, 'ready')
    assert.equal(watch.remote.ci.reason, 'ci-observer-unavailable')

    const receipt = run(releaseRuntime, { ...input, argv: ['observe', 'demo', '--site', 'example', '--status', 'observed', '--handle', 'https://example.test/', '--json'] })
    assert.equal(receipt.releaseState, 'observed')
    assert.equal(JSON.parse(readFileSync(join(releasePath, 'release.receipt.json'))).sites[0].handle, 'https://example.test/')

    writeFileSync(join(site, 'README.md'), '# Drift\n')
    assert.equal(run(releaseRuntime, { ...input, argv: ['verify', 'demo', '--json'] }).status, 'drifted')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('Release preview runs only the Site-declared command and records the observed URL', () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'endroit-release-preview-')))
  const site = join(home, 'site')
  const surfacePath = join(site, 'surfaces/home')
  const releasePath = join(home, 'releases/demo')
  mkdirSync(surfacePath, { recursive: true })
  mkdirSync(releasePath, { recursive: true })
  writeFileSync(join(surfacePath, 'SURFACE.md'), '# Fixture\n')
  writeFileSync(join(site, '.gitignore'), 'qualification-output/\n')
  git(site, ['init', '--quiet', '--initial-branch=main'])
  git(site, ['add', '.'])
  git(site, ['-c', 'user.name=Endroit', '-c', 'user.email=local@endroit.org', 'commit', '--quiet', '-m', 'fixture'])
  const source = releaseArtifact(releasePath)
  const participant = source.fragments.find((fragment) => fragment.kind === 'release_site')
  participant.export = './surfaces/home'; participant.metadata.export = './surfaces/home'
  writeFileSync(join(releasePath, 'dogfood.receipt.json'), `${JSON.stringify({ version: 1, release: 'demo', sourceDigest: source.source_digest, status: 'passed' }, null, 2)}\n`)
  const surface = {
    id: 'home', kind: 'endroit/release:public-surface', ref: 'artifact:site/example/endroit/release/public-surface/home',
    site: 'example', path: surfacePath,
    metadata: {
      $schema: 'https://endroit.org/schema/release/public-surface/v1alpha1.json', kind: 'endroit/release:public-surface', id: 'home', owner: 'site:example',
      artifact_contract: 'endroit/release/public-surface/v1alpha1', material_state: 'retained', currentness: 'current', derived_from: [],
    },
    fragments: [
      fragment({ kind: 'surface_contract', id: 'home', entrypoint: '/' }),
      fragment({
        kind: 'site_export', id: 'home-export', name: './surfaces/home', renderer: 'render.mjs',
        qualification: { check: ['node', '-e', "require('fs').mkdirSync('qualification-output');require('fs').writeFileSync('qualification-output/ran','yes')"] },
        outputs: [], preview: { command: ['node', '-e', "console.log('http://127.0.0.1:4321/')"] },
      }),
      fragment({ kind: 'content', id: 'hero' }),
    ],
  }
  const input = {
    argv: ['preview', 'demo', '--site', 'example'], homeRoot: home,
    resolvedHome: { routes: [{ id: 'main', site: 'example', declaredPath: site, declared: { status: 'active' } }] },
    inspection: { artifacts: [source, surface] },
  }
  try {
    const invalid = structuredClone(source)
    const invalidParticipant = invalid.fragments.find((fragment) => fragment.kind === 'release_site')
    delete invalidParticipant.effects; delete invalidParticipant.metadata.effects
    assert.match(runFailure(releaseRuntime, { ...input, argv: ['inspect', 'demo', '--json'], inspection: { artifacts: [invalid, surface] } }), /fragment_field_missing/)

    const bypass = structuredClone(source)
    const bypassParticipant = bypass.fragments.find((fragment) => fragment.kind === 'release_site')
    bypassParticipant.export = './'; bypassParticipant.metadata.export = './'
    assert.match(runFailure(releaseRuntime, { ...input, argv: ['inspect', 'demo', '--json'], inspection: { artifacts: [bypass, surface] } }), /release_surface_bypass/)

    const check = run(releaseRuntime, { ...input, argv: ['lock', 'demo', '--check', '--json'] })
    assert.equal(check.status, 'lock-ready')
    assert.equal(existsSync(join(site, 'qualification-output/ran')), false)

    const result = spawnSync(process.execPath, [releaseRuntime], { input: JSON.stringify(input), encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /http:\/\/127\.0\.0\.1:4321\//)
    assert.equal(JSON.parse(readFileSync(join(home, '.endroit/release-previews/demo--example.json'))).url, 'http://127.0.0.1:4321/')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

function artifactKinds() {
  return [
    {
      id: 'endroit/release:release', localId: 'release', owner: 'endroit/release', owners: ['home'],
      workplacePath: 'releases', root: releaseRoot, schema: 'schemas/release.schema.json', template: 'templates/RELEASE.md', document: 'RELEASE.md',
    },
    {
      id: 'endroit/release:public-surface', localId: 'public-surface', owner: 'endroit/release', owners: ['site'],
      sitePath: 'surfaces', root: releaseRoot, schema: 'schemas/public-surface.schema.json', template: 'templates/SURFACE.md', document: 'SURFACE.md',
    },
  ]
}

function releaseArtifact(path) {
  return {
    id: 'demo',
    kind: 'endroit/release:release',
    ref: 'artifact:workplace/endroit/release/release/demo',
    path,
    source_digest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    metadata: {
      $schema: 'https://endroit.org/schema/release/release/v1alpha1.json',
      kind: 'endroit/release:release',
      id: 'demo',
      owner: 'workplace:fixture',
      artifact_contract: 'endroit/release/release/v1alpha1',
      material_state: 'retained',
      currentness: 'current',
      derived_from: [],
    },
    fragments: [
      fragment({ kind: 'release_contract', id: 'release', title: 'Demo', question: 'Ship this exact release?' }),
      fragment({ kind: 'review_gate', id: 'final-review', question: 'Are the expected effects accepted?', required: true }),
      fragment({ kind: 'release_dogfood', id: 'workplace', required: true }),
      fragment({ kind: 'release_site', id: 'example', site: 'example', export: './', effects: ['publish-main'], expected_handle: 'https://example.test/', depends_on: [] }),
    ],
  }
}

function fragment(metadata) { return { ...metadata, heading: metadata.id, level: 2, metadata, body: '' } }

function run(runtime, input) {
  const result = spawnSync(process.execPath, [runtime], { input: JSON.stringify(input), encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout)
}

function runFailure(runtime, input) {
  const result = spawnSync(process.execPath, [runtime], { input: JSON.stringify(input), encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
  assert.notEqual(result.status, 0, result.stdout)
  return result.stderr
}

function git(cwd, args) { execFileSync('git', args, { cwd, stdio: 'pipe' }) }
