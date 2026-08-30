import { lstat, mkdir, readFile, readdir, realpath, rename, rm } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { hash, stable } from "./compiler/index.ts";
import { inspectCheckpoint, restoreCheckpoint, verifyCheckpoint, verifyRestoredCheckpoint, type CheckpointManifest } from "./checkpoint.ts";
import { rememberCurrentMember, resolveCurrentMember, type CurrentMemberResolution } from "./current-member.ts";
import { applySiteRouteSetup, planSiteRouteSetup, type SiteRouteSetupPlan, type SiteRouteSetupReceipt } from "./site-setup.ts";
import { applyWorkplaceSetup, planWorkplaceSetup, type WorkplaceSetupPlan, type WorkplaceSetupReceipt } from "./setup.ts";

const REF = /^workplace:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
const REVISION = /^sha256:[a-f0-9]{64}$/;
const CHECKPOINT_ID = /^checkpoint:sha256:[a-f0-9]{64}$/;
const ID = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const RESERVED = new Set(["sites", "workplaces"]);

type RecoveryWorktree = { id: string; logicalPath: string; site: string; route: string };
type RecoveryRoot = { ref: string; worktrees: RecoveryWorktree[] };

export type WorkplaceRecoveryRequest = {
  kind: "WorkplaceRecoveryRequest";
  version: 1;
  anchor: string;
  setup: string;
  sites: Array<{ workplace: string; request: string }>;
  checkpoints: Array<{
    id: string;
    workplace: string;
    checkpoint: string;
    target: "checkouts/sites";
    checkpointId: string;
    portableFingerprint: string;
    roots: RecoveryRoot[];
  }>;
  position: { workplace: string; member?: string; desk?: string };
};

export type WorkplaceRecoveryPlan = {
  kind: "WorkplaceRecoveryPlan";
  version: 1;
  revision: string;
  anchor: string;
  anchorMount: string;
  localPath?: string;
  setup: { path: string; plan: WorkplaceSetupPlan };
  sites: Array<{ workplace: string; path: string; plan: SiteRouteSetupPlan }>;
  checkpoints: Array<WorkplaceRecoveryRequest["checkpoints"][number] & {
    checkpoint: string;
    target: "checkouts/sites";
    resolvedTarget: string;
    action: "restore" | "verify";
    worktrees: RecoveryWorktree[];
  }>;
  position: CurrentMemberResolution;
};

export type WorkplaceRecoveryReceipt = {
  kind: "WorkplaceRecoveryReceipt";
  version: 1;
  plan: string;
  anchor: string;
  status: "ready" | "pending-member";
  setup: WorkplaceSetupReceipt;
  sites: SiteRouteSetupReceipt[];
  checkpoints: Array<{
    id: string;
    workplace: string;
    target: string;
    action: "restore" | "verify";
    status: "restored-equivalent";
    checkpointId: string;
    portableFingerprint: string;
  }>;
  position: CurrentMemberResolution;
};

export class RecoveryError extends Error {
  constructor(readonly code: "invalid-recovery-request" | "recovery-collision" | "recovery-digest-mismatch" | "recovery-unavailable" | "recovery-position-mismatch", message: string) {
    super(message);
    this.name = "RecoveryError";
  }
}

function fail(code: RecoveryError["code"], message: string): never {
  throw new RecoveryError(code, message);
}

function object(value: unknown, subject: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid-recovery-request", `${subject} must be an object`);
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, keys: string[], subject: string): void {
  const unknown = Object.keys(value).filter((key) => !keys.includes(key));
  const missing = keys.filter((key) => !(key in value));
  if (unknown.length) fail("invalid-recovery-request", `${subject} has unknown fields: ${unknown.join(", ")}`);
  if (missing.length) fail("invalid-recovery-request", `${subject} is missing fields: ${missing.join(", ")}`);
}

function ref(value: unknown, subject: string): string {
  if (typeof value !== "string" || !REF.test(value)) fail("invalid-recovery-request", `${subject} must be a fully qualified Workplace ref`);
  return value;
}

function slug(value: unknown, subject: string): string {
  if (typeof value !== "string" || !ID.test(value)) fail("invalid-recovery-request", `${subject} must be a slug`);
  return value;
}

function familySlug(value: unknown, subject: string): string {
  const parsed = slug(value, subject);
  if (RESERVED.has(parsed)) fail("invalid-recovery-request", `${subject} must be a non-reserved slug`);
  return parsed;
}

function text(value: unknown, subject: string): string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) fail("invalid-recovery-request", `${subject} must be non-empty text`);
  return value.trim();
}

function revision(value: unknown, subject: string): string {
  if (typeof value !== "string" || !REVISION.test(value)) fail("invalid-recovery-request", `${subject} must be sha256`);
  return value;
}

function parseRoots(value: unknown, subject: string): RecoveryRoot[] {
  if (!Array.isArray(value) || value.length === 0) fail("invalid-recovery-request", `${subject} must be a non-empty array`);
  const ids = new Set<string>();
  const paths = new Set<string>();
  const roots = value.map((value, rootIndex) => {
    const rootSubject = `${subject}[${rootIndex}]`;
    const root = object(value, rootSubject);
    exact(root, ["ref", "worktrees"], rootSubject);
    if (!Array.isArray(root.worktrees) || root.worktrees.length === 0) fail("invalid-recovery-request", `${rootSubject}.worktrees must be non-empty`);
    const worktrees = root.worktrees.map((value, worktreeIndex) => {
      const worktreeSubject = `${rootSubject}.worktrees[${worktreeIndex}]`;
      const worktree = object(value, worktreeSubject);
      exact(worktree, ["id", "logicalPath", "site", "route"], worktreeSubject);
      const id = slug(worktree.id, `${worktreeSubject}.id`);
      const site = familySlug(worktree.site, `${worktreeSubject}.site`);
      const route = familySlug(worktree.route, `${worktreeSubject}.route`);
      const logicalPath = text(worktree.logicalPath, `${worktreeSubject}.logicalPath`).replaceAll("\\", "/");
      if (logicalPath !== `${site}/${route}`) fail("invalid-recovery-request", `${worktreeSubject}.logicalPath must equal ${site}/${route}`);
      if (ids.has(id) || paths.has(logicalPath)) fail("invalid-recovery-request", `${worktreeSubject} repeats a worktree identity or logicalPath`);
      ids.add(id); paths.add(logicalPath);
      return { id, logicalPath, site, route };
    });
    return { ref: ref(root.ref, `${rootSubject}.ref`), worktrees };
  });
  if (new Set(roots.map((root) => root.ref)).size !== roots.length) fail("invalid-recovery-request", `${subject} repeats a Root ref`);
  return roots;
}

function parseRequest(value: unknown, requestDirectory: string): WorkplaceRecoveryRequest {
  const source = object(value, "WorkplaceRecoveryRequest");
  exact(source, ["kind", "version", "anchor", "setup", "sites", "checkpoints", "position"], "WorkplaceRecoveryRequest");
  if (source.kind !== "WorkplaceRecoveryRequest" || source.version !== 1 || !Array.isArray(source.sites) || !Array.isArray(source.checkpoints)) fail("invalid-recovery-request", "Unsupported WorkplaceRecoveryRequest");
  const anchor = ref(source.anchor, "WorkplaceRecoveryRequest.anchor");
  const setup = resolve(requestDirectory, text(source.setup, "WorkplaceRecoveryRequest.setup"));
  const sites = source.sites.map((value, index) => {
    const subject = `WorkplaceRecoveryRequest.sites[${index}]`;
    const site = object(value, subject);
    exact(site, ["workplace", "request"], subject);
    return { workplace: ref(site.workplace, `${subject}.workplace`), request: resolve(requestDirectory, text(site.request, `${subject}.request`)) };
  });
  if (new Set(sites.map((item) => item.workplace)).size !== sites.length) fail("invalid-recovery-request", "Recovery Site requests must have unique Workplaces");
  const checkpoints = source.checkpoints.map((value, index) => {
    const subject = `WorkplaceRecoveryRequest.checkpoints[${index}]`;
    const checkpoint = object(value, subject);
    exact(checkpoint, ["id", "workplace", "checkpoint", "target", "checkpointId", "portableFingerprint", "roots"], subject);
    if (checkpoint.target !== "checkouts/sites") fail("invalid-recovery-request", `${subject}.target must be checkouts/sites`);
    const checkpointId = text(checkpoint.checkpointId, `${subject}.checkpointId`);
    if (!CHECKPOINT_ID.test(checkpointId)) fail("invalid-recovery-request", `${subject}.checkpointId is invalid`);
    return {
      id: slug(checkpoint.id, `${subject}.id`),
      workplace: ref(checkpoint.workplace, `${subject}.workplace`),
      checkpoint: resolve(requestDirectory, text(checkpoint.checkpoint, `${subject}.checkpoint`)),
      target: "checkouts/sites" as const,
      checkpointId,
      portableFingerprint: revision(checkpoint.portableFingerprint, `${subject}.portableFingerprint`),
      roots: parseRoots(checkpoint.roots, `${subject}.roots`),
    };
  });
  if (new Set(checkpoints.map((item) => item.id)).size !== checkpoints.length || new Set(checkpoints.map((item) => item.workplace)).size !== checkpoints.length) fail("invalid-recovery-request", "Recovery checkpoints must have unique ids and Workplaces");
  const positionSource = object(source.position, "WorkplaceRecoveryRequest.position");
  const unknownPosition = Object.keys(positionSource).filter((key) => !["workplace", "member", "desk"].includes(key));
  if (unknownPosition.length || !("workplace" in positionSource)) fail("invalid-recovery-request", unknownPosition.length ? `WorkplaceRecoveryRequest.position has unknown fields: ${unknownPosition.join(", ")}` : "WorkplaceRecoveryRequest.position is missing workplace");
  if ((positionSource.member === undefined) !== (positionSource.desk === undefined)) fail("invalid-recovery-request", "Position needs both member and desk or neither");
  const workplace = ref(positionSource.workplace, "position.workplace");
  const position = positionSource.member === undefined
    ? { workplace }
    : { workplace, member: ref(positionSource.member, "position.member"), desk: ref(positionSource.desk, "position.desk") };
  if (position.member && (!position.member.startsWith(`${workplace}/member/`) || !position.desk!.startsWith(`${workplace}/desk/`))) fail("invalid-recovery-request", "Position Member and Desk must belong to its Workplace");
  return { kind: "WorkplaceRecoveryRequest", version: 1, anchor, setup, sites, checkpoints, position };
}

function semanticRoots(manifest: CheckpointManifest): RecoveryRoot[] {
  return manifest.repositories.map((repository) => ({
    ref: repository.rootRef,
    worktrees: repository.worktrees.map((id) => {
      const worktree = manifest.worktrees.find((item) => item.worktreeId === id) ?? fail("invalid-recovery-request", `${repository.rootRef} names missing worktree ${id}`);
      const [site, route, ...extra] = worktree.logicalPath.split("/");
      if (!site || !route || extra.length) fail("invalid-recovery-request", `${worktree.logicalPath} must identify one site/route`);
      familySlug(site, `${id}.site`); familySlug(route, `${id}.route`);
      return { id, logicalPath: worktree.logicalPath, site, route };
    }),
  }));
}

function sortedRoots(roots: RecoveryRoot[]): RecoveryRoot[] {
  return roots.map((root) => ({ ...root, worktrees: [...root.worktrees].sort((a, b) => a.id.localeCompare(b.id)) })).sort((a, b) => a.ref.localeCompare(b.ref));
}

function assertManifest(request: WorkplaceRecoveryRequest["checkpoints"][number], manifest: CheckpointManifest): void {
  if (manifest.checkpointId !== request.checkpointId || manifest.portableFingerprint !== request.portableFingerprint || manifest.workplaceRef !== request.workplace) fail("invalid-recovery-request", `${request.id} does not match its declared checkpoint identity`);
  if (stable(sortedRoots(semanticRoots(manifest))) !== stable(sortedRoots(request.roots))) fail("invalid-recovery-request", `${request.id}.roots does not exactly match MANIFEST.json`);
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) {
    if (error instanceof Error && error.message.includes("ENOENT")) return false;
    throw error;
  }
}

async function rejectFamilyCollision(workplaceMount: string, target: string, worktrees: RecoveryWorktree[] = []): Promise<void> {
  if (!await exists(workplaceMount)) {
    if (await exists(target)) fail("recovery-collision", `${target} exists without its Workplace Mount`);
    return;
  }
  const canonicalMount = await realpath(workplaceMount).catch(() => fail("recovery-collision", `${workplaceMount} cannot be resolved`));
  const addresses: Array<[string, string]> = [
    [resolve(workplaceMount, "checkouts"), resolve(canonicalMount, "checkouts")],
    [resolve(workplaceMount, "checkouts/workplaces"), resolve(canonicalMount, "checkouts/workplaces")],
    [target, resolve(canonicalMount, "checkouts/sites")],
  ];
  for (const [path, expected] of addresses) {
    if (!await exists(path)) continue;
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isDirectory() || await realpath(path) !== expected) fail("recovery-collision", `${path} must be a physical directory inside the Site checkout family`);
  }
  if (!await exists(target)) return;
  const canonicalTarget = await realpath(target);
  const repositoryRoot = resolve(target, ".git-repositories");
  if (!await exists(repositoryRoot)) fail("recovery-unavailable", `${repositoryRoot} is missing from the restored Site family`);
  const repositoryInfo = await lstat(repositoryRoot);
  const canonicalRepositoryRoot = resolve(canonicalTarget, ".git-repositories");
  if (repositoryInfo.isSymbolicLink() || !repositoryInfo.isDirectory() || await realpath(repositoryRoot) !== canonicalRepositoryRoot) fail("recovery-collision", `${repositoryRoot} must be a physical directory inside the Site checkout family`);
  for (const worktree of worktrees) {
    for (const path of [resolve(target, worktree.site), resolve(target, worktree.logicalPath)]) {
      if (!await exists(path)) fail("recovery-unavailable", `${path} is missing from the restored Site family`);
      const info = await lstat(path);
      const expected = resolve(canonicalTarget, path === resolve(target, worktree.site) ? worktree.site : worktree.logicalPath);
      if (info.isSymbolicLink() || !info.isDirectory() || await realpath(path) !== expected) fail("recovery-collision", `${path} must be a physical directory inside the Site checkout family`);
    }
    const pointer = resolve(target, worktree.logicalPath, ".git");
    const pointerInfo = await lstat(pointer).catch(() => fail("recovery-unavailable", `${pointer} is missing from the restored Site family`));
    if (pointerInfo.isSymbolicLink() || !pointerInfo.isFile()) fail("recovery-collision", `${pointer} must be a physical Git worktree pointer`);
    const line = (await readFile(pointer, "utf8")).trim();
    if (!line.startsWith("gitdir: ")) fail("recovery-collision", `${pointer} is not a Git worktree pointer`);
    const gitDir = await realpath(resolve(dirname(pointer), line.slice("gitdir: ".length))).catch(() => fail("recovery-unavailable", `${pointer} targets an unavailable Git directory`));
    const fromRepositories = relative(canonicalRepositoryRoot, gitDir);
    if (/^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(fromRepositories) || fromRepositories.startsWith("..")) fail("recovery-collision", `${pointer} escapes the restored Site family`);
  }
}

function recoveryMount(plan: WorkplaceRecoveryPlan, workplace: string): string {
  return workplace === plan.anchor
    ? plan.anchorMount
    : plan.setup.plan.targets.find((target) => target.workplace === workplace)?.resolvedMount ?? fail("recovery-unavailable", `${workplace} has no Mount`);
}

export async function planWorkplaceRecovery(value: unknown, options: { anchorMount: string; requestDirectory?: string; localPath?: string }): Promise<WorkplaceRecoveryPlan> {
  const requestDirectory = resolve(options.requestDirectory ?? process.cwd());
  const request = parseRequest(value, requestDirectory);
  const setupSource = JSON.parse(await readFile(request.setup, "utf8")) as unknown;
  const setupPlan = await planWorkplaceSetup(setupSource, { anchorMount: options.anchorMount, requestDirectory: dirname(request.setup), ...(options.localPath ? { localPath: options.localPath } : {}) });
  if (request.anchor !== setupPlan.anchor) fail("invalid-recovery-request", `Recovery Anchor ${request.anchor} does not match setup ${setupPlan.anchor}`);
  const mounts = new Map<string, string>([[request.anchor, setupPlan.anchorMount], ...setupPlan.targets.map((target) => [target.workplace, target.resolvedMount] as const)]);
  const sites = await Promise.all(request.sites.map(async (site) => {
    const workplaceMount = mounts.get(site.workplace);
    const setupTarget = setupPlan.targets.find((target) => target.workplace === site.workplace);
    if (!workplaceMount || setupTarget && !setupTarget.required) fail("invalid-recovery-request", `${site.workplace} must be the Anchor or a required setup target`);
    const source = JSON.parse(await readFile(site.request, "utf8")) as unknown;
    const plan = await planSiteRouteSetup(source, { workplaceMount, requestDirectory: dirname(site.request), allowAbsentMount: true });
    if (plan.workplace !== site.workplace) fail("invalid-recovery-request", `${site.request} does not target ${site.workplace}`);
    return { workplace: site.workplace, path: site.request, plan };
  }));
  const checkpoints = await Promise.all(request.checkpoints.map(async (checkpoint) => {
    const workplaceMount = mounts.get(checkpoint.workplace);
    const setupTarget = setupPlan.targets.find((target) => target.workplace === checkpoint.workplace);
    if (!workplaceMount || setupTarget && !setupTarget.required) fail("invalid-recovery-request", `${checkpoint.workplace} must be the Anchor or a required setup target`);
    const inspected = await inspectCheckpoint(checkpoint.checkpoint);
    assertManifest(checkpoint, inspected.manifest);
    const resolvedTarget = resolve(workplaceMount, checkpoint.target);
    if (resolvedTarget !== resolve(workplaceMount, "checkouts/sites")) fail("recovery-collision", `${checkpoint.id} escapes the Site checkout family`);
    const worktrees = checkpoint.roots.flatMap((root) => root.worktrees);
    await rejectFamilyCollision(workplaceMount, resolvedTarget, worktrees);
    return { ...checkpoint, checkpoint: inspected.path, resolvedTarget, action: await exists(resolvedTarget) ? "verify" as const : "restore" as const, worktrees };
  }));
  const cleanRoutes = new Set<string>();
  for (const site of sites) for (const product of site.plan.sites) for (const route of product.routes) cleanRoutes.add(`${site.workplace}/${product.id}/${route.id}`);
  for (const checkpoint of checkpoints) for (const worktree of checkpoint.worktrees) {
    const key = `${checkpoint.workplace}/${worktree.logicalPath}`;
    if (cleanRoutes.has(key)) fail("invalid-recovery-request", `${key} is declared by both a Product Remote and a checkpoint`);
  }
  if (!mounts.has(request.position.workplace)) fail("invalid-recovery-request", `Position Workplace ${request.position.workplace} is not in setup`);
  const position = await resolveCurrentMember({ anchorMount: setupPlan.anchorMount, anchor: request.anchor, ...request.position });
  const preview = {
    kind: "WorkplaceRecoveryPlan" as const,
    version: 1 as const,
    anchor: request.anchor,
    anchorMount: setupPlan.anchorMount,
    ...(options.localPath ? { localPath: options.localPath } : {}),
    setup: { path: request.setup, plan: setupPlan },
    sites,
    checkpoints,
    position,
  };
  return { ...preview, revision: hash(stable(preview)) };
}

async function verifyPosition(plan: WorkplaceRecoveryPlan, position: Extract<CurrentMemberResolution, { status: "resolved" }>): Promise<Extract<CurrentMemberResolution, { status: "resolved" }>> {
  const mount = position.workplace === plan.anchor
    ? plan.anchorMount
    : plan.setup.plan.targets.find((target) => target.workplace === position.workplace)?.resolvedMount ?? fail("recovery-unavailable", `${position.workplace} has no Mount`);
  let entry: Record<string, unknown>;
  try { entry = object(JSON.parse(await readFile(join(mount, ".endroit/entry.json"), "utf8")) as unknown, "EntryBinding"); }
  catch (error) {
    if (error instanceof RecoveryError) throw error;
    fail("recovery-position-mismatch", `${position.workplace} has no readable Entry Binding`);
  }
  if (entry.workplace !== position.workplace || entry.member !== position.member || entry.desk !== position.desk) fail("recovery-position-mismatch", `Position does not match ${position.workplace} Entry Binding`);
  return position;
}

async function removeIfEmpty(path: string): Promise<void> {
  if (await readdir(path, { withFileTypes: true }).then((entries) => entries.length === 0).catch(() => false)) await rm(path, { recursive: true, force: true });
}

async function rollbackSites(receipts: SiteRouteSetupReceipt[]): Promise<void> {
  for (const receipt of [...receipts].reverse()) {
    for (const site of [...receipt.sites].reverse()) {
      for (const route of [...site.routes].reverse()) if (route.status === "cloned") await rm(route.path, { recursive: true, force: true });
    }
    for (const path of [...receipt.createdDirectories].reverse()) await removeIfEmpty(path);
  }
}

async function promoteStagedSites(receipt: SiteRouteSetupReceipt, plan: SiteRouteSetupPlan): Promise<SiteRouteSetupReceipt> {
  const finalFamily = resolve(plan.workplaceMount, "checkouts/sites");
  const canonicalFamily = await realpath(finalFamily);
  const routes = new Map(plan.sites.flatMap((site) => site.routes.map((route) => [`${site.id}/${route.id}`, route.path] as const)));
  for (const site of receipt.sites) {
    const siteTarget = join(finalFamily, site.id);
    if (!await exists(siteTarget)) await mkdir(siteTarget, { recursive: false });
    const info = await lstat(siteTarget);
    if (info.isSymbolicLink() || !info.isDirectory() || await realpath(siteTarget) !== resolve(canonicalFamily, site.id)) fail("recovery-collision", `${siteTarget} must be a physical Site directory`);
    for (const route of site.routes) {
      const target = routes.get(`${site.id}/${route.id}`) ?? fail("recovery-unavailable", `${site.id}/${route.id} is absent from its Site plan`);
      if (await exists(target)) fail("recovery-collision", `${target} appeared before Site promotion`);
      await rename(route.path, target);
      route.path = target;
    }
  }
  await rm(dirname(receipt.family), { recursive: true, force: true });
  return { ...receipt, family: finalFamily, createdDirectories: [] };
}

export async function applyWorkplaceRecovery(plan: WorkplaceRecoveryPlan, expectedRevision: string): Promise<WorkplaceRecoveryReceipt> {
  const { revision: _revision, ...preview } = plan;
  const currentRevision = hash(stable(preview));
  if (plan.revision !== currentRevision || expectedRevision !== currentRevision) fail("recovery-digest-mismatch", `Preview digest mismatch: expected current ${currentRevision}`);
  for (const checkpoint of plan.checkpoints) {
    await rejectFamilyCollision(recoveryMount(plan, checkpoint.workplace), checkpoint.resolvedTarget, checkpoint.worktrees);
    const verified = await verifyCheckpoint(checkpoint.checkpoint);
    assertManifest(checkpoint, verified.manifest);
    if (checkpoint.action === "restore" && await exists(checkpoint.resolvedTarget)) fail("recovery-collision", `${checkpoint.resolvedTarget} appeared after preview`);
    if (checkpoint.action === "verify" && !await exists(checkpoint.resolvedTarget)) fail("recovery-unavailable", `${checkpoint.resolvedTarget} disappeared after preview`);
  }
  const currentPosition = await resolveCurrentMember({
    anchorMount: plan.anchorMount,
    anchor: plan.anchor,
    workplace: plan.position.workplace,
    ...(plan.position.status === "resolved" && plan.position.source === "request" ? { member: plan.position.member, desk: plan.position.desk } : {}),
  });
  if (stable(currentPosition) !== stable(plan.position)) fail("recovery-position-mismatch", "Current Member changed after Preview");
  const restored: string[] = [];
  const stagedRoots: string[] = [];
  const siteReceipts: SiteRouteSetupReceipt[] = [];
  const checkpointReceipts: WorkplaceRecoveryReceipt["checkpoints"] = [];
  let position: CurrentMemberResolution | undefined;
  const setup = await applyWorkplaceSetup(plan.setup.plan, plan.setup.plan.revision, {
    afterApply: async (setupReceipt) => {
      if (setupReceipt.status !== "ready") fail("recovery-unavailable", "Workplace setup did not reach ready");
      try {
        const staged = new Map<string, { receipt: SiteRouteSetupReceipt; plan: SiteRouteSetupPlan }>();
        for (const site of plan.sites) {
          const checkpoint = plan.checkpoints.find((item) => item.workplace === site.workplace && item.action === "restore");
          if (checkpoint) {
            const stage = join(recoveryMount(plan, site.workplace), ".endroit", `recovery-stage-${crypto.randomUUID()}`, "sites");
            stagedRoots.push(dirname(stage));
            staged.set(site.workplace, { receipt: await applySiteRouteSetup(site.plan, site.plan.revision, { targetFamily: stage }), plan: site.plan });
          } else siteReceipts.push(await applySiteRouteSetup(site.plan, site.plan.revision));
        }
        for (const checkpoint of plan.checkpoints) {
          await rejectFamilyCollision(recoveryMount(plan, checkpoint.workplace), checkpoint.resolvedTarget, checkpoint.worktrees);
          const result = checkpoint.action === "restore"
            ? await restoreCheckpoint(checkpoint.checkpoint, checkpoint.resolvedTarget)
            : await verifyRestoredCheckpoint(checkpoint.checkpoint, checkpoint.resolvedTarget);
          if (checkpoint.action === "restore") restored.push(result.path);
          checkpointReceipts.push({ id: checkpoint.id, workplace: checkpoint.workplace, target: result.path, action: checkpoint.action, status: "restored-equivalent", checkpointId: result.receipt.checkpointId, portableFingerprint: result.receipt.portableFingerprint });
          const stagedSite = staged.get(checkpoint.workplace);
          if (stagedSite) {
            const promoted = await promoteStagedSites(stagedSite.receipt, stagedSite.plan);
            siteReceipts.push(promoted);
            staged.delete(checkpoint.workplace);
          }
        }
        for (const item of staged.values()) await rm(dirname(item.receipt.family), { recursive: true, force: true });
        if (currentPosition.status === "resolved") {
          position = await verifyPosition(plan, currentPosition);
          if (currentPosition.source === "request") await rememberCurrentMember({ anchorMount: plan.anchorMount, anchor: plan.anchor, workplace: currentPosition.workplace, member: currentPosition.member, desk: currentPosition.desk });
        } else position = currentPosition;
      } catch (error) {
        for (const target of restored.reverse()) await rm(target, { recursive: true, force: true });
        for (const target of stagedRoots.reverse()) await rm(target, { recursive: true, force: true });
        await rollbackSites(siteReceipts);
        throw error;
      }
    },
  });
  if (!position) fail("recovery-position-mismatch", "Position was not evaluated");
  return { kind: "WorkplaceRecoveryReceipt", version: 1, plan: plan.revision, anchor: plan.anchor, status: position.status === "resolved" ? "ready" : "pending-member", setup, sites: siteReceipts, checkpoints: checkpointReceipts, position };
}
