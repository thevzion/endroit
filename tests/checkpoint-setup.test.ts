import { describe, expect, test } from "bun:test";
import { lstat, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { captureCheckpoint, verifyRestoredCheckpoint, type CheckpointCaptureRequest } from "../src/checkpoint.ts";
import { publishCheckpoint, type CheckpointFetchRequest } from "../src/checkpoint-remote.ts";
import { createLocalCheckpoint, loadContinuityDescriptor } from "../src/checkpoint-store.ts";
import type { WorkplaceCheckpointSetupReceipt as SetupReceipt } from "../src/checkpoint-setup.ts";
import { applyNewWorkplace, loadStandardProfile, planNewWorkplace, type NewWorkplaceRequest } from "../src/compiler/new-workplace.ts";
import { checkpointFixture, cli, evidence, git, repository } from "./helpers/checkpoint-fixture.ts";

const workplace = "workplace://checkpoint-fixture";
const member = `${workplace}/member/operator`;
// These end-to-end cases run many Git processes; ordinary tests retain the 30s default.
const heavyGitTimeout = process.platform === "win32" ? 180_000 : 30_000;

function jsonCli<T = SetupReceipt>(cwd: string, args: string[], expected = 0, env: Record<string, string | undefined> = process.env): T {
  const result = Bun.spawnSync([...cli, ...args, "--json"], { cwd, stdout: "pipe", stderr: "pipe", env });
  if (result.exitCode !== expected) throw new Error(`CLI exited ${result.exitCode}: ${new TextDecoder().decode(result.stderr)}`);
  return JSON.parse(new TextDecoder().decode(expected === 0 ? result.stdout : result.stderr));
}

function errorCli(cwd: string, args: string[]): { code: string; error: string } {
  const result = Bun.spawnSync([...cli, ...args, "--json"], { cwd, stdout: "pipe", stderr: "pipe" });
  expect(result.exitCode).not.toBe(0);
  const error = JSON.parse(new TextDecoder().decode(result.stderr)) as { code: string; error: string };
  expect(typeof error.code).toBe("string");
  return error;
}

function fileUrl(path: string): string {
  const normalized = resolve(path).replaceAll("\\", "/");
  return `file://${normalized.startsWith("/") ? "" : "/"}${encodeURI(normalized)}`;
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) {
    if (error instanceof Error && error.message.includes("ENOENT")) return false;
    throw error;
  }
}

async function fixture(options: { dirty?: boolean; sites?: boolean; invalid?: boolean; coveredRoutes?: boolean } = {}) {
  const root = resolve(tmpdir(), `endroit-checkpoint-setup-${crypto.randomUUID()}`);
  const mount = join(root, "source");
  const request: NewWorkplaceRequest = {
    kind: "NewWorkplaceRequest", version: 1, target: mount,
    workplace: { id: "checkpoint-fixture", name: "Synthetic checkpoint fixture" },
    member: { id: "operator", name: "Synthetic Operator", language: "en" },
    desk: { id: "operator", name: "Operator Desk", welcome: { tone: "Direct.", humor: "None.", durableChanges: "Update owned sources only." } },
    providers: [],
    git: { initialize: true, commits: true, author: { name: "Synthetic Fixture", email: "fixture@example.test" } },
  };
  const profile = await loadStandardProfile(resolve(repository, "profiles/standard/profile.json"));
  const plan = planNewWorkplace(request, { profile, cliCommand: cli });
  await applyNewWorkplace(plan, plan.revision);
  const shared = join(mount, "workplace");
  await mkdir(join(shared, ".workplace"), { recursive: true });
  await writeFile(join(shared, ".workplace/setup.json"), `${JSON.stringify({ kind: "WorkplaceSetupRequest", version: 1, anchor: workplace, targets: [] }, null, 2)}\n`);
  await writeFile(join(shared, ".workplace/recovery.json"), `${JSON.stringify({
    kind: "WorkplaceRecoveryRequest", version: 1, anchor: workplace,
    setup: "setup.json", sites: [], checkpoints: [], position: { workplace },
  }, null, 2)}\n`);
  if (options.dirty) {
    const doctrine = join(shared, "sources/DOCTRINE.md");
    const original = await readFile(doctrine, "utf8");
    await writeFile(doctrine, `${original}\nStaged recovery fixture continuity.\n`);
    git(shared, ["add", "sources/DOCTRINE.md"]);
    await writeFile(doctrine, `${original}\nCurrent unstaged recovery fixture continuity.\n`);
    const portable = join(shared, "WORKPLACE.md");
    const originalPortable = await readFile(portable, "utf8");
    await writeFile(portable, `${originalPortable}\nStaged portable Root bytes.\n`);
    git(shared, ["add", "WORKPLACE.md"]);
    await writeFile(portable, `${originalPortable}\nUnstaged portable Root bytes.\n`);
    await writeFile(join(shared, "untracked.txt"), "Selected Root payload.\n");
    await writeFile(join(shared, ".git/info/exclude"), "ignored-secret.txt\n");
    await writeFile(join(shared, "ignored-secret.txt"), "Synthetic ignored sentinel.\n");
  }
  if (options.invalid) await writeFile(join(shared, "sources/DOCTRINE.md"), "---\nkind: [\n---\nInvalid synthetic source.\n");
  const map = JSON.parse(await readFile(join(shared, ".workplace/workplace-map.json"), "utf8")) as { sourceRevision: string };
  const captureRequest: CheckpointCaptureRequest = {
    kind: "CheckpointCaptureRequest", version: 1, workplace, workplaceRevision: map.sourceRevision,
    ownerMember: member, line: "main", parentCheckpoint: null,
    sourceRoot: mount, output: join(root, "checkpoint"),
    roots: [{ ref: `${workplace}/root/shared`, worktrees: [{ id: "shared-main", path: shared, logicalPath: "workplace" }] }],
    policy: { includeUntracked: true },
  };
  if (options.sites) {
    const sites = await checkpointFixture({ root: join(root, "site-fixture"), source: join(mount, "checkouts/sites"), siteLayout: true, platformNeutral: true });
    captureRequest.roots.push(...sites.request.roots.map((root) => ({
      ref: root.ref.replace("workplace://fixture/root/shared", `${workplace}/root/product`).replace("workplace://fixture", workplace),
      worktrees: root.worktrees.map((worktree) => ({ ...worktree, id: `site-${worktree.id}`, logicalPath: `checkouts/sites/${worktree.logicalPath}` })),
    })));
  }
  if (options.coveredRoutes) {
    await writeFile(join(shared, ".workplace/sites.json"), `${JSON.stringify({
      kind: "SiteRouteSetupRequest", version: 1, workplace,
      sites: [
        { id: "desk", routes: [{ id: "main", revision: { kind: "branch", name: "develop" } }] },
        { id: "product", routes: ["main", "detached"].map((id) => ({ id, revision: { kind: "branch", name: "develop" } })) },
        { id: "service", routes: [{ id: "main", revision: { kind: "branch", name: "develop" } }] },
      ].map((site) => ({ ...site, productRemote: { kind: "ProductRemote", locator: `ssh://fixture.invalid/${site.id}.git` } })),
    }, null, 2)}\n`);
    const path = join(shared, ".workplace/recovery.json");
    const recovery = JSON.parse(await readFile(path, "utf8"));
    await writeFile(path, `${JSON.stringify({ ...recovery, sites: [{ workplace, request: "sites.json" }] }, null, 2)}\n`);
  }
  return { root, mount, shared, captureRequest, creationRequest: request };
}

describe("checkpoint-first fresh-machine setup", () => {
  test("restores a dirty Root and declared Site Routes without context, recloning or changing portable bytes", async () => {
    const state = await fixture({ dirty: true, sites: true, coveredRoutes: true });
    try {
      const before = evidence(state.shared);
      const worktrees = state.captureRequest.roots.flatMap((root) => root.worktrees);
      const allBefore = new Map(worktrees.map((worktree) => [worktree.id, evidence(worktree.path)]));
      const captured = await captureCheckpoint(state.captureRequest);
      const target = join(state.root, "new-machine");
      // A regression must fail before any network access: SSH may only run this local failure command.
      const offline = { ...process.env, GIT_SSH_COMMAND: "exit 97" };
      const receipt = jsonCli(state.root, ["setup", "--checkpoint", captured.path, "--to", target, "--as", "operator"], 0, offline);
      expect(receipt.kind).toBe("WorkplaceCheckpointSetupReceipt");
      expect(receipt.status).toBe("degraded");
      expect(receipt.action).toBe("restored");
      expect(receipt.checkpoint.status).toBe("restored-equivalent");
      expect(receipt.checkpoint.checkpointId).toBe(captured.receipt.checkpointId);
      expect(receipt.checkpoint.portableFingerprint).toBe(captured.receipt.portableFingerprint);
      expect(receipt.check.operationStatus).toBe("compile-required");
      expect(evidence(join(target, "workplace"))).toBe(before);
      expect(evidence(state.shared)).toBe(before);
      expect((await verifyRestoredCheckpoint(captured.path, target)).receipt.portableFingerprint).toBe(captured.receipt.portableFingerprint);
      expect(await exists(join(target, "workplace/ignored-secret.txt"))).toBe(false);
      expect(typeof receipt.frontDoor).toBe("string");
      const door = await readFile(receipt.frontDoor!, "utf8");
      expect(door).toContain("Current unstaged recovery fixture continuity.");
      expect(door).toContain(member);
      expect(door).toContain("members/operator/MEMBER.md");
      expect(door).toContain("members/operator/desk/DESK.md");
      expect(door).toContain("](.endroit/site-route-bindings.json)");
      const memberLink = /\]\(([^)]+members\/operator\/MEMBER\.md)\)/.exec(door)?.[1];
      const deskLink = /\]\(([^)]+members\/operator\/desk\/DESK\.md)\)/.exec(door)?.[1];
      expect(typeof memberLink).toBe("string");
      expect(typeof deskLink).toBe("string");
      expect(await readFile(resolve(target, memberLink!), "utf8")).toContain(member);
      expect(await readFile(resolve(target, deskLink!), "utf8")).toContain(`${workplace}/desk/operator`);
      expect(receipt.setup?.receipt.sites.flatMap((result) => result.sites)).toEqual([]);
      const entry = JSON.parse(await readFile(join(target, ".endroit/entry.json"), "utf8"));
      expect(entry.member).toBe(member);
      expect(entry.rootBindings).toEqual({ shared: "workplace" });
      for (const worktree of worktrees) {
        expect(evidence(join(target, worktree.logicalPath))).toBe(allBefore.get(worktree.id));
        expect(evidence(worktree.path)).toBe(allBefore.get(worktree.id));
      }
      const registry = JSON.parse(await readFile(join(target, ".endroit/site-route-bindings.json"), "utf8")) as {
        workplace: string; bindings: Array<{ site: string; route: string; binding: { mount: string; realpath: string; commonGitDir: string; kind: string } }>;
      };
      expect(registry.workplace).toBe(workplace);
      expect(registry.bindings.map((binding) => `${binding.site}/${binding.route}`)).toEqual(["desk/main", "product/detached", "product/main", "service/main"]);
      for (const record of registry.bindings) {
        const expected = await realpath(join(target, "checkouts/sites", record.site, record.route));
        expect(record.binding.mount).toBe(expected);
        expect(record.binding.realpath).toBe(expected);
        expect(record.binding.kind).toBe("worktree");
        expect(record.binding.commonGitDir.startsWith(join(await realpath(target), ".git-repositories"))).toBe(true);
      }
      expect(git(join(target, "checkouts/sites/product/detached"), ["symbolic-ref", "-q", "HEAD"], 1)).toBe("");
      expect(git(join(target, "checkouts/sites/service/main"), ["ls-files", "--unmerged"]).split("\n")).toHaveLength(3);
      expect(await exists(join(target, "checkouts/sites/desk/main/cache.bin"))).toBe(false);
      expect(await exists(join(target, "checkouts/workplaces"))).toBe(false);
      const replay = jsonCli(state.root, ["setup", "--checkpoint", captured.path, "--to", target, "--as", "operator"], 0, offline);
      expect(replay.action).toBe("unchanged");
      expect(replay.status).toBe("degraded");
      expect(evidence(join(target, "workplace"))).toBe(before);
      expect((await verifyRestoredCheckpoint(captured.path, target)).receipt.status).toBe("restored-equivalent");
      await writeFile(join(target, "workplace/untracked.txt"), "Changed after restoration.\n");
      const drifted = evidence(join(target, "workplace"));
      expect(errorCli(state.root, ["setup", "--checkpoint", captured.path, "--to", target, "--as", "operator"]).code).toBe("checkpoint-restore-mismatch");
      expect(evidence(join(target, "workplace"))).toBe(drifted);
      expect(await readFile(join(target, "workplace/untracked.txt"), "utf8")).toBe("Changed after restoration.\n");
    } finally { await rm(state.root, { recursive: true, force: true }); }
  }, process.platform === "win32" ? 180_000 : 60_000); // Full topology restore, entry, replay and drift verification.

  test("distinguishes ready from unresolved Member without guessing the only declared human", async () => {
    const state = await fixture();
    try {
      const before = evidence(state.shared);
      const captured = await captureCheckpoint(state.captureRequest);
      const target = join(state.root, "ready-target");
      const receipt = jsonCli(state.root, ["setup", "--checkpoint", captured.path, "--to", target, "--as", "operator"]);
      expect(receipt.status).toBe("ready");
      expect(receipt.check.operationStatus).toBe("ready");
      expect(typeof receipt.frontDoor).toBe("string");
      expect(evidence(join(target, "workplace"))).toBe(before);
      const unresolved = join(state.root, "unresolved-target");
      const pending = jsonCli(state.root, ["setup", "--checkpoint", captured.path, "--to", unresolved]);
      expect(pending.status).toBe("pending-member");
      expect(pending.frontDoor).toBe(undefined);
      expect(await exists(join(unresolved, ".endroit/current-member.json"))).toBe(false);
      expect(evidence(join(unresolved, "workplace"))).toBe(before);
    } finally { await rm(state.root, { recursive: true, force: true }); }
  });

  test("enters a preserved dirty Root read-only and refuses changed local door, source or Member", async () => {
    const state = await fixture({ dirty: true });
    try {
      const captured = await captureCheckpoint(state.captureRequest);
      const target = join(state.root, "enter-target");
      const receipt = jsonCli(state.root, ["setup", "--checkpoint", captured.path, "--to", target, "--as", "operator"]);
      const before = evidence(join(target, "workplace"));
      const enter = ["workplace", "enter", workplace, "--anchor", target];
      const entered = jsonCli<{ kind: string; status: string; entryMode: string; member: string; frontDoor: string }>(state.root, enter);
      expect(entered.kind).toBe("EnteredWorkplace");
      expect(entered.status).toBe("entered");
      expect(entered.entryMode).toBe("preserved-local");
      expect(entered.member).toBe(member);
      expect(entered.frontDoor).toBe(receipt.frontDoor!);
      expect(evidence(join(target, "workplace"))).toBe(before);
      for (const path of [receipt.frontDoor!, join(target, "workplace/sources/DOCTRINE.md"), join(target, ".endroit/entry.json")]) {
        const original = await readFile(path, "utf8");
        const modified = path.endsWith("entry.json")
          ? `${JSON.stringify({ ...JSON.parse(original), member: `${workplace}/member/unknown`, desk: `${workplace}/desk/unknown` }, null, 2)}\n`
          : `${original}\nChanged after exact restoration.\n`;
        await writeFile(path, modified);
        expect(errorCli(state.root, enter).code).toBe("compile-required");
        expect(await readFile(path, "utf8")).toBe(modified);
        await writeFile(path, original);
      }
      expect((await verifyRestoredCheckpoint(captured.path, target)).receipt.portableFingerprint).toBe(captured.receipt.portableFingerprint);
      expect(evidence(join(target, "workplace"))).toBe(before);
      expect(receipt.check.operationStatus).toBe("compile-required");
    } finally { await rm(state.root, { recursive: true, force: true }); }
  });

  test("keeps semantic-invalid restoration exact but unavailable for a Front Door", async () => {
    const state = await fixture({ invalid: true });
    try {
      const before = evidence(state.shared);
      const captured = await captureCheckpoint(state.captureRequest);
      const target = join(state.root, "invalid-source-target");
      const receipt = jsonCli(state.root, ["setup", "--checkpoint", captured.path, "--to", target, "--as", "operator"]);
      expect(receipt.status).toBe("degraded");
      expect(receipt.frontDoor).toBe(undefined);
      expect(await exists(join(target, "FRONTDOOR.md"))).toBe(false);
      expect(receipt.checkpoint.status).toBe("restored-equivalent");
      expect(evidence(join(target, "workplace"))).toBe(before);
      expect((await verifyRestoredCheckpoint(captured.path, target)).receipt.portableFingerprint).toBe(captured.receipt.portableFingerprint);
    } finally { await rm(state.root, { recursive: true, force: true }); }
  });

  test("refuses collisions and an invalid Member before installing a destination", async () => {
    const state = await fixture();
    try {
      const before = evidence(state.shared);
      const captured = await captureCheckpoint(state.captureRequest);
      const collision = join(state.root, "occupied");
      await mkdir(collision, { recursive: true });
      await writeFile(join(collision, "keep.txt"), "Existing user-owned bytes.\n");
      expect(errorCli(state.root, ["setup", "--checkpoint", captured.path, "--to", collision, "--as", "operator"]).code).toBe("checkpoint-target-exists");
      expect((await readdir(collision, { withFileTypes: true })).map((entry) => entry.name)).toEqual(["keep.txt"]);
      expect(await readFile(join(collision, "keep.txt"), "utf8")).toBe("Existing user-owned bytes.\n");
      const linked = join(state.root, "linked-target");
      await symlink(collision, linked, process.platform === "win32" ? "junction" : "dir");
      expect(errorCli(state.root, ["setup", "--checkpoint", captured.path, "--to", linked, "--as", "operator"]).code).toBe("checkpoint-target-exists");
      expect((await lstat(linked)).isSymbolicLink()).toBe(true);
      expect((await readdir(collision, { withFileTypes: true })).map((entry) => entry.name)).toEqual(["keep.txt"]);
      const missingMember = join(state.root, "wrong-member-target");
      expect(errorCli(state.root, ["setup", "--checkpoint", captured.path, "--to", missingMember, "--as", "unknown-member"]).code).toBe("invalid-current-member-binding");
      expect(await exists(missingMember)).toBe(false);
      expect(evidence(state.shared)).toBe(before);
    } finally { await rm(state.root, { recursive: true, force: true }); }
  });

  for (const variant of ["missing-root", "peer-workplace"] as const) test(`rejects a checkpoint with ${variant}`, async () => {
    const state = await fixture({ sites: true });
    try {
      const before = new Map(state.captureRequest.roots.flatMap((root) => root.worktrees).map((worktree) => [worktree.path, evidence(worktree.path)]));
      const request: CheckpointCaptureRequest = {
        ...state.captureRequest, output: join(state.root, variant),
        roots: state.captureRequest.roots.map((root, index) => ({ ...root, worktrees: root.worktrees.map((worktree) => ({
          ...worktree,
          logicalPath: variant === "missing-root" && index === 0 ? "checkouts/sites/root/main" : variant === "peer-workplace" && index === 2 ? "checkouts/workplaces/peer/workplace" : worktree.logicalPath,
        })) })),
      };
      const captured = await captureCheckpoint(request);
      const target = join(state.root, `${variant}-target`);
      expect(errorCli(state.root, ["setup", "--checkpoint", captured.path, "--to", target, "--as", "operator"]).code).toBe(variant === "missing-root" ? "checkpoint-schema-invalid" : "checkpoint-path-invalid");
      expect(await exists(target)).toBe(false);
      for (const [path, expected] of before) expect(evidence(path)).toBe(expected);
    } finally { await rm(state.root, { recursive: true, force: true }); }
  });

  test("rejects machine-local dependencies in portable Recovery declarations before installation", async () => {
    const state = await fixture();
    try {
      const outside = join(state.root, "outside-setup.json");
      const outsideBytes = await readFile(join(state.shared, ".workplace/setup.json"), "utf8");
      await writeFile(outside, outsideBytes);
      const recovery = join(state.shared, ".workplace/recovery.json");
      const original = JSON.parse(await readFile(recovery, "utf8"));
      await writeFile(recovery, `${JSON.stringify({ ...original, setup: outside }, null, 2)}\n`);
      const before = evidence(state.shared);
      const captured = await captureCheckpoint(state.captureRequest);
      const target = join(state.root, "unsafe-portable-target");
      errorCli(state.root, ["setup", "--checkpoint", captured.path, "--to", target, "--as", "operator"]);
      expect(await exists(target)).toBe(false);
      expect(await readFile(outside, "utf8")).toBe(outsideBytes);
      expect(evidence(state.shared)).toBe(before);
    } finally { await rm(state.root, { recursive: true, force: true }); }
  });

  test("fetches an exact cold checkpoint using a local request or one-file Git Bootstrap Ref without changing origins", async () => {
    const state = await fixture({ dirty: true });
    try {
      const product = join(state.root, "product.git");
      git(state.root, ["clone", "-q", "--bare", "--", state.shared, product]);
      git(state.shared, ["remote", "add", "origin", product]);
      const continuity = join(state.root, "continuity.git");
      git(state.root, ["init", "-q", "--bare", continuity]);
      const captured = await captureCheckpoint(state.captureRequest);
      const fetch: CheckpointFetchRequest = {
        kind: "CheckpointFetchRequest", version: 1,
        binding: { kind: "ContinuityBinding", version: 1, workplace, role: "separate", locator: continuity, productLocator: product, productVisibility: "public", continuityVisibility: "private", credentialBinding: "git:fixture" },
        ownerMember: member, line: "main",
      };
      await publishCheckpoint(captured.path, { ...fetch, kind: "CheckpointPublishRequest", parentCheckpoint: null });
      const bootstrap = join(state.root, "bootstrap");
      await mkdir(bootstrap, { recursive: true });
      git(bootstrap, ["init", "-q", "-b", "develop"]);
      git(bootstrap, ["config", "user.name", "Synthetic Bootstrap"]);
      git(bootstrap, ["config", "user.email", "fixture@example.test"]);
      const requestPath = join(bootstrap, "fetch.json");
      await writeFile(requestPath, `${JSON.stringify(fetch, null, 2)}\n`);
      await writeFile(join(bootstrap, "unrelated.txt"), "Unrequested synthetic bootstrap payload.\n");
      git(bootstrap, ["add", "."]);
      git(bootstrap, ["commit", "-qm", "synthetic fetch descriptor"]);
      const refsBefore = [product, continuity, bootstrap].map((repo) => git(repo, ["show-ref"]));
      const before = evidence(state.shared);
      const originBefore = git(state.shared, ["remote", "-v"]);
      for (const [index, source] of [requestPath, `git+${fileUrl(bootstrap)}#refs/heads/develop:fetch.json`].entries()) {
        const target = join(state.root, `cold-target-${index}`);
        const receipt = jsonCli(state.root, ["setup", "--checkpoint", captured.receipt.checkpointId, "--checkpoint-from", source, "--to", target, "--as", "operator"]);
        expect(receipt.checkpoint.checkpointId).toBe(captured.receipt.checkpointId);
        expect(receipt.checkpoint.status).toBe("restored-equivalent");
        expect(receipt.remote?.status).toBe("fetched-verified");
        if (index === 1) {
          expect(receipt.bootstrap?.path).toBe("fetch.json");
          expect(receipt.bootstrap?.oid).toBe(git(bootstrap, ["rev-parse", "HEAD"]));
        }
        expect(receipt.status).toBe("degraded");
        expect(evidence(join(target, "workplace"))).toBe(before);
        expect(git(join(target, "workplace"), ["remote", "get-url", "origin"])).toBe(product);
        expect((await verifyRestoredCheckpoint(captured.path, target)).receipt.portableFingerprint).toBe(captured.receipt.portableFingerprint);
      }
      await writeFile(join(state.mount, ".endroit/continuity.json"), `${JSON.stringify({
        kind: "ContinuityDescriptor", version: 1, anchor: workplace, workplace,
        capture: "capture.json", store: "checkpoints", restoreTarget: "../restored", line: "main",
        policy: { remote: "separate", requirement: "optional" }, binding: fetch.binding,
      }, null, 2)}\n`);
      const fromContext = join(state.root, "remote-from-context");
      const restored = jsonCli(state.mount, ["setup", "--checkpoint", captured.receipt.checkpointId, "--to", fromContext, "--as", "operator"]);
      expect(restored.remote?.status).toBe("fetched-verified");
      expect(restored.checkpoint.checkpointId).toBe(captured.receipt.checkpointId);
      expect(evidence(join(fromContext, "workplace"))).toBe(before);
      expect((await readdir(join(state.mount, ".endroit/checkpoints", captured.receipt.checkpointId.slice("checkpoint:sha256:".length)), { withFileTypes: true })).map((entry) => entry.name)).toContain("MANIFEST.json");
      await writeFile(requestPath, `${JSON.stringify({ ...fetch, unrecognized: true }, null, 2)}\n`);
      const rejected = join(state.root, "closed-fetch-target");
      expect(errorCli(state.root, ["setup", "--checkpoint", captured.receipt.checkpointId, "--checkpoint-from", requestPath, "--to", rejected, "--as", "operator"]).code).toBe("checkpoint-schema-invalid");
      expect(await exists(rejected)).toBe(false);
      expect([product, continuity, bootstrap].map((repo) => git(repo, ["show-ref"]))).toEqual(refsBefore);
      expect(git(state.shared, ["remote", "-v"])).toBe(originBefore);
      expect(evidence(state.shared)).toBe(before);
    } finally { await rm(state.root, { recursive: true, force: true }); }
  }, heavyGitTimeout);

  test("selects a checkpoint ID from the current Workplace local store", async () => {
    const state = await fixture({ dirty: true });
    try {
      await writeFile(join(state.mount, ".endroit/capture.json"), `${JSON.stringify(state.captureRequest, null, 2)}\n`);
      await writeFile(join(state.mount, ".endroit/continuity.json"), `${JSON.stringify({
        kind: "ContinuityDescriptor", version: 1, anchor: workplace, workplace,
        capture: "capture.json", store: "checkpoints", restoreTarget: "../restored", line: "main",
        policy: { remote: "none", requirement: "optional" },
      }, null, 2)}\n`);
      const before = evidence(state.shared);
      const captured = await createLocalCheckpoint(await loadContinuityDescriptor(state.mount), { member });
      const target = join(state.root, "from-current-store");
      const receipt = jsonCli(state.mount, ["setup", "--checkpoint", captured.checkpointId, "--to", target, "--as", "operator"]);
      expect(receipt.checkpoint.checkpointId).toBe(captured.checkpointId);
      expect(receipt.checkpoint.portableFingerprint).toBe(captured.verification.portableFingerprint);
      expect(receipt.status).toBe("degraded");
      expect(evidence(join(target, "workplace"))).toBe(before);
      expect(evidence(state.shared)).toBe(before);
    } finally { await rm(state.root, { recursive: true, force: true }); }
  });

  test("sets up a managed peer independently without absorbing it into the Root checkpoint", async () => {
    const state = await fixture();
    try {
      const peerSource = join(state.root, "peer-source");
      const profile = await loadStandardProfile(resolve(repository, "profiles/standard/profile.json"));
      const peerPlan = planNewWorkplace({
        ...state.creationRequest, target: peerSource, workplace: { id: "peer", name: "Synthetic managed peer" },
        desk: { ...state.creationRequest.desk, welcome: { ...state.creationRequest.desk.welcome, tone: "Independent peer greeting." } },
      }, { profile, cliCommand: cli });
      await applyNewWorkplace(peerPlan, peerPlan.revision);
      const peerRoot = join(peerSource, "workplace");
      const remote = join(state.root, "peer.git");
      git(state.root, ["clone", "-q", "--bare", "--", peerRoot, remote]);
      const refsBefore = git(remote, ["show-ref"]);
      const peerBefore = evidence(peerRoot);
      const setupPath = join(state.root, "setup-peer.json");
      await writeFile(setupPath, `${JSON.stringify({
        kind: "WorkplaceSetupRequest", version: 1, anchor: workplace,
        targets: [{ workplace: "workplace://peer", relation: "attachment", required: true, mount: { mode: "managed", path: "checkouts/workplaces/peer" }, source: remote,
          entry: JSON.parse(await readFile(join(peerSource, ".endroit/entry.json"), "utf8")), providers: [] }],
      }, null, 2)}\n`);
      const recoveryPath = join(state.root, "recovery-peer.json");
      await writeFile(recoveryPath, `${JSON.stringify({ kind: "WorkplaceRecoveryRequest", version: 1, anchor: workplace, setup: setupPath, sites: [], checkpoints: [], position: { workplace } }, null, 2)}\n`);
      const before = evidence(state.shared);
      const captured = await captureCheckpoint(state.captureRequest);
      const target = join(state.root, "with-peer");
      const receipt = jsonCli(state.root, ["setup", "--checkpoint", captured.path, "--to", target, "--as", "operator", "--from", recoveryPath]);
      const peerMount = join(target, "checkouts/workplaces/peer");
      expect(receipt.status).toBe("ready");
      expect(evidence(join(target, "workplace"))).toBe(before);
      expect(await readFile(receipt.frontDoor!, "utf8")).toContain("workplace://peer");
      expect(await readFile(receipt.frontDoor!, "utf8")).not.toContain("Independent peer greeting.");
      expect(await readFile(join(peerMount, "FRONTDOOR.md"), "utf8")).toContain("Independent peer greeting.");
      const entered = jsonCli<{ workplace: string; entryMode: string; frontDoor: string }>(state.root, ["workplace", "enter", "workplace://peer", "--anchor", target]);
      expect(entered.workplace).toBe("workplace://peer");
      expect(entered.entryMode).toBe("ready");
      expect(await readFile(entered.frontDoor, "utf8")).toContain("Independent peer greeting.");
      expect(git(join(peerMount, "workplace"), ["status", "--porcelain"])).toBe("");
      expect(git(join(peerMount, "workplace"), ["rev-parse", "HEAD"])).toBe(git(peerRoot, ["rev-parse", "HEAD"]));
      expect(git(remote, ["show-ref"])).toBe(refsBefore);
      expect(evidence(peerRoot)).toBe(peerBefore);
      expect((await verifyRestoredCheckpoint(captured.path, target)).receipt.portableFingerprint).toBe(captured.receipt.portableFingerprint);
      const peerDoctrine = join(peerMount, "workplace/sources/DOCTRINE.md");
      await writeFile(peerDoctrine, `${await readFile(peerDoctrine, "utf8")}\nPeer changed after the first setup.\n`);
      const changedPeer = evidence(join(peerMount, "workplace"));
      const replay = jsonCli(state.root, ["setup", "--checkpoint", captured.path, "--to", target, "--as", "operator", "--from", recoveryPath]);
      expect(replay.action).toBe("unchanged");
      expect(replay.status).toBe("degraded");
      expect(evidence(join(peerMount, "workplace"))).toBe(changedPeer);
      expect(evidence(join(target, "workplace"))).toBe(before);
    } finally { await rm(state.root, { recursive: true, force: true }); }
  });

  test("keeps the restored Root usable when an optional managed peer is unavailable", async () => {
    const state = await fixture();
    try {
      const peer = "workplace://optional-peer";
      const setupPath = join(state.root, "optional-setup.json");
      await writeFile(setupPath, `${JSON.stringify({
        kind: "WorkplaceSetupRequest", version: 1, anchor: workplace,
        targets: [{ workplace: peer, relation: "attachment", required: false,
          mount: { mode: "managed", path: "checkouts/workplaces/optional-peer" }, source: join(state.root, "unavailable.git"), providers: [],
          entry: { kind: "EntryBinding", workplace: peer, member: `${peer}/member/operator`, desk: `${peer}/desk/operator`, rootBindings: { shared: "workplace" } } }],
      }, null, 2)}\n`);
      const recoveryPath = join(state.root, "optional-recovery.json");
      await writeFile(recoveryPath, `${JSON.stringify({ kind: "WorkplaceRecoveryRequest", version: 1, anchor: workplace, setup: setupPath, sites: [], checkpoints: [], position: { workplace } }, null, 2)}\n`);
      const before = evidence(state.shared);
      const captured = await captureCheckpoint(state.captureRequest);
      const target = join(state.root, "without-optional-peer");
      const receipt = jsonCli(state.root, ["setup", "--checkpoint", captured.path, "--to", target, "--as", "operator", "--from", recoveryPath]);
      expect(receipt.status).toBe("degraded");
      expect(receipt.checkpoint.status).toBe("restored-equivalent");
      expect(receipt.setup?.receipt.setup.targets[0]?.status).toBe("unavailable");
      expect(typeof receipt.frontDoor).toBe("string");
      expect(await exists(join(target, "checkouts/workplaces/optional-peer"))).toBe(false);
      const registry = jsonCli<{ entries: Array<{ workplace: string }> }>(state.root, ["workplace", "list", target]);
      expect(registry.entries.some((entry) => entry.workplace === peer)).toBe(false);
      expect(evidence(join(target, "workplace"))).toBe(before);
      expect(evidence(state.shared)).toBe(before);
      expect((await verifyRestoredCheckpoint(captured.path, target)).receipt.portableFingerprint).toBe(captured.receipt.portableFingerprint);
    } finally { await rm(state.root, { recursive: true, force: true }); }
  });
});
