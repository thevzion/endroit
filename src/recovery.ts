import { lstat, readFile, realpath, rm } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { hash, stable } from "./compiler/index.ts";
import { inspectCheckpoint, restoreCheckpoint, verifyCheckpoint, verifyRestoredCheckpoint, type CheckpointManifest } from "./checkpoint.ts";
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
  // ponytail: v1 Routes are checkpoint-backed; add committed-only Route requests when their portable locator contract lands.
  checkpoints: Array<{
    id: string;
    workplace: string;
    checkpoint: string;
    target: "checkouts/sites";
    checkpointId: string;
    portableFingerprint: string;
    roots: RecoveryRoot[];
  }>;
  position: { workplace: string; member: string; desk: string };
};

export type WorkplaceRecoveryPlan = {
  kind: "WorkplaceRecoveryPlan";
  version: 1;
  revision: string;
  anchor: string;
  anchorMount: string;
  localPath?: string;
  setup: { path: string; plan: WorkplaceSetupPlan };
  checkpoints: Array<WorkplaceRecoveryRequest["checkpoints"][number] & {
    checkpoint: string;
    target: "checkouts/sites";
    resolvedTarget: string;
    action: "restore" | "verify";
    worktrees: RecoveryWorktree[];
  }>;
  position: WorkplaceRecoveryRequest["position"];
};

export type WorkplaceRecoveryReceipt = {
  kind: "WorkplaceRecoveryReceipt";
  version: 1;
  plan: string;
  anchor: string;
  status: "ready";
  setup: WorkplaceSetupReceipt;
  checkpoints: Array<{
    id: string;
    workplace: string;
    target: string;
    action: "restore" | "verify";
    status: "restored-equivalent";
    checkpointId: string;
    portableFingerprint: string;
  }>;
  position: WorkplaceRecoveryRequest["position"] & { status: "resolved" };
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

function parseRequest(value: unknown, requestDirectory: string): WorkplaceRecoveryRequest & { setup: string; checkpoints: Array<WorkplaceRecoveryRequest["checkpoints"][number] & { checkpoint: string }> } {
  const source = object(value, "WorkplaceRecoveryRequest");
  exact(source, ["kind", "version", "anchor", "setup", "checkpoints", "position"], "WorkplaceRecoveryRequest");
  if (source.kind !== "WorkplaceRecoveryRequest" || source.version !== 1 || !Array.isArray(source.checkpoints)) fail("invalid-recovery-request", "Unsupported WorkplaceRecoveryRequest");
  const anchor = ref(source.anchor, "WorkplaceRecoveryRequest.anchor");
  const setup = resolve(requestDirectory, text(source.setup, "WorkplaceRecoveryRequest.setup"));
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
  exact(positionSource, ["workplace", "member", "desk"], "WorkplaceRecoveryRequest.position");
  const position = { workplace: ref(positionSource.workplace, "position.workplace"), member: ref(positionSource.member, "position.member"), desk: ref(positionSource.desk, "position.desk") };
  if (!position.member.startsWith(`${position.workplace}/member/`) || !position.desk.startsWith(`${position.workplace}/desk/`)) fail("invalid-recovery-request", "Position Member and Desk must belong to its Workplace");
  return { kind: "WorkplaceRecoveryRequest", version: 1, anchor, setup, checkpoints, position };
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
  if (!mounts.has(request.position.workplace)) fail("invalid-recovery-request", `Position Workplace ${request.position.workplace} is not in setup`);
  const preview = {
    kind: "WorkplaceRecoveryPlan" as const,
    version: 1 as const,
    anchor: request.anchor,
    anchorMount: setupPlan.anchorMount,
    ...(options.localPath ? { localPath: options.localPath } : {}),
    setup: { path: request.setup, plan: setupPlan },
    checkpoints,
    position: request.position,
  };
  return { ...preview, revision: hash(stable(preview)) };
}

async function verifyPosition(plan: WorkplaceRecoveryPlan): Promise<WorkplaceRecoveryReceipt["position"]> {
  const mount = plan.position.workplace === plan.anchor
    ? plan.anchorMount
    : plan.setup.plan.targets.find((target) => target.workplace === plan.position.workplace)?.resolvedMount ?? fail("recovery-unavailable", `${plan.position.workplace} has no Mount`);
  let entry: Record<string, unknown>;
  try { entry = object(JSON.parse(await readFile(join(mount, ".endroit/entry.json"), "utf8")) as unknown, "EntryBinding"); }
  catch (error) {
    if (error instanceof RecoveryError) throw error;
    fail("recovery-position-mismatch", `${plan.position.workplace} has no readable Entry Binding`);
  }
  if (entry.workplace !== plan.position.workplace || entry.member !== plan.position.member || entry.desk !== plan.position.desk) fail("recovery-position-mismatch", `Position does not match ${plan.position.workplace} Entry Binding`);
  return { ...plan.position, status: "resolved" };
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
  const restored: string[] = [];
  const checkpointReceipts: WorkplaceRecoveryReceipt["checkpoints"] = [];
  let position: WorkplaceRecoveryReceipt["position"] | undefined;
  const setup = await applyWorkplaceSetup(plan.setup.plan, plan.setup.plan.revision, {
    afterApply: async (setupReceipt) => {
      if (setupReceipt.status !== "ready") fail("recovery-unavailable", "Workplace setup did not reach ready");
      try {
        for (const checkpoint of plan.checkpoints) {
          await rejectFamilyCollision(recoveryMount(plan, checkpoint.workplace), checkpoint.resolvedTarget, checkpoint.worktrees);
          const result = checkpoint.action === "restore"
            ? await restoreCheckpoint(checkpoint.checkpoint, checkpoint.resolvedTarget)
            : await verifyRestoredCheckpoint(checkpoint.checkpoint, checkpoint.resolvedTarget);
          if (checkpoint.action === "restore") restored.push(result.path);
          checkpointReceipts.push({ id: checkpoint.id, workplace: checkpoint.workplace, target: result.path, action: checkpoint.action, status: "restored-equivalent", checkpointId: result.receipt.checkpointId, portableFingerprint: result.receipt.portableFingerprint });
        }
        position = await verifyPosition(plan);
      } catch (error) {
        for (const target of restored.reverse()) await rm(target, { recursive: true, force: true });
        throw error;
      }
    },
  });
  if (!position) fail("recovery-position-mismatch", "Position was not resolved");
  return { kind: "WorkplaceRecoveryReceipt", version: 1, plan: plan.revision, anchor: plan.anchor, status: "ready", setup, checkpoints: checkpointReceipts, position };
}
