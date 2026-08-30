import { describe, expect, test } from "bun:test";
import { lstat, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { captureCheckpoint, restoreCheckpoint, verifyCheckpoint } from "../src/checkpoint.ts";
import { applyNewWorkplace, loadStandardProfile, planNewWorkplace, type NewWorkplaceRequest } from "../src/compiler/new-workplace.ts";
import type { WorkplaceSetupRequest } from "../src/setup.ts";
import type { SiteRouteSetupRequest } from "../src/site-setup.ts";
import type { WorkplaceRecoveryPlan, WorkplaceRecoveryReceipt, WorkplaceRecoveryRequest } from "../src/recovery.ts";
import { checkpointFixture, cli, evidence, git, repository, run } from "./helpers/checkpoint-fixture.ts";

const profilePath = resolve(repository, "profiles/standard/profile.json");

function jsonCli(args: string[], expected = 0): unknown {
  const output = run(repository, [...cli, ...args], expected);
  return JSON.parse(output);
}

function errorCli(args: string[], expected: number): { code: string; error: string } {
  const result = Bun.spawnSync([...cli, ...args], { cwd: repository, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== expected) throw new Error(`CLI exited ${result.exitCode}: ${new TextDecoder().decode(result.stderr)}`);
  return JSON.parse(new TextDecoder().decode(result.stderr));
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) {
    if (error instanceof Error && error.message.includes("ENOENT")) return false;
    throw error;
  }
}

function newRequest(target: string, id: string): NewWorkplaceRequest {
  return {
    kind: "NewWorkplaceRequest", version: 1, target,
    workplace: { id, name: `${id} fixture` },
    member: { id: "operator", name: "Fixture Operator", language: "en" },
    desk: { id: "operator", name: "Operator Desk", welcome: { tone: "Direct.", humor: "None.", durableChanges: "Update owned sources only." } },
    providers: [],
    git: { initialize: true, commits: true, author: { name: "Fixture", email: "fixture@example.test" } },
  };
}

async function createWorkplace(target: string, id: string) {
  const profile = await loadStandardProfile(profilePath);
  const plan = planNewWorkplace(newRequest(target, id), { profile, cliCommand: cli });
  return applyNewWorkplace(plan, plan.revision);
}

async function recoveryFixture() {
  const state = await checkpointFixture();
  const anchor = await createWorkplace(join(state.root, "physical-b/anchor"), "anchor");
  const peer = await createWorkplace(join(state.root, "peer-source"), "peer");
  const peerRemote = join(state.root, "remotes/peer.git");
  await mkdir(dirname(peerRemote), { recursive: true });
  git(state.root, ["clone", "--bare", "--", peer.roots.shared, peerRemote]);
  await writeFile(join(anchor.mount, "workplace/links.json"), `${JSON.stringify({ kind: "WorkplaceLinks", version: 1, workplace: "workplace://anchor", links: [{ target: "workplace://peer" }] }, null, 2)}\n`);

  state.request.workplace = "workplace://anchor";
  state.request.ownerMember = "workplace://anchor/member/operator";
  state.request.roots = state.request.roots.map((root) => ({
    ...root,
    ref: root.ref.replace("workplace://fixture", "workplace://anchor"),
    worktrees: root.worktrees.map((worktree) => ({ ...worktree, logicalPath: `${worktree.id.split("-")[0]}/${worktree.id.endsWith("detached") ? "detached" : "main"}` })),
  }));
  const captured = await captureCheckpoint(state.request);
  const verified = await verifyCheckpoint(captured.path);

  const requestRoot = join(state.root, "requests");
  await mkdir(requestRoot, { recursive: true });
  const setup: WorkplaceSetupRequest = {
    kind: "WorkplaceSetupRequest", version: 1, anchor: "workplace://anchor",
    targets: [{
      workplace: "workplace://peer", relation: "link", required: true,
      mount: { mode: "managed", path: "checkouts/workplaces/peer" }, source: peerRemote,
      entry: JSON.parse(await readFile(join(peer.mount, ".endroit/entry.json"), "utf8")), providers: [],
    }],
  };
  const setupPath = join(requestRoot, "setup.json");
  await writeFile(setupPath, `${JSON.stringify(setup, null, 2)}\n`);
  const sites: SiteRouteSetupRequest = {
    kind: "SiteRouteSetupRequest", version: 1, workplace: "workplace://anchor",
    sites: [{ id: "clean-product", productRemote: { kind: "ProductRemote", locator: peerRemote }, routes: [{ id: "develop", revision: { kind: "branch", name: "develop" } }] }],
  };
  const sitesPath = join(requestRoot, "sites.json");
  await writeFile(sitesPath, `${JSON.stringify(sites, null, 2)}\n`);
  const roots = verified.manifest.repositories.map((repositorySnapshot) => ({
    ref: repositorySnapshot.rootRef,
    worktrees: repositorySnapshot.worktrees.map((id) => {
      const worktree = verified.manifest.worktrees.find((candidate) => candidate.worktreeId === id)!;
      const [site, route] = worktree.logicalPath.split("/");
      return { id, logicalPath: worktree.logicalPath, site: site!, route: route! };
    }),
  }));
  const request: WorkplaceRecoveryRequest = {
    kind: "WorkplaceRecoveryRequest", version: 1, anchor: "workplace://anchor", setup: "setup.json",
    sites: [{ workplace: "workplace://anchor", request: "sites.json" }],
    checkpoints: [{
      id: "anchor-sites", workplace: "workplace://anchor", checkpoint: captured.path,
      target: "checkouts/sites", checkpointId: captured.receipt.checkpointId,
      portableFingerprint: captured.receipt.portableFingerprint, roots,
    }],
    position: { workplace: "workplace://peer", member: "workplace://peer/member/operator", desk: "workplace://peer/desk/operator" },
  };
  const requestPath = join(requestRoot, "recovery.json");
  await writeFile(requestPath, `${JSON.stringify(request, null, 2)}\n`);
  return { ...state, captureRequest: state.request, anchor, peer, peerRemote, captured, request, requestPath };
}

describe("fresh-machine Workplace recovery", () => {
  test("previews, restores dirty Sites, resolves Position and replays unchanged", async () => {
    const state = await recoveryFixture();
    try {
      const target = join(state.anchor.mount, "checkouts/sites");
      const managedPeer = join(state.anchor.mount, "checkouts/workplaces/peer");
      const cleanRoute = join(target, "clean-product/develop");
      const checkouts = join(state.anchor.mount, "checkouts");
      const outsideCheckouts = join(state.root, "outside-checkouts");
      await mkdir(outsideCheckouts, { recursive: true });
      await symlink(outsideCheckouts, checkouts);
      const escapedFamily = errorCli(["workplace", "recover", state.anchor.mount, "--from", state.requestPath, "--preview", "--json"], 1);
      expect(escapedFamily.code).toBe("setup-collision");
      expect(await exists(join(outsideCheckouts, "workplaces"))).toBe(false);
      await rm(checkouts, { recursive: false, force: false });

      for (const invalid of [
        { ...state.request, checkpoints: [{ ...state.request.checkpoints[0]!, target: "checkouts/workplaces" }] },
        { ...state.request, checkpoints: [{ ...state.request.checkpoints[0]!, roots: state.request.checkpoints[0]!.roots.map((root, index) => index ? root : { ...root, worktrees: root.worktrees.map((worktree, worktreeIndex) => worktreeIndex ? worktree : { ...worktree, site: "workplaces", logicalPath: `workplaces/${worktree.route}` }) }) }] },
      ]) {
        const invalidPath = join(dirname(state.requestPath), `invalid-${crypto.randomUUID()}.json`);
        await writeFile(invalidPath, `${JSON.stringify(invalid, null, 2)}\n`);
        const error = errorCli(["workplace", "recover", state.anchor.mount, "--from", invalidPath, "--preview", "--json"], 2);
        expect(error.code).toBe("invalid-recovery-request");
        expect(await exists(target)).toBe(false);
        expect(await exists(managedPeer)).toBe(false);
        expect(await exists(join(state.anchor.mount, ".endroit/workplaces.json"))).toBe(false);
      }
      const overlapSitesPath = join(dirname(state.requestPath), "overlap-sites.json");
      await writeFile(overlapSitesPath, `${JSON.stringify({
        kind: "SiteRouteSetupRequest", version: 1, workplace: "workplace://anchor",
        sites: [{ id: "desk", productRemote: { kind: "ProductRemote", locator: state.peerRemote }, routes: [{ id: "main", revision: { kind: "branch", name: "develop" } }] }],
      }, null, 2)}\n`);
      const overlapPath = join(dirname(state.requestPath), "overlap-recovery.json");
      await writeFile(overlapPath, `${JSON.stringify({ ...state.request, sites: [{ workplace: "workplace://anchor", request: "overlap-sites.json" }] }, null, 2)}\n`);
      const overlap = errorCli(["workplace", "recover", state.anchor.mount, "--from", overlapPath, "--preview", "--json"], 2);
      expect(overlap.code).toBe("invalid-recovery-request");
      expect(await exists(target)).toBe(false);
      expect(await exists(managedPeer)).toBe(false);

      const noGitPreview = Bun.spawnSync([...cli, "workplace", "recover", state.anchor.mount, "--from", state.requestPath, "--preview", "--json"], {
        cwd: repository, stdout: "pipe", stderr: "pipe", env: { ...process.env, PATH: "/endroit-preview-has-no-tools" },
      });
      expect(noGitPreview.exitCode).toBe(0);
      const preview = JSON.parse(new TextDecoder().decode(noGitPreview.stdout)) as WorkplaceRecoveryPlan;
      expect(preview.checkpoints[0]?.action).toBe("restore");
      expect(preview.sites[0]?.plan.sites[0]?.routes[0]?.action).toBe("materialize");
      expect(preview.checkpoints[0]?.roots.flatMap((root) => root.worktrees)).toHaveLength(4);
      expect(await exists(target)).toBe(false);
      expect(await exists(managedPeer)).toBe(false);
      const outsideSites = join(state.root, "outside-sites");
      await mkdir(outsideSites, { recursive: true });
      await mkdir(dirname(target), { recursive: true });
      await symlink(outsideSites, target);
      const racedFamily = errorCli(["workplace", "recover", state.anchor.mount, "--from", state.requestPath, "--apply", preview.revision, "--json"], 1);
      expect(racedFamily.code).toBe("site-route-collision");
      expect(await exists(join(outsideSites, "shared"))).toBe(false);
      expect(await exists(managedPeer)).toBe(false);
      expect(await exists(join(state.anchor.mount, ".endroit/workplaces.json"))).toBe(false);
      await rm(target, { recursive: false, force: false });

      const stale = errorCli(["workplace", "recover", state.anchor.mount, "--from", state.requestPath, "--apply", `sha256:${"0".repeat(64)}`, "--json"], 2);
      expect(stale.code).toBe("recovery-digest-mismatch");
      expect(await exists(target)).toBe(false);
      expect(await exists(managedPeer)).toBe(false);

      const before = new Map([
        ["shared-main", evidence(state.shared)], ["shared-detached", evidence(state.detached)],
        ["desk-main", evidence(state.desk)], ["site-main", evidence(state.site)],
      ]);
      const receipt = jsonCli(["workplace", "recover", state.anchor.mount, "--from", state.requestPath, "--apply", preview.revision, "--json"]) as WorkplaceRecoveryReceipt;
      expect(receipt.status).toBe("ready");
      expect(receipt.setup.status).toBe("ready");
      expect(receipt.checkpoints[0]?.status).toBe("restored-equivalent");
      expect(receipt.sites[0]?.sites[0]?.routes[0]?.status).toBe("cloned");
      expect(receipt.position.status).toBe("resolved");
      expect(await exists(managedPeer)).toBe(true);
      expect(git(cleanRoute, ["status", "--porcelain"])).toBe("");
      expect(git(cleanRoute, ["symbolic-ref", "--short", "HEAD"])).toBe("develop");
      expect(git(cleanRoute, ["remote", "get-url", "origin"])).toBe(state.peerRemote);
      expect(resolve(state.source)).not.toBe(resolve(target));
      for (const worktree of state.captureRequest.roots.flatMap((root) => root.worktrees)) {
        expect(evidence(join(target, worktree.logicalPath))).toBe(before.get(worktree.id));
      }

      const replay = jsonCli(["workplace", "recover", state.anchor.mount, "--from", state.requestPath, "--preview", "--json"]) as WorkplaceRecoveryPlan;
      expect(replay.checkpoints[0]?.action).toBe("verify");
      expect(replay.sites[0]?.plan.sites[0]?.routes[0]?.action).toBe("verify");
      const replayReceipt = jsonCli(["workplace", "recover", state.anchor.mount, "--from", state.requestPath, "--apply", replay.revision, "--json"]) as WorkplaceRecoveryReceipt;
      expect(replayReceipt.setup.targets.every((item) => item.status === "unchanged")).toBe(true);
      expect(replayReceipt.checkpoints[0]?.action).toBe("verify");
      expect(replayReceipt.checkpoints[0]?.status).toBe("restored-equivalent");
      expect(replayReceipt.sites[0]?.sites[0]?.routes[0]?.status).toBe("unchanged");

      const restoredRoute = join(target, "desk/main");
      const outsideRoute = join(state.root, "outside-route");
      await rename(restoredRoute, outsideRoute);
      await symlink(outsideRoute, restoredRoute);
      const escapedRoute = errorCli(["workplace", "recover", state.anchor.mount, "--from", state.requestPath, "--preview", "--json"], 1);
      expect(escapedRoute.code).toBe("recovery-collision");
    } finally {
      await rm(state.root, { recursive: true, force: true });
    }
  });

  test("rolls setup back when an existing restore target mismatches", async () => {
    const state = await recoveryFixture();
    try {
      const target = join(state.anchor.mount, "checkouts/sites");
      await restoreCheckpoint(state.captured.path, target);
      await writeFile(join(target, "desk/main/work.txt"), "drifted after restore\n");
      const preview = jsonCli(["workplace", "recover", state.anchor.mount, "--from", state.requestPath, "--preview", "--json"]) as WorkplaceRecoveryPlan;
      expect(preview.checkpoints[0]?.action).toBe("verify");
      const error = errorCli(["workplace", "recover", state.anchor.mount, "--from", state.requestPath, "--apply", preview.revision, "--json"], 1);
      expect(error.code).toBe("checkpoint-restore-mismatch");
      expect(await exists(join(state.anchor.mount, ".endroit/workplaces.json"))).toBe(false);
      expect(await exists(join(state.anchor.mount, "checkouts/workplaces/peer"))).toBe(false);
      expect(await readFile(join(target, "desk/main/work.txt"), "utf8")).toBe("drifted after restore\n");
    } finally {
      await rm(state.root, { recursive: true, force: true });
    }
  });

  test("materializes physical state while Current Member is pending, then bootstraps and reuses the local binding", async () => {
    const state = await recoveryFixture();
    try {
      const pendingRequest = { ...state.request, position: { workplace: "workplace://peer" } };
      const pendingPath = join(dirname(state.requestPath), "pending-member.json");
      await writeFile(pendingPath, `${JSON.stringify(pendingRequest, null, 2)}\n`);
      const preview = jsonCli(["workplace", "recover", state.anchor.mount, "--from", pendingPath, "--preview", "--json"]) as WorkplaceRecoveryPlan;
      expect(preview.position.status).toBe("pending-member");
      const pending = jsonCli(["workplace", "recover", state.anchor.mount, "--from", pendingPath, "--apply", preview.revision, "--json"]) as WorkplaceRecoveryReceipt;
      expect(pending.status).toBe("pending-member");
      expect(pending.position.status).toBe("pending-member");
      expect(await exists(join(state.anchor.mount, "checkouts/sites/clean-product/develop"))).toBe(true);
      expect(await exists(join(state.anchor.mount, "checkouts/workplaces/peer"))).toBe(true);

      const explicitPreview = jsonCli(["workplace", "recover", state.anchor.mount, "--from", state.requestPath, "--preview", "--json"]) as WorkplaceRecoveryPlan;
      const ready = jsonCli(["workplace", "recover", state.anchor.mount, "--from", state.requestPath, "--apply", explicitPreview.revision, "--json"]) as WorkplaceRecoveryReceipt;
      expect(ready.status).toBe("ready");
      expect(await exists(join(state.anchor.mount, ".endroit/current-member.json"))).toBe(true);

      const localPreview = jsonCli(["workplace", "recover", state.anchor.mount, "--from", pendingPath, "--preview", "--json"]) as WorkplaceRecoveryPlan;
      expect(localPreview.position.status).toBe("resolved");
      if (localPreview.position.status !== "resolved") throw new Error("local Current Member did not resolve");
      expect(localPreview.position.source).toBe("local");
      const local = jsonCli(["workplace", "recover", state.anchor.mount, "--from", pendingPath, "--apply", localPreview.revision, "--json"]) as WorkplaceRecoveryReceipt;
      expect(local.status).toBe("ready");
    } finally {
      await rm(state.root, { recursive: true, force: true });
    }
  });

  test("removes a newly restored target when Position resolution fails", async () => {
    const state = await recoveryFixture();
    try {
      const request = { ...state.request, position: { ...state.request.position, member: "workplace://peer/member/someone-else" } };
      const requestPath = join(dirname(state.requestPath), "position-mismatch.json");
      await writeFile(requestPath, `${JSON.stringify(request, null, 2)}\n`);
      const preview = jsonCli(["workplace", "recover", state.anchor.mount, "--from", requestPath, "--preview", "--json"]) as WorkplaceRecoveryPlan;
      const error = errorCli(["workplace", "recover", state.anchor.mount, "--from", requestPath, "--apply", preview.revision, "--json"], 1);
      expect(error.code).toBe("recovery-position-mismatch");
      expect(await exists(join(state.anchor.mount, "checkouts/sites"))).toBe(false);
      expect(await exists(join(state.anchor.mount, "checkouts/workplaces/peer"))).toBe(false);
      expect(await exists(join(state.anchor.mount, ".endroit/workplaces.json"))).toBe(false);
    } finally {
      await rm(state.root, { recursive: true, force: true });
    }
  });

  test("rolls back a newly persisted Binding without deleting its pre-existing clean Route", async () => {
    const state = await recoveryFixture();
    try {
      const family = join(state.anchor.mount, "checkouts/sites");
      const preexistingRoute = join(family, "clean-product/develop");
      await mkdir(dirname(preexistingRoute), { recursive: true });
      git(state.root, ["clone", "--branch", "develop", "--", state.peerRemote, preexistingRoute]);
      const bindingRegistry = join(state.anchor.mount, ".endroit/site-route-bindings.json");
      expect(await exists(bindingRegistry)).toBe(false);
      const request = {
        ...state.request,
        checkpoints: [],
        position: { ...state.request.position, member: "workplace://peer/member/someone-else" },
      };
      const requestPath = join(dirname(state.requestPath), "clean-position-mismatch.json");
      await writeFile(requestPath, `${JSON.stringify(request, null, 2)}\n`);
      const preview = jsonCli(["workplace", "recover", state.anchor.mount, "--from", requestPath, "--preview", "--json"]) as WorkplaceRecoveryPlan;
      expect(preview.sites[0]?.plan.sites[0]?.routes[0]?.action).toBe("verify");
      const error = errorCli(["workplace", "recover", state.anchor.mount, "--from", requestPath, "--apply", preview.revision, "--json"], 1);
      expect(error.code).toBe("recovery-position-mismatch");
      expect(await exists(family)).toBe(true);
      expect(await exists(preexistingRoute)).toBe(true);
      expect(git(preexistingRoute, ["status", "--porcelain"])).toBe("");
      expect(await exists(bindingRegistry)).toBe(false);
      expect(await exists(join(state.anchor.mount, "checkouts/workplaces/peer"))).toBe(false);
    } finally {
      await rm(state.root, { recursive: true, force: true });
    }
  });
});
