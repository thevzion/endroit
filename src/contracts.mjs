import Ajv2020 from 'ajv/dist/2020.js'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { EndroitError } from './lib/errors.mjs'

export const API = Object.freeze({
  home: 'https://endroit.org/schema/v7/home.json',
  equipment: 'https://endroit.org/schema/v7/equipment.json',
  desk: 'https://endroit.org/schema/v7/desk.json',
  member: 'https://endroit.org/schema/v7/member.json',
  site: 'https://endroit.org/schema/v7/site.json',
  route: 'https://endroit.org/schema/v8/route.json',
  routeV7: 'https://endroit.org/schema/v7/route.json',
  artifact: 'https://endroit.org/schema/v7/artifact.json',
  runtime: 'endroit.org/runtime/v2alpha1',
})

const schemaFiles = ['home.schema.json', 'desk.schema.json', 'member.schema.json', 'equipment.schema.json', 'site.schema.json', 'route.schema.json', 'runtime.schema.json', 'artifact.schema.json']
let validatorsPromise
let routeV8ValidatorPromise

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
  if (type === 'route') return validateRouteDocument(document)
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

export async function validateRouteDocument(document) {
  let validate
  if (document?.$schema === API.routeV7) {
    validate = (await validators()).get('route')
  } else if (document?.$schema === API.route) {
    routeV8ValidatorPromise ??= (async () => {
      const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false })
      const path = fileURLToPath(new URL('../schemas/v8/route.schema.json', import.meta.url))
      return ajv.compile(JSON.parse(await readFile(path, 'utf8')))
    })()
    validate = await routeV8ValidatorPromise
  } else {
    throw new EndroitError(
      'schema_version_mismatch',
      `Unsupported route schema ${document?.$schema ?? '(missing)'}; Endroit reads v7 and v8 Routes.`,
      { exitCode: 3 },
    )
  }
  if (!validate(document)) {
    const message = validate.errors.map((error) => `${error.instancePath || '/'} ${error.message}`).join('; ')
    throw new EndroitError('document_invalid', `Invalid route: ${message}.`, { details: { errors: validate.errors } })
  }
  return document
}

export async function compileSchemas() {
  return [...(await validators()).keys()]
}
