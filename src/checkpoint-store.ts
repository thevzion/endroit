import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { captureCheckpoint, restoreCheckpoint, verifyCheckpoint, type CheckpointManifest, type CheckpointReceipt } from "./checkpoint.ts";
import { fetchCheckpoint, parseContinuityBinding, publishCheckpoint, resolveRemoteCheckpointLine, type CheckpointRemoteReceipt, type ContinuityBinding } from "./checkpoint-remote.ts";
import { hash, stable } from "./compiler/index.ts";
import { resolveCurrentMember, verifyCurrentMemberSources } from "./current-member.ts";

const CHECKPOINT_ID = /^checkpoint:sha256:[a-f0-9]{64}$/;
const MEMBER = /^(workplace:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*)\/member\/([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)$/;
const LINE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export type ContinuityPolicy = { remote: "product" | "separate" | "none"; requirement: "optional" | "required" };
export type ContinuityDescriptor = {
  kind: "ContinuityDescriptor";
  version: 1;
  anchor: string;
  workplace: string;
  capture: string;
  store: string;
  restoreTarget: string;
  line: string;
  policy: ContinuityPolicy;
  binding?: ContinuityBinding;
};
export type ResolvedContinuityDescriptor = Omit<ContinuityDescriptor, "capture" | "store" | "restoreTarget"> & {
  mount: string;
  path: string;
  capture: string;
  store: string;
  restoreTarget: string;
};
export type ContinuityStoreReceipt = {
  kind: "ContinuityStoreReceipt";
  version: 1;
  operation: "create" | "fetch";
  status: "installed" | "unchanged";
  checkpointId: string;
  ownerMember: string;
  line: string;
  parentCheckpoint: string | null;
  lineUpdate: "advanced" | "unchanged" | "diverged" | "not-selected";
  path: string;
  verification: CheckpointReceipt;
};
export type NoContinuityRemoteReceipt = { kind: "ContinuityRemoteReceipt"; version: 1; operation: "push"; status: "no-continuity-remote"; checkpointId: string | null };

export class CheckpointStoreError extends Error {
  constructor(readonly code: "invalid-continuity-descriptor" | "continuity-unavailable" | "continuity-collision" | "no-continuity-remote", message: string) {
    super(message); this.name = "CheckpointStoreError";
  }
}
function fail(code: CheckpointStoreError["code"], message: string): never { throw new CheckpointStoreError(code, message); }
function object(value: unknown, subject: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid-continuity-descriptor", `${subject} must be an object`);
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, allowed: string[], subject: string, required = allowed): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  const missing = required.filter((key) => !(key in value));
  if (unknown.length) fail("invalid-continuity-descriptor", `${subject} has unknown fields: ${unknown.join(", ")}`);
  if (missing.length) fail("invalid-continuity-descriptor", `${subject} is missing fields: ${missing.join(", ")}`);
}
function text(value: unknown, subject: string): string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) fail("invalid-continuity-descriptor", `${subject} must be non-empty text`);
  return value.trim();
}
function semanticRef(value: unknown, subject: string): string {
  const result = text(value, subject);
  if (!/^workplace:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/.test(result)) fail("invalid-continuity-descriptor", `${subject} must be a Workplace ref`);
  return result;
}
function lineName(value: unknown, subject: string): string {
  const result = text(value, subject);
  if (!LINE.test(result)) fail("invalid-continuity-descriptor", `${subject} must be a portable line name`);
  return result;
}
function parseDescriptor(value: unknown, requestDirectory: string): ContinuityDescriptor {
  const source = object(value, "ContinuityDescriptor");
  exact(source, ["kind", "version", "anchor", "workplace", "capture", "store", "restoreTarget", "line", "policy", "binding"], "ContinuityDescriptor", ["kind", "version", "anchor", "workplace", "capture", "store", "restoreTarget", "line", "policy"]);
  if (source.kind !== "ContinuityDescriptor" || source.version !== 1) fail("invalid-continuity-descriptor", "Unsupported ContinuityDescriptor");
  const policySource = object(source.policy, "ContinuityDescriptor.policy");
  exact(policySource, ["remote", "requirement"], "ContinuityDescriptor.policy");
  if (!["product", "separate", "none"].includes(String(policySource.remote)) || !["optional", "required"].includes(String(policySource.requirement))) fail("invalid-continuity-descriptor", "ContinuityDescriptor.policy is invalid");
  const policy = { remote: policySource.remote as ContinuityPolicy["remote"], requirement: policySource.requirement as ContinuityPolicy["requirement"] };
  const binding = source.binding === undefined ? undefined : parseContinuityBinding(source.binding, requestDirectory);
  if (policy.remote === "none" && binding) fail("invalid-continuity-descriptor", "remote none cannot have a ContinuityBinding");
  const workplace = semanticRef(source.workplace, "ContinuityDescriptor.workplace");
  if (binding && (binding.role !== policy.remote || binding.workplace !== workplace)) fail("invalid-continuity-descriptor", "ContinuityBinding role and Workplace must match ContinuityPolicy and descriptor");
  return { kind: "ContinuityDescriptor", version: 1, anchor: semanticRef(source.anchor, "ContinuityDescriptor.anchor"), workplace, capture: text(source.capture, "ContinuityDescriptor.capture"), store: text(source.store, "ContinuityDescriptor.store"), restoreTarget: text(source.restoreTarget, "ContinuityDescriptor.restoreTarget"), line: lineName(source.line, "ContinuityDescriptor.line"), policy, ...(binding ? { binding } : {}) };
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) { if (error instanceof Error && error.message.includes("ENOENT")) return false; throw error; }
}
function inside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !/^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(path));
}
async function physicalDirectory(path: string, expected: string, subject: string): Promise<boolean> {
  if (!await exists(path)) return false;
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory() || await realpath(path) !== expected) fail("continuity-collision", `${subject} must be a physical directory`);
  return true;
}
async function assertPhysicalTree(mount: string, target: string): Promise<void> {
  const canonicalMount = await realpath(mount).catch(() => fail("continuity-unavailable", `${mount} is unavailable`));
  if (!await physicalDirectory(mount, canonicalMount, "Workplace Mount") || !inside(mount, target)) fail("continuity-collision", `${target} must stay inside ${mount}`);
  let current = mount;
  for (const part of relative(mount, target).split(/[\\/]/).filter(Boolean)) {
    current = join(current, part);
    await physicalDirectory(current, resolve(canonicalMount, relative(mount, current)), current);
  }
}
async function ensurePhysicalTree(mount: string, target: string): Promise<string[]> {
  await assertPhysicalTree(mount, target);
  const canonicalMount = await realpath(mount); const created: string[] = []; let current = mount;
  try {
    for (const part of relative(mount, target).split(/[\\/]/).filter(Boolean)) {
      current = join(current, part);
      if (!await exists(current)) { await mkdir(current, { recursive: false }); created.push(current); }
      await physicalDirectory(current, resolve(canonicalMount, relative(mount, current)), current);
    }
    return created;
  } catch (error) { await removeCreatedDirectories(created); throw error; }
}
async function removeCreatedDirectories(paths: string[]): Promise<void> {
  for (const path of [...paths].reverse()) if (await readdir(path, { withFileTypes: true }).then((entries) => entries.length === 0).catch(() => false)) await rm(path, { recursive: true, force: true });
}
async function readJson(path: string, subject: string): Promise<unknown> {
  const info = await lstat(path).catch(() => fail("continuity-unavailable", `${subject} is unavailable: ${path}`));
  if (info.isSymbolicLink() || !info.isFile()) fail("continuity-collision", `${subject} must be a physical file: ${path}`);
  try { return JSON.parse(await readFile(path, "utf8")) as unknown; }
  catch (error) { if (error instanceof SyntaxError) fail("invalid-continuity-descriptor", `${subject} is invalid JSON: ${path}`); throw error; }
}

export async function loadContinuityDescriptor(mountPath: string): Promise<ResolvedContinuityDescriptor> {
  const mount = resolve(mountPath);
  await assertPhysicalTree(mount, mount);
  const local = join(mount, ".endroit/continuity.json");
  const portable = join(mount, "workplace/.workplace/continuity.json");
  const path = await exists(local) ? local : await exists(portable) ? portable : fail("continuity-unavailable", `${mount} has no ContinuityDescriptor`);
  const descriptor = parseDescriptor(await readJson(path, "ContinuityDescriptor"), dirname(path));
  if (path === portable && descriptor.binding) fail("invalid-continuity-descriptor", "A portable ContinuityDescriptor must not contain a machine-local ContinuityBinding");
  const base = dirname(path); const store = resolve(base, descriptor.store); const restoreTarget = resolve(base, descriptor.restoreTarget); const localRoot = resolve(mount, ".endroit");
  if (store === localRoot || !inside(localRoot, store)) fail("continuity-collision", `${store} must be below ${localRoot}`);
  if (restoreTarget === mount || !inside(mount, restoreTarget) || inside(localRoot, restoreTarget)) fail("continuity-collision", `${restoreTarget} must be a non-local-state target inside ${mount}`);
  await assertPhysicalTree(mount, store); await assertPhysicalTree(mount, dirname(restoreTarget));
  return { ...descriptor, mount, path, capture: resolve(base, descriptor.capture), store, restoreTarget };
}

function checkpointId(value: string): string {
  if (!CHECKPOINT_ID.test(value)) fail("invalid-continuity-descriptor", `${value} is not a checkpoint ID`);
  return value;
}
function checkpointPath(store: string, id: string): string { return join(store, checkpointId(id).slice("checkpoint:sha256:".length)); }
type LocalCheckpointLine = { kind: "CheckpointLine"; version: 1; workplace: string; ownerMember: string; line: string; checkpointId: string; parentCheckpoint: string | null; fingerprint: string; closure: string };
function linePath(descriptor: ResolvedContinuityDescriptor, ownerMember: string, line: string): string { return join(descriptor.store, "lines", hash(ownerMember).slice("sha256:".length), `${lineName(line, "line")}.json`); }
function closure(manifest: CheckpointManifest): string { return hash(stable(manifest.repositories.map((repository) => ({ repositoryId: repository.repositoryId, objectClosure: repository.objectClosure })))); }
function lineRecord(manifest: CheckpointManifest): LocalCheckpointLine {
  return { kind: "CheckpointLine", version: 1, workplace: manifest.workplaceRef, ownerMember: manifest.ownerMember, line: manifest.line, checkpointId: manifest.checkpointId, parentCheckpoint: manifest.parentCheckpoint, fingerprint: manifest.portableFingerprint, closure: closure(manifest) };
}
async function readLine(descriptor: ResolvedContinuityDescriptor, ownerMember: string, line: string): Promise<LocalCheckpointLine | undefined> {
  const path = linePath(descriptor, ownerMember, line);
  if (!await exists(path)) return undefined;
  const source = object(await readJson(path, "CheckpointLine"), "CheckpointLine");
  exact(source, ["kind", "version", "workplace", "ownerMember", "line", "checkpointId", "parentCheckpoint", "fingerprint", "closure"], "CheckpointLine");
  if (source.kind !== "CheckpointLine" || source.version !== 1 || source.workplace !== descriptor.workplace || source.ownerMember !== ownerMember || source.line !== line || typeof source.fingerprint !== "string" || !/^sha256:[a-f0-9]{64}$/.test(source.fingerprint) || typeof source.closure !== "string" || !/^sha256:[a-f0-9]{64}$/.test(source.closure) || source.parentCheckpoint !== null && (typeof source.parentCheckpoint !== "string" || !CHECKPOINT_ID.test(source.parentCheckpoint))) fail("continuity-collision", `${path} does not match its Checkpoint Line`);
  return { kind: "CheckpointLine", version: 1, workplace: descriptor.workplace, ownerMember, line, checkpointId: checkpointId(String(source.checkpointId)), parentCheckpoint: source.parentCheckpoint as string | null, fingerprint: source.fingerprint, closure: source.closure };
}
async function writeLine(descriptor: ResolvedContinuityDescriptor, manifest: CheckpointManifest, allowBootstrap: boolean): Promise<"advanced" | "unchanged" | "diverged"> {
  const path = linePath(descriptor, manifest.ownerMember, manifest.line);
  await ensurePhysicalTree(descriptor.mount, dirname(path));
  const current = await readLine(descriptor, manifest.ownerMember, manifest.line);
  const next = lineRecord(manifest); const value = stable(next);
  if (current?.checkpointId === manifest.checkpointId) return "unchanged";
  if (current && current.checkpointId !== manifest.parentCheckpoint) return "diverged";
  if (!current && manifest.parentCheckpoint && !allowBootstrap) return "diverged";
  const temporary = `${path}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try { await writeFile(temporary, value, { flag: "wx" }); await rename(temporary, path); }
  finally { await rm(temporary, { recursive: false, force: true }); }
  return "advanced";
}
async function ownerForLine(descriptor: ResolvedContinuityDescriptor, explicit?: string): Promise<string> {
  if (explicit) {
    const match = MEMBER.exec(explicit);
    if (!match || match[1] !== descriptor.workplace || !match[2]) fail("invalid-continuity-descriptor", `${explicit} is not a Member of ${descriptor.workplace}`);
    await verifyCurrentMemberSources({ workplaceMount: descriptor.mount, workplace: descriptor.workplace, member: explicit, desk: `${descriptor.workplace}/desk/${match[2]}` });
    return explicit;
  }
  const resolved = await resolveCurrentMember({ anchorMount: descriptor.mount, anchor: descriptor.anchor, workplace: descriptor.workplace });
  if (resolved.status !== "resolved") fail("continuity-unavailable", `Current Member is unresolved for ${descriptor.workplace}`);
  return resolved.member;
}
async function packageAt(descriptor: ResolvedContinuityDescriptor, id: string): Promise<{ path: string; manifest: CheckpointManifest; receipt: CheckpointReceipt }> {
  const path = checkpointPath(descriptor.store, id);
  const info = await lstat(path).catch(() => fail("continuity-unavailable", `${id} is not in the local store`));
  if (info.isSymbolicLink() || !info.isDirectory() || await realpath(path) !== resolve(await realpath(descriptor.store), relative(descriptor.store, path))) fail("continuity-collision", `${path} must be a physical checkpoint package`);
  const verified = await verifyCheckpoint(path);
  if (verified.manifest.checkpointId !== id || verified.manifest.workplaceRef !== descriptor.workplace) fail("continuity-collision", `${path} does not contain the declared Workplace checkpoint`);
  return { path, manifest: verified.manifest, receipt: verified.receipt };
}
async function installPackage(descriptor: ResolvedContinuityDescriptor, source: string, operation: "create" | "fetch", selectLine: "advance" | "bootstrap" | false): Promise<ContinuityStoreReceipt> {
  const observed = await verifyCheckpoint(source);
  if (observed.manifest.workplaceRef !== descriptor.workplace) fail("continuity-collision", `${observed.manifest.checkpointId} belongs to another Workplace`);
  const target = checkpointPath(descriptor.store, observed.manifest.checkpointId); let status: ContinuityStoreReceipt["status"] = "installed";
  if (await exists(target)) {
    const existing = await packageAt(descriptor, observed.manifest.checkpointId);
    if (stable(existing.manifest) !== stable(observed.manifest)) fail("continuity-collision", `${target} contains another checkpoint`);
    await rm(source, { recursive: true, force: true }); status = "unchanged";
  } else await rename(source, target);
  const verification = await verifyCheckpoint(target);
  const lineUpdate = selectLine ? await writeLine(descriptor, verification.manifest, selectLine === "bootstrap") : "not-selected";
  return { kind: "ContinuityStoreReceipt", version: 1, operation, status, checkpointId: verification.manifest.checkpointId, ownerMember: verification.manifest.ownerMember, line: verification.manifest.line, parentCheckpoint: verification.manifest.parentCheckpoint, lineUpdate, path: target, verification: verification.receipt };
}
async function withStore<T>(descriptor: ResolvedContinuityDescriptor, effect: () => Promise<T>): Promise<T> {
  const created = await ensurePhysicalTree(descriptor.mount, descriptor.store);
  try { return await effect(); } catch (error) { await removeCreatedDirectories(created); throw error; }
}

export async function createLocalCheckpoint(descriptor: ResolvedContinuityDescriptor, options: { member?: string; line?: string } = {}): Promise<ContinuityStoreReceipt> {
  return withStore(descriptor, async () => {
    const ownerMember = await ownerForLine(descriptor, options.member); const selectedLine = lineName(options.line ?? descriptor.line, "Checkpoint Line");
    const previousLine = await readLine(descriptor, ownerMember, selectedLine); const previousId = previousLine?.checkpointId; const source = object(await readJson(descriptor.capture, "CheckpointCaptureRequest"), "CheckpointCaptureRequest");
    const temporary = join(descriptor.store, `.capture-${crypto.randomUUID()}`);
    try {
      const captured = await captureCheckpoint({ ...source, ownerMember, line: selectedLine, parentCheckpoint: previousId ?? null, output: temporary }, { requestDirectory: dirname(descriptor.capture) });
      if (previousId) {
        const previous = await packageAt(descriptor, previousId);
        if (previous.receipt.portableFingerprint === captured.receipt.portableFingerprint) {
          await rm(captured.path, { recursive: true, force: true });
          return { kind: "ContinuityStoreReceipt", version: 1, operation: "create", status: "unchanged", checkpointId: previous.manifest.checkpointId, ownerMember: previous.manifest.ownerMember, line: previous.manifest.line, parentCheckpoint: previous.manifest.parentCheckpoint, lineUpdate: "unchanged", path: previous.path, verification: previous.receipt };
        }
      }
      return await installPackage(descriptor, captured.path, "create", "advance");
    } finally { await rm(temporary, { recursive: true, force: true }); }
  });
}

export async function selectLocalCheckpoint(descriptor: ResolvedContinuityDescriptor, selector?: string, options: { member?: string; line?: string } = {}): Promise<{ path: string; manifest: CheckpointManifest; receipt: CheckpointReceipt }> {
  await assertPhysicalTree(descriptor.mount, descriptor.store);
  let id = selector;
  if (selector === undefined) {
    const owner = await ownerForLine(descriptor, options.member); const selectedLine = lineName(options.line ?? descriptor.line, "Checkpoint Line");
    id = (await readLine(descriptor, owner, selectedLine))?.checkpointId ?? fail("continuity-unavailable", `${owner} has no local checkpoint on line ${selectedLine}`);
  }
  return packageAt(descriptor, checkpointId(id!));
}

export async function observeLocalCheckpoint(descriptor: ResolvedContinuityDescriptor, selector: string): Promise<{ path: string; checkpointId: string } | undefined> {
  await assertPhysicalTree(descriptor.mount, descriptor.store);
  const id = selector;
  const path = checkpointPath(descriptor.store, checkpointId(id));
  if (!await exists(path)) return undefined;
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory() || await realpath(path) !== resolve(await realpath(descriptor.store), relative(descriptor.store, path))) fail("continuity-collision", `${path} must be a physical checkpoint package`);
  return { path, checkpointId: id };
}

function fetchRequest(descriptor: ResolvedContinuityDescriptor, ownerMember: string, line: string): unknown {
  if (!descriptor.binding) fail("no-continuity-remote", "No local ContinuityBinding is configured");
  return { kind: "CheckpointFetchRequest", version: 1, binding: descriptor.binding, ownerMember, line };
}
export async function pushContinuityCheckpoint(descriptor: ResolvedContinuityDescriptor, selector?: string, options: { member?: string; line?: string } = {}): Promise<{ receipt: CheckpointRemoteReceipt | NoContinuityRemoteReceipt }> {
  const selectedId = selector === undefined ? undefined : checkpointId(selector);
  if (!descriptor.binding || descriptor.policy.remote === "none") return { receipt: { kind: "ContinuityRemoteReceipt", version: 1, operation: "push", status: "no-continuity-remote", checkpointId: selectedId ?? null } };
  const local = await selectLocalCheckpoint(descriptor, selectedId, options);
  return publishCheckpoint(local.path, { kind: "CheckpointPublishRequest", version: 1, binding: descriptor.binding, ownerMember: local.manifest.ownerMember, line: local.manifest.line, parentCheckpoint: local.manifest.parentCheckpoint });
}
export async function fetchContinuityCheckpoint(descriptor: ResolvedContinuityDescriptor, selector?: string, options: { member?: string; line?: string } = {}): Promise<{ store: ContinuityStoreReceipt; remote: CheckpointRemoteReceipt }> {
  if (!descriptor.binding || descriptor.policy.remote === "none") fail("no-continuity-remote", "No local ContinuityBinding is configured");
  return withStore(descriptor, async () => {
    const owner = await ownerForLine(descriptor, options.member); const selectedLine = lineName(options.line ?? descriptor.line, "Checkpoint Line"); const request = fetchRequest(descriptor, owner, selectedLine);
    const id = selector === undefined ? (await resolveRemoteCheckpointLine(request))?.checkpointId ?? fail("continuity-unavailable", `${owner} has no remote checkpoint on line ${selectedLine}`) : checkpointId(selector);
    const temporary = join(descriptor.store, `.fetch-${crypto.randomUUID()}`);
    try { const fetched = await fetchCheckpoint(id, request, temporary); return { store: await installPackage(descriptor, fetched.path, "fetch", selector === undefined ? "bootstrap" : false), remote: fetched.receipt }; }
    finally { await rm(temporary, { recursive: true, force: true }); }
  });
}
export async function restoreContinuityCheckpoint(descriptor: ResolvedContinuityDescriptor, selector?: string, options: { member?: string; line?: string } = {}): Promise<{ path: string; receipt: CheckpointReceipt }> {
  const local = await selectLocalCheckpoint(descriptor, selector, options); const created = await ensurePhysicalTree(descriptor.mount, dirname(descriptor.restoreTarget));
  try { return await restoreCheckpoint(local.path, descriptor.restoreTarget); }
  catch (error) { await removeCreatedDirectories(created); throw error; }
}
