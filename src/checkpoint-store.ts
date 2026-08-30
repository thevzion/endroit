import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { captureCheckpoint, restoreCheckpoint, verifyCheckpoint, type CheckpointReceipt } from "./checkpoint.ts";
import { fetchCheckpoint, publishCheckpoint, resolveLatestRemoteCheckpoint, type CheckpointRemoteReceipt } from "./checkpoint-remote.ts";
import { stable } from "./compiler/index.ts";

const CHECKPOINT_ID = /^checkpoint:sha256:[a-f0-9]{64}$/;

export type ContinuityDescriptor = {
  kind: "ContinuityDescriptor";
  version: 1;
  capture: string;
  store: string;
  restoreTarget: string;
  remote?: { publish: string; fetch: string };
  setupContinuity: "optional" | "required";
};

export type ResolvedContinuityDescriptor = Omit<ContinuityDescriptor, "capture" | "store" | "restoreTarget" | "remote"> & {
  mount: string;
  path: string;
  capture: string;
  store: string;
  restoreTarget: string;
  remote?: { publish: string; fetch: string };
};

export type ContinuityStoreReceipt = {
  kind: "ContinuityStoreReceipt";
  version: 1;
  operation: "create" | "fetch";
  status: "installed" | "unchanged";
  checkpointId: string;
  path: string;
  latest: true;
  verification: CheckpointReceipt;
};

export type NoContinuityRemoteReceipt = {
  kind: "ContinuityRemoteReceipt";
  version: 1;
  operation: "push";
  status: "no-continuity-remote";
  selector: string;
};

export class CheckpointStoreError extends Error {
  constructor(readonly code: "invalid-continuity-descriptor" | "continuity-unavailable" | "continuity-collision" | "no-continuity-remote", message: string) {
    super(message);
    this.name = "CheckpointStoreError";
  }
}

function fail(code: CheckpointStoreError["code"], message: string): never {
  throw new CheckpointStoreError(code, message);
}

function object(value: unknown, subject: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid-continuity-descriptor", `${subject} must be an object`);
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, keys: string[], subject: string): void {
  const unknown = Object.keys(value).filter((key) => !keys.includes(key));
  const missing = keys.filter((key) => !(key in value));
  if (unknown.length) fail("invalid-continuity-descriptor", `${subject} has unknown fields: ${unknown.join(", ")}`);
  if (missing.length) fail("invalid-continuity-descriptor", `${subject} is missing fields: ${missing.join(", ")}`);
}

function text(value: unknown, subject: string): string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) fail("invalid-continuity-descriptor", `${subject} must be non-empty text`);
  return value.trim();
}

function parseDescriptor(value: unknown): ContinuityDescriptor {
  const source = object(value, "ContinuityDescriptor");
  exact(source, ["kind", "version", "capture", "store", "restoreTarget", ...(source.remote === undefined ? [] : ["remote"]), "setupContinuity"], "ContinuityDescriptor");
  if (source.kind !== "ContinuityDescriptor" || source.version !== 1 || !["optional", "required"].includes(String(source.setupContinuity))) fail("invalid-continuity-descriptor", "Unsupported ContinuityDescriptor");
  let remote: ContinuityDescriptor["remote"];
  if (source.remote !== undefined) {
    const value = object(source.remote, "ContinuityDescriptor.remote");
    exact(value, ["publish", "fetch"], "ContinuityDescriptor.remote");
    remote = { publish: text(value.publish, "ContinuityDescriptor.remote.publish"), fetch: text(value.fetch, "ContinuityDescriptor.remote.fetch") };
  }
  return {
    kind: "ContinuityDescriptor",
    version: 1,
    capture: text(source.capture, "ContinuityDescriptor.capture"),
    store: text(source.store, "ContinuityDescriptor.store"),
    restoreTarget: text(source.restoreTarget, "ContinuityDescriptor.restoreTarget"),
    ...(remote ? { remote } : {}),
    setupContinuity: source.setupContinuity as "optional" | "required",
  };
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) {
    if (error instanceof Error && error.message.includes("ENOENT")) return false;
    throw error;
  }
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
  const canonicalMount = await realpath(mount);
  const created: string[] = [];
  let current = mount;
  try {
    for (const part of relative(mount, target).split(/[\\/]/).filter(Boolean)) {
      current = join(current, part);
      if (!await exists(current)) {
        await mkdir(current, { recursive: false });
        created.push(current);
      }
      await physicalDirectory(current, resolve(canonicalMount, relative(mount, current)), current);
    }
    return created;
  } catch (error) {
    await removeCreatedDirectories(created);
    throw error;
  }
}

async function removeCreatedDirectories(paths: string[]): Promise<void> {
  for (const path of [...paths].reverse()) {
    if (await readdir(path, { withFileTypes: true }).then((entries) => entries.length === 0).catch(() => false)) await rm(path, { recursive: false, force: true });
  }
}

async function readJson(path: string, subject: string): Promise<unknown> {
  const info = await lstat(path).catch(() => fail("continuity-unavailable", `${subject} is unavailable: ${path}`));
  if (info.isSymbolicLink() || !info.isFile()) fail("continuity-collision", `${subject} must be a physical file: ${path}`);
  try { return JSON.parse(await readFile(path, "utf8")) as unknown; }
  catch (error) {
    if (error instanceof SyntaxError) fail("invalid-continuity-descriptor", `${subject} is invalid JSON: ${path}`);
    throw error;
  }
}

export async function loadContinuityDescriptor(mountPath: string): Promise<ResolvedContinuityDescriptor> {
  const mount = resolve(mountPath);
  await assertPhysicalTree(mount, mount);
  const candidates = [join(mount, ".endroit/continuity.json"), join(mount, "workplace/.workplace/continuity.json")];
  let path: string | undefined;
  for (const candidate of candidates) if (await exists(candidate)) { path = candidate; break; }
  if (!path) fail("continuity-unavailable", `${mount} has no ContinuityDescriptor`);
  const descriptor = parseDescriptor(await readJson(path, "ContinuityDescriptor"));
  const base = dirname(path);
  const store = resolve(base, descriptor.store);
  const restoreTarget = resolve(base, descriptor.restoreTarget);
  const localRoot = resolve(mount, ".endroit");
  if (store === localRoot || !inside(localRoot, store)) fail("continuity-collision", `${store} must be below ${localRoot}`);
  if (restoreTarget === mount || !inside(mount, restoreTarget) || inside(localRoot, restoreTarget)) fail("continuity-collision", `${restoreTarget} must be a non-local-state target inside ${mount}`);
  await assertPhysicalTree(mount, store);
  await assertPhysicalTree(mount, dirname(restoreTarget));
  return {
    ...descriptor,
    mount,
    path,
    capture: resolve(base, descriptor.capture),
    store,
    restoreTarget,
    ...(descriptor.remote ? { remote: { publish: resolve(base, descriptor.remote.publish), fetch: resolve(base, descriptor.remote.fetch) } } : {}),
  };
}

function checkpointId(value: string): string {
  if (!CHECKPOINT_ID.test(value)) fail("invalid-continuity-descriptor", `${value} is not a checkpoint ID`);
  return value;
}

function checkpointPath(store: string, id: string): string {
  return join(store, checkpointId(id).slice("checkpoint:sha256:".length));
}

async function writeLatest(descriptor: ResolvedContinuityDescriptor, id: string): Promise<void> {
  const path = join(descriptor.store, "latest.json");
  const value = stable({ kind: "ContinuityLatest", version: 1, checkpointId: checkpointId(id) });
  if (await exists(path)) {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile()) fail("continuity-collision", `${path} must be a physical file`);
    if (await readFile(path, "utf8") === value) return;
  }
  const temporary = `${path}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    await writeFile(temporary, value, { flag: "wx" });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { recursive: false, force: true });
  }
}

async function readLatest(descriptor: ResolvedContinuityDescriptor): Promise<string> {
  const path = join(descriptor.store, "latest.json");
  const source = object(await readJson(path, "ContinuityLatest"), "ContinuityLatest");
  exact(source, ["kind", "version", "checkpointId"], "ContinuityLatest");
  if (source.kind !== "ContinuityLatest" || source.version !== 1) fail("invalid-continuity-descriptor", "Unsupported ContinuityLatest");
  return checkpointId(String(source.checkpointId));
}

async function installPackage(descriptor: ResolvedContinuityDescriptor, source: string, operation: "create" | "fetch"): Promise<ContinuityStoreReceipt> {
  const observed = await verifyCheckpoint(source);
  const target = checkpointPath(descriptor.store, observed.manifest.checkpointId);
  let status: ContinuityStoreReceipt["status"] = "installed";
  if (await exists(target)) {
    const info = await lstat(target);
    if (info.isSymbolicLink() || !info.isDirectory() || await realpath(target) !== resolve(await realpath(descriptor.store), relative(descriptor.store, target))) fail("continuity-collision", `${target} must be a physical checkpoint package`);
    const existing = await verifyCheckpoint(target);
    if (existing.manifest.checkpointId !== observed.manifest.checkpointId) fail("continuity-collision", `${target} contains another checkpoint`);
    await rm(source, { recursive: true, force: true });
    status = "unchanged";
  } else {
    await rename(source, target);
  }
  const verification = await verifyCheckpoint(target);
  await writeLatest(descriptor, verification.manifest.checkpointId);
  return { kind: "ContinuityStoreReceipt", version: 1, operation, status, checkpointId: verification.manifest.checkpointId, path: target, latest: true, verification: verification.receipt };
}

async function withStore<T>(descriptor: ResolvedContinuityDescriptor, effect: () => Promise<T>): Promise<T> {
  const created = await ensurePhysicalTree(descriptor.mount, descriptor.store);
  try { return await effect(); }
  catch (error) {
    await removeCreatedDirectories(created);
    throw error;
  }
}

export async function createLocalCheckpoint(descriptor: ResolvedContinuityDescriptor): Promise<ContinuityStoreReceipt> {
  return withStore(descriptor, async () => {
    const source = object(await readJson(descriptor.capture, "CheckpointCaptureRequest"), "CheckpointCaptureRequest");
    const temporary = join(descriptor.store, `.capture-${crypto.randomUUID()}`);
    try {
      const captured = await captureCheckpoint({ ...source, output: temporary }, { requestDirectory: dirname(descriptor.capture) });
      return await installPackage(descriptor, captured.path, "create");
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });
}

export async function selectLocalCheckpoint(descriptor: ResolvedContinuityDescriptor, selector: string = "latest"): Promise<{ path: string; receipt: CheckpointReceipt }> {
  await assertPhysicalTree(descriptor.mount, descriptor.store);
  const id = selector === "latest" ? await readLatest(descriptor) : checkpointId(selector);
  const path = checkpointPath(descriptor.store, id);
  const info = await lstat(path).catch(() => fail("continuity-unavailable", `${id} is not in the local store`));
  if (info.isSymbolicLink() || !info.isDirectory() || await realpath(path) !== resolve(await realpath(descriptor.store), relative(descriptor.store, path))) fail("continuity-collision", `${path} must be a physical checkpoint package`);
  const verified = await verifyCheckpoint(path);
  if (verified.manifest.checkpointId !== id) fail("continuity-collision", `${path} does not contain ${id}`);
  return { path, receipt: verified.receipt };
}

export async function observeLocalCheckpoint(descriptor: ResolvedContinuityDescriptor, selector: string): Promise<{ path: string; checkpointId: string } | undefined> {
  await assertPhysicalTree(descriptor.mount, descriptor.store);
  let id: string;
  if (selector === "latest") {
    if (!await exists(join(descriptor.store, "latest.json"))) return undefined;
    id = await readLatest(descriptor);
  } else id = checkpointId(selector);
  const path = checkpointPath(descriptor.store, id);
  if (!await exists(path)) return undefined;
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory() || await realpath(path) !== resolve(await realpath(descriptor.store), relative(descriptor.store, path))) fail("continuity-collision", `${path} must be a physical checkpoint package`);
  return { path, checkpointId: id };
}

export async function pushContinuityCheckpoint(descriptor: ResolvedContinuityDescriptor, selector: string = "latest"): Promise<{ receipt: CheckpointRemoteReceipt | NoContinuityRemoteReceipt }> {
  if (!descriptor.remote) return { receipt: { kind: "ContinuityRemoteReceipt", version: 1, operation: "push", status: "no-continuity-remote", selector } };
  const local = await selectLocalCheckpoint(descriptor, selector);
  const request = await readJson(descriptor.remote.publish, "CheckpointPublishRequest");
  return publishCheckpoint(local.path, request, { requestDirectory: dirname(descriptor.remote.publish) });
}

export async function fetchContinuityCheckpoint(descriptor: ResolvedContinuityDescriptor, selector: string): Promise<{ store: ContinuityStoreReceipt; remote: CheckpointRemoteReceipt }> {
  if (!descriptor.remote) fail("no-continuity-remote", "ContinuityDescriptor has no remote");
  return withStore(descriptor, async () => {
    const request = await readJson(descriptor.remote!.fetch, "CheckpointFetchRequest");
    const id = selector === "latest"
      ? (await resolveLatestRemoteCheckpoint(request, { requestDirectory: dirname(descriptor.remote!.fetch) }))?.checkpointId ?? fail("continuity-unavailable", "Continuity Remote has no latest checkpoint")
      : checkpointId(selector);
    const temporary = join(descriptor.store, `.fetch-${crypto.randomUUID()}`);
    try {
      const fetched = await fetchCheckpoint(id, request, temporary, { requestDirectory: dirname(descriptor.remote!.fetch) });
      return { store: await installPackage(descriptor, fetched.path, "fetch"), remote: fetched.receipt };
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });
}

export async function restoreContinuityCheckpoint(descriptor: ResolvedContinuityDescriptor, selector: string = "latest"): Promise<{ path: string; receipt: CheckpointReceipt }> {
  const local = await selectLocalCheckpoint(descriptor, selector);
  const created = await ensurePhysicalTree(descriptor.mount, dirname(descriptor.restoreTarget));
  try { return await restoreCheckpoint(local.path, descriptor.restoreTarget); }
  catch (error) {
    await removeCreatedDirectories(created);
    throw error;
  }
}
