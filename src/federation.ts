import { lstat, mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

const REF = /^workplace:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

export type WorkplaceRegistryEntry = {
  workplace: string;
  provenance: Array<"link" | "attachment">;
  availability: "available" | "unavailable";
  state: "not-entered";
};

export type WorkplaceRegistry = {
  kind: "WorkplaceRegistry";
  version: 1;
  anchor: string;
  entries: WorkplaceRegistryEntry[];
};

export type WorkplaceLink = { target: string };
export type WorkplaceBinding = { workplace: string; mode: "managed" | "external"; mount: string };
type WorkplaceLinks = { kind: "WorkplaceLinks"; version: 1; workplace: string; links: WorkplaceLink[] };
export type WorkplaceLocalBindings = {
  kind: "WorkplaceLocalBindings";
  version: 1;
  workplace: string;
  attachments: WorkplaceLink[];
  bindings: WorkplaceBinding[];
};

export class FederationError extends Error {
  constructor(readonly code: "unavailable" | "unsafe-mount" | "identity-mismatch" | "invalid-federation-source" | "compile-required", message: string) {
    super(message);
    this.name = "FederationError";
  }
}

function fail(message: string): never {
  throw new FederationError("invalid-federation-source", message);
}

function object(value: unknown, subject: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${subject} must be an object`);
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, keys: string[], subject: string): void {
  const unknown = Object.keys(value).filter((key) => !keys.includes(key));
  const missing = keys.filter((key) => !(key in value));
  if (unknown.length > 0) fail(`${subject} has unknown fields: ${unknown.join(", ")}`);
  if (missing.length > 0) fail(`${subject} is missing fields: ${missing.join(", ")}`);
}

function semanticRef(value: unknown, subject: string): string {
  if (typeof value !== "string" || !REF.test(value)) fail(`${subject} is not a fully qualified Workplace ref`);
  return value;
}

function absolutePath(value: string): boolean {
  return /^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(value);
}

async function optionalJson(path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    if (error instanceof Error && error.message.includes("ENOENT")) return undefined;
    if (error instanceof SyntaxError) fail(`${path} is invalid JSON: ${error.message}`);
    throw error;
  }
}

function unique(values: string[], subject: string): void {
  const duplicate = values.find((value, index) => values.indexOf(value) !== index);
  if (duplicate) fail(`${subject} repeats ${duplicate}`);
}

function parseLink(value: unknown, subject: string): WorkplaceLink {
  const source = object(value, subject);
  exact(source, ["target"], subject);
  return { target: semanticRef(source.target, `${subject}.target`) };
}

function parseLinks(value: unknown, anchor: string): WorkplaceLinks {
  const source = object(value, "WorkplaceLinks");
  exact(source, ["kind", "version", "workplace", "links"], "WorkplaceLinks");
  if (source.kind !== "WorkplaceLinks" || source.version !== 1) fail("WorkplaceLinks kind/version must be WorkplaceLinks/1");
  const workplace = semanticRef(source.workplace, "WorkplaceLinks.workplace");
  if (workplace !== anchor) fail(`WorkplaceLinks owns ${workplace}, expected ${anchor}`);
  if (!Array.isArray(source.links)) fail("WorkplaceLinks.links must be an array");
  const links = source.links.map((item, index) => parseLink(item, `WorkplaceLinks.links[${index}]`));
  unique(links.map((item) => item.target), "WorkplaceLinks.links");
  if (links.some((item) => item.target === anchor)) fail("WorkplaceLinks cannot link its own Workplace");
  return { kind: "WorkplaceLinks", version: 1, workplace, links };
}

function parseLocal(value: unknown, anchor: string): WorkplaceLocalBindings {
  const source = object(value, "WorkplaceLocalBindings");
  exact(source, ["kind", "version", "workplace", "attachments", "bindings"], "WorkplaceLocalBindings");
  if (source.kind !== "WorkplaceLocalBindings" || source.version !== 1) fail("WorkplaceLocalBindings kind/version must be WorkplaceLocalBindings/1");
  const workplace = semanticRef(source.workplace, "WorkplaceLocalBindings.workplace");
  if (workplace !== anchor) fail(`WorkplaceLocalBindings owns ${workplace}, expected ${anchor}`);
  if (!Array.isArray(source.attachments) || !Array.isArray(source.bindings)) fail("WorkplaceLocalBindings attachments and bindings must be arrays");
  const attachments = source.attachments.map((item, index) => parseLink(item, `WorkplaceLocalBindings.attachments[${index}]`));
  const bindings = source.bindings.map((item, index) => {
    const subject = `WorkplaceLocalBindings.bindings[${index}]`;
    const binding = object(item, subject);
    exact(binding, ["workplace", "mode", "mount"], subject);
    const target = semanticRef(binding.workplace, `${subject}.workplace`);
    if (binding.mode !== "managed" && binding.mode !== "external") fail(`${subject}.mode must be managed or external`);
    if (typeof binding.mount !== "string" || binding.mount.length === 0) fail(`${subject}.mount must be a non-empty path`);
    if (binding.mode === "managed" && absolutePath(binding.mount)) fail(`${subject}.managed mount must be relative`);
    return { workplace: target, mode: binding.mode, mount: binding.mount } as WorkplaceBinding;
  });
  unique(attachments.map((item) => item.target), "WorkplaceLocalBindings.attachments");
  unique(bindings.map((item) => item.workplace), "WorkplaceLocalBindings.bindings");
  if (attachments.some((item) => item.target === anchor) || bindings.some((item) => item.workplace === anchor)) fail("Local federation state cannot target its own Workplace");
  return { kind: "WorkplaceLocalBindings", version: 1, workplace, attachments, bindings };
}

async function workplaceIdentity(mount: string): Promise<string> {
  const source = object(await optionalJson(join(mount, "workplace/workplace.json")), "WorkplaceBuildContract");
  if (source.kind !== "WorkplaceBuildContract" || source.version !== 2) fail(`Workplace identity at ${mount} must be WorkplaceBuildContract/2`);
  return semanticRef(source.workplace, "WorkplaceBuildContract.workplace");
}

function localSourcePath(anchorMount: string, localPath?: string): string {
  return localPath ? resolve(anchorMount, localPath) : join(resolve(anchorMount), ".endroit/workplaces.json");
}

export function resolveDeclaredWorkplaceMount(anchorMount: string, localPath: string, binding: WorkplaceBinding): string {
  if (binding.mode === "external") return absolutePath(binding.mount) ? resolve(binding.mount) : resolve(dirname(localPath), binding.mount);
  const base = resolve(anchorMount, "checkouts/workplaces");
  const target = resolve(anchorMount, binding.mount);
  const fromBase = relative(base, target);
  if (fromBase === "" || fromBase.startsWith("..") || absolutePath(fromBase)) throw new FederationError("unsafe-mount", `Managed Mount escapes ${base}: ${binding.mount}`);
  return target;
}

async function available(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && error.message.includes("ENOENT")) return false;
    throw error;
  }
}

export async function readWorkplaceFederationState(anchorMount: string, localPath?: string): Promise<{
  anchor: string;
  localPath: string;
  links: WorkplaceLink[];
  attachments: WorkplaceLink[];
  bindings: WorkplaceBinding[];
  present: boolean;
}> {
  const mount = resolve(anchorMount);
  const anchor = await workplaceIdentity(mount);
  const linksPath = join(mount, "workplace/links.json");
  const resolvedLocal = localSourcePath(mount, localPath);
  const [portable, local] = await Promise.all([optionalJson(linksPath), optionalJson(resolvedLocal)]);
  const links = portable === undefined ? [] : parseLinks(portable, anchor).links;
  const parsedLocal = local === undefined ? undefined : parseLocal(local, anchor);
  return {
    anchor,
    localPath: resolvedLocal,
    links,
    attachments: parsedLocal?.attachments ?? [],
    bindings: parsedLocal?.bindings ?? [],
    present: portable !== undefined || local !== undefined,
  };
}

export async function writeWorkplaceLocalBindings(anchorMount: string, value: WorkplaceLocalBindings, localPath?: string): Promise<string> {
  const mount = resolve(anchorMount);
  const anchor = await workplaceIdentity(mount);
  const parsed = parseLocal(value, anchor);
  const path = localSourcePath(mount, localPath);
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}-${crypto.randomUUID()}`;
  await writeFile(temp, `${JSON.stringify(parsed, null, 2)}\n`, { flag: "wx" });
  await rename(temp, path);
  return path;
}

export async function deriveWorkplaceRegistry(anchorMount: string, localPath?: string): Promise<WorkplaceRegistry> {
  const source = await readWorkplaceFederationState(anchorMount, localPath);
  const targets = new Map<string, Set<"link" | "attachment">>();
  for (const link of source.links) (targets.get(link.target) ?? targets.set(link.target, new Set()).get(link.target)!).add("link");
  for (const attachment of source.attachments) (targets.get(attachment.target) ?? targets.set(attachment.target, new Set()).get(attachment.target)!).add("attachment");
  const bindings = new Map(source.bindings.map((binding) => [binding.workplace, binding]));
  const entries: WorkplaceRegistryEntry[] = [];
  for (const [workplace, provenance] of [...targets.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const binding = bindings.get(workplace);
    const mount = binding ? resolveDeclaredWorkplaceMount(anchorMount, source.localPath, binding) : undefined;
    entries.push({
      workplace,
      provenance: [...provenance].sort((a, b) => a.localeCompare(b)),
      availability: mount && await available(mount) ? "available" : "unavailable",
      state: "not-entered",
    });
  }
  return { kind: "WorkplaceRegistry", version: 1, anchor: source.anchor, entries };
}

export async function federationProjection(anchorMount: string, localPath?: string): Promise<{ present: boolean; registry: WorkplaceRegistry; revision?: string }> {
  const source = await readWorkplaceFederationState(anchorMount, localPath);
  const registry = await deriveWorkplaceRegistry(anchorMount, localPath);
  if (!source.present) return { present: false, registry };
  const bytes = JSON.stringify(registry);
  return { present: true, registry, revision: `sha256:${new Bun.CryptoHasher("sha256").update(bytes).digest("hex")}` };
}

export function renderAdjacentWorkplaces(registry: WorkplaceRegistry): string {
  if (registry.entries.length === 0) return "";
  const lines = registry.entries.map((entry) => `- \`${entry.workplace}\` - ${entry.provenance.join("+")} - ${entry.availability} - ${entry.state}`);
  return `## Adjacent Workplaces\n\n${lines.join("\n")}\n\nUse \`endroit workplace enter <ref> --anchor <mount>\` to enter an exact target.\n`;
}

export async function resolveWorkplaceMount(anchorMount: string, target: string, localPath?: string): Promise<{ mount: string; realpath: string }> {
  semanticRef(target, "target");
  const source = await readWorkplaceFederationState(anchorMount, localPath);
  const registry = await deriveWorkplaceRegistry(anchorMount, localPath);
  if (!registry.entries.some((entry) => entry.workplace === target)) throw new FederationError("unavailable", `${target} is not adjacent to ${registry.anchor}`);
  const binding = source.bindings.find((item) => item.workplace === target);
  if (!binding) throw new FederationError("unavailable", `${target} has no local Binding`);
  const mount = resolveDeclaredWorkplaceMount(anchorMount, source.localPath, binding);
  let targetRealpath: string;
  try {
    targetRealpath = await realpath(mount);
  } catch {
    throw new FederationError("unavailable", `${target} Mount is unavailable: ${mount}`);
  }
  const anchorRealpath = await realpath(resolve(anchorMount));
  const targetToAnchor = relative(targetRealpath, anchorRealpath);
  if (targetRealpath === anchorRealpath || (targetToAnchor !== "" && !targetToAnchor.startsWith("..") && !absolutePath(targetToAnchor))) {
    throw new FederationError("unsafe-mount", `${target} Mount cannot be the Anchor or its ancestor`);
  }
  if (binding.mode === "managed") {
    const managed = await realpath(resolve(anchorMount, "checkouts/workplaces"));
    const fromManaged = relative(managed, targetRealpath);
    if (fromManaged === "" || fromManaged.startsWith("..") || absolutePath(fromManaged)) throw new FederationError("unsafe-mount", `${target} escapes the managed Mount root`);
  }
  const observed = await workplaceIdentity(targetRealpath);
  if (observed !== target) throw new FederationError("identity-mismatch", `${target} Binding resolves to ${observed}`);
  return { mount, realpath: targetRealpath };
}

export async function enterWorkplace(options: { anchorMount: string; target: string; localPath?: string; provider?: string; profilePath?: string }) {
  const registry = await deriveWorkplaceRegistry(options.anchorMount, options.localPath);
  const resolved = options.target === registry.anchor
    ? { mount: resolve(options.anchorMount), realpath: await realpath(options.anchorMount) }
    : await resolveWorkplaceMount(options.anchorMount, options.target, options.localPath);
  const compiler = await import("./compiler/index.ts");
  const check = await compiler.checkWorkplaceMount({ mount: resolved.realpath, ...(options.provider ? { provider: options.provider } : {}), ...(options.profilePath ? { profilePath: options.profilePath } : {}) });
  let entryMode: "ready" | "preserved-local" = "ready";
  if (check.compileStatus !== "valid" || check.operationStatus !== "ready") {
    try {
      const receiptPath = join(resolved.realpath, ".endroit/checkpoint-setup.json");
      const info = await lstat(receiptPath);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error("Recovery Receipt must be physical");
      const receipt = object(await optionalJson(receiptPath), "Checkpoint setup Receipt");
      const checkpoint = object(receipt.checkpoint, "Checkpoint Receipt");
      if (receipt.kind !== "WorkplaceCheckpointSetupReceipt" || receipt.version !== 1 || receipt.mount !== resolved.realpath || !receipt.member || checkpoint.status !== "restored-equivalent") throw new Error("No bound preserved restoration");
      const git = await (await import("./compiler/git-witness.ts")).checkMountGit(resolved.realpath);
      if (git.status === "invalid") throw new Error("Git witness is invalid");
      await compiler.compileWorkplaceMount({ mount: resolved.realpath, preservePortable: true, verifyLocal: true, ...(options.provider ? { provider: options.provider } : {}), ...(options.profilePath ? { profilePath: options.profilePath } : {}) });
      entryMode = "preserved-local";
    } catch (error) {
      throw new FederationError("compile-required", `${options.target} has no verified current local entry: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const entryPath = join(resolved.realpath, ".endroit/entry.json");
  const entry = object(await optionalJson(entryPath), "EntryBinding");
  const member = semanticRef(entry.member, "EntryBinding.member");
  const desk = semanticRef(entry.desk, "EntryBinding.desk");
  return {
    kind: "EnteredWorkplace" as const,
    status: "entered" as const,
    entryMode,
    anchor: registry.anchor,
    workplace: options.target,
    mount: resolved.mount,
    realpath: resolved.realpath,
    member,
    desk,
    frontDoor: join(resolved.realpath, "FRONTDOOR.md"),
    check: { compileStatus: check.compileStatus, operationStatus: check.operationStatus },
  };
}

export type OwnerResolutionInput = {
  explicit?: string;
  existingOwner?: string;
  candidates: string[];
  anchor: string;
  anchorAdmissible: boolean;
};

export type OwnerResolution = { status: "resolved"; workplace: string } | { status: "pending"; candidates: string[] };

export function resolveOwner(input: OwnerResolutionInput): OwnerResolution {
  const candidates = [...new Set(input.candidates)].sort();
  if (input.explicit) return { status: "resolved", workplace: semanticRef(input.explicit, "explicit Workplace") };
  if (input.existingOwner) return { status: "resolved", workplace: semanticRef(input.existingOwner, "existing owner") };
  if (candidates.length === 1) return { status: "resolved", workplace: semanticRef(candidates[0], "candidate") };
  if (input.anchorAdmissible) return { status: "resolved", workplace: semanticRef(input.anchor, "Anchor") };
  return { status: "pending", candidates: candidates.map((candidate) => semanticRef(candidate, "candidate")) };
}

export function resolveOwnerOperations(inputs: OwnerResolutionInput[]): OwnerResolution[] {
  return inputs.map(resolveOwner);
}
