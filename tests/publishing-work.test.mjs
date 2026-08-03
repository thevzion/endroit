import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const runtime = join(root, 'equipment', 'endroit', 'publishing', 'runtime.mjs')
const migration = 'editorial-work-v1'

test('Publishing migrates mapped Work graphs from resolved Home and Desk Rooms', () => {
  const homeRoot = mkdtempSync(join(tmpdir(), 'endroit-publishing-work-'))
  const rooms = [
    {
      id: 'studio',
      scope: 'home',
      ref: 'room:home/studio',
      path: 'rooms/studio/ROOM.md',
      mappingRoom: 'studio',
      work: 'brief',
      candidate: 'brief-root',
      publication: 'brief-web',
      handle: true,
    },
    {
      id: 'initiatives/launch',
      scope: 'desk',
      ref: 'room:desk/initiatives/launch',
      path: '.desk/rooms/initiatives/launch/ROOM.md',
      mappingRoom: 'room:desk/initiatives/launch',
      work: 'announcement',
      candidate: 'announcement-root',
      publication: 'announcement-post',
      handle: false,
    },
  ]

  try {
    for (const room of rooms) createRoomFixture(homeRoot, room)
    const resolvedHome = { rooms: rooms.map(({ id, scope, ref, path }) => ({ kind: 'room', id, scope, ref, path })) }
    const direct = (args, env = {}) => spawnSync(process.execPath, [runtime], {
      input: JSON.stringify({ argv: [...args, '--json'], homeRoot, resolvedHome }),
      encoding: 'utf8',
      env: { ...process.env, ...env },
      maxBuffer: 4 * 1024 * 1024,
    })
    const run = (args) => {
      const result = direct(args)
      assert.equal(result.status, 0, result.stderr)
      return JSON.parse(result.stdout)
    }

    const inspection = run(['migrate', migration, 'inspect'])
    assert.deepEqual(inspection.totals, { works: 2, candidates: 2, publications: 2 })
    assert.deepEqual(inspection.rooms.map(({ room }) => room), rooms.map(({ ref }) => ref))
    assert.deepEqual(inspection.rooms[0].unmapped, ['retained-note'])
    assert.equal(inspection.rooms[0].retainedHandles, 1)

    const failedPrepare = direct(['migrate', migration, 'prepare'], { ENDROIT_PUBLISHING_FAIL_AFTER: '4' })
    assert.notEqual(failedPrepare.status, 0)
    for (const room of rooms) {
      const migrationRoot = join(publishingRoot(homeRoot, room), 'migrations', migration)
      assert.equal(existsSync(join(migrationRoot, 'legacy')), false)
      assert.equal(existsSync(join(migrationRoot, 'manifest.json')), false)
    }

    const prepared = run(['migrate', migration, 'prepare'])
    assert.equal(prepared.snapshotFiles, 5)
    const failedApply = direct(['migrate', migration, 'apply'], { ENDROIT_PUBLISHING_FAIL_AFTER: '1' })
    assert.notEqual(failedApply.status, 0)
    for (const room of rooms) assert.equal(existsSync(join(publishingRoot(homeRoot, room), 'work')), false)

    assert.equal(run(['migrate', migration, 'apply']).status, 'applied')
    assert.equal(run(['migrate', migration, 'verify']).status, 'verified')

    const listed = run(['list', '--all'])
    assert.equal(listed.entities.length, 6)
    assert.ok(listed.entities.some(({ ref }) => ref === 'artifact:home/studio/publishing/work/brief'))
    assert.ok(listed.entities.some(({ ref }) => ref === 'candidate:desk/initiatives/launch/publishing/work/announcement/candidate/announcement-root'))
    assert.equal(run(['list', '--room', 'room:home/studio']).entities.length, 1)
    assert.equal(run(['inspect', 'artifact:desk/initiatives/launch/publishing/work/announcement']).metadata.owner, 'room:desk/initiatives/launch')

    assert.equal(run(['migrate', migration, 'cutover']).status, 'cutover')
    assert.equal(run(['validate']).status, 'valid')
    const handle = readFileSync(join(publishingRoot(homeRoot, rooms[0]), 'handles/web/brief.md'), 'utf8')
    assert.match(handle, /publication: "artifact:home\/studio\/publishing\/work\/brief\/publication\/brief-web"/)
    assert.match(readFileSync(join(publishingRoot(homeRoot, rooms[1]), 'handles/feed/announcement.md'), 'utf8'), /publication: "artifact:desk\/initiatives\/launch\/publishing\/work\/announcement\/publication\/announcement-post"/)
    assert.match(readFileSync(join(publishingRoot(homeRoot, rooms[0]), 'publication/retained-note/artifact.md'), 'utf8'), /status: "ready"/)
    assert.match(readFileSync(join(publishingRoot(homeRoot, rooms[0]), 'handles/web/retained.md'), 'utf8'), /publication: "artifact:home\/studio\/publishing\/publication\/retained-note"/)

    for (const room of rooms) {
      const base = publishingRoot(homeRoot, room)
      const migrated = readFileSync(join(base, 'work', room.work, 'publication', room.publication, 'content.md'))
      const snapshot = readFileSync(join(base, 'migrations', migration, 'legacy', 'publication', room.publication, 'content.md'))
      assert.deepEqual(migrated, snapshot)
    }

    assert.equal(run(['migrate', migration, 'rollback']).status, 'rolled_back')
    for (const room of rooms) {
      const base = publishingRoot(homeRoot, room)
      assert.equal(existsSync(join(base, 'work')), false)
      assert.match(readFileSync(join(base, 'publication', room.publication, 'artifact.md'), 'utf8'), /status: "ready"/)
      const manifest = JSON.parse(readFileSync(join(base, 'migrations', migration, 'manifest.json'), 'utf8'))
      assert.equal(manifest.room, room.ref)
      assert.equal(manifest.state, 'rolled_back')
    }
    assert.equal(existsSync(join(publishingRoot(homeRoot, rooms[1]), 'handles/feed/announcement.md')), false)
  } finally {
    rmSync(homeRoot, { recursive: true, force: true })
  }
})

function createRoomFixture(homeRoot, room) {
  const source = join(homeRoot, room.path)
  const publishing = publishingRoot(homeRoot, room)
  mkdirSync(dirname(source), { recursive: true })
  writeFileSync(source, `# ${room.id}\n`)

  const publicationRoot = join(publishing, 'publication', room.publication)
  mkdirSync(publicationRoot, { recursive: true })
  const legacyRef = `artifact:${room.scope}/${room.id}/publishing/publication/${room.publication}`
  writeFileSync(join(publicationRoot, 'artifact.md'), document({
    $schema: 'https://endroit.org/schema/v7/artifact.json',
    id: room.publication,
    kind: 'endroit/publishing:publication',
    status: 'ready',
    owner: room.ref,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    derived_from: [],
    format: room.handle ? 'article' : 'post',
    title: `Title ${room.publication}`,
    audience: 'readers',
    language: 'en',
    channel: 'web',
  }, `# ${room.publication}\n`))
  writeFileSync(join(publicationRoot, 'content.md'), `# Exact ${room.publication}\n`)

  if (room.handle) {
    const handleRoot = join(publishing, 'handles', 'web')
    mkdirSync(handleRoot, { recursive: true })
    writeFileSync(join(handleRoot, 'brief.md'), document({
      id: 'brief',
      kind: 'publishing-handle',
      status: 'published',
      owner: room.ref,
      publication: legacyRef,
      system: 'web',
      remote_id: 'brief',
      url: 'https://example.test/brief',
    }, '# Handle\n'))

    const retainedRoot = join(publishing, 'publication', 'retained-note')
    mkdirSync(retainedRoot, { recursive: true })
    writeFileSync(join(retainedRoot, 'artifact.md'), document({
      id: 'retained-note',
      kind: 'endroit/publishing:publication',
      status: 'ready',
      owner: room.ref,
    }, '# Retained\n'))
    writeFileSync(join(retainedRoot, 'content.md'), '# Retained exact content\n')
    writeFileSync(join(handleRoot, 'retained.md'), document({
      id: 'retained',
      kind: 'publishing-handle',
      status: 'published',
      owner: room.ref,
      publication: `artifact:${room.scope}/${room.id}/publishing/publication/retained-note`,
      system: 'web',
      remote_id: 'retained',
      url: 'https://example.test/retained',
    }, '# Retained Handle\n'))
  }

  const mappingRoot = join(publishing, 'migrations', migration)
  mkdirSync(mappingRoot, { recursive: true })
  writeFileSync(join(mappingRoot, 'mapping.json'), `${JSON.stringify({
    version: 1,
    migration,
    room: room.mappingRoom,
    owner: room.ref,
    migration_at: '2026-02-01T00:00:00.000Z',
    new_handles: room.handle ? [] : [{
      id: 'announcement',
      publication: room.publication,
      system: 'feed',
      status: 'published',
      remote_id: 'announcement',
      url: 'https://example.test/announcement',
      published_at: '2026-02-01T00:00:00.000Z',
      observed_at: '2026-02-01T00:00:00.000Z',
      evidence: 'Observed synthetic fixture.',
    }],
    works: [{
      id: room.work,
      status: 'active',
      intent: 'Keep one durable editorial intention.',
      thesis: 'The source remains exact across projections.',
      audience: 'Readers',
      continuity: 'Reopen when the source or destination changes.',
      selected_candidate: room.candidate,
      candidates: [{
        id: room.candidate,
        status: 'selected',
        lineage: 'root',
        derived_from: [],
        source_publication: room.publication,
      }],
      publications: [{
        id: room.publication,
        candidate: room.candidate,
        format: room.handle ? 'article' : 'post',
      }],
    }],
  }, null, 2)}\n`)
}

function publishingRoot(homeRoot, room) {
  return join(dirname(join(homeRoot, room.path)), 'publishing')
}

function document(metadata, body) {
  const frontmatter = Object.entries(metadata).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n')
  return `---\n${frontmatter}\n---\n\n${body}`
}
