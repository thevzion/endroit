import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export async function collectVersionedSchemas(projectRoot, version, names) {
  const schemas = []
  for (const name of names) {
    const source = `schemas/${version}/${name}.schema.json`
    const content = await readFile(join(projectRoot, source))
    const url = `https://endroit.org/schema/${version}/${name}.json`
    if (JSON.parse(content).$id !== url) throw new Error(`${source} must use $id ${url}.`)
    schemas.push({ name, source, url, sha256: createHash('sha256').update(content).digest('hex') })
  }
  return schemas
}

export async function verifyVersionedSchemas(schemas, version, names, verifyPublicSchema) {
  const label = version === 'v7' ? 'Release schemas' : `Release ${version} schemas`
  if (JSON.stringify(schemas?.map((entry) => entry.name)) !== JSON.stringify(names)) {
    throw new Error(`${label} must be ${names.join(', ')}.`)
  }
  for (const entry of schemas) {
    const expectedUrl = `https://endroit.org/schema/${version}/${entry.name}.json`
    if (entry.url !== expectedUrl) throw new Error(`${entry.name} schema URL must be ${expectedUrl}.`)
    await verifyPublicSchema(entry)
  }
}
