import Ajv2020 from 'ajv/dist/2020.js'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { HairnessError } from './lib/errors.mjs'

export const API = Object.freeze({
  home: 'https://hairness.dev/schema/home.json',
  asset: 'https://hairness.dev/schema/asset.json',
  desk: 'https://hairness.dev/schema/desk.json',
  runtime: 'hairness.dev/runtime/v1alpha1',
})

const schemaFiles = ['home.schema.json', 'desk.schema.json', 'asset.schema.json', 'runtime.schema.json']
let validatorsPromise

async function validators() {
  validatorsPromise ??= (async () => {
    const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false })
    const values = new Map()
    for (const file of schemaFiles) {
      const path = fileURLToPath(new URL(`../schemas/v5/${file}`, import.meta.url))
      const schema = JSON.parse(await readFile(path, 'utf8'))
      values.set(file.replace('.schema.json', ''), ajv.compile(schema))
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
