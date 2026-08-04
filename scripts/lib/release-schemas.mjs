import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export async function collectVersionedSchemas(projectRoot, version, names) {
  return collectSchemas(projectRoot, names.map((name) => ({
    name,
    source: `schemas/${version}/${name}.schema.json`,
    url: `https://endroit.org/schema/${version}/${name}.json`,
  })))
}

export async function collectWorkSchemas(projectRoot, names) {
  return collectSchemas(projectRoot, names.map((name) => ({
    name,
    source: `schemas/work/${name}.json`,
    url: `https://endroit.org/schema/work/${name}.json`,
  })))
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

export async function verifyWorkSchemas(schemas, names, verifyPublicSchema) {
  if (JSON.stringify(schemas?.map((entry) => entry.name)) !== JSON.stringify(names)) {
    throw new Error(`Release Work schemas must be ${names.join(', ')}.`)
  }
  for (const entry of schemas) {
    const expectedUrl = `https://endroit.org/schema/work/${entry.name}.json`
    if (entry.url !== expectedUrl) throw new Error(`${entry.name} Work schema URL must be ${expectedUrl}.`)
    await verifyPublicSchema(entry)
  }
}

async function collectSchemas(projectRoot, entries) {
  const schemas = []
  for (const entry of entries) {
    const content = await readFile(join(projectRoot, entry.source))
    if (JSON.parse(content).$id !== entry.url) throw new Error(`${entry.source} must use $id ${entry.url}.`)
    schemas.push({ ...entry, sha256: createHash('sha256').update(content).digest('hex') })
  }
  return schemas
}
