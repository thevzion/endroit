import {
  V9_API,
  compileSchemasV9,
  validateContract,
  validateDocumentV9,
  validateLegacyDocument,
} from './documents.mjs'

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
  documentV9: V9_API.document,
  profileV9: V9_API.profile,
  workplace: V9_API.workplace,
  memberV9: V9_API.member,
  deskV9: V9_API.desk,
  roomV9: V9_API.room,
  siteV9: V9_API.site,
  routeV9: V9_API.route,
  equipmentV9: V9_API.equipment,
  artifactV9: V9_API.artifact,
})

const legacyTypes = ['home', 'desk', 'member', 'equipment', 'site', 'route', 'runtime', 'artifact']

export async function validateDocument(document, type) {
  if (V9_API[type] && document?.$schema === V9_API[type]) return validateDocumentV9(document, type)
  return validateLegacyDocument(document, type)
}

export async function validateRouteDocument(document) {
  if (document?.$schema === V9_API.route) return validateDocumentV9(document, 'route')
  return validateLegacyDocument(document, 'route')
}

export async function compileSchemas() {
  await compileSchemasV9()
  return [...legacyTypes]
}

export { compileSchemasV9, validateContract, validateDocumentV9, V9_API }
