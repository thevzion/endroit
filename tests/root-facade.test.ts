import { describe, expect, test } from "bun:test";
import { cp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { applyNewWorkplace, loadStandardProfile, planNewWorkplace, type NewWorkplaceRequest } from "../src/compiler/new-workplace.ts";
import { applyWorkplaceRecovery, planWorkplaceRecovery, RecoveryError, type WorkplaceRecoveryPlan, type WorkplaceRecoveryRequest } from "../src/recovery.ts";
import { planRootSetup, selectRecoveryRequest, setupFromRoot, statusFromRoot, type RootSetupResult } from "../src/root-facade.ts";
import type { ContinuityStoreReceipt } from "../src/checkpoint-store.ts";
import type { WorkplaceSetupRequest } from "../src/setup.ts";
import { checkpointFixture, cli, evidence, git, repository } from "./helpers/checkpoint-fixture.ts";

const profilePath = resolve(repository, "profiles/standard/profile.json");
const member = "workplace://anchor/member/operator";

function jsonCli(cwd: string, args: string[], expected = 0, env: Record<string, string | undefined> = process.env): unknown {
  const result = Bun.spawnSync([...cli, ...args], { cwd, stdout: "pipe", stderr: "pipe", env });
  if (result.exitCode !== expected) throw new Error(`CLI exited ${result.exitCode}: ${new TextDecoder().decode(result.stderr)}`);
  const bytes = expected === 0 ? result.stdout : result.stderr;
  return JSON.parse(new TextDecoder().decode(bytes));
}

async function tree(root: string, current = root): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) result.push(...await tree(root, path));
    else result.push(path.slice(root.length + 1));
  }
  return result.sort();
}

async function fixture() {
  const root = resolve(tmpdir(), `endroit-root-facade-${crypto.randomUUID()}`);
  const mount = join(root, "anchor");
  const request: NewWorkplaceRequest = {
    kind: "NewWorkplaceRequest", version: 1, target: mount,
    workplace: { id: "anchor", name: "Synthetic Anchor" },
    member: { id: "operator", name: "Synthetic Operator", language: "en" },
    desk: { id: "operator", name: "Operator Desk", welcome: { tone: "Direct.", humor: "None.", durableChanges: "Change owned sources only." } },
    providers: [],
    git: { initialize: true, commits: true, author: { name: "Synthetic Fixture", email: "fixture@example.test" } },
  };
  const profile = await loadStandardProfile(profilePath);
  const creation = planNewWorkplace(request, { profile, cliCommand: cli });
  await applyNewWorkplace(creation, creation.revision);
  const requestRoot = join(mount, "workplace/.workplace");
  await mkdir(requestRoot, { recursive: true });
  const setup: WorkplaceSetupRequest = { kind: "WorkplaceSetupRequest", version: 1, anchor: "workplace://anchor", targets: [] };
  const setupPath = join(requestRoot, "setup.json");
  await writeFile(setupPath, `${JSON.stringify(setup, null, 2)}\n`);
  const recovery: WorkplaceRecoveryRequest = {
    kind: "WorkplaceRecoveryRequest", version: 1, anchor: "workplace://anchor", setup: "setup.json", sites: [], checkpoints: [],
    position: { workplace: "workplace://anchor", member, desk: "workplace://anchor/desk/operator" },
  };
  const recoveryPath = join(requestRoot, "recovery.json");
  await writeFile(recoveryPath, `${JSON.stringify(recovery, null, 2)}\n`);
  return { root, mount, requestRoot, setupPath, recovery, recoveryPath };
}

describe("root-driven Workplace facade", () => {
  test("uses the exact advanced Recovery Plan and Receipt and replays unchanged", async () => {
    const state = await fixture();
    try {
      const nested = join(state.mount, "workplace/sources/members/operator/desk");
      const advanced = await planWorkplaceRecovery(state.recovery, { anchorMount: await realpath(state.mount), requestDirectory: await realpath(state.requestRoot) });
      const smart = await planRootSetup({ start: nested });
      expect(smart.recovery.provenance).toBe("portable");
      expect(smart.plan).toEqual(advanced);
      const advancedReceipt = await applyWorkplaceRecovery(advanced, advanced.revision);
      const replay = await setupFromRoot({ start: nested, as: member });
      expect(replay.status).toBe("ready");
      expect(replay.continuity).toEqual({ status: "available", requirement: "undeclared", missing: [] });
      expect(replay.plan).toEqual(advanced);
      expect(replay.receipt).toEqual(advancedReceipt);
      expect((await setupFromRoot({ start: nested, as: member })).receipt).toEqual(replay.receipt);
      const fromCli = jsonCli(nested, ["setup", "--as", member, "--json"]) as typeof replay;
      expect(fromCli.plan).toEqual(advanced);
      expect(fromCli.receipt).toEqual(advancedReceipt);
      expect((jsonCli(nested, ["status", "--json"]) as { recovery: { status: string } }).recovery.status).toBe("declared");
    } finally { await rm(state.root, { recursive: true, force: true }); }
  });

  test("honors explicit, local and portable Request precedence and keeps status read-only", async () => {
    const state = await fixture();
    try {
      expect((await selectRecoveryRequest(state.mount)).provenance).toBe("portable");
      const external = join(state.root, "bootstrap/recovery.json");
      await mkdir(dirname(external), { recursive: true });
      await writeFile(external, `${JSON.stringify({ ...state.recovery, setup: state.setupPath }, null, 2)}\n`);
      const first = await setupFromRoot({ start: state.mount, with: external, as: member });
      expect(first.source).toBe("explicit");
      const local = await selectRecoveryRequest(state.mount);
      expect(local.provenance).toBe("local");
      expect(local.request.setup).toBe(state.setupPath);
      expect((await selectRecoveryRequest(state.mount, state.recoveryPath)).provenance).toBe("explicit");
      const before = await readFile(join(state.mount, ".endroit/recovery.json"), "utf8");
      const status = await statusFromRoot(join(state.mount, "workplace"));
      expect(status.mount).toBe(await realpath(state.mount));
      expect(status.recovery.status).toBe("declared");
      expect(await readFile(join(state.mount, ".endroit/recovery.json"), "utf8")).toBe(before);
    } finally { await rm(state.root, { recursive: true, force: true }); }
  });

  test("proves --as from Member and same-id Desk sources before remembering it", async () => {
    const state = await fixture();
    try {
      const valid = await setupFromRoot({ start: state.mount, as: member });
      expect(valid.receipt.position.status).toBe("resolved");
      expect(valid.receipt.position.source).toBe("request");
      expect(valid.receipt.position.status === "resolved" ? valid.receipt.position.member : undefined).toBe(member);
      const binding = JSON.parse(await readFile(join(state.mount, ".endroit/current-member.json"), "utf8")) as { members: Array<{ member: string }> };
      expect(binding.members.map((entry) => entry.member)).toEqual([member]);
    } finally { await rm(state.root, { recursive: true, force: true }); }

    const invalid = await fixture();
    try {
      let observed: unknown;
      try { await setupFromRoot({ start: invalid.mount, as: "workplace://anchor/member/unknown" }); }
      catch (error) { observed = error; }
      expect(observed instanceof RecoveryError).toBe(true);
      const cliError = jsonCli(invalid.mount, ["setup", "--as", "workplace://anchor/member/unknown", "--json"], 1) as { code: string };
      expect(cliError.code).toBe("recovery-position-mismatch");
      expect(await Bun.file(join(invalid.mount, ".endroit/current-member.json")).exists()).toBe(false);
    } finally { await rm(invalid.root, { recursive: true, force: true }); }
  });

  test("names missing continuity without claiming ready and blocks only required Position", async () => {
    const state = await fixture();
    try {
      const missing = {
        id: "anchor-sites", workplace: "workplace://anchor", checkpoint: join(state.root, "absent-checkpoint"), target: "checkouts/sites" as const,
        checkpointId: `checkpoint:sha256:${"1".repeat(64)}`, portableFingerprint: `sha256:${"2".repeat(64)}`,
        roots: [{ ref: "workplace://anchor/root/product", worktrees: [{ id: "product-main", logicalPath: "product/main", site: "product", route: "main" }] }],
      };
      const recoveryPath = join(state.root, "missing-recovery.json");
      await writeFile(recoveryPath, `${JSON.stringify({ ...state.recovery, setup: state.setupPath, checkpoints: [missing] }, null, 2)}\n`);
      const optional = await setupFromRoot({ start: state.mount, from: recoveryPath, as: member });
      expect(optional.status).toBe("degraded");
      expect(optional.receipt.status).toBe("ready");
      expect(optional.plan.checkpoints).toEqual([]);
      expect(optional.continuity.missing).toEqual([{ id: "anchor-sites", checkpointId: missing.checkpointId, action: `endroit checkpoint fetch ${missing.checkpointId} --json` }]);

      await writeFile(join(state.mount, ".endroit/continuity.json"), `${JSON.stringify({
        kind: "ContinuityDescriptor", version: 1, capture: "capture.json", store: "checkpoints", restoreTarget: "../checkouts/sites", setupContinuity: "required",
      }, null, 2)}\n`);
      const remembered = await readFile(join(state.mount, ".endroit/current-member.json"), "utf8");
      const required = await setupFromRoot({ start: state.mount, from: recoveryPath, as: member });
      expect(required.status).toBe("blocked-continuity");
      expect(required.receipt.status).toBe("blocked-continuity");
      expect(required.receipt.position.status).toBe("blocked-continuity");
      expect(required.receipt.position.status === "blocked-continuity" ? required.receipt.position.currentMember.status : undefined).toBe("resolved");
      expect(await readFile(join(state.mount, ".endroit/current-member.json"), "utf8")).toBe(remembered);
      expect(required.plan.positionBlock).toEqual({ reason: "required-continuity", checkpoints: [missing.checkpointId] });
      const { positionBlock: _positionBlock, ...unblocked } = required.plan;
      let tampered: unknown;
      try { await applyWorkplaceRecovery(unblocked as WorkplaceRecoveryPlan, required.plan.revision); }
      catch (error) { tampered = error; }
      expect(tampered instanceof RecoveryError ? tampered.code : undefined).toBe("recovery-digest-mismatch");
      expect(required.continuity.status).toBe("blocked");
      expect(required.continuity.requirement).toBe("required");

      const stored = join(state.mount, `.endroit/checkpoints/${missing.checkpointId.slice("checkpoint:sha256:".length)}`);
      await mkdir(stored, { recursive: true });
      await writeFile(join(state.mount, ".endroit/recovery.json"), `${JSON.stringify({ ...state.recovery, setup: state.setupPath, checkpoints: [missing] }, null, 2)}\n`);
      const beforeStatus = await tree(join(state.mount, ".endroit/checkpoints"));
      const status = jsonCli(state.mount, ["status", "--json"]) as { recovery: { continuity: { status: string; verification: string } } };
      expect(status.recovery.continuity).toEqual({ status: "available", requirement: "required", missing: [], verification: "not-run" });
      expect(await tree(join(state.mount, ".endroit/checkpoints"))).toEqual(beforeStatus);
    } finally { await rm(state.root, { recursive: true, force: true }); }
  });

  test("does not remember an explicit Member while required continuity blocks Position", async () => {
    const state = await fixture();
    try {
      const checkpointId = `checkpoint:sha256:${"3".repeat(64)}`;
      const recoveryPath = join(state.root, "required-recovery.json");
      await writeFile(recoveryPath, `${JSON.stringify({
        ...state.recovery,
        setup: state.setupPath,
        checkpoints: [{
          id: "anchor-sites", workplace: "workplace://anchor", checkpoint: join(state.root, "absent-checkpoint"), target: "checkouts/sites",
          checkpointId, portableFingerprint: `sha256:${"4".repeat(64)}`,
          roots: [{ ref: "workplace://anchor/root/product", worktrees: [{ id: "product-main", logicalPath: "product/main", site: "product", route: "main" }] }],
        }],
      }, null, 2)}\n`);
      await writeFile(join(state.mount, ".endroit/continuity.json"), `${JSON.stringify({
        kind: "ContinuityDescriptor", version: 1, capture: "capture.json", store: "checkpoints", restoreTarget: "../checkouts/sites", setupContinuity: "required",
      }, null, 2)}\n`);
      const result = await setupFromRoot({ start: state.mount, from: recoveryPath, as: member });
      expect(result.receipt.status).toBe("blocked-continuity");
      expect(await Bun.file(join(state.mount, ".endroit/current-member.json")).exists()).toBe(false);
    } finally { await rm(state.root, { recursive: true, force: true }); }
  });

  test("rejects local Recovery Requests reached through a symlinked family", async () => {
    const state = await fixture();
    try {
      const outside = join(state.root, "outside-local-state");
      await mkdir(outside, { recursive: true });
      await writeFile(join(outside, "recovery.json"), `${JSON.stringify({ ...state.recovery, setup: state.setupPath }, null, 2)}\n`);
      await rm(join(state.mount, ".endroit"), { recursive: true, force: true });
      await symlink(outside, join(state.mount, ".endroit"));
      let observed: unknown;
      try { await selectRecoveryRequest(state.mount); }
      catch (error) { observed = error; }
      expect(observed instanceof Error && "code" in observed ? observed.code : undefined).toBe("recovery-request-unavailable");
      expect((await readdir(outside, { withFileTypes: true })).map((entry) => entry.name)).toEqual(["recovery.json"]);
    } finally { await rm(state.root, { recursive: true, force: true }); }
  });

  test("round-trips a dirty multi-worktree topology from machine A to B through root commands", async () => {
    const machineA = await fixture();
    const machineB = await fixture();
    try {
      const topology = await checkpointFixture({
        root: join(machineA.root, "topology"), source: join(machineA.mount, "checkouts/sites"), siteLayout: true, platformNeutral: true,
      });
      const capture = {
        ...topology.request,
        workplace: "workplace://anchor",
        roots: topology.request.roots.map((root) => ({
          ...root,
          ref: root.ref.replace("workplace://fixture", "workplace://anchor"),
          worktrees: root.worktrees,
        })),
      };
      const capturePath = join(machineA.mount, ".endroit/capture.json");
      await writeFile(capturePath, `${JSON.stringify(capture, null, 2)}\n`);
      await writeFile(join(machineA.mount, ".endroit/continuity.json"), `${JSON.stringify({
        kind: "ContinuityDescriptor", version: 1, capture: "capture.json", store: "checkpoints", restoreTarget: "../unused-restore", setupContinuity: "optional",
      }, null, 2)}\n`);

      expect(git(topology.detached, ["branch", "--show-current"])).toBe("");
      expect(git(topology.desk, ["status", "--porcelain=v2", "--untracked-files=all"])).toContain("work.txt");
      expect(git(topology.site, ["diff", "--name-only", "--diff-filter=U"])).toBe("conflict.txt");
      for (const worktree of capture.roots.flatMap((root) => root.worktrees)) {
        expect(relative(topology.source, worktree.path).replaceAll("\\", "/")).toBe(worktree.logicalPath);
      }

      const created = jsonCli(join(machineA.mount, "workplace"), ["checkpoint", "--json"]) as ContinuityStoreReceipt;
      expect(created.operation).toBe("create");
      expect(created.verification.coverage).toEqual({
        repositories: 3, worktrees: 4, untracked: 1, ignored: 1,
        exclusions: ["filesystem-metadata", "special-files", "ignored-files-not-selected", "provider-state", "credentials"],
      });
      expect(git(join(machineA.mount, "workplace"), ["remote"])).toBe("");
      for (const worktree of capture.roots.flatMap((root) => root.worktrees)) expect(git(worktree.path, ["remote"])).toBe("");

      const targetStore = join(machineB.mount, ".endroit/checkpoints");
      const targetPackage = join(targetStore, created.checkpointId.slice("checkpoint:sha256:".length));
      await mkdir(targetStore, { recursive: true });
      await cp(created.path, targetPackage, { recursive: true });
      await writeFile(join(targetStore, "latest.json"), `${JSON.stringify({ kind: "ContinuityLatest", version: 1, checkpointId: created.checkpointId }, null, 2)}\n`);
      await writeFile(join(machineB.mount, ".endroit/continuity.json"), `${JSON.stringify({
        kind: "ContinuityDescriptor", version: 1, capture: "unused.json", store: "checkpoints", restoreTarget: "../manual-restore", setupContinuity: "required",
      }, null, 2)}\n`);

      const recoveryRoots = capture.roots.map((root) => ({
        ref: root.ref,
        worktrees: root.worktrees.map((worktree) => {
          const [site, route] = worktree.logicalPath.split("/");
          return { id: worktree.id, logicalPath: worktree.logicalPath, site: site!, route: route! };
        }),
      }));
      const recovery: WorkplaceRecoveryRequest = {
        ...machineB.recovery,
        setup: machineB.setupPath,
        checkpoints: [{
          id: "anchor-sites", workplace: "workplace://anchor", checkpoint: join(machineB.root, "absent-package"), target: "checkouts/sites",
          checkpointId: created.checkpointId, portableFingerprint: created.verification.portableFingerprint, roots: recoveryRoots,
        }],
      };
      await writeFile(join(machineB.mount, ".endroit/recovery.json"), `${JSON.stringify(recovery, null, 2)}\n`);

      const status = jsonCli(machineB.mount, ["status", "--json"]) as { recovery: { continuity: { status: string; verification: string } } };
      expect(status.recovery.continuity).toEqual({ status: "available", requirement: "required", missing: [], verification: "not-run" });
      const target = join(machineB.mount, "checkouts/sites");
      const manualTarget = join(machineB.mount, "manual-restore");
      expect(await Bun.file(target).exists()).toBe(false);
      expect(await Bun.file(manualTarget).exists()).toBe(false);
      const restored = jsonCli(machineB.mount, ["checkpoint", "restore", "latest", "--json"]) as { path: string; receipt: { status: string; checkpointId: string; portableFingerprint: string } };
      expect(restored.path).toBe(await realpath(manualTarget));
      expect(restored.receipt).toEqual({
        schema: "workplace-checkpoint-receipt/1", operation: "restore", checkpointId: created.checkpointId,
        workplaceRef: "workplace://anchor", portableFingerprint: created.verification.portableFingerprint,
        status: "restored-equivalent", coverage: created.verification.coverage,
      });
      expect(await Bun.file(join(machineB.mount, ".endroit/current-member.json")).exists()).toBe(false);
      expect(await Bun.file(target).exists()).toBe(false);

      const sourceEvidence = new Map(capture.roots.flatMap((root) => root.worktrees).map((worktree) => [worktree.id, evidence(worktree.path)]));
      for (const worktree of capture.roots.flatMap((root) => root.worktrees)) {
        const restoredPath = join(manualTarget, worktree.logicalPath);
        expect(resolve(restoredPath)).not.toBe(resolve(worktree.path));
        expect(evidence(restoredPath)).toBe(sourceEvidence.get(worktree.id));
        expect(git(restoredPath, ["remote"])).toBe("");
      }

      const first = jsonCli(join(machineB.mount, "workplace"), ["setup", "--json"]) as RootSetupResult;
      expect(first.status).toBe("ready");
      expect(first.receipt.checkpoints).toEqual([{
        id: "anchor-sites", workplace: "workplace://anchor", target: await realpath(target), action: "restore",
        status: "restored-equivalent", checkpointId: created.checkpointId, portableFingerprint: created.verification.portableFingerprint,
      }]);
      for (const worktree of capture.roots.flatMap((root) => root.worktrees)) {
        expect(evidence(join(target, worktree.logicalPath))).toBe(sourceEvidence.get(worktree.id));
      }
      const memberBinding = await readFile(join(machineB.mount, ".endroit/current-member.json"), "utf8");
      const storeBeforeReplay = await tree(targetStore);
      const evidenceBeforeReplay = new Map(capture.roots.flatMap((root) => root.worktrees).map((worktree) => [worktree.id, evidence(join(target, worktree.logicalPath))]));
      const replay = jsonCli(machineB.mount, ["setup", "--json"]) as RootSetupResult;
      expect(replay.status).toBe("ready");
      expect(replay.receipt.checkpoints).toEqual([{
        id: "anchor-sites", workplace: "workplace://anchor", target: await realpath(target), action: "verify",
        status: "restored-equivalent", checkpointId: created.checkpointId, portableFingerprint: created.verification.portableFingerprint,
      }]);
      expect(await readFile(join(machineB.mount, ".endroit/current-member.json"), "utf8")).toBe(memberBinding);
      expect(await tree(targetStore)).toEqual(storeBeforeReplay);
      for (const worktree of capture.roots.flatMap((root) => root.worktrees)) expect(evidence(join(target, worktree.logicalPath))).toBe(evidenceBeforeReplay.get(worktree.id));

      if (process.env.ENDROIT_ACCEPTANCE_TRACE === "1") console.log(JSON.stringify({
        machineA: await realpath(machineA.mount), machineB: await realpath(machineB.mount), sourceRoot: await realpath(topology.source), restoredRoot: await realpath(target),
        checkpointId: created.checkpointId, sourceFingerprint: created.verification.portableFingerprint, targetFingerprint: restored.receipt.portableFingerprint,
        firstAction: first.receipt.checkpoints[0]?.action, replayAction: replay.receipt.checkpoints[0]?.action, replayUnchanged: true,
      }));
    } finally {
      await rm(machineA.root, { recursive: true, force: true });
      await rm(machineB.root, { recursive: true, force: true });
    }
  });
});
