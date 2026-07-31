import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export async function writeEquipment(root, manifest = equipment(), files = {}) {
  await mkdir(root, { recursive: true })
  const path = join(root, 'equipment.json')
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`)
  for (const [name, content] of Object.entries(files)) {
    const destination = join(root, name)
    await mkdir(dirname(destination), { recursive: true })
    await writeFile(destination, content)
  }
  return path
}

export function equipment(overrides = {}) {
  return {
    $schema: 'https://endroit.org/schema/equipment.json',
    name: 'fixture/review',
    version: '1.0.0',
    description: 'Review agentic material.',
    files: ['capabilities/review.md'],
    capabilities: [{ id: 'review', path: 'capabilities/review.md', description: 'Review a subject.' }],
    skills: [{ id: 'review', capability: 'review', description: 'Use when a subject needs review.' }],
    commands: [{ id: 'review', capability: 'review', description: 'Review a subject on request.' }],
    ...overrides,
  }
}

export function captureIo() {
  const out = []
  const err = []
  return {
    io: {
      stdout: { write: (value) => out.push(String(value)) },
      stderr: { write: (value) => err.push(String(value)) },
    },
    stdout: () => out.join(''),
    stderr: () => err.join(''),
  }
}
