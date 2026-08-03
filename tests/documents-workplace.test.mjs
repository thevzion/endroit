import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  V9_API,
  compileSchemasV9,
  documentDigest,
  extractSection,
  parseDocument,
  readDocument,
  renderDocument,
  validateContract,
  validateDocumentV9,
} from '../src/documents.mjs'
import { initHome } from '../src/create.mjs'
import { loadDesk } from '../src/desk.mjs'
import { loadMember } from '../src/member.mjs'
import { publicPlan, resolveHome } from '../src/resolved.mjs'
import { findWorkplace, loadWorkplace } from '../src/workplace.mjs'
import { removeTree } from '../src/lib/io.mjs'

test('Document parsing is strict, deterministic and exposes sections and typed Fragments', async () => {
  const source = `---
$schema: "https://endroit.org/schema/v9/document.json"
kind: "endroit/material"
id: "proof"
owner: "room:desk/endroit"
document_role: "material"
data: {"z":1,"a":[true,"x"]}
---

# Proof

## Claim

\`\`\`endroit
kind: "claim"
id: "positioning"
currentness: "current"
\`\`\`

Endroit compiles owned context.
`
  const document = parseDocument(source, { path: 'PROOF.md' })
  assert.equal(document.source_digest, documentDigest(source))
  assert.equal(extractSection(document, 'Claim').fragment.id, 'positioning')
  assert.equal(extractSection(document, '## claim').fragment.body, 'Endroit compiles owned context.')
  assert.equal(document.fragments[0].kind, 'claim')
  const { data, ...validMetadata } = document.metadata
  await validateDocumentV9(validMetadata, 'document')

  const rendered = renderDocument({ metadata: document.metadata, body: document.body })
  assert.equal(rendered, renderDocument(parseDocument(rendered)))
  assert.match(rendered, /data: {"a":\[true,"x"\],"z":1}/)

  for (const invalid of [
    source.replace('id: "proof"', 'id: "proof"\nid: "again"'),
    source.replace('data: {"z":1,"a":[true,"x"]}', 'data: {broken'),
    source.replace('document_role:', 'document-role:'),
    source.replace('id: "proof"', "id: 'proof'"),
  ]) {
    assert.throws(() => parseDocument(invalid), (error) => error.code?.startsWith('document_frontmatter_'))
  }
})

test('Document files reject symlinks and invalid UTF-8', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'endroit-document-files-'))
  try {
    const target = join(temporary, 'target.md')
    await writeFile(target, '---\nid: "plain"\n---\n')
    await symlink(target, join(temporary, 'linked.md'))
    await assert.rejects(() => readDocument(join(temporary, 'linked.md')), (error) => error.code === 'document_symlink')
    await writeFile(join(temporary, 'invalid.md'), Buffer.from([0xff, 0xfe]))
    await assert.rejects(() => readDocument(join(temporary, 'invalid.md')), (error) => error.code === 'document_encoding')
  } finally {
    await removeTree(temporary, { force: true })
  }
})

test('the single schema registry validates v9 Documents, PROFILE.md and Work v1alpha2', async () => {
  assert.deepEqual(await compileSchemasV9(), ['document', 'profile', 'workplace', 'member', 'desk', 'room', 'site', 'route', 'equipment', 'artifact'])
  const profile = parseDocument(await readFile(new URL('../PROFILE.md', import.meta.url)))
  await validateDocumentV9(profile.metadata, 'profile')
  const work = {
    $schema: 'https://endroit.org/schema/work/v1alpha2.json',
    kind: 'endroit/work:item',
    id: 'proof',
    owner: 'room:desk/endroit',
    contract: 'endroit/work/v1alpha2',
    work_type: null,
    work_state: 'active',
    derived_from: [],
    objective: 'Prove the contract.',
    expected_effect: null,
    sources: [],
    claims: [],
    obligations: [],
    contradictions: [],
    assignments: [],
    verification: [],
    observed_result: null,
    review: [],
  }
  await validateContract(work)
  await assert.rejects(() => validateContract({ ...work, final: false }), (error) => error.code === 'document_invalid')
})

test('Workplace discovery ignores unmarked documents and fails closed on marked declarations', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'endroit-discovery-'))
  try {
    const root = join(temporary, 'root')
    await initHome(root, { name: 'declared', deskStrategy: 'later' })
    const nested = join(root, 'nested', 'deeper')
    await mkdir(nested, { recursive: true })
    await writeFile(join(root, 'nested', 'WORKPLACE.md'), '# An unrelated document\n')
    assert.equal(await findWorkplace(nested), root)

    await writeFile(join(root, 'nested', 'WORKPLACE.md'), '---\nkind: "endroit/workplace"\nid: [broken\n---\n')
    await assert.rejects(() => findWorkplace(nested), (error) => error.code === 'document_frontmatter_value_invalid')

    await writeFile(join(root, 'nested', 'WORKPLACE.md'), await readFile(join(root, 'WORKPLACE.md')))
    await writeFile(join(root, 'nested', 'endroit.json'), '{}\n')
    await assert.rejects(() => findWorkplace(nested), (error) => error.code === 'ambiguous_sources')
  } finally {
    await removeTree(temporary, { force: true })
  }
})

test('v9 creation writes one Markdown canon and resolves deterministic source revisions', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'endroit-v9-core-'))
  try {
    const revisions = []
    for (const directory of ['one', 'two']) {
      const root = join(temporary, directory)
      const initialized = await initHome(root, { name: 'same', memberName: 'Alexis', deskStrategy: 'later' })
      assert.equal(initialized.workplace, root)
      await assert.rejects(readFile(join(root, 'endroit.json')), (error) => error.code === 'ENOENT')
      await assert.rejects(readFile(join(root, 'HOME.md')), (error) => error.code === 'ENOENT')
      assert.equal((await loadWorkplace(root)).metadata.kind, 'endroit/workplace')
      assert.equal((await loadMember(root, 'owner')).membership_state, 'active')
      assert.equal(await loadDesk(root), null)

      const plan = await resolveHome(root)
      revisions.push(plan.revision)
      assert.equal(plan.resolvedWorkplace.revision, plan.revision)
      assert.equal(plan.sources.every((source) => !source.path.startsWith('/')), true)
      assert.doesNotMatch(JSON.stringify(publicPlan(plan)), new RegExp(escapeRegex(temporary)))
    }
    assert.equal(revisions[0], revisions[1])
  } finally {
    await removeTree(temporary, { force: true })
  }
})

test('legacy v7 declarations are read only through the compatibility adapter', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'endroit-v7-adapter-'))
  try {
    await mkdir(join(temporary, 'members', 'owner'), { recursive: true })
    await writeFile(join(temporary, 'endroit.json'), `${JSON.stringify({
      $schema: 'https://endroit.org/schema/v7/home.json',
      name: 'legacy',
      runtime: '@endroit/cli@0.9.0-alpha.0',
      providers: ['codex'],
    })}\n`)
    await writeFile(join(temporary, 'HOME.md'), '# Legacy\n\nReadable constitution.\n')
    await writeFile(join(temporary, 'members', 'owner', 'MEMBER.md'), `---
$schema: "https://endroit.org/schema/v7/member.json"
id: "owner"
name: "Owner"
status: "active"
accounts: []
---

# Owner
`)
    const workplace = await loadWorkplace(temporary)
    assert.equal(workplace.legacy, true)
    assert.equal(workplace.status, 'degraded')
    assert.equal(workplace.id, 'legacy')
    assert.equal((await loadMember(temporary, 'owner')).legacy, true)
  } finally {
    await removeTree(temporary, { force: true })
  }
})

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
