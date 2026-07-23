import Ajv2020 from 'ajv/dist/2020.js'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { HairnessError } from './lib/errors.mjs'

export const API = Object.freeze({
  home: 'https://hairness.dev/schema/home.json',
  asset: 'https://hairness.dev/schema/asset.json',
  desk: 'https://hairness.dev/schema/desk.json',
  artifact: 'https://hairness.dev/schema/artifact.json',
  hud: 'hairness.dev/hud/v1alpha1',
})

const schemaFiles = ['home.schema.json', 'desk.schema.json', 'asset.schema.json', 'artifact.schema.json', 'hud.schema.json']
const schemaIds = Object.freeze({
  home: API.home,
  desk: API.desk,
  asset: API.asset,
  artifact: API.artifact,
  hud: 'https://hairness.dev/schema/hud.json',
})
let validatorsPromise
let ajvPromise

async function ajv() {
  ajvPromise ??= (async () => {
    const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false })
    for (const file of schemaFiles) {
      const path = fileURLToPath(new URL(`../schemas/v5/${file}`, import.meta.url))
      ajv.addSchema(JSON.parse(await readFile(path, 'utf8')))
    }
    return ajv
  })()
  return ajvPromise
}

async function validators() {
  validatorsPromise ??= (async () => {
    const instance = await ajv()
    const values = new Map()
    for (const file of schemaFiles) {
      const type = file.replace('.schema.json', '')
      values.set(type, instance.getSchema(schemaIds[type]))
    }
    return values
  })()
  return validatorsPromise
}

export async function validateDocument(document, type) {
  const validate = (await validators()).get(type)
  if (!validate) throw new HairnessError('document_unsupported', `Unsupported document type ${type}.`)
  if (!validate(document)) {
    const message = validate.errors.map((error) => `${error.instancePath || '/'} ${error.message}`).join('; ')
    throw new HairnessError('document_invalid', `Invalid ${type}: ${message}.`, { details: { errors: validate.errors } })
  }
  return document
}

export async function compileSchemas() {
  return [...(await validators()).keys()]
}

export async function validateAgainstSchema(value, schema, label) {
  let validate
  try {
    validate = (await ajv()).compile(schema)
  } catch (error) {
    throw new HairnessError('settings_schema_invalid', `Invalid ${label} schema: ${error.message}.`, { cause: error })
  }
  if (!validate(value)) {
    const message = validate.errors.map((error) => `${error.instancePath || '/'} ${error.message}`).join('; ')
    throw new HairnessError('settings_invalid', `Invalid ${label}: ${message}.`, { details: { errors: validate.errors } })
  }
  return value
}
