import Ajv2020 from 'ajv/dist/2020.js'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { EndroitError } from './lib/errors.mjs'

export const API = Object.freeze({
  home: 'https://endroit.org/schema/home.json',
  equipment: 'https://endroit.org/schema/equipment.json',
  desk: 'https://endroit.org/schema/desk.json',
  member: 'https://endroit.org/schema/member.json',
  site: 'https://endroit.org/schema/site.json',
  route: 'https://endroit.org/schema/route.json',
  runtime: 'endroit.org/runtime/v1alpha1',
})

const schemaFiles = ['home.schema.json', 'desk.schema.json', 'member.schema.json', 'equipment.schema.json', 'site.schema.json', 'route.schema.json', 'runtime.schema.json']
let validatorsPromise

async function validators() {
  validatorsPromise ??= (async () => {
    const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false })
    const values = new Map()
    for (const file of schemaFiles) {
      const path = fileURLToPath(new URL(`../schemas/v7/${file}`, import.meta.url))
      const schema = JSON.parse(await readFile(path, 'utf8'))
      values.set(file.replace('.schema.json', ''), ajv.compile(schema))
    }
    return values
  })()
  return validatorsPromise
}

export async function validateDocument(document, type) {
  const validate = (await validators()).get(type)
  if (!validate) throw new EndroitError('document_unsupported', `Unsupported document type ${type}.`)
  const expectedSchema = API[type]
  if (expectedSchema?.startsWith('https://') && document?.$schema !== expectedSchema) {
    throw new EndroitError(
      'schema_version_mismatch',
      `Unsupported ${type} schema ${document?.$schema ?? '(missing)'}; Endroit 0.8 requires ${expectedSchema}.`,
      { exitCode: 3 },
    )
  }
  if (!validate(document)) {
    const message = validate.errors.map((error) => `${error.instancePath || '/'} ${error.message}`).join('; ')
    throw new EndroitError('document_invalid', `Invalid ${type}: ${message}.`, { details: { errors: validate.errors } })
  }
  return document
}

export async function compileSchemas() {
  return [...(await validators()).keys()]
}
