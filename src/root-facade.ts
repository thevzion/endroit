import { cp, lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { BootstrapRefError, isBootstrapRef, resolveBootstrapRef, type BootstrapRefReceipt } from "./bootstrap-ref.ts";
import { CheckpointStoreError, fetchContinuityCheckpoint, loadContinuityDescriptor, observeLocalCheckpoint, type ResolvedContinuityDescriptor } from "./checkpoint-store.ts";
import { assertCheckpointGitPlacement, CheckpointError } from "./checkpoint.ts";
import { checkWorkplaceMount, discoverMount, hash, stable, type CheckResult } from "./compiler/index.ts";
import { resolveCurrentMember, verifyCurrentMemberSources } from "./current-member.ts";
import { applyWorkplaceRecovery, normalizeWorkplaceRecoveryRequest, planWorkplaceRecovery, type WorkplaceRecoveryPlan, type WorkplaceRecoveryReceipt, type WorkplaceRecoveryRequest } from "./recovery.ts";

const MEMBER = /^(workplace:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*)\/member\/([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)$/;
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export type RecoverySource = { path: string; provenance: "explicit" | "local" | "portable" | "bootstrap"; request: WorkplaceRecoveryRequest };

export type RootSetupResult = {
  mount: string;
  source: RecoverySource["provenance"];
  status: "ready" | "pending-member" | "degraded" | "blocked-continuity";
  plan: WorkplaceRecoveryPlan;
  receipt: WorkplaceRecoveryReceipt;
  continuity: RootContinuityStatus;
  bootstrap?: BootstrapRefReceipt;
};

export type RootContinuityStatus = {
  status: "available" | "degraded" | "blocked";
  requirement: "optional" | "required" | "undeclared";
  missing: Array<{ id: string; workplace: string; requirement: "optional" | "required" | "undeclared"; checkpointId: string; action: string }>;
  fetched?: Array<{ id: string; workplace: string; requirement: "optional" | "required" | "undeclared"; checkpointId: string; status: "installed" | "unchanged"; remoteStatus: "fetched-verified" }>;
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
  constructor(readonly code: "root-unavailable" | "recovery-request-unavailable" | "invalid-bootstrap-ref" | "bootstrap-ref-unavailable", message: string) {
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

function inside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !/^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(path));
}

function bootstrapPaths(source: RecoverySource): string[] {
  return [...new Set([
    source.path,
    source.request.setup,
    ...source.request.sites.map((site) => site.request),
    ...(source.request.continuity ?? []).map((entry) => entry.descriptor),
    ...source.request.checkpoints.map((checkpoint) => checkpoint.checkpoint),
  ])];
}

async function assertPhysicalTree(path: string, root: string): Promise<void> {
  const info = await lstat(path).catch(() => fail("bootstrap-ref-unavailable", `${path} is unavailable in the Bootstrap package`));
  if (info.isSymbolicLink() || await realpath(path) !== resolve(path)) fail("invalid-bootstrap-ref", `${path} must be physical`);
  if (info.isDirectory()) {
    for (const entry of await readdir(path, { withFileTypes: true })) await assertPhysicalTree(join(path, entry.name), root);
  } else if (!info.isFile()) fail("invalid-bootstrap-ref", `${path} must be a regular file or directory`);
  if (!inside(root, resolve(path))) fail("invalid-bootstrap-ref", `${path} escapes the Bootstrap package`);
}

async function physicalTreeDigest(root: string): Promise<string> {
  const canonical = await realpath(root);
  const entries: Array<{ path: string; kind: "directory" | "file"; bytes?: string }> = [];
  const visit = async (path: string): Promise<void> => {
    const info = await lstat(path);
    if (info.isSymbolicLink() || await realpath(path) !== resolve(path)) fail("invalid-bootstrap-ref", `${path} must be physical`);
    const name = relative(canonical, path).split("\\").join("/") || ".";
    if (info.isDirectory()) {
      entries.push({ path: `${name}/`, kind: "directory" });
      for (const entry of (await readdir(path, { withFileTypes: true })).map((item) => item.name).sort()) await visit(join(path, entry));
    } else if (info.isFile()) entries.push({ path: name, kind: "file", bytes: hash(new Uint8Array(await readFile(path))) });
    else fail("invalid-bootstrap-ref", `${path} must be a regular file or directory`);
  };
  await visit(canonical);
  return hash(stable(entries));
}

async function validateBootstrapPackage(source: RecoverySource, checkout: string): Promise<void> {
  const canonical = await realpath(checkout);
  for (const path of bootstrapPaths(source)) {
    if (!inside(canonical, resolve(path))) fail("invalid-bootstrap-ref", `${path} escapes the Bootstrap package`);
    if (path === source.path || path === source.request.setup || source.request.sites.some((site) => site.request === path) || source.request.continuity?.some((entry) => entry.descriptor === path)) {
      const info = await lstat(path).catch(() => fail("bootstrap-ref-unavailable", `${path} is unavailable in the Bootstrap package`));
      if (!info.isFile()) fail("invalid-bootstrap-ref", `${path} must be a physical Bootstrap file`);
    }
    if (await exists(path)) await assertPhysicalTree(path, canonical);
  }
}

type StagedBootstrapPackage = { root: string; recovery: RecoverySource; digest: string };

async function stageBootstrapPackage(source: RecoverySource, checkout: string): Promise<StagedBootstrapPackage> {
  await validateBootstrapPackage(source, checkout);
  const root = await realpath(checkout);
  return { root, recovery: source, digest: await physicalTreeDigest(root) };
}

async function persistBootstrapPackage(mount: string, source: RecoverySource, packageRoot: string, digest: string): Promise<void> {
  const cache = join(mount, `.endroit/bootstrap/${digest.slice("sha256:".length)}`);
  const recoveryPath = join(mount, ".endroit/recovery.json");
  await assertLocalOverlay(mount, recoveryPath);
  const previous = await readFile(recoveryPath, "utf8").catch((error) => error instanceof Error && error.message.includes("ENOENT") ? undefined : Promise.reject(error));
  const bootstrapRoot = dirname(cache);
  let cacheCreated = false;
  let bootstrapCreated = false;
  if (await exists(bootstrapRoot)) await assertPhysicalTree(bootstrapRoot, await realpath(join(mount, ".endroit")));
  const mapped = new Map<string, string>();
  for (const path of bootstrapPaths(source)) {
    mapped.set(path, join(cache, relative(packageRoot, path)));
  }
  const request: WorkplaceRecoveryRequest = {
    ...source.request,
    setup: mapped.get(source.request.setup)!,
    sites: source.request.sites.map((site) => ({ ...site, request: mapped.get(site.request)! })),
    ...(source.request.continuity?.length ? { continuity: source.request.continuity.map((entry) => ({ ...entry, descriptor: mapped.get(entry.descriptor)! })) } : {}),
    checkpoints: source.request.checkpoints.map((checkpoint) => ({ ...checkpoint, checkpoint: mapped.get(checkpoint.checkpoint)! })),
  };
  const staging = join(bootstrapRoot, `.${digest.slice("sha256:".length)}.tmp-${process.pid}-${crypto.randomUUID()}`);
  try {
    if (!await exists(bootstrapRoot)) { await mkdir(bootstrapRoot, { recursive: false }); bootstrapCreated = true; }
    if (await exists(cache)) {
      if (await physicalTreeDigest(cache) !== digest) fail("invalid-bootstrap-ref", `${cache} does not match its Bootstrap package digest`);
    } else {
      if (await exists(staging)) fail("invalid-bootstrap-ref", `${staging} appeared before Bootstrap persistence`);
      await cp(packageRoot, staging, { recursive: true });
      if (await physicalTreeDigest(staging) !== digest) fail("invalid-bootstrap-ref", "Staged Bootstrap package changed before persistence");
      await rename(staging, cache);
      cacheCreated = true;
    }
    await rememberRecoveryRequest(mount, request);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    if (cacheCreated) await rm(cache, { recursive: true, force: true });
    if (previous === undefined) await rm(recoveryPath, { recursive: false, force: true });
    else await writeFile(recoveryPath, previous);
    if (bootstrapCreated && await readdir(bootstrapRoot, { withFileTypes: true }).then((entries) => entries.length === 0).catch(() => false)) await rm(bootstrapRoot, { recursive: false, force: true });
    throw error;
  }
}

function qualifiedPosition(member: string): WorkplaceRecoveryRequest["position"] {
  const match = MEMBER.exec(member);
  if (!match?.[1] || !match[2]) fail("invalid-bootstrap-ref", "--as must be one fully qualified Member ref");
  return { workplace: match[1], member, desk: `${match[1]}/desk/${match[2]}` };
}

function requestedPosition(anchor: string, value: string): { position: WorkplaceRecoveryRequest["position"]; slug?: string } {
  if (SLUG.test(value)) return { position: { workplace: anchor, member: `${anchor}/member/${value}`, desk: `${anchor}/desk/${value}` }, slug: value };
  return { position: qualifiedPosition(value) };
}

async function adoptionOptions(mount: string, plan: WorkplaceRecoveryPlan, slug?: string): Promise<{ anchorAdoption?: NonNullable<WorkplaceRecoveryPlan["anchorAdoption"]>; members?: NonNullable<WorkplaceRecoveryPlan["members"]> }> {
  const entryPath = join(mount, ".endroit/entry.json");
  let anchorAdoption: NonNullable<WorkplaceRecoveryPlan["anchorAdoption"]> | undefined;
  if (!await exists(entryPath)) {
    if (plan.position.status !== "resolved" || plan.position.workplace !== plan.anchor) fail("invalid-bootstrap-ref", "A fresh Anchor needs --as for its own verified Member");
    if (await exists(join(mount, ".endroit"))) fail("invalid-bootstrap-ref", "Fresh Anchor adoption requires absent local .endroit state");
    await verifyCurrentMemberSources({ workplaceMount: mount, workplace: plan.anchor, member: plan.position.member, desk: plan.position.desk });
    anchorAdoption = { action: "create", entry: { kind: "EntryBinding", workplace: plan.anchor, member: plan.position.member, desk: plan.position.desk, rootBindings: { shared: "workplace" } } };
  }
  if (!slug) return { ...(anchorAdoption ? { anchorAdoption } : {}) };
  const members = [
    { workplace: plan.anchor, member: `${plan.anchor}/member/${slug}`, desk: `${plan.anchor}/desk/${slug}` },
    ...plan.setup.plan.targets.map((target) => ({ workplace: target.workplace, member: `${target.workplace}/member/${slug}`, desk: `${target.workplace}/desk/${slug}` })),
  ];
  for (const target of plan.setup.plan.targets) {
    const expected = members.find((entry) => entry.workplace === target.workplace)!;
    if (target.entry.member !== expected.member || target.entry.desk !== expected.desk) fail("invalid-bootstrap-ref", `${target.workplace} does not declare --as ${slug}`);
  }
  return { ...(anchorAdoption ? { anchorAdoption } : {}), members };
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

function mountFor(plan: WorkplaceRecoveryPlan, workplace: string): string | undefined {
  return workplace === plan.anchor ? plan.anchorMount : plan.setup.plan.targets.find((target) => target.workplace === workplace)?.resolvedMount;
}

async function prepareContinuity(plan: WorkplaceRecoveryPlan, request: WorkplaceRecoveryRequest, options: { fetch?: boolean; memberSlug?: string } = {}): Promise<{ request: WorkplaceRecoveryRequest; status: RootContinuityStatus }> {
  const checkpoints: WorkplaceRecoveryRequest["checkpoints"] = [];
  const missing: RootContinuityStatus["missing"] = [];
  const fetched: NonNullable<RootContinuityStatus["fetched"]> = [];
  const requirements: Array<"optional" | "required" | "undeclared"> = [];
  for (const checkpoint of request.checkpoints) {
    const targetMount = mountFor(plan, checkpoint.workplace);
    const descriptor = targetMount && await exists(targetMount) ? await continuityDescriptor(targetMount) : undefined;
    const declared = plan.continuity?.find((entry) => entry.workplace === checkpoint.workplace);
    const checkpointRequirement = descriptor?.policy.requirement ?? declared?.policy.requirement ?? "undeclared";
    requirements.push(checkpointRequirement);
    let path = checkpoint.checkpoint;
    if (!await exists(path) && descriptor) {
      const local = await observeLocalCheckpoint(descriptor, checkpoint.checkpointId);
      if (local) path = local.path;
    }
    if (!await exists(path) && options.fetch && descriptor?.workplace === checkpoint.workplace && descriptor.binding && descriptor.policy.remote !== "none") {
      try {
        const requestedMember = options.memberSlug
          ? `${checkpoint.workplace}/member/${options.memberSlug}`
          : request.position.workplace === checkpoint.workplace ? request.position.member : undefined;
        const result = await fetchContinuityCheckpoint(descriptor, checkpoint.checkpointId, {
          ...(requestedMember ? { member: requestedMember } : {}),
          line: descriptor.line,
        });
        path = result.store.path;
        fetched.push({ id: checkpoint.id, workplace: checkpoint.workplace, requirement: checkpointRequirement, checkpointId: checkpoint.checkpointId, status: result.store.status, remoteStatus: "fetched-verified" });
      } catch (error) {
        if (!(error instanceof CheckpointError && ["checkpoint-remote-git-failed", "checkpoint-parent-unavailable"].includes(error.code))) throw error;
      }
    }
    if (await exists(path)) checkpoints.push({ ...checkpoint, checkpoint: path });
    else missing.push({ id: checkpoint.id, workplace: checkpoint.workplace, requirement: checkpointRequirement, checkpointId: checkpoint.checkpointId, action: `endroit checkpoint fetch ${checkpoint.checkpointId} --json` });
  }
  const requirement = requirements.includes("required") ? "required" : requirements.includes("optional") ? "optional" : "undeclared";
  const blocked = missing.some((item) => item.requirement === "required" && item.workplace === request.position.workplace);
  return {
    request: { ...request, checkpoints },
    status: { status: missing.length ? blocked ? "blocked" : "degraded" : "available", requirement, missing, ...(fetched.length ? { fetched } : {}) },
  };
}

function requiredMissing(status: RootContinuityStatus, workplace: string): string[] {
  return status.missing.filter((item) => item.requirement === "required" && item.workplace === workplace).map((item) => item.checkpointId);
}

export async function planRootSetup(options: { start?: string; from?: string; with?: string; as?: string; fetchContinuity?: boolean; preservePortable?: true; restoredRoutes?: string[] } = {}): Promise<{ mount: string; recovery: RecoverySource; plan: WorkplaceRecoveryPlan; remember: boolean; continuity: RootContinuityStatus }> {
  if (options.from && options.with) fail("invalid-bootstrap-ref", "setup accepts either --from or --with, not both");
  const mount = await resolveWorkplaceRoot(options.start);
  const recovery = await selectRecoveryRequest(mount, options.with ?? options.from);
  const selected = options.as ? requestedPosition(recovery.request.anchor, options.as) : { position: recovery.request.position };
  const request = { ...recovery.request, position: selected.position };
  if (options.with) await assertLocalOverlay(mount, join(mount, ".endroit/recovery.json"));
  const preservation = { ...(options.preservePortable ? { preservePortable: true as const } : {}), ...(options.restoredRoutes ? { restoredRoutes: options.restoredRoutes } : {}) };
  const topology = await planWorkplaceRecovery({ ...request, checkpoints: [] }, { anchorMount: mount, requestDirectory: dirname(recovery.path), ...preservation });
  for (const checkpoint of request.checkpoints) {
    const ownerMount = checkpoint.workplace === request.anchor ? mount : topology.setup.plan.targets.find((entry) => entry.workplace === checkpoint.workplace)?.resolvedMount;
    if (ownerMount) {
      const target = resolve(ownerMount, checkpoint.target);
      await assertCheckpointGitPlacement(undefined, target, { restoring: !await exists(target) });
    }
  }
  const continuity = await prepareContinuity(topology, request, { fetch: options.fetchContinuity, ...(selected.slug ? { memberSlug: selected.slug } : {}) });
  const initial = await planWorkplaceRecovery(continuity.request, {
    anchorMount: mount,
    requestDirectory: dirname(recovery.path),
    ...preservation,
    ...(continuity.status.status === "blocked" ? { positionBlock: { reason: "required-continuity" as const, checkpoints: requiredMissing(continuity.status, request.position.workplace) } } : {}),
  });
  const adoption = await adoptionOptions(mount, initial, selected.slug);
  const plan = adoption.anchorAdoption || adoption.members ? await planWorkplaceRecovery(continuity.request, {
    anchorMount: mount,
    requestDirectory: dirname(recovery.path),
    ...preservation,
    ...(continuity.status.status === "blocked" ? { positionBlock: { reason: "required-continuity" as const, checkpoints: requiredMissing(continuity.status, request.position.workplace) } } : {}),
    ...adoption,
  }) : initial;
  return { mount, recovery: { ...recovery, request }, plan, remember: Boolean(options.with), continuity: continuity.status };
}

export async function setupFromRoot(options: { start?: string; from?: string; with?: string; as?: string; preservePortable?: true; restoredRoutes?: string[] } = {}): Promise<RootSetupResult> {
  let bootstrap: Awaited<ReturnType<typeof resolveBootstrapRef>> | undefined;
  let staged: StagedBootstrapPackage | undefined;
  try {
    if (options.with && isBootstrapRef(options.with)) {
      bootstrap = await resolveBootstrapRef(options.with);
      const source = await recoveryFile(bootstrap.recoveryPath, "bootstrap");
      staged = await stageBootstrapPackage(source, bootstrap.checkout);
    }
    const resolvedOptions = staged ? { ...options, with: staged.recovery.path } : options;
    const prepared = await planRootSetup({ ...resolvedOptions, fetchContinuity: true });
    const revalidated = await planRootSetup(resolvedOptions);
    const receipt = await applyWorkplaceRecovery(revalidated.plan, prepared.plan.revision, prepared.remember ? {
      afterApply: staged
        ? () => persistBootstrapPackage(prepared.mount, { ...staged!.recovery, request: prepared.recovery.request }, staged!.root, staged!.digest)
        : () => rememberRecoveryRequest(prepared.mount, prepared.recovery.request),
    } : {});
    let finalPlan = revalidated.plan;
    let finalReceipt = receipt;
    let finalContinuity = prepared.continuity.fetched?.length ? { ...revalidated.continuity, fetched: prepared.continuity.fetched } : revalidated.continuity;
    if (finalContinuity.missing.length) {
      const retryPrepared = await planRootSetup({ ...resolvedOptions, start: prepared.mount, fetchContinuity: true });
      const improved = retryPrepared.continuity.missing.length < finalContinuity.missing.length || Boolean(retryPrepared.continuity.fetched?.length);
      if (improved) {
        const retryRevalidated = await planRootSetup({ ...resolvedOptions, start: prepared.mount });
        const retryReceipt = await applyWorkplaceRecovery(retryRevalidated.plan, retryPrepared.plan.revision);
        finalPlan = retryRevalidated.plan;
        finalReceipt = { ...retryReceipt, setup: receipt.setup, ...(receipt.continuity ? { continuity: receipt.continuity } : {}) };
        finalContinuity = retryPrepared.continuity.fetched?.length ? { ...retryRevalidated.continuity, fetched: retryPrepared.continuity.fetched } : retryRevalidated.continuity;
      }
    }
    const status = finalContinuity.status === "degraded" && finalReceipt.status === "ready" ? "degraded" : finalReceipt.status;
    return { mount: revalidated.mount, source: bootstrap ? "bootstrap" : revalidated.recovery.provenance, status, plan: finalPlan, receipt: finalReceipt, continuity: finalContinuity, ...(bootstrap ? { bootstrap: { ...bootstrap.receipt, digest: staged!.digest } } : {}) };
  } catch (error) {
    if (error instanceof BootstrapRefError) fail(error.code, error.message);
    throw error;
  } finally {
    await bootstrap?.cleanup();
  }
}

export async function statusFromRoot(start = process.cwd()): Promise<RootStatus> {
  const mount = await resolveWorkplaceRoot(start);
  const workplace = await workplaceIdentity(mount);
  const check = await checkWorkplaceMount({ mount });
  try {
    const recovery = await selectRecoveryRequest(mount);
    const topology = await planWorkplaceRecovery({ ...recovery.request, checkpoints: [] }, { anchorMount: mount, requestDirectory: dirname(recovery.path) });
    const continuity = await prepareContinuity(topology, recovery.request);
    const position = await resolveCurrentMember({ anchorMount: mount, anchor: recovery.request.anchor, ...recovery.request.position });
    return { kind: "WorkplaceRootStatus", version: 1, mount, workplace, check, recovery: { status: "declared", provenance: recovery.provenance, position, continuity: { ...continuity.status, verification: "not-run" } } };
  } catch (error) {
    return { kind: "WorkplaceRootStatus", version: 1, mount, workplace, check, recovery: { status: "unavailable", error: error instanceof Error ? error.message : String(error) } };
  }
}
