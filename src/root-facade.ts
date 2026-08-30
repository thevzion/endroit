import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { CheckpointStoreError, loadContinuityDescriptor, observeLocalCheckpoint, type ResolvedContinuityDescriptor } from "./checkpoint-store.ts";
import { checkWorkplaceMount, discoverMount, stable, type CheckResult } from "./compiler/index.ts";
import { resolveCurrentMember } from "./current-member.ts";
import { applyWorkplaceRecovery, normalizeWorkplaceRecoveryRequest, planWorkplaceRecovery, type WorkplaceRecoveryPlan, type WorkplaceRecoveryReceipt, type WorkplaceRecoveryRequest } from "./recovery.ts";

const MEMBER = /^(workplace:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*)\/member\/([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)$/;

export type RecoverySource = { path: string; provenance: "explicit" | "local" | "portable"; request: WorkplaceRecoveryRequest };

export type RootSetupResult = {
  mount: string;
  source: RecoverySource["provenance"];
  status: "ready" | "pending-member" | "degraded" | "blocked-continuity";
  plan: WorkplaceRecoveryPlan;
  receipt: WorkplaceRecoveryReceipt;
  continuity: RootContinuityStatus;
};

export type RootContinuityStatus = {
  status: "available" | "degraded" | "blocked";
  requirement: "optional" | "required" | "undeclared";
  missing: Array<{ id: string; checkpointId: string; action: string }>;
};

export type RootStatus = {
  kind: "WorkplaceRootStatus";
  version: 1;
  mount: string;
  workplace: string;
  check: CheckResult;
  recovery: { status: "declared"; provenance: RecoverySource["provenance"]; position: WorkplaceRecoveryPlan["position"]; continuity: RootContinuityStatus & { verification: "not-run" } } | { status: "unavailable"; error: string };
};

export class RootFacadeError extends Error {
  constructor(readonly code: "root-unavailable" | "recovery-request-unavailable" | "invalid-bootstrap-ref", message: string) {
    super(message);
    this.name = "RootFacadeError";
  }
}

function fail(code: RootFacadeError["code"], message: string): never { throw new RootFacadeError(code, message); }

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) {
    if (error instanceof Error && error.message.includes("ENOENT")) return false;
    throw error;
  }
}

export async function resolveWorkplaceRoot(start = process.cwd()): Promise<string> {
  const discovered = await discoverMount(resolve(start)) ?? fail("root-unavailable", `No Workplace Mount found from ${resolve(start)}`);
  return await realpath(discovered).catch(() => fail("root-unavailable", `${discovered} is unavailable`));
}

async function workplaceIdentity(mount: string): Promise<string> {
  try {
    const value = JSON.parse(await readFile(join(mount, "workplace/workplace.json"), "utf8")) as Record<string, unknown>;
    if (value.kind !== "WorkplaceBuildContract" || value.version !== 2 || typeof value.workplace !== "string") fail("root-unavailable", `${mount} has no WorkplaceBuildContract/2`);
    return value.workplace;
  } catch (error) {
    if (error instanceof RootFacadeError) throw error;
    fail("root-unavailable", `${mount} has no readable Workplace identity`);
  }
}

async function recoveryFile(path: string, provenance: RecoverySource["provenance"]): Promise<RecoverySource> {
  const resolved = resolve(path);
  const info = await lstat(resolved).catch(() => fail("recovery-request-unavailable", `${resolved} is unavailable`));
  if (info.isSymbolicLink() || !info.isFile()) fail("recovery-request-unavailable", `${resolved} must be a physical Recovery Request`);
  const canonical = await realpath(resolved).catch(() => fail("recovery-request-unavailable", `${resolved} is unavailable`));
  let value: unknown;
  try { value = JSON.parse(await readFile(canonical, "utf8")) as unknown; }
  catch (error) { fail("recovery-request-unavailable", `${canonical} is invalid JSON: ${error instanceof Error ? error.message : String(error)}`); }
  return { path: canonical, provenance, request: normalizeWorkplaceRecoveryRequest(value, dirname(canonical)) };
}

async function assertRecoveryFamily(mount: string, provenance: "local" | "portable"): Promise<void> {
  const canonicalMount = await realpath(mount).catch(() => fail("recovery-request-unavailable", `${mount} is unavailable`));
  const directories = provenance === "local"
    ? [join(mount, ".endroit")]
    : [join(mount, "workplace"), join(mount, "workplace/.workplace")];
  for (const directory of directories) {
    const info = await lstat(directory).catch(() => fail("recovery-request-unavailable", `${directory} is unavailable`));
    const expected = join(canonicalMount, directory.slice(mount.length + 1));
    if (info.isSymbolicLink() || !info.isDirectory() || await realpath(directory) !== expected) fail("recovery-request-unavailable", `${directory} must be a physical Recovery Request family`);
  }
}

export async function selectRecoveryRequest(mount: string, explicit?: string): Promise<RecoverySource> {
  if (explicit) return recoveryFile(explicit, "explicit");
  const local = join(mount, ".endroit/recovery.json");
  if (await exists(local)) {
    await assertRecoveryFamily(mount, "local");
    return recoveryFile(local, "local");
  }
  const portable = join(mount, "workplace/.workplace/recovery.json");
  if (await exists(portable)) {
    await assertRecoveryFamily(mount, "portable");
    return recoveryFile(portable, "portable");
  }
  fail("recovery-request-unavailable", `${mount} has no declared Recovery Request`);
}

function asPosition(member: string): WorkplaceRecoveryRequest["position"] {
  const match = MEMBER.exec(member);
  if (!match?.[1] || !match[2]) fail("invalid-bootstrap-ref", "--as must be one fully qualified Member ref");
  return { workplace: match[1], member, desk: `${match[1]}/desk/${match[2]}` };
}

async function assertLocalOverlay(mount: string, path: string): Promise<void> {
  const canonicalMount = await realpath(mount);
  const local = dirname(path);
  if (await exists(local)) {
    const info = await lstat(local);
    if (info.isSymbolicLink() || !info.isDirectory() || await realpath(local) !== join(canonicalMount, ".endroit")) fail("invalid-bootstrap-ref", `${local} must be a physical local-state directory`);
  }
  if (await exists(path)) {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile()) fail("invalid-bootstrap-ref", `${path} must be a physical local Recovery Request`);
  }
}

async function rememberRecoveryRequest(mount: string, request: WorkplaceRecoveryRequest): Promise<void> {
  const path = join(mount, ".endroit/recovery.json");
  await assertLocalOverlay(mount, path);
  const bytes = stable(request);
  if (await exists(path) && await readFile(path, "utf8") === bytes) return;
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    await writeFile(temporary, bytes, { flag: "wx" });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { recursive: false, force: true });
  }
}

async function continuityDescriptor(mount: string): Promise<ResolvedContinuityDescriptor | undefined> {
  try { return await loadContinuityDescriptor(mount); }
  catch (error) {
    if (error instanceof CheckpointStoreError && error.code === "continuity-unavailable") return undefined;
    throw error;
  }
}

async function prepareContinuity(mount: string, request: WorkplaceRecoveryRequest): Promise<{ request: WorkplaceRecoveryRequest; status: RootContinuityStatus }> {
  const descriptor = await continuityDescriptor(mount);
  const checkpoints: WorkplaceRecoveryRequest["checkpoints"] = [];
  const missing: RootContinuityStatus["missing"] = [];
  for (const checkpoint of request.checkpoints) {
    let path = checkpoint.checkpoint;
    if (!await exists(path) && descriptor) {
      const local = await observeLocalCheckpoint(descriptor, checkpoint.checkpointId);
      if (local) path = local.path;
    }
    if (await exists(path)) checkpoints.push({ ...checkpoint, checkpoint: path });
    else missing.push({ id: checkpoint.id, checkpointId: checkpoint.checkpointId, action: `endroit checkpoint fetch ${checkpoint.checkpointId} --json` });
  }
  const requirement = descriptor?.policy.requirement ?? "undeclared";
  return {
    request: { ...request, checkpoints },
    status: { status: missing.length ? requirement === "required" ? "blocked" : "degraded" : "available", requirement, missing },
  };
}

export async function planRootSetup(options: { start?: string; from?: string; with?: string; as?: string } = {}): Promise<{ mount: string; recovery: RecoverySource; plan: WorkplaceRecoveryPlan; remember: boolean; continuity: RootContinuityStatus }> {
  if (options.from && options.with) fail("invalid-bootstrap-ref", "setup accepts either --from or --with, not both");
  const mount = await resolveWorkplaceRoot(options.start);
  const recovery = await selectRecoveryRequest(mount, options.with ?? options.from);
  const request = options.as ? { ...recovery.request, position: asPosition(options.as) } : recovery.request;
  if (options.with) await assertLocalOverlay(mount, join(mount, ".endroit/recovery.json"));
  const continuity = await prepareContinuity(mount, request);
  const plan = await planWorkplaceRecovery(continuity.request, {
    anchorMount: mount,
    requestDirectory: dirname(recovery.path),
    ...(continuity.status.status === "blocked" ? { positionBlock: { reason: "required-continuity" as const, checkpoints: continuity.status.missing.map((item) => item.checkpointId) } } : {}),
  });
  return { mount, recovery: { ...recovery, request }, plan, remember: Boolean(options.with), continuity: continuity.status };
}

export async function setupFromRoot(options: { start?: string; from?: string; with?: string; as?: string } = {}): Promise<RootSetupResult> {
  const prepared = await planRootSetup(options);
  const revalidated = await planRootSetup(options);
  const receipt = await applyWorkplaceRecovery(revalidated.plan, prepared.plan.revision);
  if (prepared.remember) await rememberRecoveryRequest(prepared.mount, prepared.recovery.request);
  const status = revalidated.continuity.status === "degraded" && receipt.status === "ready" ? "degraded" : receipt.status;
  return { mount: revalidated.mount, source: revalidated.recovery.provenance, status, plan: revalidated.plan, receipt, continuity: revalidated.continuity };
}

export async function statusFromRoot(start = process.cwd()): Promise<RootStatus> {
  const mount = await resolveWorkplaceRoot(start);
  const workplace = await workplaceIdentity(mount);
  const check = await checkWorkplaceMount({ mount });
  try {
    const recovery = await selectRecoveryRequest(mount);
    const continuity = await prepareContinuity(mount, recovery.request);
    const position = await resolveCurrentMember({ anchorMount: mount, anchor: recovery.request.anchor, ...recovery.request.position });
    return { kind: "WorkplaceRootStatus", version: 1, mount, workplace, check, recovery: { status: "declared", provenance: recovery.provenance, position, continuity: { ...continuity.status, verification: "not-run" } } };
  } catch (error) {
    return { kind: "WorkplaceRootStatus", version: 1, mount, workplace, check, recovery: { status: "unavailable", error: error instanceof Error ? error.message : String(error) } };
  }
}
