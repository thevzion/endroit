import { readFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { parseDocument } from "yaml";
import type {
  AffordanceContract,
  ControlClause,
  CoordinationPolicy,
  LoadedProfilePackage,
  LoadedSourceContract,
  Profile,
  Revision,
  SourceContractId,
  WorkplaceProfilePackageManifest,
} from "./model.ts";

const ID = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const COMPONENTS = ["grammar", "lexicon", "responsibilities", "composition", "coordination", "disclosure", "projections", "new"] as const;
const DEFAULTS = ["constitution", "doctrine", "change", "member", "desk", "welcome", "memory"] as const;
const SOURCE_CONTRACT_IDS = ["room", "meeting", "work", "site"] as const;
const SOURCE_CONTRACT_CONSUMERS: Record<SourceContractId, string[]> = {
  room: ["open-room"],
  meeting: ["open-room"],
  work: ["open-work"],
  site: ["open-work"],
};
const MANIFEST_KEYS = new Set(["$schema", "kind", "version", "id", "ref", "release", "sourceContracts", "components", "affordances", "defaults"]);
const AFFORDANCE_KEYS = new Set(["kind", "version", "id", "positions", "applicability", "authority", "providerTargets", "instructions"]);
const CONTROL_KEYS = new Set(["id", "positions", "trigger", "placement", "criticality", "reasonForDisclosure", "consequenceIfMissed", "requiredEvidence", "enforcement"]);
const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function fail(message: string): never { throw new Error(message); }

function object(value: unknown, subject: string): Record<string, unknown> {
  if (value === null || Array.isArray(value) || typeof value !== "object") fail(`${subject} must be an object`);
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, keys: ReadonlySet<string>, subject: string): void {
  const unknown = Object.keys(value).filter((key) => !keys.has(key));
  if (unknown.length) fail(`${subject} has unknown fields: ${unknown.sort().join(", ")}`);
}

function strings(value: unknown, subject: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item)) fail(`${subject} must be a non-empty string array`);
  return value as string[];
}

function rejectPrototypeKeys(value: unknown, subject: string): void {
  if (Array.isArray(value)) return value.forEach((item, index) => rejectPrototypeKeys(item, `${subject}[${index}]`));
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_KEYS.has(key)) fail(`${subject} contains forbidden key ${key}`);
    rejectPrototypeKeys(item, `${subject}.${key}`);
  }
}

function parseJson(bytes: string, subject: string): unknown {
  const document = parseDocument(bytes, { schema: "json", uniqueKeys: true });
  if (document.errors.length) fail(`${subject} is invalid JSON: ${document.errors[0]!.message}`);
  let value: unknown;
  try { value = JSON.parse(bytes) as unknown; }
  catch (error) { fail(`${subject} is invalid JSON: ${error instanceof Error ? error.message : String(error)}`); }
  rejectPrototypeKeys(value, subject);
  return value;
}

function hash(bytes: string | Uint8Array): Revision {
  return `sha256:${new Bun.CryptoHasher("sha256").update(bytes).digest("hex")}`;
}

function canonicalText(bytes: string): string {
  return bytes.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

function safePath(root: string, path: unknown, subject: string): string {
  if (typeof path !== "string" || !path || path.startsWith("/") || path.split(/[\\/]/).includes("..")) fail(`${subject} must be a safe relative path`);
  const target = resolve(root, path);
  const relation = relative(root, target);
  if (!relation || relation === ".." || relation.startsWith(`..${sep}`)) fail(`${subject} escapes the Profile Package`);
  return target;
}

async function readDeclared(root: string, path: unknown, subject: string, files: Map<string, string>): Promise<string> {
  const target = safePath(root, path, subject);
  let bytes: string;
  try { bytes = canonicalText(await readFile(target, "utf8")); }
  catch (error) { fail(`${subject} is unavailable at ${target}: ${error instanceof Error ? error.message : String(error)}`); }
  files.set(relative(root, target).split(sep).join("/"), bytes);
  return bytes;
}

function validateAffordance(value: unknown, expectedId: string): AffordanceContract {
  const contract = object(value, `Affordance ${expectedId}`);
  exact(contract, AFFORDANCE_KEYS, `Affordance ${expectedId}`);
  if (contract.kind !== "AffordanceContract" || contract.version !== 1 || contract.id !== expectedId || !ID.test(expectedId)) fail(`Affordance ${expectedId} has invalid identity`);
  if (strings(contract.positions, `Affordance ${expectedId}.positions`).some((position) => !["hall", "place", "meeting", "work", "site"].includes(position))) fail(`Affordance ${expectedId} has invalid Position`);
  if (!["onboarding-required", "bound", "active-meeting"].includes(String(contract.applicability))) fail(`Affordance ${expectedId} has invalid applicability`);
  if (!["none", "bounded", "human-consent"].includes(String(contract.authority))) fail(`Affordance ${expectedId} has invalid Authority`);
  if (strings(contract.providerTargets, `Affordance ${expectedId}.providerTargets`).some((target) => !["skill", "command"].includes(target))) fail(`Affordance ${expectedId} has invalid provider target`);
  return value as AffordanceContract;
}

function validateControls(value: unknown): ControlClause[] {
  if (!Array.isArray(value)) fail("Disclosure.controls must be an array");
  const ids = new Set<string>();
  return value.map((item, index) => {
    const clause = object(item, `Disclosure.controls[${index}]`);
    exact(clause, CONTROL_KEYS, `Disclosure.controls[${index}]`);
    if (typeof clause.id !== "string" || !ID.test(clause.id) || ids.has(clause.id)) fail(`Disclosure.controls[${index}] has invalid or duplicate id`);
    ids.add(clause.id);
    if (strings(clause.positions, `Control ${clause.id}.positions`).some((position) => !["hall", "place", "meeting", "work", "site"].includes(position))) fail(`Control ${clause.id} has invalid Position`);
    if (!["Resident", "RequiredRead", "MayRead", "Guard"].includes(String(clause.placement))) fail(`Control ${clause.id} has invalid placement`);
    if (!["critical", "advisory"].includes(String(clause.criticality))) fail(`Control ${clause.id} has invalid criticality`);
    if (!["staged", "history", "qualification"].includes(String(clause.enforcement))) fail(`Control ${clause.id} has invalid enforcement`);
    for (const key of ["trigger", "reasonForDisclosure", "consequenceIfMissed"] as const) if (typeof clause[key] !== "string" || !clause[key]) fail(`Control ${clause.id}.${key} is required`);
    strings(clause.requiredEvidence, `Control ${clause.id}.requiredEvidence`);
    return item as ControlClause;
  });
}

export async function loadProfilePackage(manifestPath: string): Promise<LoadedProfilePackage> {
  const path = resolve(manifestPath.endsWith(".json") ? manifestPath : resolve(manifestPath, "profile.json"));
  const root = dirname(path);
  const files = new Map<string, string>();
  const manifestBytes = await readFile(path, "utf8").then(canonicalText).catch((error) => fail(`Profile Package manifest is unavailable at ${path}: ${error instanceof Error ? error.message : String(error)}`));
  files.set("profile.json", manifestBytes);
  const manifest = object(parseJson(manifestBytes, "Profile Package manifest"), "Profile Package manifest");
  exact(manifest, MANIFEST_KEYS, "Profile Package manifest");
  if (manifest.kind !== "WorkplaceProfilePackage" || manifest.version !== 1 || typeof manifest.id !== "string" || !ID.test(manifest.id)) fail("Unsupported Workplace Profile Package");
  if (typeof manifest.ref !== "string" || !manifest.ref.startsWith("workplace://profiles/")) fail("Profile Package ref is invalid");
  if (typeof manifest.release !== "string" || !manifest.release) fail("Profile Package release is required");
  const sourceContractsBytes = await readDeclared(root, manifest.sourceContracts, "Profile Package Source Contracts", files);
  const sourceContractsDocument = object(parseJson(sourceContractsBytes, "Profile Package Source Contracts"), "Profile Package Source Contracts");
  exact(sourceContractsDocument, new Set(["kind", "version", "contracts"]), "Profile Package Source Contracts");
  if (sourceContractsDocument.kind !== "SourceContracts" || sourceContractsDocument.version !== 1 || !Array.isArray(sourceContractsDocument.contracts)) fail("Unsupported Profile Package Source Contracts");
  const sourceContracts = {} as Record<SourceContractId, LoadedSourceContract>;
  const contractPaths = new Set<string>();
  for (const [index, value] of sourceContractsDocument.contracts.entries()) {
    const contract = object(value, `Source Contracts[${index}]`);
    exact(contract, new Set(["id", "path", "projection", "variables", "consumers", "maxBytes"]), `Source Contracts[${index}]`);
    if (!SOURCE_CONTRACT_IDS.includes(contract.id as SourceContractId) || sourceContracts[contract.id as SourceContractId]) fail(`Source Contracts[${index}].id is invalid or duplicated`);
    const id = contract.id as SourceContractId;
    const sourcePath = String(contract.path);
    if (contractPaths.has(sourcePath)) fail(`Source Contract ${id}.path is duplicated`);
    contractPaths.add(sourcePath);
    const projectionPath = String(contract.projection);
    if (projectionPath !== `.workplace/source-contracts/${id.toUpperCase()}.md`) fail(`Source Contract ${id}.projection is invalid`);
    const variables = strings(contract.variables, `Source Contract ${id}.variables`);
    if (new Set(variables).size !== variables.length || variables.some((variable) => !/^[A-Z][A-Z0-9_]*$/.test(variable))) fail(`Source Contract ${id}.variables are invalid or duplicated`);
    const consumers = strings(contract.consumers, `Source Contract ${id}.consumers`);
    if (consumers.join("|") !== SOURCE_CONTRACT_CONSUMERS[id].join("|")) fail(`Source Contract ${id}.consumers are invalid`);
    if (!Number.isInteger(contract.maxBytes) || Number(contract.maxBytes) < 1 || Number(contract.maxBytes) > 256 * 1024) fail(`Source Contract ${id}.maxBytes is invalid`);
    const template = await readDeclared(root, contract.path, `Source Contract ${id} template`, files);
    if (new TextEncoder().encode(template).byteLength > Number(contract.maxBytes)) fail(`Source Contract ${id} template exceeds its byte budget`);
    const placeholders = [...template.matchAll(/\{\{([A-Z][A-Z0-9_]*)\}\}/g)].map((match) => match[1]!);
    const unsupported = template.replace(/\{\{[A-Z][A-Z0-9_]*\}\}/g, "").match(/\{\{[^}]+\}\}/)?.[0];
    if (unsupported || [...new Set(placeholders)].sort().join("|") !== [...variables].sort().join("|")) fail(`Source Contract ${id} placeholders do not match declared variables`);
    const templateRevision = hash(template);
    const revision = hash(`${JSON.stringify(contract)}\0${templateRevision}`);
    sourceContracts[id] = { id, sourcePath, projectionPath, variables, consumers, maxBytes: Number(contract.maxBytes), template, templateRevision, revision };
  }
  if (SOURCE_CONTRACT_IDS.some((id) => !sourceContracts[id])) fail("Profile Package Source Contracts must declare exactly room, meeting, work and site");
  const components = object(manifest.components, "Profile Package components");
  exact(components, new Set(COMPONENTS), "Profile Package components");
  const defaults = object(manifest.defaults, "Profile Package defaults");
  exact(defaults, new Set(DEFAULTS), "Profile Package defaults");
  if (!Array.isArray(manifest.affordances) || !manifest.affordances.length) fail("Profile Package affordances must not be empty");

  const decoded: Record<string, unknown> = {};
  for (const id of COMPONENTS) decoded[id] = parseJson(await readDeclared(root, components[id], `Profile Package component ${id}`, files), `Profile Package component ${id}`);
  const grammar = object(decoded.grammar, "Grammar");
  const disclosure = object(decoded.disclosure, "Disclosure");
  const { controls: rawControls, kind: _kind, version: _version, ...disclosures } = disclosure;
  const profile = { ...grammar, disclosures } as Profile;
  if (profile.id !== manifest.id || profile.ref !== manifest.ref) fail("Profile Package manifest and Grammar identity diverge");
  const controls = validateControls(rawControls);

  const lexiconRaw = object(decoded.lexicon, "Lexicon");
  exact(lexiconRaw, new Set(["kind", "version", "terms", "requiredTerms"]), "Lexicon");
  const terms = object(lexiconRaw.terms, "Lexicon.terms") as Record<string, { label: string; definition: string; aliases: string[] }>;
  const aliases = new Set<string>();
  for (const id of strings(lexiconRaw.requiredTerms, "Lexicon.requiredTerms")) if (!terms[id]) fail(`Lexicon is missing required term ${id}`);
  for (const [id, termValue] of Object.entries(terms)) {
    if (!ID.test(id)) fail(`Lexicon has invalid term ${id}`);
    const term = object(termValue, `Lexicon.terms.${id}`);
    exact(term, new Set(["label", "definition", "aliases"]), `Lexicon.terms.${id}`);
    if (typeof term.label !== "string" || !term.label || typeof term.definition !== "string" || !term.definition) fail(`Lexicon term ${id} is incomplete`);
    for (const alias of strings(term.aliases, `Lexicon.terms.${id}.aliases`)) {
      const normalized = alias.toLowerCase();
      if (terms[normalized] || aliases.has(normalized)) fail(`Lexicon alias ${alias} is ambiguous`);
      aliases.add(normalized);
    }
  }

  const responsibilityRaw = object(decoded.responsibilities, "Responsibilities");
  exact(responsibilityRaw, new Set(["kind", "version", "sources"]), "Responsibilities");
  if (!Array.isArray(responsibilityRaw.sources)) fail("Responsibilities.sources must be an array");
  const responsibilities = responsibilityRaw.sources.map((value, index) => {
    const item = object(value, `Responsibilities.sources[${index}]`);
    exact(item, new Set(["id", "role", "owner", "required", "default"]), `Responsibilities.sources[${index}]`);
    if (typeof item.id !== "string" || !ID.test(item.id) || typeof item.role !== "string" || !profile.roles[item.role]) fail(`Responsibility ${index} has invalid id or Role`);
    if (!DEFAULTS.includes(item.id as typeof DEFAULTS[number]) || item.default !== defaults[item.id]) fail(`Responsibility ${item.id} does not resolve its declared default`);
    if (!["shared", "private"].includes(String(item.owner)) || ![true, "bound"].includes(item.required as true | "bound")) fail(`Responsibility ${item.id} has invalid ownership or requirement`);
    return item as LoadedProfilePackage["responsibilities"][number];
  });
  if (new Set(responsibilities.map((item) => item.id)).size !== responsibilities.length) fail("Responsibilities contain duplicate ids");

  const composition = object(decoded.composition, "Composition template");
  exact(composition, new Set(["kind", "version", "equipment"]), "Composition template");
  const coordination = object(decoded.coordination, "Coordination template");
  exact(coordination, new Set(["kind", "version", "roles", "resolution", "dispatchEnvelope", "fallbacks"]), "Coordination template");
  const projections = object(decoded.projections, "Projection grammar");
  exact(projections, new Set(["kind", "version", "portable", "local"]), "Projection grammar");
  const newResolver = object(decoded.new, "New resolver");
  exact(newResolver, new Set(["kind", "version", "questions", "variables", "exclusions"]), "New resolver");

  const loadedAffordances: LoadedProfilePackage["affordances"] = {};
  for (const [index, value] of manifest.affordances.entries()) {
    const selected = object(value, `Profile Package affordances[${index}]`);
    exact(selected, new Set(["id", "path"]), `Profile Package affordances[${index}]`);
    if (typeof selected.id !== "string" || !ID.test(selected.id) || loadedAffordances[selected.id]) fail(`Profile Package affordance ${index} has invalid or duplicate id`);
    const contractBytes = await readDeclared(root, selected.path, `Affordance ${selected.id} contract`, files);
    const contract = validateAffordance(parseJson(contractBytes, `Affordance ${selected.id} contract`), selected.id);
    const instructions = await readDeclared(root, join(dirname(String(selected.path)), contract.instructions), `Affordance ${selected.id} instructions`, files);
    if (new TextEncoder().encode(instructions).byteLength > 16 * 1024) fail(`Affordance ${selected.id} instructions exceed 16 KiB`);
    loadedAffordances[selected.id] = { contract, instructions, revision: hash(`${contractBytes}\n${instructions}`) };
  }

  const loadedDefaults: Record<string, string> = {};
  for (const id of DEFAULTS) {
    const bytes = await readDeclared(root, defaults[id], `Profile Package default ${id}`, files);
    if (new TextEncoder().encode(bytes).byteLength > (id === "welcome" ? 4096 : 32 * 1024)) fail(`Profile Package default ${id} exceeds its byte budget`);
    loadedDefaults[id] = bytes;
  }

  const digest = hash([...files.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, bytes]) => `${name}\0${hash(bytes)}`).join("\n"));
  return {
    path,
    manifest: manifest as WorkplaceProfilePackageManifest,
    digest,
    profile,
    controls,
    lexicon: terms,
    responsibilities,
    compositionTemplate: { equipment: strings(composition.equipment, "Composition template.equipment") },
    coordinationTemplate: {
      roles: coordination.roles as CoordinationPolicy["roles"],
      resolution: coordination.resolution as CoordinationPolicy["resolution"],
      dispatchEnvelope: strings(coordination.dispatchEnvelope, "Coordination template.dispatchEnvelope"),
      fallbacks: coordination.fallbacks as CoordinationPolicy["fallbacks"],
    },
    projections: { portable: strings(projections.portable, "Projection grammar.portable"), local: strings(projections.local, "Projection grammar.local") },
    newResolver: { questions: strings(newResolver.questions, "New resolver.questions"), variables: strings(newResolver.variables, "New resolver.variables"), exclusions: strings(newResolver.exclusions, "New resolver.exclusions") },
    sourceContracts,
    affordances: loadedAffordances,
    defaults: loadedDefaults,
  };
}

export function renderProfileTemplate(template: string, variables: Record<string, string>): string {
  const rendered = template.replace(/\{\{([A-Z][A-Z0-9_]*)\}\}/g, (_match, id: string) => variables[id] ?? fail(`Profile template variable ${id} is unresolved`));
  const unresolved = rendered.match(/\{\{[^}]+\}\}/)?.[0];
  if (unresolved) fail(`Profile template contains unsupported placeholder ${unresolved}`);
  return rendered.trim();
}

export function instantiateCoordinationPolicy(profilePackage: LoadedProfilePackage, workplace: string): CoordinationPolicy {
  return { kind: "CoordinationPolicy", version: 1, ref: `${workplace}/coordination`, ...profilePackage.coordinationTemplate };
}
