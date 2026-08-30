import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { isBootstrapRef, resolveBootstrapRef, type BootstrapRefReceipt } from "./bootstrap-ref.ts";
import { assertCheckpointGitPlacement, CheckpointError, inspectCheckpoint, restoreCheckpoint, verifyCheckpoint, verifyRestoredCheckpoint, type CheckpointManifest, type CheckpointReceipt } from "./checkpoint.ts";
import { fetchCheckpoint, parseFetchRequest, type CheckpointRemoteReceipt } from "./checkpoint-remote.ts";
import { fetchContinuityCheckpoint, loadContinuityDescriptor, observeLocalCheckpoint } from "./checkpoint-store.ts";
import { checkWorkplaceMount, hash, stable, type CheckResult } from "./compiler/index.ts";
import { resolveCurrentMember } from "./current-member.ts";
import { checkPortableDeclarations } from "./compiler/git-witness.ts";
import { planRootSetup, resolveWorkplaceRoot, selectRecoveryRequest, setupFromRoot, type RootSetupResult } from "./root-facade.ts";
import { bindRestoredSiteRoutes } from "./site-setup.ts";
import { ensureSetupIgnore, reconcilePreservedMount } from "./setup.ts";

const CHECKPOINT = /^checkpoint:sha256:[a-f0-9]{64}$/;
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
type Options = { checkpoint: string; to: string; start?: string; as?: string; from?: string; checkpointFrom?: string };
export type WorkplaceCheckpointSetupReceipt = {
  kind: "WorkplaceCheckpointSetupReceipt";
  version: 1;
  mount: string;
  action: "restored" | "unchanged";
  status: "ready" | "degraded" | "pending-member";
  member: string | null;
  recoveryRevision?: string;
  checkpoint: CheckpointReceipt;
  check: CheckResult;
  setup?: RootSetupResult;
  frontDoor?: string;
  remote?: CheckpointRemoteReceipt;
  bootstrap?: BootstrapRefReceipt;
};

function fail(code: string, message: string): never { throw new CheckpointError(code, message); }
async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) { if (error instanceof Error && error.message.includes("ENOENT")) return false; throw error; }
}
function inside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !/^(?:\/|[A-Za-z]:|\\\\)/.test(path));
}

function topology(manifest: CheckpointManifest): Array<{ site: string; route: string }> {
  const root = manifest.worktrees.filter((entry) => entry.logicalPath === "workplace");
  if (root.length !== 1) fail("checkpoint-schema-invalid", "Workplace setup requires exactly one logicalPath workplace");
  const owner = manifest.repositories.find((entry) => entry.worktrees.includes(root[0]!.worktreeId));
  if (owner?.rootRef !== `${manifest.workplaceRef}/root/shared`) fail("checkpoint-schema-invalid", "The workplace worktree must belong to its shared Root");
  return manifest.worktrees.filter((entry) => entry !== root[0]).map((entry) => {
    const [family, sites, site, route, ...extra] = entry.logicalPath.split("/");
    if (family !== "checkouts" || sites !== "sites" || !site || !route || extra.length || !SLUG.test(site) || !SLUG.test(route) || [site, route].some((value) => ["workplaces", "sites"].includes(value))) fail("checkpoint-path-invalid", `${entry.logicalPath} is outside the declared Site family`);
    return { site, route };
  });
}

async function physicalReplay(mount: string, manifest: CheckpointManifest): Promise<void> {
  for (const path of [".endroit", ".endroit/checkpoint-setup.json", ".git-repositories", ...manifest.worktrees.map((entry) => entry.logicalPath)]) {
    let cursor = mount;
    for (const part of path.split("/")) {
      cursor = join(cursor, part);
      const info = await lstat(cursor).catch(() => fail("checkpoint-target-exists", `${cursor} is missing from the previous restoration`));
      if (info.isSymbolicLink()) fail("checkpoint-target-exists", `${cursor} must be physical`);
    }
  }
  for (const entry of manifest.worktrees) {
    const pointer = join(mount, entry.logicalPath, ".git");
    const info = await lstat(pointer);
    if (!info.isFile() || info.isSymbolicLink()) fail("checkpoint-target-exists", `${pointer} must be a restored worktree pointer`);
    const bytes = (await readFile(pointer, "utf8")).trim();
    if (!bytes.startsWith("gitdir: ") || !inside(join(mount, ".git-repositories"), await realpath(resolve(dirname(pointer), bytes.slice(8))))) fail("checkpoint-target-exists", `${pointer} points outside restored repositories`);
  }
}

async function recoveryRevision(mount: string, from?: string): Promise<string> {
  const source = await selectRecoveryRequest(mount, from);
  const paths = [source.path, source.request.setup, ...source.request.sites.map((entry) => entry.request), ...(source.request.continuity ?? []).map((entry) => entry.descriptor)];
  const entries = await Promise.all(paths.map(async (path) => ({ path: relative(dirname(source.path), path).split("\\").join("/"), digest: hash(new Uint8Array(await readFile(path))) })));
  return hash(stable(entries));
}

export async function setupFromCheckpoint(options: Options): Promise<WorkplaceCheckpointSetupReceipt> {
  if (!options.checkpoint || !options.to) fail("checkpoint-schema-invalid", "setup --checkpoint requires an exact checkpoint and --to");
  if (options.checkpointFrom && !CHECKPOINT.test(options.checkpoint)) fail("checkpoint-schema-invalid", "--checkpoint-from requires an immutable checkpoint ID");
  const parent = await realpath(dirname(resolve(options.to))).catch(() => fail("checkpoint-path-invalid", "The destination parent must already exist"));
  const target = join(parent, basename(resolve(options.to)));
  let temporary: string | undefined;
  let bootstrap: Awaited<ReturnType<typeof resolveBootstrapRef>> | undefined;
  let remote: CheckpointRemoteReceipt | undefined;
  let packagePath = resolve(options.checkpoint);
  let requestedMember = options.as;
  let contextWorkplace: string | undefined;
  try {
    // Refuse ordinary existing destinations before contacting a remote.
    if (await exists(target) && (await lstat(target)).isSymbolicLink()) fail("checkpoint-target-exists", "Recovery destination must be physical");
    if (await exists(target) && !await exists(join(target, ".endroit/checkpoint-setup.json"))) fail("checkpoint-target-exists", `${target} is not an exact previous restoration`);
    await assertCheckpointGitPlacement(undefined, target, { restoring: !await exists(target) });
    if (CHECKPOINT.test(options.checkpoint)) {
      if (options.checkpointFrom) {
        let path = resolve(options.checkpointFrom);
        if (isBootstrapRef(options.checkpointFrom)) {
          bootstrap = await resolveBootstrapRef(options.checkpointFrom, { singleFile: true });
          path = bootstrap.recoveryPath;
        }
        const info = await lstat(path);
        if (!info.isFile() || info.isSymbolicLink()) fail("checkpoint-schema-invalid", "CheckpointFetchRequest must be a physical file");
        const request = parseFetchRequest(JSON.parse(await readFile(path, "utf8")), dirname(path));
        temporary = await mkdtemp(join(tmpdir(), "endroit-checkpoint-setup-"));
        const fetched = await fetchCheckpoint(options.checkpoint, request, join(temporary, "checkpoint"));
        packagePath = fetched.path; remote = fetched.receipt;
      } else {
        const mount = await resolveWorkplaceRoot(options.start);
        if (inside(mount, target)) fail("checkpoint-path-invalid", "Recovery destination must not be inside its source Mount");
        const descriptor = await loadContinuityDescriptor(mount);
        contextWorkplace = descriptor.workplace;
        const member = requestedMember && SLUG.test(requestedMember) ? `${descriptor.workplace}/member/${requestedMember}` : requestedMember;
        const current = await resolveCurrentMember({ anchorMount: mount, anchor: descriptor.anchor, workplace: descriptor.workplace });
        if (!requestedMember && current.status === "resolved") requestedMember = current.member;
        const local = await observeLocalCheckpoint(descriptor, options.checkpoint);
        if (local) packagePath = local.path;
        else {
          const fetched = await fetchContinuityCheckpoint(descriptor, options.checkpoint, { ...(member ? { member } : {}), line: descriptor.line });
          packagePath = fetched.store.path; remote = fetched.remote;
        }
      }
    }
    await assertCheckpointGitPlacement((await inspectCheckpoint(packagePath)).manifest, target, { restoring: !await exists(target) });
    const verified = await verifyCheckpoint(packagePath);
    const manifest = verified.manifest;
    if (contextWorkplace && contextWorkplace !== manifest.workplaceRef) fail("checkpoint-schema-invalid", "Checkpoint belongs to another Workplace than the source context");
    if (inside(verified.path, target) || inside(target, verified.path)) fail("checkpoint-path-invalid", "Checkpoint package and destination must be disjoint");
    const routes = topology(manifest);
    const restoredRoutes = routes.map(({ site, route }) => `${manifest.workplaceRef}/${site}/${route}`);
    const member = requestedMember ? SLUG.test(requestedMember) ? `${manifest.workplaceRef}/member/${requestedMember}` : requestedMember : null;
    if (member && (!member.startsWith(`${manifest.workplaceRef}/member/`) || !SLUG.test(member.slice(`${manifest.workplaceRef}/member/`.length)))) fail("checkpoint-schema-invalid", "--as must identify a Member of the restored Workplace");
    if (await exists(target)) {
      await physicalReplay(target, manifest);
      const previous = JSON.parse(await readFile(join(target, ".endroit/checkpoint-setup.json"), "utf8")) as WorkplaceCheckpointSetupReceipt;
      if (previous.kind !== "WorkplaceCheckpointSetupReceipt" || previous.version !== 1 || previous.mount !== target || previous.member !== member || previous.checkpoint?.checkpointId !== manifest.checkpointId) fail("checkpoint-target-exists", `${target} belongs to another restore request`);
      if (member && previous.recoveryRevision !== await recoveryRevision(target, options.from)) fail("checkpoint-target-exists", "Recovery declarations changed since the previous restoration");
      const result = await verifyRestoredCheckpoint(verified.path, target);
      const check = await checkWorkplaceMount({ mount: target });
      const targets = await Promise.all((previous.setup?.receipt.setup.targets ?? []).map(async (peer) => {
        const path = previous.setup!.plan.setup.plan.targets.find((entry) => entry.workplace === peer.workplace)?.resolvedMount;
        try { return { ...peer, check: await checkWorkplaceMount({ mount: path ?? fail("checkpoint-target-exists", "Recovery peer has no recorded Mount") }) }; }
        catch { return { ...peer, status: "unavailable" as const }; }
      }));
      const peersReady = targets.every((peer) => peer.status !== "unavailable" && peer.check?.operationStatus === "ready");
      const setup = previous.setup ? { ...previous.setup, status: peersReady ? previous.setup.status : "degraded" as const, receipt: { ...previous.setup.receipt, setup: { ...previous.setup.receipt.setup, status: peersReady ? previous.setup.receipt.setup.status : "degraded" as const, targets } } } : undefined;
      return { ...previous, ...(setup ? { setup } : {}), action: "unchanged", checkpoint: result.receipt, check, status: member ? check.operationStatus === "ready" && setup?.status === "ready" ? "ready" : "degraded" : "pending-member" };
    }
    let declarations: string | undefined;
    const restored = await restoreCheckpoint(verified.path, target, { beforeInstall: async (staging) => {
      const contract = JSON.parse(await readFile(join(staging, "workplace/workplace.json"), "utf8")) as Record<string, unknown>;
      if (contract.kind !== "WorkplaceBuildContract" || contract.version !== 2 || contract.workplace !== manifest.workplaceRef) fail("checkpoint-schema-invalid", "Checkpoint Root identity does not match its manifest");
      const declarationsCheck = await checkPortableDeclarations(join(staging, "workplace"));
      if (declarationsCheck.length) fail("checkpoint-schema-invalid", declarationsCheck.map((entry) => entry.message).join("; "));
      if (member) {
        declarations = await recoveryRevision(staging, options.from);
        const plan = await planRootSetup({ start: staging, ...(options.from ? { from: options.from } : {}), as: requestedMember, preservePortable: true, restoredRoutes });
        if (plan.plan.checkpoints.length || plan.continuity.missing.length) fail("checkpoint-schema-invalid", "Whole-Workplace recovery cannot also overlay another checkpoint");
        if (plan.plan.setup.plan.targets.some((entry) => entry.mount.mode !== "managed")) fail("checkpoint-path-invalid", "Whole-Workplace recovery only creates managed peer Mounts; external attachments are configured separately");
      }
    } });
    try {
      let setup: RootSetupResult | undefined;
      let localCheck: CheckResult | undefined;
      if (member) {
        if (declarations !== await recoveryRevision(target, options.from)) fail("checkpoint-schema-invalid", "Recovery declarations changed before setup");
        await ensureSetupIgnore(target);
        setup = await setupFromRoot({ start: target, ...(options.from ? { from: options.from } : {}), as: requestedMember, preservePortable: true, restoredRoutes });
        await bindRestoredSiteRoutes(target, routes);
        localCheck = await reconcilePreservedMount(target);
      }
      await verifyRestoredCheckpoint(verified.path, target);
      const check = localCheck ?? await checkWorkplaceMount({ mount: target });
      const frontDoor = join(target, "FRONTDOOR.md");
      const result: WorkplaceCheckpointSetupReceipt = {
        kind: "WorkplaceCheckpointSetupReceipt", version: 1, mount: target, action: "restored",
        status: !member ? "pending-member" : check.operationStatus === "ready" && setup?.status === "ready" ? "ready" : "degraded",
        member, ...(declarations ? { recoveryRevision: declarations } : {}), checkpoint: restored.receipt, check,
        ...(setup ? { setup } : {}),
        ...(setup && !check.diagnostics.some((entry) => entry.code === "local-projection-unavailable") && await exists(frontDoor) ? { frontDoor } : {}),
        ...(remote ? { remote } : {}), ...(bootstrap ? { bootstrap: bootstrap.receipt } : {}),
      };
      await mkdir(join(target, ".endroit"), { recursive: true });
      await writeFile(join(target, ".endroit/checkpoint-setup.json"), stable(result), { flag: "wx" });
      return result;
    } catch (error) {
      // Only this newly restored Mount is owned by this attempt; never an existing target.
      await rm(target, { recursive: true, force: true });
      throw error;
    }
  } finally {
    await bootstrap?.cleanup();
    if (temporary) await rm(temporary, { recursive: true, force: true });
  }
}
