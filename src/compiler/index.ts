import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { isAlias, isNode, parseDocument, visit } from "yaml";
import type {
  Composition,
  CoordinationIR,
  CoordinationPolicy,
  Diagnostic,
  EntryBinding,
  Equipment,
  MethodDefinition,
  LoadedProfilePackage,
  Profile,
  ProviderBinding,
  Revision,
  SourceContractId,
  SourceEnvelope,
  SourceRecord,
  WorkplaceBuildContract,
} from "./model.ts";
import { loadProfilePackage, renderProfileTemplate } from "./profile-package.ts";

export * from "./model.ts";
export * from "./meeting.ts";
export * from "./settle.ts";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export type CompileInput = {
  root: string;
  profile: Profile;
  profilePackage?: LoadedProfilePackage;
  workplace: WorkplaceBuildContract;
  composition: Composition;
  equipment: Equipment[];
  coordination: CoordinationPolicy;
  sources: SourceRecord[];
  entry?: EntryBinding;
  provider?: ProviderBinding;
  ignore: { bytes: string; revision: Revision };
};

export type MapEntry = {
  ref: string;
  entity: string;
  roles: string[];
  root: string;
  path: string;
  projectionPath: string;
  revision: Revision;
  lifecycle?: string;
};

export type CompileResult = {
  root: string;
  status: "onboarding-required" | "bound";
  revision: Revision;
  files: string[];
  entries: MapEntry[];
};

export type CheckResult = {
  compileStatus: "missing" | "valid" | "stale" | "unavailable";
  entryStatus: "unadopted" | "onboarding-required" | "bound" | "ambiguous";
  operationStatus: "ready" | "compile-required" | "pending" | "degraded";
  requiredAction?: string;
  diagnostics: Diagnostic[];
};

export type FrontDoorIR = {
  scope: string;
  position: "hall" | "place" | "meeting" | "work" | "site";
  entryStatus: "onboarding-required" | "bound";
  title: string;
  sections: Array<{
    id: string;
    title: string;
    body: string;
    scope: string;
    visibility: "must-show" | "may-show" | "must-hide";
    reasonForDisclosure: string;
    sources: Array<{ ref: string; revision: Revision }>;
    links: Array<{ label: string; path: string; ref?: string }>;
  }>;
};

const SOURCE_KEYS = new Set([
  "ref", "entity", "roles", "slot", "owner", "scope", "label", "language",
  "summary", "when", "responsibilities", "authorityLimits", "durableChanges",
  "outcomes", "verification",
  "intent", "primaryWork", "relatedWorks", "occupants", "controls",
  "dispatches", "nextBoundary", "disposition",
  "sharedShelves",
  "appliesTo", "status", "supersedes", "contradicts", "relations",
  "derivedFrom", "lifecycle", "currency", "freshness", "claimMaturity",
]);

const PROFILE_KEYS = new Set([
  "$schema", "id", "version", "ref", "roots", "entities", "roles", "slots",
  "relations", "views", "lifecycles", "disclosures",
]);
const ROOT_KEYS = new Set(["ownership", "visibility", "physical"]);
const ENTITY_KEYS = new Set(["title", "purpose", "useWhen", "avoidWhen", "roles"]);
const ROLE_KEYS = new Set(["mode", "target", "requiresRoles", "conflictsWith", "roots", "source", "locator", "lifecycle", "slots", "requiredRelations", "sourceResponsibilities", "projectionResponsibilities", "entry", "purpose", "useWhen", "avoidWhen", "ownership", "retention"]);
const ROLE_TARGET_KEYS = new Set(["kind", "ids"]);
const SOURCE_DEFINITION_KEYS = new Set(["format", "leaf"]);
const SLOT_KEYS = new Set(["owner", "role", "accepts", "cardinality", "locator", "visibility", "order", "lifecycle", "affordances"]);
const ACCEPTS_KEYS = new Set(["entities", "roles", "projections"]);
const RELATION_KEYS = new Set(["from", "to", "cardinality", "external", "purpose"]);
const CARDINALITY_KEYS = new Set(["from", "to"]);
const VIEW_KEYS = new Set(["fromEntities", "fromRoles", "projection"]);
const DISCLOSURE_KEYS = new Set(["discovery", "identity", "roots", "lifecycle", "sites", "projections", "degraded", "selectors", "limits"]);
const DISCLOSURE_SELECTOR_KEYS = new Set(["id", "positions", "visibility", "roles", "relations", "reason"]);
const LIMIT_KEYS = new Set(["maxSourceBytes", "maxSources", "maxDepth", "maxResidentBytes"]);
const WORKPLACE_KEYS = new Set(["kind", "version", "workplace", "profile", "composition", "roots", "policy", "distributionTargets"]);
const WORKPLACE_POLICY_KEYS = new Set(["disclosureSelectors", "localBuildIntent", "delivery"]);
const SELECTOR_KEYS = new Set(["ref", "path", "revision"]);
const TARGET_KEYS = new Set(["provider", "kind", "path", "discovery", "loadGuarantee"]);
const COMPOSITION_KEYS = new Set(["kind", "ref", "equipment"]);
const ENTRY_KEYS = new Set(["kind", "workplace", "member", "desk", "rootBindings"]);
const PROVIDER_KEYS = new Set(["kind", "provider", "targets", "tools"]);
const TOOL_BINDING_KEYS = new Set(["trait", "tool", "provider", "availability", "command"]);
const EQUIPMENT_KEYS = new Set(["kind", "ref", "id", "compatibleProfiles", "methods"]);
const METHOD_KEYS = new Set(["id", "title", "instructions", "intent", "useWhen", "avoidWhen", "acceptsWorkForms", "requiredPlaceRoles", "requiredEntityRoles", "requires", "operations", "effects", "authority", "proof", "staticFallback", "coordination", "requiredControls", "context", "stages"]);
const METHOD_CONTEXT_KEYS = new Set(["requiredReads", "conditionalReads", "forbiddenScopes", "searchRoot", "stopCondition"]);
const OPERATION_KEYS = new Set(["id", "trait", "effect", "authority", "proof"]);
const STAGE_KEYS = new Set(["id", "appliesTo", "operations", "outcome", "optional"]);
const OUTCOME_KEYS = new Set(["id", "requires", "produces", "preserves", "forbids", "evidence"]);
const COORDINATION_KEYS = new Set(["kind", "version", "ref", "roles", "resolution", "dispatchEnvelope", "fallbacks"]);
const COORDINATION_ROLE_KEYS = new Set(["owns", "never"]);
const COORDINATION_ROUTE_KEYS = new Set(["id", "when", "sequence"]);
const COORDINATION_WHEN_KEYS = new Set(["rootCount", "effectCount", "integration", "contextClass"]);
const COORDINATION_FALLBACK_KEYS = new Set(["ambiguous", "missingAuthority", "noSubagents", "inlineWorker"]);
const MEETING_OCCUPANT_KEYS = new Set(["id", "role", "agent", "contribution"]);
const MEETING_DISPATCH_KEYS = new Set(["id", "occupant", "meetingRef", "position", "work", "objective", "authoritativeSources", "mutableScope", "exclusions", "authority", "mandate", "expectedOutcome", "terminalCondition", "activeControls", "status"]);
const PROFILE_SELECTION_KEYS = new Set(["kind", "version", "ref", "digest"]);

const REF = /^workplace:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
const ID = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

function fail(message: string): never {
  throw new Error(message);
}

function object(value: unknown, subject: string): Record<string, unknown> {
  if (value === null || Array.isArray(value) || typeof value !== "object") fail(`${subject} must be an object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(`${subject} has an invalid prototype`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: Set<string>, subject: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) fail(`${subject} has unknown fields: ${unknown.sort().join(", ")}`);
}

function record(value: unknown, subject: string): Record<string, Record<string, unknown>> {
  const result = object(value, subject);
  for (const [key, item] of Object.entries(result)) {
    if (!ID.test(key)) fail(`${subject} has invalid id: ${key}`);
    object(item, `${subject}.${key}`);
  }
  return result as Record<string, Record<string, unknown>>;
}

function stringArray(value: unknown, subject: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) fail(`${subject} must be a string array`);
  return value as string[];
}

function semanticRef(value: unknown, subject: string): string {
  if (typeof value !== "string" || !REF.test(value)) fail(`${subject} is not a v0 workplace:// Ref`);
  return value;
}

export function hash(bytes: string | Uint8Array): Revision {
  const digest = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  return `sha256:${digest}`;
}

export function stable(value: unknown): string {
  const normalize = (item: unknown): Json => {
    if (item === null || typeof item === "string" || typeof item === "boolean" || typeof item === "number") return item;
    if (Array.isArray(item)) return item.map(normalize);
    const source = object(item, "serializable value");
    return Object.fromEntries(Object.keys(source).sort().map((key) => [key, normalize(source[key])])) as { [key: string]: Json };
  };
  return `${JSON.stringify(normalize(value), null, 2)}\n`;
}

async function readJson<T>(path: string, subject: string): Promise<T> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    fail(`${subject} is unavailable at ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    fail(`${subject} is invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function validateProfile(profile: Profile): void {
  const raw = object(profile, "Profile");
  exactKeys(raw, PROFILE_KEYS, "Profile");
  if (typeof profile.id !== "string" || !ID.test(profile.id)) fail("Profile.id must be a lower-ASCII slug");
  semanticRef(profile.ref, "Profile.ref");
  const roots = record(profile.roots, "Profile.roots");
  const entities = record(profile.entities, "Profile.entities");
  const roles = record(profile.roles, "Profile.roles");
  const slots = record(profile.slots, "Profile.slots");
  const relations = record(profile.relations, "Profile.relations");
  record(profile.views, "Profile.views");
  const lifecycles = object(profile.lifecycles, "Profile.lifecycles");
  for (const [id, states] of Object.entries(lifecycles)) {
    if (!ID.test(id)) fail(`Profile.lifecycles has invalid id: ${id}`);
    stringArray(states, `Profile.lifecycles.${id}`);
  }
  const disclosures = object(profile.disclosures, "Profile.disclosures");
  exactKeys(disclosures, DISCLOSURE_KEYS, "Profile.disclosures");
  const limits = object(disclosures.limits, "Profile.disclosures.limits");
  exactKeys(limits, LIMIT_KEYS, "Profile.disclosures.limits");
  for (const key of LIMIT_KEYS) {
    if (!Number.isInteger(limits[key]) || Number(limits[key]) <= 0) fail(`Profile.disclosures.limits.${key} must be a positive integer`);
  }
  if (!Array.isArray(disclosures.selectors)) fail("Profile.disclosures.selectors must be an array");
  const selectorIds = new Set<string>();
  for (const [index, value] of disclosures.selectors.entries()) {
    const selector = object(value, `Profile.disclosures.selectors[${index}]`);
    exactKeys(selector, DISCLOSURE_SELECTOR_KEYS, `Profile.disclosures.selectors[${index}]`);
    if (typeof selector.id !== "string" || !ID.test(selector.id)) fail(`Profile disclosure selector ${index} has invalid id`);
    if (selectorIds.has(selector.id)) fail(`Profile has duplicate disclosure selector ${selector.id}`);
    selectorIds.add(selector.id);
    const positions = stringArray(selector.positions, `Profile disclosure selector ${selector.id}.positions`);
    if (positions.some((item) => !["hall", "place", "meeting", "work", "site"].includes(item))) fail(`Profile disclosure selector ${selector.id} has invalid Position`);
    if (!["must-show", "may-show", "must-hide"].includes(String(selector.visibility))) fail(`Profile disclosure selector ${selector.id} has invalid visibility`);
    for (const role of stringArray(selector.roles, `Profile disclosure selector ${selector.id}.roles`)) if (!(role in roles)) fail(`Profile disclosure selector ${selector.id} references unknown Role ${role}`);
    for (const relation of stringArray(selector.relations, `Profile disclosure selector ${selector.id}.relations`)) if (!(relation in relations)) fail(`Profile disclosure selector ${selector.id} references unknown Relation ${relation}`);
    if (typeof selector.reason !== "string" || selector.reason.length === 0) fail(`Profile disclosure selector ${selector.id} needs a reason`);
  }
  if (Object.keys(roots).length === 0 || Object.keys(entities).length === 0) fail("Profile needs at least one Root and entity family");

  for (const [id, entity] of Object.entries(entities)) {
    exactKeys(entity, ENTITY_KEYS, `Profile.entities.${id}`);
    for (const role of stringArray(entity.roles, `Profile.entities.${id}.roles`)) {
      if (!(role in roles)) fail(`Entity ${id} references unknown Role ${role}`);
    }
  }
  for (const [id, role] of Object.entries(roles)) {
    exactKeys(role, ROLE_KEYS, `Profile.roles.${id}`);
    if (role.mode !== "authored" && role.mode !== "resolved") fail(`Role ${id} has invalid mode`);
    const target = object(role.target, `Role ${id}.target`);
    exactKeys(target, ROLE_TARGET_KEYS, `Role ${id}.target`);
    if (!["entity-family", "slot", "relation", "projection"].includes(String(target.kind))) fail(`Role ${id} has invalid target kind`);
    if (target.kind === "entity-family") {
      for (const entity of stringArray(target.ids, `Role ${id}.target.ids`)) if (!(entity in entities)) fail(`Role ${id} targets unknown entity ${entity}`);
    }
    for (const required of stringArray(role.requiresRoles ?? [], `Role ${id}.requiresRoles`)) if (!(required in roles)) fail(`Role ${id} requires unknown Role ${required}`);
    for (const conflict of stringArray(role.conflictsWith ?? [], `Role ${id}.conflictsWith`)) if (!(conflict in roles)) fail(`Role ${id} conflicts with unknown Role ${conflict}`);
    for (const root of stringArray(role.roots ?? [], `Role ${id}.roots`)) if (!(root in roots)) fail(`Role ${id} references unknown Root ${root}`);
    for (const slot of stringArray(role.slots ?? [], `Role ${id}.slots`)) if (!(slot in slots)) fail(`Role ${id} references unknown Slot ${slot}`);
    if (role.source) exactKeys(object(role.source, `Role ${id}.source`), SOURCE_DEFINITION_KEYS, `Role ${id}.source`);
  }
  for (const [id, root] of Object.entries(roots)) exactKeys(root, ROOT_KEYS, `Profile.roots.${id}`);
  for (const [id, slot] of Object.entries(slots)) {
    exactKeys(slot, SLOT_KEYS, `Profile.slots.${id}`);
    if (!(String(slot.owner) in roles)) fail(`Slot ${id} has unknown owner Role ${String(slot.owner)}`);
    if (!(String(slot.role) in roles)) fail(`Slot ${id} has unknown spatial Role ${String(slot.role)}`);
    const accepts = object(slot.accepts, `Slot ${id}.accepts`);
    exactKeys(accepts, ACCEPTS_KEYS, `Slot ${id}.accepts`);
    for (const entity of stringArray(accepts.entities ?? [], `Slot ${id}.accepts.entities`)) if (!(entity in entities)) fail(`Slot ${id} accepts unknown entity ${entity}`);
    for (const role of stringArray(accepts.roles ?? [], `Slot ${id}.accepts.roles`)) if (!(role in roles)) fail(`Slot ${id} accepts unknown Role ${role}`);
    safeTemplate(String(slot.locator), `Slot ${id}.locator`);
  }
  for (const [id, relation] of Object.entries(relations)) {
    exactKeys(relation, RELATION_KEYS, `Profile.relations.${id}`);
    exactKeys(object(relation.cardinality, `Profile.relations.${id}.cardinality`), CARDINALITY_KEYS, `Profile.relations.${id}.cardinality`);
    for (const role of [...stringArray(relation.from, `Relation ${id}.from`), ...stringArray(relation.to, `Relation ${id}.to`)]) {
      if (!(role in roles) && !(role in entities)) fail(`Relation ${id} references unknown family/Role ${role}`);
    }
  }
  for (const [id, view] of Object.entries(record(profile.views, "Profile.views"))) exactKeys(view, VIEW_KEYS, `Profile.views.${id}`);
}

const COORDINATION_ROLES = ["main", "manager", "worker"] as const;
const DISPATCH_ENVELOPE = [
  "meetingRef", "position", "workRef", "objective", "authoritativeSources", "mutableScope",
  "exclusions", "authority", "mandate", "expectedOutcome", "terminalCondition",
  "activeControls",
] as const;

export function validateCoordinationPolicy(value: unknown, workplace: string): CoordinationPolicy {
  const policy = object(value, "CoordinationPolicy");
  exactKeys(policy, COORDINATION_KEYS, "CoordinationPolicy");
  if (policy.kind !== "CoordinationPolicy" || policy.version !== 1) fail("Unsupported CoordinationPolicy");
  if (policy.ref !== `${workplace}/coordination`) fail("CoordinationPolicy.ref must belong to this Workplace");
  semanticRef(policy.ref, "CoordinationPolicy.ref");

  const roles = object(policy.roles, "CoordinationPolicy.roles");
  exactKeys(roles, new Set(COORDINATION_ROLES), "CoordinationPolicy.roles");
  for (const role of COORDINATION_ROLES) {
    const contract = object(roles[role], `CoordinationPolicy.roles.${role}`);
    exactKeys(contract, COORDINATION_ROLE_KEYS, `CoordinationPolicy.roles.${role}`);
    if (stringArray(contract.owns, `CoordinationPolicy.roles.${role}.owns`).length === 0) fail(`CoordinationPolicy.roles.${role}.owns must not be empty`);
    if (stringArray(contract.never, `CoordinationPolicy.roles.${role}.never`).length === 0) fail(`CoordinationPolicy.roles.${role}.never must not be empty`);
  }

  if (!Array.isArray(policy.resolution) || policy.resolution.length !== 3) fail("CoordinationPolicy.resolution must contain the three closed routes");
  const expectedRoutes = new Map<string, { when: Record<string, Json>; sequence: string[] }>([
    ["read-only", { when: { rootCount: "one", effectCount: "zero", integration: false, contextClass: "bounded" }, sequence: ["main"] }],
    ["single-scope", { when: { rootCount: "one", effectCount: "one", integration: false, contextClass: "bounded" }, sequence: ["main", "worker", "main"] }],
    ["integration", { when: { rootCount: "multiple", effectCount: "multiple", integration: true, contextClass: "substantial" }, sequence: ["main", "manager", "worker", "manager", "main"] }],
  ]);
  const ids = new Set<string>();
  for (const [index, value] of policy.resolution.entries()) {
    const route = object(value, `CoordinationPolicy.resolution[${index}]`);
    exactKeys(route, COORDINATION_ROUTE_KEYS, `CoordinationPolicy.resolution[${index}]`);
    if (typeof route.id !== "string" || !expectedRoutes.has(route.id) || ids.has(route.id)) fail(`CoordinationPolicy.resolution[${index}].id is invalid`);
    ids.add(route.id);
    const when = object(route.when, `CoordinationPolicy.resolution[${index}].when`);
    exactKeys(when, COORDINATION_WHEN_KEYS, `CoordinationPolicy.resolution[${index}].when`);
    if (!["one", "multiple"].includes(String(when.rootCount))) fail(`CoordinationPolicy route ${route.id} has invalid rootCount`);
    if (!["zero", "one", "multiple"].includes(String(when.effectCount))) fail(`CoordinationPolicy route ${route.id} has invalid effectCount`);
    if (typeof when.integration !== "boolean") fail(`CoordinationPolicy route ${route.id} has invalid integration`);
    if (!["bounded", "substantial"].includes(String(when.contextClass))) fail(`CoordinationPolicy route ${route.id} has invalid contextClass`);
    if (stable(when as Json) !== stable(expectedRoutes.get(route.id)!.when)) fail(`CoordinationPolicy route ${route.id} has invalid predicates`);
    const sequence = stringArray(route.sequence, `CoordinationPolicy route ${route.id}.sequence`);
    if (sequence.join("|") !== expectedRoutes.get(route.id)!.sequence.join("|")) fail(`CoordinationPolicy route ${route.id} has invalid sequence`);
  }

  const envelope = stringArray(policy.dispatchEnvelope, "CoordinationPolicy.dispatchEnvelope");
  if (envelope.length !== DISPATCH_ENVELOPE.length || [...envelope].sort().join("|") !== [...DISPATCH_ENVELOPE].sort().join("|")) fail("CoordinationPolicy.dispatchEnvelope is incomplete");
  const fallbacks = object(policy.fallbacks, "CoordinationPolicy.fallbacks");
  exactKeys(fallbacks, COORDINATION_FALLBACK_KEYS, "CoordinationPolicy.fallbacks");
  if (fallbacks.ambiguous !== "ask-once-zero-write" || fallbacks.missingAuthority !== "blocked" || !["degraded", "blocked"].includes(String(fallbacks.noSubagents))) fail("CoordinationPolicy fallbacks must fail closed");
  if (fallbacks.inlineWorker !== "forbidden" && fallbacks.inlineWorker !== "single-scope-explicit") fail("CoordinationPolicy.fallbacks.inlineWorker is invalid");
  return value as CoordinationPolicy;
}

export function parseCoordinationPolicy(bytes: string, workplace: string): CoordinationPolicy {
  try {
    JSON.parse(bytes);
  } catch (error) {
    fail(`CoordinationPolicy is not strict JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const document = parseDocument(bytes, { strict: true, uniqueKeys: true, stringKeys: true, schema: "json" });
  if (document.errors.length > 0) fail(`CoordinationPolicy is invalid: ${document.errors.map((error) => error.message).join("; ")}`);
  return validateCoordinationPolicy(document.toJS({ maxAliasCount: 0 }), workplace);
}

export function parseSourceEnvelope(bytes: string, relativePath = "source.md"): SourceRecord {
  if (new TextEncoder().encode(bytes).byteLength > 256 * 1024) fail(`${relativePath} exceeds the absolute source budget`);
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(bytes);
  if (!match?.[1] || match[2] === undefined) fail(`${relativePath} must begin with one strict YAML frontmatter document`);
  if (new TextEncoder().encode(match[1]).byteLength > 16 * 1024) fail(`${relativePath} frontmatter exceeds 16 KiB`);
  if (/^%/m.test(match[1])) fail(`${relativePath} YAML directives are forbidden`);
  if (/^\s*(?:---|\.\.\.)\s*(?:\r?\n|$)/.test(match[2])) fail(`${relativePath} contains multiple YAML documents`);
  if (!/^\s*#\s+/m.test(match[2])) fail(`${relativePath} Markdown body must contain a heading`);
  const document = parseDocument(match[1], {
    strict: true,
    uniqueKeys: true,
    stringKeys: true,
    schema: "core",
  });
  const problems = [...document.errors, ...document.warnings];
  if (problems.length > 0) fail(`${relativePath} frontmatter is invalid: ${problems.map((item) => item.message).join("; ")}`);
  let forbidden = "";
  visit(document, (_key, node) => {
    if (isAlias(node)) forbidden = "aliases";
    else if (isNode(node) && node.anchor) forbidden = "anchors";
    else if (isNode(node) && node.tag) forbidden = "custom tags";
  });
  if (forbidden) fail(`${relativePath} frontmatter forbids ${forbidden}`);
  const envelope = document.toJS({ maxAliasCount: 0 }) as SourceEnvelope;
  const raw = object(envelope, `${relativePath} envelope`);
  exactKeys(raw, SOURCE_KEYS, `${relativePath} envelope`);
  semanticRef(envelope.ref, `${relativePath}.ref`);
  semanticRef(envelope.owner, `${relativePath}.owner`);
  semanticRef(envelope.scope, `${relativePath}.scope`);
  if (typeof envelope.entity !== "string" || !ID.test(envelope.entity)) fail(`${relativePath}.entity is invalid`);
  if (typeof envelope.summary !== "string" || envelope.summary.length === 0) fail(`${relativePath}.summary is required`);
  if (envelope.label !== undefined && (typeof envelope.label !== "string" || envelope.label.length > 120)) fail(`${relativePath}.label is invalid`);
  if (envelope.language !== undefined && (typeof envelope.language !== "string" || envelope.language.length > 40)) fail(`${relativePath}.language is invalid`);
  stringArray(envelope.roles ?? [], `${relativePath}.roles`);
  stringArray(envelope.when, `${relativePath}.when`);
  stringArray(envelope.responsibilities ?? [], `${relativePath}.responsibilities`);
  stringArray(envelope.authorityLimits ?? [], `${relativePath}.authorityLimits`);
  stringArray(envelope.durableChanges ?? [], `${relativePath}.durableChanges`);
  stringArray(envelope.outcomes ?? [], `${relativePath}.outcomes`);
  stringArray(envelope.verification ?? [], `${relativePath}.verification`);
  for (const ref of stringArray(envelope.sharedShelves ?? [], `${relativePath}.sharedShelves`)) semanticRef(ref, `${relativePath}.sharedShelves`);
  const relations = object(envelope.relations, `${relativePath}.relations`);
  for (const [id, refs] of Object.entries(relations)) {
    if (!ID.test(id)) fail(`${relativePath} relation id is invalid: ${id}`);
    for (const ref of stringArray(refs, `${relativePath}.relations.${id}`)) semanticRef(ref, `${relativePath}.relations.${id}`);
  }
  const meetingFields = ["intent", "primaryWork", "relatedWorks", "occupants", "controls", "dispatches", "nextBoundary", "disposition"] as const;
  if (envelope.entity !== "meeting" && meetingFields.some((key) => envelope[key] !== undefined)) fail(`${relativePath} uses Meeting fields on ${envelope.entity}`);
  if (envelope.entity === "meeting") {
    if (!(envelope.roles ?? []).includes("meeting")) fail(`${relativePath} Meeting source needs the meeting Role`);
    if (!["active", "settling", "closed"].includes(String(envelope.lifecycle))) fail(`${relativePath}.lifecycle must be active, settling or closed`);
    if (typeof envelope.intent !== "string" || envelope.intent.trim().length === 0 || envelope.intent.length > 500) fail(`${relativePath}.intent is invalid`);
    if (typeof envelope.nextBoundary !== "string" || envelope.nextBoundary.trim().length === 0 || envelope.nextBoundary.length > 500) fail(`${relativePath}.nextBoundary is invalid`);
    if (envelope.primaryWork) semanticRef(envelope.primaryWork, `${relativePath}.primaryWork`);
    for (const ref of stringArray(envelope.relatedWorks ?? [], `${relativePath}.relatedWorks`)) semanticRef(ref, `${relativePath}.relatedWorks`);
    stringArray(envelope.controls ?? [], `${relativePath}.controls`);
    if (!Array.isArray(envelope.occupants)) fail(`${relativePath}.occupants must be an array`);
    const occupantIds = new Set<string>();
    for (const [index, value] of envelope.occupants.entries()) {
      const occupant = object(value, `${relativePath}.occupants[${index}]`);
      exactKeys(occupant, MEETING_OCCUPANT_KEYS, `${relativePath}.occupants[${index}]`);
      if (typeof occupant.id !== "string" || !ID.test(occupant.id) || occupantIds.has(occupant.id)) fail(`${relativePath}.occupants[${index}].id is invalid or duplicated`);
      occupantIds.add(occupant.id);
      if (!["main", "manager", "worker", "specialized"].includes(String(occupant.role))) fail(`${relativePath}.occupants[${index}].role is invalid`);
      if (occupant.agent !== undefined) semanticRef(occupant.agent, `${relativePath}.occupants[${index}].agent`);
      if (occupant.contribution !== undefined) semanticRef(occupant.contribution, `${relativePath}.occupants[${index}].contribution`);
    }
    if (!Array.isArray(envelope.dispatches)) fail(`${relativePath}.dispatches must be an array`);
    const dispatchIds = new Set<string>();
    for (const [index, value] of envelope.dispatches.entries()) {
      const dispatch = object(value, `${relativePath}.dispatches[${index}]`);
      exactKeys(dispatch, MEETING_DISPATCH_KEYS, `${relativePath}.dispatches[${index}]`);
      if (typeof dispatch.id !== "string" || !ID.test(dispatch.id) || dispatchIds.has(dispatch.id)) fail(`${relativePath}.dispatches[${index}].id is invalid or duplicated`);
      dispatchIds.add(dispatch.id);
      if (typeof dispatch.occupant !== "string" || !occupantIds.has(dispatch.occupant)) fail(`${relativePath}.dispatches[${index}].occupant is unresolved`);
      semanticRef(dispatch.meetingRef, `${relativePath}.dispatches[${index}].meetingRef`);
      if (dispatch.meetingRef !== envelope.ref) fail(`${relativePath}.dispatches[${index}].meetingRef must inherit this Meeting`);
      semanticRef(dispatch.work, `${relativePath}.dispatches[${index}].work`);
      semanticRef(dispatch.mandate, `${relativePath}.dispatches[${index}].mandate`);
      for (const ref of stringArray(dispatch.authoritativeSources, `${relativePath}.dispatches[${index}].authoritativeSources`)) semanticRef(ref, `${relativePath}.dispatches[${index}].authoritativeSources`);
      stringArray(dispatch.mutableScope, `${relativePath}.dispatches[${index}].mutableScope`);
      stringArray(dispatch.exclusions, `${relativePath}.dispatches[${index}].exclusions`);
      stringArray(dispatch.activeControls, `${relativePath}.dispatches[${index}].activeControls`);
      if (dispatch.authority !== "delegated") fail(`${relativePath}.dispatches[${index}].authority must be delegated`);
      for (const key of ["position", "expectedOutcome", "terminalCondition"] as const) if (typeof dispatch[key] !== "string" || !dispatch[key].trim()) fail(`${relativePath}.dispatches[${index}].${key} is invalid`);
      if (typeof dispatch.objective !== "string" || dispatch.objective.trim().length === 0) fail(`${relativePath}.dispatches[${index}].objective is invalid`);
      if (!["pending", "active", "complete", "blocked"].includes(String(dispatch.status))) fail(`${relativePath}.dispatches[${index}].status is invalid`);
    }
    if (envelope.disposition !== undefined && !["resume", "close"].includes(envelope.disposition)) fail(`${relativePath}.disposition is invalid`);
    if (envelope.lifecycle === "closed" && envelope.disposition !== "close") fail(`${relativePath} closed Meeting requires disposition close`);
  }
  return {
    relativePath,
    envelope,
    body: match[2],
    bytes,
    revision: hash(bytes),
  };
}

export function renderSourceContract(profilePackage: LoadedProfilePackage, id: SourceContractId, variables: Record<string, string>): SourceRecord {
  const contract = profilePackage.sourceContracts[id] ?? fail(`Source Contract ${id} is unavailable`);
  const expected = new Set(contract.variables);
  const unknown = Object.keys(variables).filter((key) => !expected.has(key)).sort();
  const missing = contract.variables.filter((key) => !(key in variables)).sort();
  if (unknown.length) fail(`Source Contract ${id} has unknown variables: ${unknown.join(", ")}`);
  if (missing.length) fail(`Source Contract ${id} is missing variables: ${missing.join(", ")}`);
  const encoded: Record<string, string> = {};
  for (const key of contract.variables) {
    const value = variables[key];
    if (typeof value !== "string" || !value.trim()) fail(`Source Contract ${id} variable ${key} must be a non-empty string`);
    encoded[key] = JSON.stringify(value);
  }
  const rendered = `${renderProfileTemplate(contract.template, encoded)}\n`;
  if (new TextEncoder().encode(rendered).byteLength > contract.maxBytes) fail(`Source Contract ${id} render exceeds its byte budget`);
  return parseSourceEnvelope(rendered, contract.projectionPath);
}

function safeTemplate(template: string, subject: string): void {
  if (!template || template.startsWith("/") || template.includes("\\") || template.split("/").includes("..")) fail(`${subject} is unsafe`);
  const stripped = template.replace(/\{(?:node\.id|scope\.id|root\.id|relation\.[a-z0-9-]+\.id)\}/g, "x");
  if (stripped.includes("{") || stripped.includes("}")) fail(`${subject} uses an unsupported locator expression`);
}

function refId(ref: string): string {
  const parts = ref.split("/");
  return parts.at(-1) ?? fail(`Ref has no id: ${ref}`);
}

function locatorFor(source: SourceRecord, profile: Profile): string {
  const roles = source.envelope.roles ?? [];
  const role = roles.map((id) => [id, profile.roles[id]] as const).find(([, value]) => value?.locator);
  if (!role?.[1]?.locator) fail(`${source.envelope.ref} has no authored Role locator`);
  if (role[1].mode !== "authored") fail(`${source.envelope.ref} cannot author resolved Role ${role[0]}`);
  const relations = source.envelope.relations;
  const path = role[1].locator.replace(/\{([^}]+)\}/g, (_whole, token: string) => {
    if (token === "node.id") return refId(source.envelope.ref);
    if (token === "scope.id") return refId(source.envelope.scope);
    if (token === "root.id") return "shared";
    const relation = /^relation\.([a-z0-9-]+)\.id$/.exec(token)?.[1];
    if (relation) {
      const refs = relations[relation];
      if (refs?.length !== 1) fail(`${source.envelope.ref} locator requires exactly one ${relation} relation`);
      return refId(refs[0]!);
    }
    return fail(`${source.envelope.ref} uses unsupported locator token ${token}`);
  });
  safeTemplate(path, `${source.envelope.ref} resolved locator`);
  return path;
}

function validateSources(input: CompileInput): MapEntry[] {
  const byRef = new Map(input.sources.map((source) => [source.envelope.ref, source]));
  if (byRef.size !== input.sources.length) fail("Sources contain duplicate semantic Refs");
  const paths = new Set<string>();
  const entries = input.sources.map((source) => {
    const envelope = source.envelope;
    const entity = input.profile.entities[envelope.entity];
    if (!entity) fail(`${envelope.ref} uses unknown entity family ${envelope.entity}`);
    const roles = envelope.roles ?? [];
    if (roles.length === 0) fail(`${envelope.ref} needs at least one authored Role`);
    for (const roleId of roles) {
      const role = input.profile.roles[roleId];
      if (!role) fail(`${envelope.ref} uses unknown Role ${roleId}`);
      if (role.mode !== "authored") fail(`${envelope.ref} cannot author resolved Role ${roleId}`);
      if (role.target.kind !== "entity-family" || !role.target.ids.includes(envelope.entity)) fail(`${envelope.ref} Role ${roleId} is incompatible with ${envelope.entity}`);
      if (role.roots && !role.roots.includes(source.root ?? "shared")) fail(`${envelope.ref} Role ${roleId} cannot live in Root class ${source.root ?? "shared"}`);
      for (const required of role.requiresRoles ?? []) if (!roles.includes(required)) fail(`${envelope.ref} Role ${roleId} requires ${required}`);
      for (const conflict of role.conflictsWith ?? []) if (roles.includes(conflict)) fail(`${envelope.ref} Roles ${roleId} and ${conflict} conflict`);
      for (const relation of role.requiredRelations ?? []) if ((envelope.relations[relation]?.length ?? 0) === 0) fail(`${envelope.ref} Role ${roleId} requires Relation ${relation}`);
    }
    if (roles.includes("welcome") && new TextEncoder().encode(source.body).byteLength > 4096) {
      fail(`${envelope.ref} WELCOME body exceeds 4 KiB`);
    }
    if (envelope.entity === "meeting") {
      const works = [...new Set([envelope.primaryWork, ...(envelope.relatedWorks ?? []), ...(envelope.dispatches ?? []).map((item) => item.work)].filter((ref): ref is string => Boolean(ref)))];
      for (const ref of works) if (byRef.get(ref)?.envelope.entity !== "work") fail(`${envelope.ref} references unresolved Work ${ref}`);
      for (const occupant of envelope.occupants ?? []) if (occupant.contribution) {
        const contribution = byRef.get(occupant.contribution);
        if (!contribution || !(contribution.envelope.roles ?? []).includes("meeting-contribution")) fail(`${envelope.ref} Occupant ${occupant.id} has unresolved contribution ${occupant.contribution}`);
      }
    }
    for (const ref of envelope.sharedShelves ?? []) if (!byRef.has(ref)) fail(`${envelope.ref} shares unknown Shelf item ${ref}`);
    if (envelope.slot) {
      const slot = input.profile.slots[envelope.slot];
      if (!slot) fail(`${envelope.ref} uses unknown Slot ${envelope.slot}`);
      const accepted = slot.accepts.entities?.includes(envelope.entity) || roles.some((role) => slot.accepts.roles?.includes(role));
      if (!accepted) fail(`${envelope.ref} is not accepted by Slot ${envelope.slot}`);
    }
    for (const [relation, refs] of Object.entries(envelope.relations)) {
      const definition = input.profile.relations[relation];
      if (!definition) fail(`${envelope.ref} uses undeclared Relation ${relation}`);
      if (!definition.from.some((id) => id === envelope.entity || roles.includes(id))) fail(`${envelope.ref} is not a valid source for Relation ${relation}`);
      for (const ref of refs) {
        const target = byRef.get(ref);
        if (!target && definition.external === "forbidden") fail(`${envelope.ref} Relation ${relation} points outside the Instance: ${ref}`);
        if (target && !definition.to.some((id) => id === target.envelope.entity || (target.envelope.roles ?? []).includes(id))) fail(`${envelope.ref} Relation ${relation} has incompatible target ${ref}`);
      }
    }
    const path = locatorFor(source, input.profile);
    const folded = path.toLowerCase();
    if (paths.has(folded)) fail(`Source target collision at ${path}`);
    paths.add(folded);
    const projectionPath = roles.includes("room") ? `rooms/${refId(envelope.ref)}/FRONTDOOR.md`
      : roles.includes("site") ? `sites/${refId(envelope.ref)}/FRONTDOOR.md`
      : envelope.entity === "meeting" ? join(dirname(path), "FRONTDOOR.md").split(sep).join("/")
      : envelope.entity === "work" ? `work/${refId(envelope.ref)}/FRONTDOOR.md`
      : roles.includes("desk") ? `desks/${refId(envelope.ref)}/FRONTDOOR.md`
      : roles.some((role) => input.profile.roles[role]?.entry === "scope") ? `scopes/${envelope.entity}/${refId(envelope.ref)}/FRONTDOOR.md`
      : path;
    return { ref: envelope.ref, entity: envelope.entity, roles, root: source.root ?? "shared", path, projectionPath, revision: source.revision, ...(envelope.lifecycle ? { lifecycle: envelope.lifecycle } : {}) };
  }).sort((a, b) => a.ref.localeCompare(b.ref));
  validateIntegrationProof(input);
  return entries;
}

function validateIntegrationProof(input: CompileInput): void {
  if (!input.profilePackage?.controls.some((clause) => clause.id === "integration-dispatch")) return;
  const works = input.sources.filter((source) => source.envelope.entity === "work" && (source.envelope.relations.targets?.length ?? 0) > 0);
  if (input.entry && works.length > 0) {
    const qualified = new Set((input.provider?.targets ?? []).filter((target) => target.kind === "agent" && target.loadGuarantee === "qualified").map((target) => basename(target.path).replace(/\.md$/, "")));
    if (!qualified.has("manager") || !qualified.has("worker")) fail("Bound integration requires qualified Manager and Worker provider targets; Main fallback is forbidden");
  }
  const meetings = input.sources.filter((source) => source.envelope.entity === "meeting" && ["active", "settling"].includes(String(source.envelope.lifecycle)));
  for (const work of works) {
    const candidates = meetings.filter((candidate) => candidate.envelope.primaryWork === work.envelope.ref
      || candidate.envelope.relatedWorks?.includes(work.envelope.ref)
      || candidate.envelope.relations.advances?.includes(work.envelope.ref));
    const meeting = candidates.find((candidate) => candidate.envelope.occupants?.some((occupant) => occupant.role === "manager")
      && candidate.envelope.occupants?.some((occupant) => occupant.role === "worker"));
    if (!meeting) fail(`${work.envelope.ref} integration has no active Meeting with Manager and Worker proof`);
    const manager = meeting.envelope.occupants?.find((occupant) => occupant.role === "manager");
    const workers = meeting.envelope.occupants?.filter((occupant) => occupant.role === "worker") ?? [];
    if (!manager || workers.length === 0) fail(`${work.envelope.ref} integration requires Manager and Worker Occupants`);
    for (const worker of workers) {
      const dispatch = meeting.envelope.dispatches?.find((item) => item.occupant === worker.id && item.work === work.envelope.ref && ["active", "complete"].includes(item.status));
      if (!dispatch) fail(`${work.envelope.ref} integration has no active complete-envelope dispatch for Worker ${worker.id}`);
    }
    if (["complete", "completed", "awaiting-human-validation"].includes(String(work.envelope.status))) {
      if (workers.some((worker) => !worker.contribution) || meeting.envelope.dispatches?.some((dispatch) => dispatch.work === work.envelope.ref && dispatch.status !== "complete")) {
        fail(`${work.envelope.ref} completion requires complete Worker contributions and dispatches`);
      }
    }
  }
}

type IgnoreRule = { negative: boolean; pattern: string; regex: RegExp };

function globRegex(pattern: string): RegExp {
  const anchored = pattern.startsWith("/");
  const directory = pattern.endsWith("/");
  const source = pattern.replace(/^\//, "").replace(/\/$/, "");
  let body = "";
  for (let index = 0; index < source.length; index++) {
    const char = source[index]!;
    if (char === "*" && source[index + 1] === "*") {
      if (source[index + 2] === "/") {
        body += "(?:.*/)?";
        index += 2;
      } else {
        body += ".*";
        index++;
      }
    } else if (char === "*") body += "[^/]*";
    else if (char === "?") body += "[^/]";
    else body += char.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
  }
  const prefix = anchored || source.includes("/") ? "^" : "(?:^|.*/)";
  return new RegExp(`${prefix}${body}${directory ? "(?:/.*)?" : "(?:$|/.*)"}`);
}

export function parseWorkplaceIgnore(bytes: string): IgnoreRule[] {
  if (new TextEncoder().encode(bytes).byteLength > 64 * 1024) fail(".workplaceignore exceeds 64 KiB");
  const rules: IgnoreRule[] = [];
  for (const [index, raw] of bytes.split(/\r?\n/).entries()) {
    if (raw.includes("\0")) fail(`.workplaceignore line ${index + 1} contains NUL`);
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.length > 512) fail(`.workplaceignore line ${index + 1} exceeds 512 bytes`);
    const negative = line.startsWith("!");
    const pattern = negative ? line.slice(1) : line;
    if (!pattern) fail(`.workplaceignore line ${index + 1} has an empty negation`);
    rules.push({ negative, pattern, regex: globRegex(pattern) });
  }
  return rules;
}

export function isWorkplaceIgnored(rules: IgnoreRule[], path: string): boolean {
  let ignored = false;
  const normalized = path.split(sep).join("/").replace(/^\.\//, "");
  for (const rule of rules) if (rule.regex.test(normalized)) ignored = !rule.negative;
  return ignored;
}

async function markdownFiles(sharedRoot: string, sourceRoot: string, limit: number, rules: IgnoreRule[]): Promise<string[]> {
  const result: string[] = [];
  const visit = async (directory: string, depth: number): Promise<void> => {
    if (depth > 20) fail("Source tree exceeds maximum depth");
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      const sourcePath = relative(sharedRoot, path).split(sep).join("/");
      if (entry.isSymbolicLink()) fail(`Source tree contains symlink: ${path}`);
      if (isWorkplaceIgnored(rules, sourcePath)) continue;
      if (entry.isDirectory() && entry.name !== "methods") await visit(path, depth + 1);
      else if (entry.isFile() && entry.name.endsWith(".md") && !["FRONTDOOR.md", "AGENTS.md", "CLAUDE.md"].includes(entry.name)) result.push(path);
      if (result.length > limit) fail(`Source tree exceeds maximum source count ${limit}`);
    }
  };
  await visit(sourceRoot, 0);
  return result;
}

export async function loadCompileInput(options: {
  profilePath?: string;
  workplacePath: string;
  entryPath?: string;
  providerPath?: string;
  providerPaths?: string[];
}): Promise<CompileInput> {
  const workplacePath = resolve(options.workplacePath);
  const root = dirname(workplacePath);
  const mount = basename(root) === "workplace" ? dirname(root) : root;
  const workplace = await readJson<WorkplaceBuildContract>(workplacePath, "Workplace build contract");
  exactKeys(object(workplace, "Workplace build contract"), WORKPLACE_KEYS, "Workplace build contract");
  exactKeys(object(workplace.profile, "workplace.profile"), SELECTOR_KEYS, "workplace.profile");
  exactKeys(object(workplace.composition, "workplace.composition"), SELECTOR_KEYS, "workplace.composition");
  exactKeys(object(workplace.policy, "workplace.policy"), WORKPLACE_POLICY_KEYS, "workplace.policy");
  for (const [index, target] of workplace.distributionTargets.entries()) {
    exactKeys(object(target, `workplace.distributionTargets[${index}]`), TARGET_KEYS, `workplace.distributionTargets[${index}]`);
  }
  if (workplace.kind !== "WorkplaceBuildContract" || workplace.version !== 2) fail("Unsupported Workplace build contract");
  const selectedProfilePath = resolve(root, options.profilePath ?? workplace.profile.path ?? fail("workplace.json profile.path is required by convention"));
  const selectedProfile = await readJson<Record<string, unknown>>(selectedProfilePath, "Profile selection or Package");
  let profilePackage: LoadedProfilePackage | undefined;
  let profile: Profile;
  if (selectedProfile.kind === "WorkplaceProfilePackage") {
    profilePackage = await loadProfilePackage(selectedProfilePath);
    profile = profilePackage.profile;
  } else if (selectedProfile.kind === "ProfileSelection") {
    exactKeys(object(selectedProfile, "ProfileSelection"), PROFILE_SELECTION_KEYS, "ProfileSelection");
    if (selectedProfile.version !== 1 || typeof selectedProfile.ref !== "string" || typeof selectedProfile.digest !== "string") fail("Unsupported ProfileSelection");
    const packagePath = options.profilePath
      ? resolve(options.profilePath)
      : selectedProfile.ref === "workplace://profiles/endroit-standard"
        ? resolve(import.meta.dir, "../../profiles/standard/profile.json")
        : fail(`Profile Package ${selectedProfile.ref} is unavailable; rerun with --profile <package>`);
    profilePackage = await loadProfilePackage(packagePath);
    if (profilePackage.manifest.ref !== selectedProfile.ref || profilePackage.digest !== selectedProfile.digest) fail(`Profile Package ${selectedProfile.ref} digest diverges; expected ${selectedProfile.digest}, observed ${profilePackage.digest}. Restore the pinned Package or select an explicit derived Profile.`);
    profile = profilePackage.profile;
  } else {
    profile = selectedProfile as Profile;
  }
  validateProfile(profile);
  const selectorIds = new Set(profile.disclosures.selectors.map((selector) => selector.id));
  for (const id of stringArray(workplace.policy.disclosureSelectors, "workplace.policy.disclosureSelectors")) if (!selectorIds.has(id)) fail(`Workplace policy selects unknown disclosure selector ${id}`);
  if (workplace.policy.localBuildIntent !== "bounded-work-and-site") fail("workplace.policy.localBuildIntent is invalid");
  if (workplace.policy.delivery !== "explicit-human-only") fail("workplace.policy.delivery must remain explicit-human-only");
  semanticRef(workplace.workplace, "workplace.json workplace");
  const coordination = parseCoordinationPolicy(await readFile(join(root, "coordination.json"), "utf8"), workplace.workplace);
  if (workplace.profile.ref !== profile.ref) fail(`workplace.json selects ${workplace.profile.ref}, not loaded Profile ${profile.ref}`);
  if (profilePackage && workplace.profile.revision && workplace.profile.revision !== profilePackage.digest) fail(`workplace.json pins Profile Package ${workplace.profile.revision}, observed ${profilePackage.digest}`);
  const composition = await readJson<Composition>(resolve(root, workplace.composition.path ?? "composition.json"), "Composition");
  exactKeys(object(composition, "Composition"), COMPOSITION_KEYS, "Composition");
  if (composition.kind !== "Composition" || composition.ref !== workplace.composition.ref) fail("Composition does not match workplace.json");
  const equipment: Equipment[] = [];
  for (const equipmentRoot of [join(root, "equipment"), resolve(import.meta.dir, "../../equipment")]) {
    try {
      for (const entry of (await readdir(equipmentRoot, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        if (!entry.isDirectory()) continue;
        const item = await readJson<Equipment>(join(equipmentRoot, entry.name, "equipment.json"), `Equipment ${entry.name}`);
        exactKeys(object(item, `Equipment ${entry.name}`), EQUIPMENT_KEYS, `Equipment ${entry.name}`);
        if (item.kind !== "Equipment") fail(`Equipment ${entry.name} has invalid kind`);
        if (!item.compatibleProfiles.includes(profile.id)) continue;
        for (const [methodIndex, method] of item.methods.entries()) {
          const methodSubject = `Equipment ${entry.name}.methods[${methodIndex}]`;
          exactKeys(object(method, methodSubject), METHOD_KEYS, methodSubject);
          if (typeof method.instructions !== "string" || !method.instructions || method.instructions.startsWith("/") || method.instructions.split(/[\\/]/).includes("..")) fail(`${methodSubject}.instructions must be a safe relative path`);
          const instructionsPath = resolve(equipmentRoot, entry.name, method.instructions);
          const instructions = await readFile(instructionsPath, "utf8").catch((error) => fail(`${methodSubject}.instructions is unavailable: ${error instanceof Error ? error.message : String(error)}`));
          item.methods[methodIndex] = { ...method, instructions };
          if (method.coordination && !["read-only", "single-scope", "integration"].includes(method.coordination)) fail(`${methodSubject}.coordination is invalid`);
          if (method.requiredControls) stringArray(method.requiredControls, `${methodSubject}.requiredControls`);
          if (method.context) {
            exactKeys(object(method.context, `${methodSubject}.context`), METHOD_CONTEXT_KEYS, `${methodSubject}.context`);
            stringArray(method.context.requiredReads, `${methodSubject}.context.requiredReads`);
            stringArray(method.context.conditionalReads, `${methodSubject}.context.conditionalReads`);
            stringArray(method.context.forbiddenScopes, `${methodSubject}.context.forbiddenScopes`);
            if (!method.context.searchRoot || !method.context.stopCondition) fail(`${methodSubject}.context needs searchRoot and stopCondition`);
          }
          for (const [operationIndex, operation] of method.operations.entries()) {
            exactKeys(object(operation, `${methodSubject}.operations[${operationIndex}]`), OPERATION_KEYS, `${methodSubject}.operations[${operationIndex}]`);
          }
          for (const [stageIndex, stage] of method.stages.entries()) {
            const stageSubject = `${methodSubject}.stages[${stageIndex}]`;
            exactKeys(object(stage, stageSubject), STAGE_KEYS, stageSubject);
            exactKeys(object(stage.outcome, `${stageSubject}.outcome`), OUTCOME_KEYS, `${stageSubject}.outcome`);
          }
        }
        if (!equipment.some((candidate) => candidate.ref === item.ref)) equipment.push(item);
      }
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("ENOENT")) throw error;
    }
  }
  const installed = new Set(equipment.map((item) => item.ref));
  for (const ref of composition.equipment) if (!installed.has(ref)) fail(`Composition selects missing Equipment ${ref}`);
  const selectedEquipment = new Set(composition.equipment);

  const ignorePath = join(root, ".workplaceignore");
  const ignoreBytes = await readFile(ignorePath, "utf8").catch((error) => {
    if (error instanceof Error && error.message.includes("ENOENT")) return "";
    throw error;
  });
  const ignoreRules = parseWorkplaceIgnore(ignoreBytes);
  const embeddedRoot = workplace.roots.find((id) => profile.roots[id]?.physical === "embedded") ?? fail("Workplace needs one embedded shared Root");
  const sourceRoot = join(root, "sources");
  const paths = await markdownFiles(root, sourceRoot, profile.disclosures.limits.maxSources, ignoreRules);
  const sources: SourceRecord[] = [];
  for (const path of paths) {
    const info = await stat(path);
    if (info.size > profile.disclosures.limits.maxSourceBytes) fail(`${path} exceeds Profile source byte limit`);
    sources.push({
      ...parseSourceEnvelope(await readFile(path, "utf8"), relative(sourceRoot, path).split(sep).join("/")),
      root: embeddedRoot,
      mountPath: relative(mount, path).split(sep).join("/"),
    });
  }
  const entry = options.entryPath ? await readJson<EntryBinding>(resolve(options.entryPath), "EntryBinding") : undefined;
  if (entry) {
    exactKeys(object(entry, "EntryBinding"), ENTRY_KEYS, "EntryBinding");
    if (entry.kind !== "EntryBinding" || entry.workplace !== workplace.workplace) fail("EntryBinding does not target this Workplace");
    semanticRef(entry.member, "EntryBinding.member");
    semanticRef(entry.desk, "EntryBinding.desk");
    const bindings = object(entry.rootBindings, "EntryBinding.rootBindings");
    for (const [rootId, physical] of Object.entries(bindings)) {
      const rootClass = rootId.split(":", 1)[0]!;
      if (!workplace.roots.includes(rootClass)) fail(`EntryBinding binds undeclared Root class ${rootClass}`);
      if (typeof physical !== "string" || physical.length === 0) fail(`EntryBinding Root ${rootId} must be a local path string`);
      if (rootClass === "shared" || rootClass === "site") continue;
      const physicalRoot = resolve(mount, physical);
      const rootPaths = await markdownFiles(physicalRoot, physicalRoot, profile.disclosures.limits.maxSources - sources.length, ignoreRules);
      for (const path of rootPaths) {
        const info = await stat(path);
        if (info.size > profile.disclosures.limits.maxSourceBytes) fail(`${path} exceeds Profile source byte limit`);
        sources.push({
          ...parseSourceEnvelope(await readFile(path, "utf8"), relative(physicalRoot, path).split(sep).join("/")),
          root: rootClass,
          mountPath: relative(mount, path).split(sep).join("/"),
        });
      }
    }
    if (bindings.shared !== "workplace") fail("EntryBinding shared Root must resolve to MountRoot/workplace");
  }
  const providerFiles = [...(options.providerPath ? [options.providerPath] : []), ...(options.providerPaths ?? [])];
  const providers = await Promise.all(providerFiles.map((path) => readJson<ProviderBinding>(resolve(path), `ProviderBinding ${path}`)));
  for (const provider of providers) {
    exactKeys(object(provider, "ProviderBinding"), PROVIDER_KEYS, "ProviderBinding");
    if (provider.kind !== "ProviderBinding" || typeof provider.provider !== "string" || !ID.test(provider.provider)) fail("ProviderBinding has invalid identity");
    for (const [index, target] of provider.targets.entries()) exactKeys(object(target, `ProviderBinding.targets[${index}]`), TARGET_KEYS, `ProviderBinding.targets[${index}]`);
    for (const [index, tool] of provider.tools.entries()) {
      exactKeys(object(tool, `ProviderBinding.tools[${index}]`), TOOL_BINDING_KEYS, `ProviderBinding.tools[${index}]`);
      if (tool.command && (!Array.isArray(tool.command) || tool.command.length === 0 || tool.command.some((part) => typeof part !== "string" || part.length === 0))) fail(`ProviderBinding.tools[${index}].command must be a non-empty string array`);
    }
    const paths = new Set<string>();
    for (const target of provider.targets) {
      if (target.provider !== provider.provider) fail(`ProviderBinding target ${target.path} names another provider`);
      if (!["front-door", "skill", "command", "view", "startup", "agent"].includes(target.kind)) fail(`ProviderBinding target ${target.path} has invalid kind`);
      if (target.path.startsWith("/") || target.path.split("/").includes("..")) fail(`ProviderBinding target ${target.path} is unsafe`);
      if (target.kind === "agent" && !["agents/manager.md", "agents/worker.md"].includes(target.path)) fail(`ProviderBinding Agent target ${target.path} is unsupported`);
      if (paths.has(target.path)) fail(`ProviderBinding has duplicate target ${target.path}`);
      paths.add(target.path);
    }
  }
  const targets = providers.flatMap((provider) => provider.targets);
  const duplicateTarget = targets.find((target) => targets.filter((candidate) => candidate.path === target.path).length > 1 && target.kind !== "agent")?.path;
  if (duplicateTarget) fail(`ProviderBindings conflict at target ${duplicateTarget}`);
  const provider = providers.length === 0 ? undefined : {
    kind: "ProviderBinding" as const,
    provider: providers.map((item) => item.provider).sort().join("+"),
    targets: targets.sort((a, b) => a.path.localeCompare(b.path)),
    tools: providers.flatMap((item) => item.tools),
  };
  const input = {
    root,
    profile,
    ...(profilePackage ? { profilePackage } : {}),
    workplace,
    composition,
    coordination,
    equipment: equipment.filter((item) => selectedEquipment.has(item.ref)).sort((a, b) => a.ref.localeCompare(b.ref)),
    sources,
    ignore: { bytes: ignoreBytes, revision: hash(ignoreBytes) },
    ...(entry ? { entry } : {}),
    ...(provider ? { provider } : {}),
  };
  validateSources(input);
  return input;
}

function relativeLink(from: string, to: string): string {
  const value = relative(dirname(from), to).split(sep).join("/");
  return value.startsWith(".") ? value : `./${value}`;
}

function methodsForPlace(input: CompileInput, subject: SourceRecord): Array<{ method: MethodDefinition; work?: SourceRecord }> {
  const place = subject.envelope.entity === "work"
    ? sourceFor(input, subject.envelope.relations["contained-by"]?.[0] ?? fail(`${subject.envelope.ref} has no containing Place`), "Containing Place")
    : subject;
  const contained = new Set(Object.values(place.envelope.relations).flat());
  const placeRoles = place.envelope.roles ?? [];
  const methods = input.equipment.flatMap((equipment) => equipment.methods);
  const workForms = new Set(methods.flatMap((method) => method.acceptsWorkForms));
  const works = subject.envelope.entity === "work"
    ? [subject]
    : input.sources.filter((source) => (source.envelope.roles ?? []).some((role) => workForms.has(role)) && (source.envelope.scope === place.envelope.ref || contained.has(source.envelope.ref)));
  const result: Array<{ method: MethodDefinition; work?: SourceRecord }> = [];
  if (subject.envelope.entity === "place") for (const method of methods) {
    if (method.acceptsWorkForms.length === 0 && method.requiredPlaceRoles.every((role) => placeRoles.includes(role))) result.push({ method });
  }
  for (const work of works) for (const method of methods) {
    const workRoles = work.envelope.roles ?? [];
    if (method.acceptsWorkForms.some((role) => workRoles.includes(role)) && method.requiredPlaceRoles.every((role) => placeRoles.includes(role))) result.push({ method, work });
  }
  return result.sort((a, b) => a.method.id.localeCompare(b.method.id));
}

function methodsForHall(input: CompileInput): MethodDefinition[] {
  if (!input.entry) return [];
  return input.equipment.flatMap((equipment) => equipment.methods)
    .filter((method) => method.acceptsWorkForms.length === 0 && method.requiredPlaceRoles.includes("hall"))
    .sort((a, b) => a.id.localeCompare(b.id));
}

function methodMarkdown(input: CompileInput, method: MethodDefinition, work: SourceRecord | undefined, methodPath: string, workPath?: string): string {
  const operations = method.operations.map((operation) => `- \`${operation.trait}\` (${operation.effect}, authority: ${operation.authority}) — proof: ${operation.proof.join(", ")}`).join("\n");
  const stages = method.stages.map((stage, index) => `${index + 1}. **${stage.id}** — requires ${stage.outcome.requires.join(", ") || "nothing"}; produces ${stage.outcome.produces.join(", ") || "nothing"}; preserves ${stage.outcome.preserves.join(", ") || "nothing"}; forbids ${stage.outcome.forbids.join(", ") || "nothing"}; evidence ${stage.outcome.evidence.join(", ") || "none"}.`).join("\n");
  const subject = work && workPath
    ? `This method is local to [${work.envelope.ref}](${relativeLink(methodPath, workPath)}).`
    : method.requiredPlaceRoles.includes("hall")
      ? "This method is local to the Hall and opens a Room only when no existing Room matches."
      : "This method opens new owned Work from this Room when no existing Work matches.";
  const traits = new Set(method.operations.map((operation) => operation.trait));
  const bindings = (input.provider?.tools ?? []).filter((tool) => traits.has(tool.trait)).map((tool) =>
    `- \`${tool.trait}\` → ${tool.tool} (${tool.provider ?? "neutral"}, ${tool.availability})${tool.command ? `: ${tool.command.map((part) => JSON.stringify(part)).join(" ")}` : ""}`
  );
  const staticProcedure = `\n${method.instructions.trim()}\n`;
  const sourceContracts = Object.values(input.profilePackage?.sourceContracts ?? {}).filter((contract) => contract.consumers.includes(method.id)).sort((a, b) => a.id.localeCompare(b.id));
  const sourceContractSection = sourceContracts.length
    ? `\n## Source contracts\n\n${sourceContracts.map((contract) => `- [${contract.id}](${relativeLink(methodPath, `workplace/${contract.projectionPath}`)}) — exact template at \`${contract.revision}\`; substitute only: ${contract.variables.map((variable) => `\`${variable}\``).join(", ")}.`).join("\n")}\n`
    : "";
  return `<!-- endroit-projection: local; method: ${method.id} -->\n# ${method.title}\n\n${subject} It is not a resident Skill.\n\n## Affordance state\n\n- installed: yes, selected by Composition\n- visible: yes, disclosed in this scoped Front Door\n- applicable: only when the current Intent satisfies **Use when** and does not satisfy **Avoid when**; visibility alone is insufficient\n- loaded: only after this file is deliberately read\n- executable: static fallback **${method.staticFallback}**; concrete Tool availability remains host-bound\n- authorized: ${method.authority === "none" ? "no additional Authority required" : `requires **${method.authority}** Authority before effect`}\n\n## Use when\n\n${method.useWhen.map((item) => `- ${item}`).join("\n")}\n\n## Avoid when\n\n${(method.avoidWhen ?? []).map((item) => `- ${item}`).join("\n") || "- No additional exclusions."}\n${staticProcedure}${sourceContractSection}\n## Flow and Outcome\n\n${stages}\n\n## Operations\n\n${operations || "- None."}\n\n## Bound Tools\n\n${bindings.join("\n") || "- No concrete Tool is bound; use the complete static fallback or report degraded."}\n\nAuthority: **${method.authority}**. Static fallback: **${method.staticFallback}**.\n`;
}

function topLevelPlaces(input: CompileInput, entries: MapEntry[]): MapEntry[] {
  const scoped = entries.filter((entry) => entry.roles.some((role) => input.profile.roles[role]?.entry === "scope") && input.sources.find((source) => source.envelope.ref === entry.ref)?.envelope.scope === input.workplace.workplace);
  const refs = new Set(scoped.map((entry) => entry.ref));
  const nested = new Set(input.sources.filter((source) => refs.has(source.envelope.ref)).flatMap((source) => Object.values(source.envelope.relations).flat()).filter((ref) => refs.has(ref)));
  return scoped.filter((entry) => !nested.has(entry.ref));
}

function selectorFor(input: CompileInput, id: string, position: FrontDoorIR["position"]) {
  if (!input.workplace.policy.disclosureSelectors.includes(id)) return undefined;
  const selector = input.profile.disclosures.selectors.find((item) => item.id === id);
  if (!selector || !selector.positions.includes(position)) return undefined;
  return selector;
}

function sectionFor(
  input: CompileInput,
  id: string,
  position: FrontDoorIR["position"],
  scope: string,
  title: string,
  body: string,
  sources: SourceRecord[] = [],
  links: Array<{ label: string; path: string; ref?: string }> = [],
): FrontDoorIR["sections"][number] | undefined {
  const selector = selectorFor(input, id, position);
  if (!selector || selector.visibility === "must-hide") return undefined;
  return {
    id,
    title,
    body,
    scope,
    visibility: selector.visibility,
    reasonForDisclosure: selector.reason,
    sources: sources.map((source) => ({ ref: source.envelope.ref, revision: source.revision })),
    links,
  };
}

function renderFrontDoor(ir: FrontDoorIR): string {
  return `<!-- endroit-projection: local; entryStatus: ${ir.entryStatus}; position: ${ir.position} -->\n# ${ir.title}\n\n- Scope: \`${ir.scope}\`\n- Position: **${ir.position}**\n- Entry status: **${ir.entryStatus}**\n\n${ir.sections.map((section) => `<!-- disclosure: ${section.id}; visibility: ${section.visibility}; reason: ${section.reasonForDisclosure}; sources: ${section.sources.map((source) => `${source.ref}@${source.revision}`).join(", ") || "none"} -->\n## ${section.title}\n\n${section.body.trim()}\n`).join("\n")}`;
}

function providerAdapter(provider: "codex" | "claude", frontDoor: string): string {
  return `<!-- endroit-projection: local; provider: ${provider} -->\n${frontDoor.replace(/<!-- disclosure:[^\n]* -->\n/g, "")}`;
}

function residentSection(source: SourceRecord): string {
  const match = /(?:^|\n)## Resident[ \t]*\n([\s\S]*?)(?=\n##[ \t]|$)/.exec(source.body.replace(/\r\n/g, "\n"));
  const body = match?.[1]?.trim();
  if (!body) fail(`${source.relativePath} must contain one non-empty ## Resident section`);
  return body;
}

function coordinationIR(input: CompileInput): CoordinationIR {
  const targets = (input.provider?.targets ?? []).filter((target) => target.kind === "agent").map((target) => ({
    provider: target.provider,
    role: target.path.split("/").at(-1)!.replace(/\.md$/, "") as "manager" | "worker",
    loadGuarantee: target.loadGuarantee,
  })).sort((a, b) => `${a.provider}:${a.role}`.localeCompare(`${b.provider}:${b.role}`));
  const qualified = new Set(targets.filter((target) => target.loadGuarantee === "qualified").map((target) => target.role));
  const status = !input.provider ? "neutral" : qualified.has("manager") && qualified.has("worker") ? "available" : "degraded";
  return {
    kind: "CoordinationIR",
    version: 1,
    workplace: input.workplace.workplace,
    policy: { ref: input.coordination.ref, revision: hash(stable(input.coordination)) },
    roles: input.coordination.roles,
    resolution: input.coordination.resolution,
    dispatchEnvelope: input.coordination.dispatchEnvelope,
    provider: { status, targets, fallback: input.coordination.fallbacks },
  };
}

function coordinationRoleMarkdown(input: CompileInput, role: "manager" | "worker"): string {
  const ir = coordinationIR(input);
  const contract = ir.roles[role];
  return `<!-- endroit-projection: local; coordination-role: ${role} -->
# ${role === "manager" ? "Manager" : "Worker"} coordination contract

- Policy: \`${ir.policy.ref}\` at \`${ir.policy.revision}\`
- Provider status: **${ir.provider.status}**
- Owns: ${contract.owns.join("; ")}
- Never: ${contract.never.join("; ")}

## Dispatch envelope

${ir.dispatchEnvelope.map((field) => `- \`${field}\``).join("\n")}

${role === "manager"
    ? "Integrate disjoint Worker results, own the Git index, run gates and commit through the declared affordance. Never contact the human or infer acceptance or delivery."
    : "Read, mutate and verify only the exclusive scope in the envelope. Return changed paths, proof and blockers. Never commit, dispatch, contact the human or widen scope."}

Missing Authority is blocked. Ambiguity means one question and zero writes. Missing subagents is ${ir.provider.fallback.noSubagents}; inline Worker execution is limited to an explicitly authorized single scope.
`;
}

function sourceFor(input: CompileInput, ref: string, subject: string): SourceRecord {
  return input.sources.find((source) => source.envelope.ref === ref) ?? fail(`${subject} does not resolve: ${ref}`);
}

function facetFor(input: CompileInput, desk: string, role: string, subject: string): SourceRecord {
  const matches = input.sources.filter((source) =>
    (source.envelope.roles ?? []).includes(role)
    && source.envelope.relations["for-desk"]?.includes(desk)
  );
  if (matches.length !== 1) fail(`Desk ${desk} must resolve exactly one ${subject}, observed ${matches.length}`);
  return matches[0]!;
}

function welcomeFor(input: CompileInput, desk: string): SourceRecord {
  return facetFor(input, desk, "welcome", "WELCOME");
}

function memoryFor(input: CompileInput, desk: string): SourceRecord {
  return facetFor(input, desk, "memory-policy", "Memory Policy");
}

function rootFrontDoor(input: CompileInput, entries: MapEntry[]): FrontDoorIR {
  const position = "hall" as const;
  const scope = input.workplace.workplace;
  const places = topLevelPlaces(input, entries);
  const sections: FrontDoorIR["sections"] = [];
  const push = (section: FrontDoorIR["sections"][number] | undefined) => { if (section) sections.push(section); };
  const residentRoleOrder = selectorFor(input, "hall-resident", position)?.roles ?? [];
  const residentSources = input.sources.filter((item) => (item.envelope.roles ?? []).some((role) =>
    input.profile.roles[role]?.projectionResponsibilities?.includes("resident-entry")
  )).sort((a, b) => {
    const rank = (source: SourceRecord) => Math.min(...(source.envelope.roles ?? []).map((role) => {
      const index = residentRoleOrder.indexOf(role);
      return index < 0 ? Number.MAX_SAFE_INTEGER : index;
    }));
    return rank(a) - rank(b) || a.envelope.ref.localeCompare(b.envelope.ref);
  });
  const residentLinks: Array<{ label: string; path: string; ref?: string }> = [];
  const residentBody = residentSources.map((source) => {
    const mapped = entries.find((entry) => entry.ref === source.envelope.ref)!;
    const label = source.envelope.label ?? refId(source.envelope.ref);
    residentLinks.push({ label, path: mapped.path, ref: source.envelope.ref });
    return `### [${label}](${mapped.path})\n\n${residentSection(source)}`;
  }).join("\n\n");
  if (residentSources.length > 0) {
    if (new TextEncoder().encode(residentBody).byteLength > input.profile.disclosures.limits.maxResidentBytes) {
      fail(`Hall resident operating contract exceeds Profile limit of ${input.profile.disclosures.limits.maxResidentBytes} bytes`);
    }
    push(sectionFor(input, "hall-resident", position, scope, "Resident operating contract", residentBody, residentSources, residentLinks));
  }
  const coordination = coordinationIR(input);
  const routeLines = coordination.resolution.map((route) => `  - ${route.id} → ${route.sequence.map((role) => role[0]!.toUpperCase() + role.slice(1)).join(" → ")}`);
  push(sectionFor(input, "hall-navigation", position, scope, "Coordination", [
    "- Before any write, classify the effect path:",
    ...routeLines,
    `  - ambiguous → ${coordination.provider.fallback.ambiguous}`,
    `- Main owns ${coordination.roles.main.owns.join(", ")}.`,
    `- Main never owns ${coordination.roles.main.never.join(", ")}.`,
    `- Provider coordination status: **${coordination.provider.status}**.`,
    "- Every dispatch inherits a resolved `meetingRef`; a subagent never opens another Meeting silently.",
    "- Structural roles load only from a situated Work or Site dispatch; global Skills do not select them.",
    `- Policy: [${coordination.policy.ref}](workplace/coordination.json) at \`${coordination.policy.revision}\`.`,
  ].join("\n"), [], [{ label: "Coordination Policy", path: "workplace/coordination.json", ref: coordination.policy.ref }]));
  const activeMeetings = input.sources.filter((source) => source.envelope.entity === "meeting" && source.envelope.lifecycle === "active");
  push(sectionFor(input, "hall-navigation", position, scope, "Meeting entry", [
    "- Join an explicit Meeting; otherwise resume one unique compatible active Meeting.",
    "- No compatible Meeting remains local and ephemeral until the first durable effect.",
    "- Multiple compatible Meetings mean one question and zero writes.",
    `- Active durable Meetings: ${activeMeetings.map((item) => `\`${item.envelope.ref}\``).join(", ") || "none"}.`,
  ].join("\n"), activeMeetings, activeMeetings.map((item) => {
    const mapped = entries.find((entry) => entry.ref === item.envelope.ref)!;
    return { label: item.envelope.ref, path: mapped.projectionPath, ref: item.envelope.ref };
  })));
  if (input.entry) {
    const member = sourceFor(input, input.entry.member, "Bound Member");
    const desk = sourceFor(input, input.entry.desk, "Bound Desk");
    if (!(desk.envelope.roles ?? []).includes("desk")) fail(`${input.entry.desk} is not a Desk`);
    if (!desk.envelope.relations["owned-by"]?.includes(input.entry.member)) fail(`${input.entry.desk} is not owned by ${input.entry.member}`);
    const welcome = welcomeFor(input, input.entry.desk);
    const memory = memoryFor(input, input.entry.desk);
    const memberEntry = entries.find((entry) => entry.ref === member.envelope.ref)!;
    const deskEntry = entries.find((entry) => entry.ref === desk.envelope.ref)!;
    const welcomeEntry = entries.find((entry) => entry.ref === welcome.envelope.ref)!;
    const memoryEntry = entries.find((entry) => entry.ref === memory.envelope.ref)!;
    const otherMembers = input.sources.filter((source) => source.envelope.entity === "member" && source.envelope.ref !== member.envelope.ref);
    const admittedDesks = input.sources.filter((source) => (source.envelope.roles ?? []).includes("desk") && source.envelope.ref !== desk.envelope.ref && source.envelope.relations.admits?.includes(member.envelope.ref));
    const card = [
      `- Bound Member: [${member.envelope.label ?? refId(member.envelope.ref)}](${memberEntry.path}) (\`${member.envelope.ref}\`)`,
      `- Bound Desk: [${desk.envelope.label ?? refId(desk.envelope.ref)}](${deskEntry.path}) (\`${desk.envelope.ref}\`)`,
      `- Language: ${member.envelope.language ?? "not declared"}`,
      `- Member revision: \`${member.revision}\``,
      `- Desk revision: \`${desk.revision}\``,
      `- WELCOME revision: \`${welcome.revision}\``,
      ...(member.envelope.responsibilities?.map((item) => `- Responsibility: ${item}`) ?? []),
      ...(member.envelope.authorityLimits?.map((item) => `- Authority limit: ${item}`) ?? []),
      ...(member.envelope.durableChanges?.map((item) => `- Durable changes: ${item}`) ?? []),
    ].join("\n");
    push(sectionFor(input, "hall-bound", position, scope, "Reception · bound Member Card", card, [member, desk, welcome], [
      { label: "Member", path: memberEntry.path, ref: member.envelope.ref },
      { label: "Desk", path: deskEntry.path, ref: desk.envelope.ref },
      { label: "WELCOME", path: welcomeEntry.path, ref: welcome.envelope.ref },
    ]));
    push(sectionFor(input, "hall-bound", position, scope, "Welcome from the bound Desk", welcome.body, [welcome], [{ label: "WELCOME", path: welcomeEntry.path, ref: welcome.envelope.ref }]));
    push(sectionFor(input, "hall-bound", position, scope, "Desk Memory Policy", `${memory.envelope.summary}\n\n- Source: [${memory.envelope.ref}](${memoryEntry.path})\n- Revision: \`${memory.revision}\`\n- Provider memory is disposable cache and never canonical.`, [memory], [{ label: "Memory Policy", path: memoryEntry.path, ref: memory.envelope.ref }]));
    push(sectionFor(input, "hall-bound", position, scope, "Member directory", otherMembers.map((item) => {
      const mapped = entries.find((entry) => entry.ref === item.envelope.ref)!;
      return `- [${item.envelope.label ?? refId(item.envelope.ref)}](${mapped.path}) — ${(item.envelope.roles ?? []).join(", ")}`;
    }).join("\n") || "- No other Member is listed.", [member, ...otherMembers]));
    push(sectionFor(input, "hall-bound", position, scope, "Keyring", admittedDesks.map((item) => {
      const mapped = entries.find((entry) => entry.ref === item.envelope.ref)!;
      const targetWelcome = welcomeFor(input, item.envelope.ref);
      const targetWelcomeEntry = entries.find((entry) => entry.ref === targetWelcome.envelope.ref)!;
      const shared = (item.envelope.sharedShelves ?? []).map((ref) => {
        const sharedEntry = entries.find((entry) => entry.ref === ref)!;
        return `[${ref}](${sharedEntry.path})`;
      });
      return `- Key to [${item.envelope.label ?? refId(item.envelope.ref)}](${mapped.path}): [declared WELCOME](${targetWelcomeEntry.path})${shared.length > 0 ? `; shared Shelves: ${shared.join(", ")}` : ""}; discovery/read only, no filesystem access, mutation, Mandate or Authority.`;
    }).join("\n") || "- No additional Desk admits this Member.", admittedDesks));
  } else {
    push(sectionFor(input, "hall-bound", position, scope, "Reception", "No EntryBinding is present. No identity is inferred. Run adoption before personalized or durable action."));
  }
  const skillTargets = applicableAffordances(input).map(({ contract }) => `.agents/skills/${contract.id}/SKILL.md`).filter((path) => selectedTarget(input, path, "skill"));
  push(sectionFor(input, "hall-navigation", position, scope, "Resident capabilities", skillTargets.length > 0
    ? `${skillTargets.map((path) => `- [${basename(dirname(path))}](${path}) — explicitly selected by ProviderBinding.`).join("\n")}\n- Global provider Skills not listed here grant no Authority.`
    : "- No provider Skill is resident. Use Front Door links and explicit Commands."));
  const hallMethods = methodsForHall(input);
  push(sectionFor(input, "hall-navigation", position, scope, "Hall methods", hallMethods.map((method) =>
    `- [${method.title}](methods/${method.id}.md) — load only when intent matches: ${method.intent.join(", ")}.`
  ).join("\n") || "- No Hall method is installed.", [], hallMethods.map((method) => ({ label: method.title, path: `methods/${method.id}.md` }))));
  push(sectionFor(input, "hall-navigation", position, scope, "Places", places.map((entry) => `- [${entry.ref}](${entry.projectionPath}) — ${input.sources.find((source) => source.envelope.ref === entry.ref)?.envelope.summary ?? ""}`).join("\n") || "- No enterable Place is declared.", [], places.map((entry) => ({ label: entry.ref, path: entry.projectionPath, ref: entry.ref }))));
  return { scope, position, entryStatus: input.entry ? "bound" : "onboarding-required", title: "Static Workplace Front Door", sections };
}

function scopedFrontDoor(input: CompileInput, source: SourceRecord, entry: MapEntry, entries: MapEntry[]): FrontDoorIR {
  const roles = source.envelope.roles ?? [];
  const position: FrontDoorIR["position"] = source.envelope.entity === "meeting" ? "meeting" : source.envelope.entity === "work" ? "work" : roles.includes("site") ? "site" : "place";
  const selectorId = position === "meeting" ? "meeting-contract" : position === "work" ? "work-contract" : position === "site" ? "site-boundary" : "place-local";
  const scope = source.envelope.ref;
  const destinations = Object.values(source.envelope.relations).flat().map((ref) => entries.find((candidate) => candidate.ref === ref)).filter((value): value is MapEntry => Boolean(value));
  const methods = methodsForPlace(input, source);
  const links = destinations.map((destination) => ({
    label: destination.ref,
    path: relativeLink(entry.projectionPath, destination.projectionPath.endsWith("FRONTDOOR.md") ? destination.projectionPath : destination.path),
    ref: destination.ref,
  }));
  const methodLines = methods.map(({ method, work }) => {
    const suffix = work ? ` for [${work.envelope.summary}](${relativeLink(entry.projectionPath, entries.find((candidate) => candidate.ref === work.envelope.ref)?.projectionPath ?? "")})` : " for opening new owned Work";
    return `- [${method.title}](${relativeLink(entry.projectionPath, join(dirname(entry.projectionPath), `methods/${method.id}.md`))})${suffix} — load only when intent matches: ${method.intent.join(", ")}.`;
  });
  const sections: FrontDoorIR["sections"] = [];
  const push = (section: FrontDoorIR["sections"][number] | undefined) => { if (section) sections.push(section); };
  push(sectionFor(input, selectorId, position, scope, "Situation", `${source.envelope.summary}\n\n- Source: [${source.envelope.ref}](${relativeLink(entry.projectionPath, entry.path)})\n- Revision: \`${source.revision}\`\n- Owner: \`${source.envelope.owner}\`\n- Parent scope: \`${source.envelope.scope}\``, [source], [{ label: "Owned source", path: relativeLink(entry.projectionPath, entry.path), ref: source.envelope.ref }]));
  push(sectionFor(input, selectorId, position, scope, "Boundaries", "- Follow a link before loading a child contract.\n- Visibility and Tool availability grant no Authority.\n- Local build authority never includes acceptance, hosting, publication or delivery."));
  const coordination = coordinationIR(input);
  if (position === "work") {
    const path = relativeLink(entry.projectionPath, "agents/manager.md");
    const route = coordination.resolution.find((item) => item.when.integration)?.sequence.map((role) => role[0]!.toUpperCase() + role.slice(1)).join(" → ") ?? "unresolved";
    push(sectionFor(input, selectorId, position, scope, "Situated coordination", `- Integration route: ${route}.\n- Load [Manager contract](${path}) only when this Work requires integration or multiple Roots/effects.\n- Provider status: **${coordination.provider.status}**; fallback: **${coordination.provider.fallback.noSubagents}**.`, [source], [{ label: "Manager contract", path }]));
  }
  if (position === "meeting") {
    const related = [...new Set([source.envelope.primaryWork, ...(source.envelope.relatedWorks ?? [])].filter((ref): ref is string => Boolean(ref)))];
    const occupantLines = (source.envelope.occupants ?? []).map((occupant) => `- ${occupant.id}: ${occupant.role}${occupant.contribution ? `; contribution \`${occupant.contribution}\`` : ""}`);
    push(sectionFor(input, selectorId, position, scope, "Meeting contract", [
      `- Lifecycle: ${source.envelope.lifecycle}`,
      `- Intent: ${source.envelope.intent}`,
      `- Work: ${related.join(", ") || "none"}`,
      `- Next boundary: ${source.envelope.nextBoundary}`,
      `- Disposition: ${source.envelope.disposition ?? "pending"}`,
      "- Occupants:",
      ...(occupantLines.length > 0 ? occupantLines : ["  - none"]),
      "- Closing this Meeting never completes its Work.",
    ].join("\n"), [source], related.map((ref) => {
      const target = entries.find((candidate) => candidate.ref === ref);
      return { label: ref, path: target ? relativeLink(entry.projectionPath, target.projectionPath) : ref, ref };
    })));
  }
  if (position === "site") {
    const path = relativeLink(entry.projectionPath, "agents/worker.md");
    push(sectionFor(input, selectorId, position, scope, "Situated coordination", `- A Worker may enter only through a complete dispatch envelope and one exclusive scope.\n- [Worker contract](${path}) forbids ${coordination.roles.worker.never.join(", ")}.\n- Provider status: **${coordination.provider.status}**.`, [source], [{ label: "Worker contract", path }]));
  }
  push(sectionFor(input, selectorId, position, scope, "Local destinations", links.map((link) => `- [${link.label}](${link.path})`).join("\n") || "- None.", destinations.map((destination) => sourceFor(input, destination.ref, "Destination")), links));
  if (position === "place") push(sectionFor(input, selectorId, position, scope, "Candidate local methods", methodLines.join("\n") || "- None for the current authored Work."));
  if (position === "work") {
    const supporting = source.envelope.relations["supported-by"]?.map((ref) => sourceFor(input, ref, "Work source")) ?? [];
    const sites = source.envelope.relations.targets?.map((ref) => entries.find((candidate) => candidate.ref === ref)!).filter(Boolean) ?? [];
    push(sectionFor(input, selectorId, position, scope, "Work contract", [
      `- Status: ${source.envelope.status ?? "not declared"}`,
      `- Required sources and Decisions: ${supporting.map((item) => `[${item.envelope.ref}](${relativeLink(entry.projectionPath, entries.find((candidate) => candidate.ref === item.envelope.ref)!.path)})`).join(", ") || "none declared"}`,
      `- Site: ${sites.map((item) => `[${item.ref}](${relativeLink(entry.projectionPath, item.projectionPath)})`).join(", ") || "none declared"}`,
      `- Verification: ${(source.envelope.verification ?? []).join("; ") || "not declared"}`,
      `- Outcome: ${(source.envelope.outcomes ?? []).join("; ") || "not declared"}`,
    ].join("\n"), [source, ...supporting], sites.map((item) => ({ label: item.ref, path: relativeLink(entry.projectionPath, item.projectionPath), ref: item.ref }))));
    push(sectionFor(input, selectorId, position, scope, "Applicable method", methodLines.join("\n") || "- No method matches this Work."));
  }
  const siteRoot = position === "site" && input.entry
    ? input.entry.rootBindings[`site:${refId(source.envelope.ref)}`] ?? input.entry.rootBindings.site
    : undefined;
  if (siteRoot) {
    const linksToSite = [
      { label: "README", path: relativeLink(entry.projectionPath, `${siteRoot}/README.md`) },
      { label: "Technical specification", path: relativeLink(entry.projectionPath, `${siteRoot}/SPEC.md`) },
      { label: "Contribution contract", path: relativeLink(entry.projectionPath, `${siteRoot}/CONTRIBUTING.md`) },
    ];
    push(sectionFor(input, selectorId, position, scope, "Sovereign Site", `${linksToSite.map((link) => `- [${link.label}](${link.path})`).join("\n")}\n- The checkout is the only legitimate product destination.\n- These links grant no acceptance, hosting, publication or delivery consent.`, [source], linksToSite));
  }
  return { scope, position, entryStatus: input.entry ? "bound" : "onboarding-required", title: source.envelope.label ?? "Scoped Front Door", sections };
}

function profileView(profile: Profile): string {
  return `# ${profile.id} Profile\n\nEntity families: ${Object.keys(profile.entities).sort().map((id) => `\`${id}\``).join(", ")}.\n\n## Closed Roles\n\n${Object.entries(profile.roles).sort(([a], [b]) => a.localeCompare(b)).map(([id, role]) => `- \`${id}\` — ${role.mode}, target ${role.target.kind}`).join("\n")}\n\n## Slots\n\n${Object.entries(profile.slots).sort(([a], [b]) => a.localeCompare(b)).map(([id, slot]) => `- \`${id}\` — ${slot.cardinality}, ${slot.visibility}, locator \`${slot.locator}\``).join("\n")}\n`;
}

function compositionView(composition: Composition, equipment: Equipment[]): string {
  const selected = composition.equipment.map((ref) => {
    const item = equipment.find((candidate) => candidate.ref === ref);
    return `- \`${ref}\` — methods: ${item?.methods.map((method) => method.id).join(", ") || "none"}`;
  }).join("\n");
  return `# Composition\n\n${selected || "- No Equipment selected."}\n`;
}

function applicableAffordances(input: CompileInput) {
  if (!input.profilePackage) return [];
  const activeMeeting = input.sources.some((source) => source.envelope.entity === "meeting" && source.envelope.lifecycle === "active");
  return Object.values(input.profilePackage.affordances).filter(({ contract }) =>
    contract.applicability === "onboarding-required" ? !input.entry
      : contract.applicability === "bound" ? Boolean(input.entry)
        : Boolean(input.entry) && activeMeeting
  ).sort((a, b) => a.contract.id.localeCompare(b.contract.id));
}

function lexiconMarkdown(input: CompileInput): string {
  const terms = input.profilePackage?.lexicon ?? {};
  return `<!-- endroit-projection: portable -->\n# Lexicon\n\n${Object.entries(terms).sort(([a], [b]) => a.localeCompare(b)).map(([id, term]) => `- **${term.label}** (\`${id}\`) — ${term.definition}${term.aliases.length ? ` Aliases: ${term.aliases.join(", ")}.` : ""}`).join("\n") || "- No Profile Lexicon is declared."}\n`;
}

function definitionIR(input: CompileInput, entries: MapEntry[]) {
  const profilePackage = input.profilePackage;
  return {
    kind: "WorkplaceDefinition",
    version: 1,
    workplace: input.workplace.workplace,
    profile: profilePackage ? { ref: profilePackage.manifest.ref, digest: profilePackage.digest, release: profilePackage.manifest.release } : { ref: input.profile.ref, digest: hash(stable(input.profile)), legacy: true },
    grammar: { ref: input.profile.ref, revision: hash(stable(input.profile)) },
    lexicon: profilePackage ? { terms: Object.keys(profilePackage.lexicon).sort(), revision: hash(stable(profilePackage.lexicon)) } : null,
    responsibilities: profilePackage?.responsibilities ?? [],
    equipment: input.equipment.map((item) => ({ ref: item.ref, revision: hash(stable(item)), methods: item.methods.map((method) => method.id) })),
    affordances: Object.values(profilePackage?.affordances ?? {}).map(({ contract, revision }) => ({ id: contract.id, revision, positions: contract.positions, applicability: contract.applicability, authority: contract.authority, providerTargets: contract.providerTargets })),
    sourceContracts: Object.values(profilePackage?.sourceContracts ?? {}).sort((a, b) => a.id.localeCompare(b.id)).map((contract) => ({ id: contract.id, source: { profile: profilePackage?.manifest.ref ?? input.profile.ref, path: contract.sourcePath }, projection: `workplace/${contract.projectionPath}`, variables: contract.variables, consumers: contract.consumers, maxBytes: contract.maxBytes, templateRevision: contract.templateRevision, revision: contract.revision })),
    providers: input.workplace.distributionTargets,
    sources: entries.filter((entry) => entry.path.startsWith("workplace/")).map((entry) => ({ ref: entry.ref, revision: entry.revision, root: entry.root, path: entry.path })),
    controls: profilePackage?.controls ?? [],
  };
}

function contextContracts(input: CompileInput) {
  return {
    kind: "ContextContracts",
    version: 1,
    workplace: input.workplace.workplace,
    methods: input.equipment.flatMap((equipment) => equipment.methods.map((method) => ({
      id: method.id,
      equipment: equipment.ref,
      coordination: method.coordination ?? "read-only",
      requiredControls: method.requiredControls ?? [],
      requiredReads: method.context?.requiredReads ?? [],
      conditionalReads: method.context?.conditionalReads ?? [],
      forbiddenScopes: method.context?.forbiddenScopes ?? [],
      searchRoot: method.context?.searchRoot ?? "declared scope",
      stopCondition: method.context?.stopCondition ?? "method Outcome is observed",
      evidence: method.proof,
    }))),
  };
}

function workplaceManifest(input: CompileInput, entries: MapEntry[]): string {
  const rooms = topLevelPlaces(input, entries);
  return `<!-- endroit-projection: portable -->\n# Static Workplace\n\n- Identity: \`${input.workplace.workplace}\`\n- Profile: \`${input.profile.ref}\`\n\nThis shared Root is a compiled, dependency-free Workplace distribution. Open its Mount for a provider-bound entry; owned Markdown here remains canonical.\n\n## Floor Plan\n\n${rooms.map((entry) => `- [${entry.ref}](${entry.path.replace(/^workplace\//, "")})`).join("\n") || "- No Room is declared."}\n\n## Control plane\n\n- [Definition](.workplace/definition.json)\n- [Lexicon](LEXICON.md)\n- [Profile](.workplace/views/PROFILE.md)\n- [Composition](.workplace/views/COMPOSITION.md)\n- [Workplace map](.workplace/workplace-map.json)\n`;
}

async function writeTree(root: string, files: Map<string, string>): Promise<void> {
  for (const [path, content] of [...files.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, { flag: "wx" });
  }
}

const IGNORE_CONTRACT = [
  "/.endroit/",
  "/.agents/",
  "/FRONTDOOR.md",
  "/AGENTS.md",
  "/CLAUDE.md",
  "/MEMORY.md",
  "/rooms/",
  "/work/",
  "/sites/",
  "/desks/",
  "/scopes/",
  "/methods/",
  "/agents/",
] as const;

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && error.message.includes("ENOENT")) return false;
    throw error;
  }
}

async function requireIgnoreContract(root: string): Promise<void> {
  const path = join(root, ".gitignore");
  const lines = new Set((await readFile(path, "utf8").catch(() => "")).split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
  const missing = IGNORE_CONTRACT.filter((line) => !lines.has(line));
  if (missing.length > 0) fail(`Local projection ignore contract is missing: ${missing.join(", ")}. Adopt the Workplace and install these exact rules before compilation.`);
}

function isLocalProjection(path: string): boolean {
  return path === "FRONTDOOR.md"
    || path === "AGENTS.md"
    || path === "CLAUDE.md"
    || path === "MEMORY.md"
    || path.startsWith(".agents/")
    || path.startsWith("rooms/")
    || path.startsWith("work/")
    || path.startsWith("sites/")
    || path.startsWith("desks/")
    || path.startsWith("scopes/")
    || path.startsWith("methods/")
    || path.startsWith("agents/")
    || /\/(?:FRONTDOOR|AGENTS|CLAUDE)\.md$/.test(path)
    || /\/methods\/[^/]+\.md$/.test(path);
}

async function atomicWrite(root: string, path: string, content: string): Promise<void> {
  const target = join(root, path);
  if (await exists(target) && await readFile(target, "utf8") === content) return;
  await mkdir(dirname(target), { recursive: true });
  const temp = `${target}.tmp-${process.pid}-${crypto.randomUUID()}`;
  await writeFile(temp, content, { flag: "wx" });
  await rename(temp, target);
}

async function providerPathsFor(mount: string, provider?: string): Promise<string[]> {
  if (provider) {
    const path = join(mount, `.endroit/providers/${provider}.json`);
    if (!await exists(path)) fail(`ProviderBinding is unavailable at ${path}`);
    return [path];
  }
  const entries = await readdir(join(mount, ".endroit/providers"), { withFileTypes: true }).catch((error) =>
    error instanceof Error && error.message.includes("ENOENT") ? [] : Promise.reject(error)
  );
  const candidates = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json")).map((entry) => entry.name).sort();
  return candidates.map((candidate) => join(mount, ".endroit/providers", candidate));
}

export async function compileWorkplaceMount(options: { mount: string; entryPath?: string; provider?: string; profilePath?: string }): Promise<CompileResult> {
  const root = resolve(options.mount);
  await requireIgnoreContract(root);
  const conventionalEntry = join(root, ".endroit/entry.json");
  const entryPath = options.entryPath ? resolve(root, options.entryPath) : await exists(conventionalEntry) ? conventionalEntry : undefined;
  const providerPaths = await providerPathsFor(root, options.provider);
  const input = await loadCompileInput({
    workplacePath: join(root, "workplace/workplace.json"),
    ...(options.profilePath ? { profilePath: options.profilePath } : {}),
    ...(entryPath ? { entryPath } : {}),
    ...(providerPaths.length > 0 ? { providerPaths } : {}),
  });
  const temp = join(dirname(root), `.${basename(root)}.compile-${process.pid}-${crypto.randomUUID()}`);
  const compiled = await compileStaticWorkplace(input, { outDir: temp, ownedSourcePrefix: "sources" });
  try {
    const previousLocal = await readJson<{ files: Array<{ path: string }> }>(join(root, ".endroit/projection-manifest.json"), "Previous local projection manifest").catch(() => ({ files: [] }));
    const previouslyOwned = new Set(previousLocal.files.map((item) => item.path));
    const selected = new Map<string, string>();
    for (const path of compiled.files) {
      const portable = ["workplace/WORKPLACE.md", "workplace/LEXICON.md"].includes(path) || path.startsWith("workplace/.workplace/");
      if (!portable && !isLocalProjection(path) && !path.startsWith(".endroit/")) continue;
      selected.set(path, await readFile(join(temp, path), "utf8"));
    }
    for (const [path, content] of selected) {
      if (!await exists(join(root, path))) continue;
      const existing = await readFile(join(root, path), "utf8");
      if (path === "workplace/WORKPLACE.md" && !existing.includes("endroit-projection: portable")) {
        fail("Refusing non-owned projection collision at workplace/WORKPLACE.md");
      }
      if (path === "workplace/LEXICON.md" && !existing.includes("endroit-projection: portable")) {
        fail("Refusing non-owned projection collision at workplace/LEXICON.md");
      }
      if (isLocalProjection(path) && !previouslyOwned.has(path) && !existing.includes("endroit-projection: local")) {
        fail(`Refusing non-owned projection collision at ${path}`);
      }
    }

    const federationModule = await import("../federation.ts");
    const federation = await federationModule.federationProjection(root);
    if (federation.present) {
      const adjacent = federationModule.renderAdjacentWorkplaces(federation.registry);
      if (adjacent) for (const path of ["FRONTDOOR.md", "AGENTS.md", "CLAUDE.md"]) {
        const content = selected.get(path);
        if (content) selected.set(path, `${content.trimEnd()}\n\n${adjacent}`);
      }
    }

    const portableManifestPath = "workplace/.workplace/projection-manifest.json";
    const portableManifest = JSON.parse(selected.get(portableManifestPath) ?? fail("Compiled portable manifest is missing")) as {
      files: Array<{ path: string; digest: Revision }>;
      [key: string]: unknown;
    };
    portableManifest.files = [...selected.entries()]
      .filter(([path]) => path !== portableManifestPath && path.startsWith("workplace/"))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([path, content]) => ({ path, digest: hash(content) }));
    selected.set(portableManifestPath, stable(portableManifest));

    const localManifestPath = ".endroit/projection-manifest.json";
    const localManifest = JSON.parse(selected.get(localManifestPath) ?? fail("Compiled local manifest is missing")) as {
      files: Array<{ path: string; digest: Revision }>;
      federationRevision?: string;
      [key: string]: unknown;
    };
    if (federation.revision) localManifest.federationRevision = federation.revision;
    else delete localManifest.federationRevision;
    localManifest.files = [...selected.entries()]
      .filter(([path]) => isLocalProjection(path) || (path.startsWith(".endroit/") && path !== localManifestPath))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([path, content]) => ({ path, digest: hash(content) }));
    selected.set(localManifestPath, stable(localManifest));

    for (const [path, content] of [...selected.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      await atomicWrite(root, path, content);
    }
    const current = new Set(localManifest.files.map((item) => item.path));
    for (const item of previousLocal.files) {
      if (!current.has(item.path)) await rm(join(root, item.path), { force: true, recursive: false });
    }
    return { ...compiled, root, files: [...selected.keys()].sort() };
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

export async function discoverMount(start: string): Promise<string | undefined> {
  let cursor = resolve(start);
  while (true) {
    if (await exists(join(cursor, "workplace/workplace.json"))) return cursor;
    if (basename(cursor) === "workplace" && await exists(join(cursor, "workplace.json"))) return dirname(cursor);
    const parent = dirname(cursor);
    if (parent === cursor) return undefined;
    cursor = parent;
  }
}

function selectedTarget(input: CompileInput, path: string, kind?: string, qualified = false): boolean {
  return input.provider?.targets.some((target) => target.path === path && (!kind || target.kind === kind) && (!qualified || target.loadGuarantee === "qualified")) ?? false;
}

function providerMemory(input: CompileInput): string {
  if (!input.entry) fail("Provider memory requires a bound Desk");
  const memory = memoryFor(input, input.entry.desk);
  return `<!-- endroit-projection: local; provider-memory: cache-policy -->\n# Desk memory policy\n\n${memory.envelope.summary}\n\n- Canonical source: [${memory.envelope.ref}](${memory.mountPath ?? memory.relativePath})\n- Source revision: \`${memory.revision}\`\n- Provider memory is disposable cache. It never owns Workplace, Desk, Work or acceptance truth.\n`;
}

function disclosureContract(input: CompileInput, doors: FrontDoorIR[]) {
  return {
    kind: "DisclosureContract",
    version: 1,
    workplace: input.workplace.workplace,
    positions: doors.map((door) => ({
      scope: door.scope,
      position: door.position,
      mustShow: door.sections.filter((section) => section.visibility === "must-show").map((section) => section.id),
      mayShow: door.sections.filter((section) => section.visibility === "may-show").map((section) => section.id),
      mustHide: input.profile.disclosures.selectors.filter((selector) => selector.positions.includes(door.position) && selector.visibility === "must-hide").map((selector) => selector.id),
      requiredLinks: [...new Set(door.sections.flatMap((section) => section.links.map((link) => link.path)))].sort(),
      sourceRevisions: [...new Map(door.sections.flatMap((section) => section.sources).map((source) => [source.ref, source])).values()].sort((a, b) => a.ref.localeCompare(b.ref)),
      controls: (input.profilePackage?.controls ?? []).filter((clause) => clause.positions.includes(door.position)).map((clause) => ({ id: clause.id, placement: clause.placement, trigger: clause.trigger, criticality: clause.criticality, reasonForDisclosure: clause.reasonForDisclosure, requiredEvidence: clause.requiredEvidence, enforcement: clause.enforcement })),
    })),
  };
}

function sourceRevision(input: CompileInput): Revision {
  return hash([...input.sources.filter((source) => source.mountPath?.startsWith("workplace/")).map((source) => `${source.envelope.ref}:${source.revision}`), ...input.equipment.map((item) => `${item.ref}:${hash(stable(item))}`), `${input.coordination.ref}:${hash(stable(input.coordination))}`, `profile:${input.profilePackage?.digest ?? hash(stable(input.profile))}`, `.workplaceignore:${input.ignore.revision}`].sort().join("\n"));
}

function entryDependencies(input: CompileInput): Array<{ ref: string; revision: Revision }> {
  if (!input.entry) return [];
  const admittedDeskRefs = new Set(input.sources.filter((source) =>
    (source.envelope.roles ?? []).includes("desk") && source.envelope.relations.admits?.includes(input.entry!.member)
  ).map((source) => source.envelope.ref));
  return input.sources.filter((source) => {
    if (source.envelope.ref === input.entry!.member || source.envelope.ref === input.entry!.desk) return true;
    if (source.envelope.entity === "member") return true;
    if ((source.envelope.roles ?? []).includes("welcome") && source.envelope.relations["for-desk"]?.includes(input.entry!.desk)) return true;
    if ((source.envelope.roles ?? []).includes("memory-policy") && source.envelope.relations["for-desk"]?.includes(input.entry!.desk)) return true;
    if ((source.envelope.roles ?? []).includes("desk") && source.envelope.relations.admits?.includes(input.entry!.member)) return true;
    return (source.envelope.roles ?? []).includes("welcome") && source.envelope.relations["for-desk"]?.some((ref) => admittedDeskRefs.has(ref));
  }).map((source) => ({ ref: source.envelope.ref, revision: source.revision })).sort((a, b) => a.ref.localeCompare(b.ref));
}

export async function compileStaticWorkplace(input: CompileInput, options: { outDir: string; ownedSourcePrefix?: string }): Promise<CompileResult> {
  const outDir = resolve(options.outDir);
  try {
    await stat(outDir);
    fail(`Output target already exists: ${outDir}`);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("ENOENT")) throw error;
  }
  const entries = validateSources(input).map((entry) => {
    const source = input.sources.find((item) => item.envelope.ref === entry.ref)!;
    return { ...entry, path: source.mountPath ?? join("workplace", options.ownedSourcePrefix ?? "sources", source.relativePath).split(sep).join("/") };
  });
  const byRef = new Map(entries.map((entry) => [entry.ref, entry]));
  const files = new Map<string, string>();
  files.set("workplace/.workplace/profile.json", stable(input.profilePackage ? { kind: "ResolvedProfilePackage", ref: input.profilePackage.manifest.ref, digest: input.profilePackage.digest, release: input.profilePackage.manifest.release } : input.profile));
  files.set("workplace/.workplace/composition.json", stable(input.composition));
  files.set("workplace/.workplace/coordination.json", stable(input.coordination));
  files.set("workplace/.workplace/definition.json", stable(definitionIR(input, entries)));
  files.set("workplace/.workplace/lexicon.json", stable({ kind: "LexiconIR", version: 1, workplace: input.workplace.workplace, profile: input.profilePackage ? { ref: input.profilePackage.manifest.ref, digest: input.profilePackage.digest } : { ref: input.profile.ref, digest: hash(stable(input.profile)) }, terms: input.profilePackage?.lexicon ?? {} }));
  for (const contract of Object.values(input.profilePackage?.sourceContracts ?? {}).sort((a, b) => a.id.localeCompare(b.id))) files.set(`workplace/${contract.projectionPath}`, contract.template.endsWith("\n") ? contract.template : `${contract.template}\n`);
  files.set("workplace/LEXICON.md", lexiconMarkdown(input));
  files.set("workplace/.workplace/views/PROFILE.md", profileView(input.profile));
  files.set("workplace/.workplace/views/COMPOSITION.md", compositionView(input.composition, input.equipment));
  files.set("workplace/WORKPLACE.md", workplaceManifest(input, entries.filter((entry) => entry.path.startsWith("workplace/"))));
  const doors: FrontDoorIR[] = [rootFrontDoor(input, entries)];
  const coordination = coordinationIR(input);
  const rootDoor = renderFrontDoor(doors[0]!);
  files.set("FRONTDOOR.md", rootDoor);
  files.set("agents/manager.md", coordinationRoleMarkdown(input, "manager"));
  files.set("agents/worker.md", coordinationRoleMarkdown(input, "worker"));
  for (const method of methodsForHall(input)) files.set(`methods/${method.id}.md`, methodMarkdown(input, method, undefined, `methods/${method.id}.md`));
  if (selectedTarget(input, "AGENTS.md", "front-door")) files.set("AGENTS.md", providerAdapter("codex", rootDoor));
  if (selectedTarget(input, "CLAUDE.md", "front-door")) files.set("CLAUDE.md", providerAdapter("claude", rootDoor));
  if (selectedTarget(input, "MEMORY.md", undefined, true) && input.entry) files.set("MEMORY.md", providerMemory(input));
  for (const affordance of applicableAffordances(input)) {
    const path = `.agents/skills/${affordance.contract.id}/SKILL.md`;
    if (selectedTarget(input, path, "skill")) files.set(path, affordance.instructions.endsWith("\n") ? affordance.instructions : `${affordance.instructions}\n`);
  }

  for (const source of input.sources) {
    const entry = byRef.get(source.envelope.ref)!;
    files.set(entry.path, source.bytes);
    if ((source.envelope.roles ?? []).some((role) => input.profile.roles[role]?.entry === "scope")) {
      const ir = scopedFrontDoor(input, source, entry, entries);
      doors.push(ir);
      const scopedDoor = renderFrontDoor(ir);
      const scopedPath = entry.projectionPath;
      files.set(scopedPath, scopedDoor);
      if (selectedTarget(input, "AGENTS.md", "front-door")) files.set(join(dirname(scopedPath), "AGENTS.md"), providerAdapter("codex", scopedDoor));
      if (selectedTarget(input, "CLAUDE.md", "front-door")) files.set(join(dirname(scopedPath), "CLAUDE.md"), providerAdapter("claude", scopedDoor));
      for (const { method, work } of methodsForPlace(input, source)) {
        const methodPath = join(dirname(scopedPath), `methods/${method.id}.md`);
        const workPath = work ? byRef.get(work.envelope.ref)?.projectionPath ?? fail(`Method Work is not mapped: ${work.envelope.ref}`) : undefined;
        files.set(methodPath, methodMarkdown(input, method, work, methodPath, workPath));
      }
    }
  }

  const map = {
    $schema: "https://endroit.org/schema/workplace-map/v1.json",
    workplace: input.workplace.workplace,
    profileRevision: input.profilePackage?.digest ?? hash(stable(input.profile)),
    sourceRevision: sourceRevision(input),
    workplaceIgnoreRevision: input.ignore.revision,
    entries: entries.filter((entry) => entry.path.startsWith("workplace/")),
  };
  files.set("workplace/.workplace/workplace-map.json", stable(map));

  const coverage = input.sources.filter((source) => source.mountPath?.startsWith("workplace/")).map((source) => {
    const entry = byRef.get(source.envelope.ref)!;
    const surfaces = [entry.path];
    if ((source.envelope.roles ?? []).some((role) => input.profile.roles[role]?.projectionResponsibilities?.includes("resident-entry"))) {
      surfaces.push("FRONTDOOR.md");
      if (files.has("AGENTS.md")) surfaces.push("AGENTS.md");
      if (files.has("CLAUDE.md")) surfaces.push("CLAUDE.md");
    }
    if (files.has(join(dirname(entry.projectionPath), "AGENTS.md"))) surfaces.push(join(dirname(entry.projectionPath), "AGENTS.md"));
    return { source: { ref: source.envelope.ref, revision: source.revision }, responsibility: `source:${source.envelope.entity}`, surfaces };
  });
  files.set("workplace/.workplace/instruction-coverage.json", stable({ workplace: input.workplace.workplace, coverage }));
  files.set(".endroit/front-door-ir.json", stable({ kind: "FrontDoorIR", version: 1, workplace: input.workplace.workplace, doors }));
  files.set(".endroit/coordination-ir.json", stable(coordination));
  files.set(".endroit/disclosure-contract.json", stable(disclosureContract(input, doors)));
  files.set(".endroit/context-contracts.json", stable(contextContracts(input)));
  files.set(".endroit/control-clauses.json", stable({ kind: "ControlClauses", version: 1, workplace: input.workplace.workplace, profile: input.profilePackage ? { ref: input.profilePackage.manifest.ref, digest: input.profilePackage.digest } : null, clauses: input.profilePackage?.controls ?? [] }));

  const manifestEntries = [...files.entries()].filter(([path]) => path.startsWith("workplace/") && !path.endsWith("projection-manifest.json")).sort(([a], [b]) => a.localeCompare(b)).map(([path, content]) => ({ path, digest: hash(content) }));
  const manifest = {
    compiler: "@endroit/cli/0.1.0-rc.1",
    workplace: input.workplace.workplace,
    profileRevision: input.profilePackage?.digest ?? hash(stable(input.profile)),
    entryProjection: "neutral",
    workplaceIgnoreRevision: input.ignore.revision,
    dependencies: [
      { ref: input.profile.ref, revision: input.profilePackage?.digest ?? hash(stable(input.profile)) },
      { ref: input.coordination.ref, revision: hash(stable(input.coordination)) },
      ...input.equipment.map((item) => ({ ref: item.ref, revision: hash(stable(item)) })),
      ...input.sources.filter((source) => source.mountPath?.startsWith("workplace/")).map((source) => ({ ref: source.envelope.ref, revision: source.revision })),
    ].sort((a, b) => a.ref.localeCompare(b.ref)),
    sourceContracts: Object.values(input.profilePackage?.sourceContracts ?? {}).sort((a, b) => a.id.localeCompare(b.id)).map((contract) => ({ id: contract.id, source: { profile: input.profilePackage?.manifest.ref ?? input.profile.ref, path: contract.sourcePath }, projection: `workplace/${contract.projectionPath}`, variables: contract.variables, consumers: contract.consumers, maxBytes: contract.maxBytes, templateRevision: contract.templateRevision, revision: contract.revision })),
    files: manifestEntries,
  };
  files.set("workplace/.workplace/projection-manifest.json", stable(manifest));
  const localEntries = [...files.entries()].filter(([path]) => isLocalProjection(path) || (path.startsWith(".endroit/") && path !== ".endroit/projection-manifest.json")).sort(([a], [b]) => a.localeCompare(b)).map(([path, content]) => ({ path, digest: hash(content) }));
  const localDependencies = [
    ...entryDependencies(input),
    { ref: input.coordination.ref, revision: hash(stable(input.coordination)) },
    ...input.equipment.map((item) => ({ ref: item.ref, revision: hash(stable(item)) })),
  ].sort((a, b) => a.ref.localeCompare(b.ref));
  files.set(".endroit/projection-manifest.json", stable({
    compiler: "@endroit/cli/0.1.0-rc.1",
    entryStatus: input.entry ? "bound" : "onboarding-required",
    binding: input.entry ? { member: input.entry.member, desk: input.entry.desk } : null,
    entryBindingRevision: hash(stable(input.entry ?? null)),
    providerBindingRevision: hash(stable(input.provider ?? null)),
    sourceRevision: hash(localDependencies.map((item) => `${item.ref}:${item.revision}`).join("\n")),
    dependencies: localDependencies,
    dependencySets: {
      reception: {
        dependencies: localDependencies,
        surfaces: localEntries.map((item) => item.path),
      },
    },
    files: localEntries,
  }));

  const temp = join(dirname(outDir), `.${basename(outDir)}.tmp-${process.pid}-${crypto.randomUUID()}`);
  await mkdir(dirname(outDir), { recursive: true });
  try {
    await mkdir(temp, { recursive: false });
    await writeTree(temp, files);
    await rename(temp, outDir);
  } catch (error) {
    await rm(temp, { recursive: true, force: true });
    throw error;
  }
  return {
    root: outDir,
    status: input.entry ? "bound" : "onboarding-required",
    revision: hash(stable(manifest)),
    files: [...files.keys()].sort(),
    entries,
  };
}

export async function checkStaticWorkplace(options: { mount?: string; root?: string }): Promise<CheckResult> {
  const root = resolve(options.mount ?? options.root ?? fail("checkStaticWorkplace requires a Mount"));
  const manifestPath = join(root, "workplace/.workplace/projection-manifest.json");
  let manifest: { files: Array<{ path: string; digest: Revision }> };
  try {
    manifest = await readJson(manifestPath, "Projection manifest");
  } catch (error) {
    return {
      compileStatus: "missing",
      entryStatus: "unadopted",
      operationStatus: "pending",
      requiredAction: "Run endroit ready from the Workplace Mount.",
      diagnostics: [{ severity: "error", code: "manifest-missing", subject: manifestPath, message: error instanceof Error ? error.message : String(error) }],
    };
  }
  const diagnostics: Diagnostic[] = [];
  for (const item of manifest.files) {
    const path = join(root, item.path);
    try {
      const actual = hash(await readFile(path));
      if (actual !== item.digest) diagnostics.push({ severity: "error", code: "projection-stale", subject: item.path, message: `expected ${item.digest}, observed ${actual}` });
    } catch (error) {
      diagnostics.push({ severity: "error", code: "projection-missing", subject: item.path, message: error instanceof Error ? error.message : String(error) });
    }
  }
  const stale = diagnostics.length > 0;
  let entryStatus: CheckResult["entryStatus"] = "onboarding-required";
  try {
    const local = await readJson<{
      entryStatus: "onboarding-required" | "bound";
      files: Array<{ path: string; digest: Revision }>;
    }>(join(root, ".endroit/projection-manifest.json"), "Local projection manifest");
    entryStatus = local.entryStatus;
    for (const item of local.files) {
      const path = join(root, item.path);
      try {
        const actual = hash(await readFile(path));
        if (actual !== item.digest) diagnostics.push({ severity: "error", code: "local-projection-stale", subject: item.path, message: `expected ${item.digest}, observed ${actual}` });
      } catch (error) {
        diagnostics.push({ severity: "error", code: "local-projection-missing", subject: item.path, message: error instanceof Error ? error.message : String(error) });
      }
    }
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("ENOENT")) diagnostics.push({ severity: "warning", code: "entry-unavailable", subject: ".endroit/projection-manifest.json", message: error instanceof Error ? error.message : String(error) });
  }
  const anyStale = stale || diagnostics.some((item) => item.severity === "error");
  const bound = entryStatus === "bound";
  return {
    compileStatus: anyStale ? "stale" : "valid",
    entryStatus,
    operationStatus: anyStale ? "degraded" : bound ? "ready" : "pending",
    ...(anyStale ? { requiredAction: "Recompile from the exact owned sources." } : !bound ? { requiredAction: "Run onboarding, create an explicit EntryBinding, then run endroit ready." } : {}),
    diagnostics,
  };
}

export async function checkWorkplaceMount(options: { mount: string; provider?: string; profilePath?: string }): Promise<CheckResult> {
  const root = resolve(options.mount);
  const base = await checkStaticWorkplace({ mount: root });
  const git = await (await import("./git-witness.ts")).checkMountGit(root);
  if (git.status === "invalid") return {
    ...base,
    compileStatus: "unavailable",
    operationStatus: "degraded",
    requiredAction: "Repair the Git witness before compilation or durable mutation.",
    diagnostics: [...base.diagnostics, ...git.diagnostics],
  };
  const entryPath = join(root, ".endroit/entry.json");
  const hasEntry = await exists(entryPath);
  let unavailableTool: { trait: string; command: string[] } | undefined;
  if (base.compileStatus === "missing") {
    return {
      ...base,
      entryStatus: hasEntry ? "bound" : "onboarding-required",
      requiredAction: hasEntry
        ? "Run endroit ready to create the missing projections."
        : "Run this Profile’s onboarding to create an explicit EntryBinding; then run endroit ready.",
    };
  }
  try {
    const providerPaths = await providerPathsFor(root, options.provider);
    const input = await loadCompileInput({
      workplacePath: join(root, "workplace/workplace.json"),
      ...(options.profilePath ? { profilePath: options.profilePath } : {}),
      ...(hasEntry ? { entryPath } : {}),
      ...(providerPaths.length > 0 ? { providerPaths } : {}),
    });
    for (const tool of input.provider?.tools ?? []) {
      if (tool.command && !await exists(tool.command[0]!)) {
        unavailableTool = { trait: tool.trait, command: tool.command };
        break;
      }
    }
    const map = await readJson<{ sourceRevision: Revision }>(join(root, "workplace/.workplace/workplace-map.json"), "Workplace map");
    const current = sourceRevision(input);
    if (map.sourceRevision !== current) {
      return {
        ...base,
        compileStatus: "stale",
        entryStatus: hasEntry ? "bound" : "onboarding-required",
        operationStatus: "compile-required",
        requiredAction: hasEntry ? "Run endroit ready to rebuild stale local projections." : "Run this Profile’s onboarding before rebuilding a personalized entry.",
        diagnostics: [...base.diagnostics, { severity: "error", code: "source-revision-stale", subject: "workplace/.workplace/workplace-map.json", message: `expected current source revision ${current}, observed ${map.sourceRevision}` }],
      };
    }
    if (hasEntry && base.entryStatus === "bound") {
      const local = await readJson<{ sourceRevision: Revision; entryBindingRevision?: Revision; providerBindingRevision?: Revision; federationRevision?: string }>(join(root, ".endroit/projection-manifest.json"), "Local projection manifest");
      const expectedEntry = hash(stable(input.entry ?? null));
      const expectedProvider = hash(stable(input.provider ?? null));
      if (local.entryBindingRevision !== expectedEntry || local.providerBindingRevision !== expectedProvider) {
        return {
          ...base,
          compileStatus: "stale",
          entryStatus: "bound",
          operationStatus: "compile-required",
          requiredAction: "Run endroit ready to rebuild projections from current local bindings.",
          diagnostics: [...base.diagnostics, { severity: "error", code: "binding-revision-stale", subject: ".endroit/projection-manifest.json", message: `expected Entry ${expectedEntry} and Provider ${expectedProvider}, observed Entry ${local.entryBindingRevision ?? "missing"} and Provider ${local.providerBindingRevision ?? "missing"}` }],
        };
      }
      const federation = await (await import("../federation.ts")).federationProjection(root);
      if (local.federationRevision !== federation.revision) {
        return {
          ...base,
          compileStatus: "stale",
          entryStatus: "bound",
          operationStatus: "compile-required",
          requiredAction: "Run endroit ready to rebuild local adjacency from current federation bindings.",
          diagnostics: [...base.diagnostics, { severity: "error", code: "federation-revision-stale", subject: ".endroit/projection-manifest.json", message: `expected Federation ${federation.revision ?? "absent"}, observed ${local.federationRevision ?? "absent"}` }],
        };
      }
      const expected = hash([
        ...entryDependencies(input),
        { ref: input.coordination.ref, revision: hash(stable(input.coordination)) },
        ...input.equipment.map((item) => ({ ref: item.ref, revision: hash(stable(item)) })),
      ].sort((a, b) => a.ref.localeCompare(b.ref)).map((item) => `${item.ref}:${item.revision}`).join("\n"));
      if (local.sourceRevision !== expected) {
        return {
          ...base,
          compileStatus: "stale",
          entryStatus: "bound",
          operationStatus: "compile-required",
          requiredAction: "Run endroit ready to rebuild stale Desk-bound projections.",
          diagnostics: [...base.diagnostics, { severity: "error", code: "entry-source-revision-stale", subject: ".endroit/projection-manifest.json", message: `expected bound source revision ${expected}, observed ${local.sourceRevision}` }],
        };
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/Profile Package|ProfileSelection|Profile selection or Package/.test(message)) return {
      ...base,
      compileStatus: "unavailable",
      operationStatus: "compile-required",
      requiredAction: `Restore the exact pinned Profile Package or rerun with --profile <package>. ${message}`,
      diagnostics: [...base.diagnostics, { severity: "error", code: "profile-package-unavailable", subject: root, message }],
    };
    return {
      ...base,
      compileStatus: "unavailable",
      operationStatus: "degraded",
      requiredAction: "Repair the named source/configuration error before compilation.",
      diagnostics: [...base.diagnostics, { severity: "error", code: "source-check-failed", subject: root, message }],
    };
  }
  if (!hasEntry && base.entryStatus !== "bound") {
    return {
      ...base,
      entryStatus: "onboarding-required",
      operationStatus: "pending",
      requiredAction: "Run this Profile’s onboarding to create an explicit EntryBinding; then run endroit ready.",
    };
  }
  if (base.entryStatus !== "bound") {
    return {
      ...base,
      entryStatus: "bound",
      operationStatus: "compile-required",
      requiredAction: "Run endroit ready to compile the bound entry.",
    };
  }
  if (unavailableTool) {
    const command = unavailableTool.command.map((part) => JSON.stringify(part)).join(" ");
    return {
      ...base,
      operationStatus: "degraded",
      requiredAction: `Restore the bound executable, then run: ${command}`,
      diagnostics: [...base.diagnostics, { severity: "warning", code: "tool-command-missing", subject: unavailableTool.trait, message: `Bound command is unavailable: ${command}` }],
    };
  }
  if (git.status === "degraded") return {
    ...base,
    operationStatus: "degraded",
    requiredAction: "Run endroit ready to repair Endroit-owned Git guards; foreign hook collisions require explicit resolution.",
    diagnostics: [...base.diagnostics, ...git.diagnostics],
  };
  return base;
}

export async function readyWorkplace(options: { start: string; provider?: string; profilePath?: string }): Promise<{ mount: string; changed: boolean; check: CheckResult }> {
  const mount = await discoverMount(options.start) ?? fail(`No Workplace Mount found from ${resolve(options.start)}`);
  const before = await checkWorkplaceMount({ mount, ...(options.provider ? { provider: options.provider } : {}), ...(options.profilePath ? { profilePath: options.profilePath } : {}) });
  if (before.diagnostics.some((item) => item.code === "git-witness-invalid" || item.code === "git-merge-implicit")) return { mount, changed: false, check: before };
  if (before.diagnostics.some((item) => item.code === "profile-package-unavailable")) return { mount, changed: false, check: before };
  if (before.compileStatus === "valid" && !["compile-required", "degraded"].includes(before.operationStatus)) return { mount, changed: false, check: before };
  await (await import("./git-witness.ts")).repairGitGuards(mount);
  await compileWorkplaceMount({ mount, ...(options.provider ? { provider: options.provider } : {}), ...(options.profilePath ? { profilePath: options.profilePath } : {}) });
  return { mount, changed: true, check: await checkWorkplaceMount({ mount, ...(options.provider ? { provider: options.provider } : {}), ...(options.profilePath ? { profilePath: options.profilePath } : {}) }) };
}
