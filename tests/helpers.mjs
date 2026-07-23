import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export async function writeAsset(root, manifest = asset(), files = {}) {
  await mkdir(root, { recursive: true })
  const path = join(root, 'asset.json')
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`)
  for (const [name, content] of Object.entries(files)) {
    const destination = join(root, name)
    await mkdir(dirname(destination), { recursive: true })
    await writeFile(destination, content)
  }
  return path
}

export function asset(overrides = {}) {
  return {
    $schema: 'https://hairness.dev/schema/asset.json',
    name: 'fixture/review',
    version: '1.0.0',
    description: 'Review agentic assets.',
    capabilities: [{ id: 'review', source: 'capabilities/review.md' }],
    skills: [{ id: 'review', capability: 'review', description: 'Review a subject.' }],
    ...overrides,
  }
}
