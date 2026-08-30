import { describe, expect, test } from "bun:test";
import { mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
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

function fileUrl(path: string): string {
  const normalized = resolve(path).replaceAll("\\", "/");
  return `file://${normalized.startsWith("/") ? "" : "/"}${encodeURI(normalized)}`;
}

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

async function fixture(id = "anchor") {
  const workplace = `workplace://${id}`;
  const current = `${workplace}/member/operator`;
  const root = resolve(tmpdir(), `endroit-root-facade-${id}-${crypto.randomUUID()}`);
  const mount = join(root, "anchor");
  const request: NewWorkplaceRequest = {
    kind: "NewWorkplaceRequest", version: 1, target: mount,
    workplace: { id, name: `Synthetic ${id}` },
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
  const setup: WorkplaceSetupRequest = { kind: "WorkplaceSetupRequest", version: 1, anchor: workplace, targets: [] };
  const setupPath = join(requestRoot, "setup.json");
  await writeFile(setupPath, `${JSON.stringify(setup, null, 2)}\n`);
  const recovery: WorkplaceRecoveryRequest = {
    kind: "WorkplaceRecoveryRequest", version: 1, anchor: workplace, setup: "setup.json", sites: [], checkpoints: [],
    position: { workplace, member: current, desk: `${workplace}/desk/operator` },
  };
  const recoveryPath = join(requestRoot, "recovery.json");
  await writeFile(recoveryPath, `${JSON.stringify(recovery, null, 2)}\n`);
  return { root, mount, workplace, member: current, requestRoot, setupPath, recovery, recoveryPath };
}

describe("root-driven Workplace facade", () => {
  test("adopts an official fresh Anchor clone and resolves a short Member slug", async () => {
    const state = await fixture();
    try {
      const before = git(join(state.mount, "workplace"), ["status", "--porcelain"]);
      await rm(join(state.mount, ".endroit"), { recursive: true, force: true });
      const result = await setupFromRoot({ start: join(state.mount, "workplace"), as: "operator" });
      expect(result.status).toBe("ready");
      expect(JSON.parse(await readFile(join(state.mount, ".endroit/entry.json"), "utf8"))).toEqual({
        kind: "EntryBinding", workplace: "workplace://anchor", member, desk: "workplace://anchor/desk/operator", rootBindings: { shared: "workplace" },
      });
      expect(JSON.parse(await readFile(join(state.mount, ".endroit/current-member.json"), "utf8"))).toEqual({
        kind: "CurrentMemberBindings", version: 1, anchor: "workplace://anchor",
        members: [{ workplace: "workplace://anchor", member, desk: "workplace://anchor/desk/operator" }],
      });
      expect((await statusFromRoot(state.mount)).check.operationStatus).toBe("ready");
      expect(git(join(state.mount, "workplace"), ["status", "--porcelain"])).toBe(before);
      expect((await setupFromRoot({ start: state.mount, as: "operator" })).receipt.setup.status).toBe("ready");
    } finally { await rm(state.root, { recursive: true, force: true }); }
  });

  test("rolls back fresh Anchor local state when a required peer cannot materialize", async () => {
    const state = await fixture();
    try {
      const before = git(join(state.mount, "workplace"), ["status", "--porcelain"]);
      const setupPath = join(state.root, "failing-setup.json");
      await writeFile(setupPath, `${JSON.stringify({
        kind: "WorkplaceSetupRequest", version: 1, anchor: "workplace://anchor",
        targets: [{
          workplace: "workplace://peer", relation: "attachment", required: true,
          mount: { mode: "external", path: join(state.root, "missing-peer") },
          entry: { kind: "EntryBinding", workplace: "workplace://peer", member: "workplace://peer/member/operator", desk: "workplace://peer/desk/operator", rootBindings: { shared: "workplace" } },
          providers: [],
        }],
      }, null, 2)}\n`);
      const recoveryPath = join(state.root, "failing-recovery.json");
      await writeFile(recoveryPath, `${JSON.stringify({ ...state.recovery, setup: setupPath }, null, 2)}\n`);
      await rm(join(state.mount, ".endroit"), { recursive: true, force: true });
      let observed: unknown;
      try { await setupFromRoot({ start: state.mount, from: recoveryPath, as: "operator" }); }
      catch (error) { observed = error; }
      expect(observed instanceof Error).toBe(true);
      expect(await Bun.file(join(state.mount, ".endroit")).exists()).toBe(false);
      expect(await Bun.file(join(state.root, "missing-peer")).exists()).toBe(false);
      expect(git(join(state.mount, "workplace"), ["status", "--porcelain"])).toBe(before);
    } finally { await rm(state.root, { recursive: true, force: true }); }
  });

  test("materializes a peer from one exact Git Bootstrap Ref and replays from the local package", async () => {
    const state = await fixture();
    const peer = await fixture("peer");
    try {
      const peerRemote = join(state.root, "peer.git");
      git(state.root, ["clone", "-q", "--bare", "--", join(peer.mount, "workplace"), peerRemote]);
      const remoteBefore = git(peerRemote, ["show-ref"]);
      const bootstrap = join(state.root, "bootstrap");
      await mkdir(join(bootstrap, ".workplace"), { recursive: true });
      git(bootstrap, ["init", "-q", "-b", "develop"]);
      git(bootstrap, ["config", "user.name", "Bootstrap Fixture"]);
      git(bootstrap, ["config", "user.email", "fixture@example.test"]);
      const peerEntry = JSON.parse(await readFile(join(peer.mount, ".endroit/entry.json"), "utf8"));
      await writeFile(join(bootstrap, ".workplace/setup.json"), `${JSON.stringify({
        kind: "WorkplaceSetupRequest", version: 1, anchor: state.workplace,
        targets: [{ workplace: peer.workplace, relation: "attachment", required: true, mount: { mode: "managed", path: "checkouts/workplaces/peer" }, source: peerRemote, entry: peerEntry, providers: [] }],
      }, null, 2)}\n`);
      await writeFile(join(bootstrap, ".workplace/recovery.json"), `${JSON.stringify({
        kind: "WorkplaceRecoveryRequest", version: 1, anchor: state.workplace, setup: "setup.json", sites: [], checkpoints: [],
        position: { workplace: state.workplace },
      }, null, 2)}\n`);
      git(bootstrap, ["add", ".workplace"]); git(bootstrap, ["commit", "-qm", "bootstrap package"]);
      const bootstrapRef = `git+${fileUrl(bootstrap)}#refs/heads/develop:.workplace/recovery.json`;
      const result = await setupFromRoot({ start: state.mount, with: bootstrapRef, as: "operator" });
      expect(result.source).toBe("bootstrap");
      expect(result.bootstrap?.ref).toBe("refs/heads/develop");
      expect(result.bootstrap?.oid).toBe(git(bootstrap, ["rev-parse", "HEAD"]));
      expect(result.bootstrap?.path).toBe(".workplace/recovery.json");
      const firstDigest = result.bootstrap!.digest;
      const peerMount = join(state.mount, "checkouts/workplaces/peer");
      expect((await statusFromRoot(peerMount)).check.operationStatus).toBe("ready");
      const local = await selectRecoveryRequest(state.mount);
      expect(local.provenance).toBe("local");
      expect(local.path).toBe(await realpath(join(state.mount, ".endroit/recovery.json")));
      expect(local.request.setup).toContain(join(state.mount, ".endroit/bootstrap"));
      const members = JSON.parse(await readFile(join(state.mount, ".endroit/current-member.json"), "utf8")) as { members: Array<{ workplace: string }> };
      expect(members.members.map((entry) => entry.workplace)).toEqual([state.workplace, peer.workplace].sort());
      expect((await setupFromRoot({ start: state.mount, as: "operator" })).receipt.setup.targets[0]?.status).toBe("unchanged");
      expect(git(peerRemote, ["show-ref"])).toBe(remoteBefore);
      expect(git(join(state.mount, "workplace"), ["remote"])).toBe("");
      expect(git(join(peerMount, "workplace"), ["remote", "get-url", "origin"])).toBe(peerRemote);
      await writeFile(join(bootstrap, ".workplace/setup.json"), `${await readFile(join(bootstrap, ".workplace/setup.json"), "utf8")}\n`);
      git(bootstrap, ["add", ".workplace/setup.json"]); git(bootstrap, ["commit", "-qm", "change referenced setup bytes"]);
      const changed = await setupFromRoot({ start: state.mount, with: bootstrapRef, as: "operator" });
      expect(changed.bootstrap?.digest === firstDigest).toBe(false);
      expect((await readdir(join(state.mount, ".endroit/bootstrap"), { withFileTypes: true })).filter((entry) => entry.isDirectory()).length).toBe(2);
    } finally { await rm(state.root, { recursive: true, force: true }); await rm(peer.root, { recursive: true, force: true }); }
  });

  test("rejects unsafe Bootstrap Refs before local mutation", async () => {
    const state = await fixture();
    try {
      const before = await tree(join(state.mount, ".endroit"));
      for (const bootstrapRef of [
        "git+https://secret@example.test/repository.git#refs/heads/develop:.workplace/recovery.json",
        "git+https://example.test/repository.git#HEAD:.workplace/recovery.json",
        "git+file:///synthetic/repository.git#refs/heads/develop:../recovery.json",
      ]) {
        let observed: unknown;
        try { await setupFromRoot({ start: state.mount, with: bootstrapRef, as: "operator" }); }
        catch (error) { observed = error; }
        expect(observed instanceof Error && "code" in observed ? observed.code : undefined).toBe("invalid-bootstrap-ref");
      }
      const hostile = join(state.root, "hostile-bootstrap");
      await mkdir(join(hostile, ".workplace"), { recursive: true });
      git(hostile, ["init", "-q", "-b", "develop"]);
      git(hostile, ["config", "user.name", "Bootstrap Fixture"]); git(hostile, ["config", "user.email", "fixture@example.test"]);
      await writeFile(join(hostile, ".workplace/recovery.json"), `${JSON.stringify({ ...state.recovery, setup: state.setupPath, position: { workplace: state.workplace } }, null, 2)}\n`);
      git(hostile, ["add", ".workplace/recovery.json"]); git(hostile, ["commit", "-qm", "hostile external path"]);
      let external: unknown;
      try { await setupFromRoot({ start: state.mount, with: `git+${fileUrl(hostile)}#refs/heads/develop:.workplace/recovery.json`, as: "operator" }); }
      catch (error) { external = error; }
      expect(external instanceof Error && "code" in external ? external.code : undefined).toBe("invalid-bootstrap-ref");
      await writeFile(join(hostile, ".workplace/recovery.json"), `${JSON.stringify({ ...state.recovery, setup: "../:", position: { workplace: state.workplace } }, null, 2)}\n`);
      git(hostile, ["add", ".workplace/recovery.json"]); git(hostile, ["commit", "-qm", "hostile magic pathspec"]);
      let magic: unknown;
      try { await setupFromRoot({ start: state.mount, with: `git+${fileUrl(hostile)}#refs/heads/develop:.workplace/recovery.json`, as: "operator" }); }
      catch (error) { magic = error; }
      expect(magic instanceof Error && "code" in magic ? magic.code : undefined).toBe("invalid-bootstrap-ref");
      expect(await tree(join(state.mount, ".endroit"))).toEqual(before);
    } finally { await rm(state.root, { recursive: true, force: true }); }
  });

  test("rolls back Current Member when Bootstrap cache persistence fails", async () => {
    const state = await fixture();
    try {
      const bootstrap = join(state.root, "rollback-bootstrap");
      await mkdir(join(bootstrap, ".workplace"), { recursive: true });
      git(bootstrap, ["init", "-q", "-b", "develop"]);
      git(bootstrap, ["config", "user.name", "Bootstrap Fixture"]); git(bootstrap, ["config", "user.email", "fixture@example.test"]);
      await writeFile(join(bootstrap, ".workplace/setup.json"), `${JSON.stringify({ kind: "WorkplaceSetupRequest", version: 1, anchor: state.workplace, targets: [] }, null, 2)}\n`);
      await writeFile(join(bootstrap, ".workplace/recovery.json"), `${JSON.stringify({ ...state.recovery, setup: "setup.json", position: { workplace: state.workplace } }, null, 2)}\n`);
      git(bootstrap, ["add", ".workplace"]); git(bootstrap, ["commit", "-qm", "rollback package"]);
      const outside = join(state.root, "outside-cache");
      await mkdir(outside, { recursive: true });
      await symlink(outside, join(state.mount, ".endroit/bootstrap"));
      expect(await Bun.file(join(state.mount, ".endroit/current-member.json")).exists()).toBe(false);
      let observed: unknown;
      try { await setupFromRoot({ start: state.mount, with: `git+${fileUrl(bootstrap)}#refs/heads/develop:.workplace/recovery.json`, as: "operator" }); }
      catch (error) { observed = error; }
      expect(observed instanceof Error && "code" in observed ? observed.code : undefined).toBe("invalid-bootstrap-ref");
      expect(await Bun.file(join(state.mount, ".endroit/current-member.json")).exists()).toBe(false);
      expect(await readdir(outside, { withFileTypes: true })).toEqual([]);
    } finally { await rm(state.root, { recursive: true, force: true }); }
  });

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
      expect(optional.continuity.missing).toEqual([{ id: "anchor-sites", workplace: state.workplace, requirement: "undeclared", checkpointId: missing.checkpointId, action: `endroit checkpoint fetch ${missing.checkpointId} --json` }]);

      await writeFile(join(state.mount, ".endroit/continuity.json"), `${JSON.stringify({
        kind: "ContinuityDescriptor", version: 1, anchor: "workplace://anchor", workplace: "workplace://anchor", capture: "capture.json", store: "checkpoints", restoreTarget: "../checkouts/sites", line: "main", policy: { remote: "none", requirement: "required" },
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
        kind: "ContinuityDescriptor", version: 1, anchor: "workplace://anchor", workplace: "workplace://anchor", capture: "capture.json", store: "checkpoints", restoreTarget: "../checkouts/sites", line: "main", policy: { remote: "none", requirement: "required" },
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

  test("materializes a peer, installs its explicit local continuity descriptor, then fetches and restores its checkpoint", async () => {
    const anchor = await fixture();
    const peer = await fixture("peer");
    try {
      const topology = await checkpointFixture({ root: join(peer.root, "topology"), source: join(peer.mount, "checkouts/sites"), siteLayout: true, platformNeutral: true });
      const capture = {
        ...topology.request,
        workplace: peer.workplace,
        roots: topology.request.roots.map((root) => ({ ...root, ref: root.ref.replace("workplace://fixture", peer.workplace) })),
      };
      const capturePath = join(peer.mount, ".endroit/capture.json");
      await writeFile(capturePath, `${JSON.stringify(capture, null, 2)}\n`);
      await writeFile(join(peer.mount, ".endroit/continuity.json"), `${JSON.stringify({
        kind: "ContinuityDescriptor", version: 1, anchor: peer.workplace, workplace: peer.workplace,
        capture: "capture.json", store: "checkpoints", restoreTarget: "../unused-restore", line: "main",
        policy: { remote: "none", requirement: "optional" },
      }, null, 2)}\n`);
      jsonCli(peer.mount, ["setup", "--as", "operator", "--json"]);
      const created = jsonCli(peer.mount, ["checkpoint", "--json"]) as ContinuityStoreReceipt;

      const continuityRemote = join(anchor.root, "peer-continuity.git");
      const productRemote = join(anchor.root, "peer-product.git");
      git(anchor.root, ["init", "-q", "--bare", continuityRemote]);
      git(anchor.root, ["clone", "-q", "--bare", "--", join(peer.mount, "workplace"), productRemote]);
      const binding = {
        kind: "ContinuityBinding", version: 1, workplace: peer.workplace, role: "separate", locator: continuityRemote,
        productLocator: productRemote, productVisibility: "public", continuityVisibility: "private", credentialBinding: "git:fixture",
      };
      await writeFile(join(peer.mount, ".endroit/continuity.json"), `${JSON.stringify({
        kind: "ContinuityDescriptor", version: 1, anchor: peer.workplace, workplace: peer.workplace,
        capture: "capture.json", store: "checkpoints", restoreTarget: "../unused-restore", line: "main",
        policy: { remote: "separate", requirement: "required" }, binding,
      }, null, 2)}\n`);
      jsonCli(peer.mount, ["checkpoint", "push", created.checkpointId, "--json"]);
      const continuityBefore = git(continuityRemote, ["show-ref"]);
      const productBefore = git(productRemote, ["show-ref"]);

      const descriptorPath = join(anchor.root, "peer-continuity.json");
      await writeFile(descriptorPath, `${JSON.stringify({
        kind: "ContinuityDescriptor", version: 1, anchor: peer.workplace, workplace: peer.workplace,
        capture: "unused.json", store: "checkpoints", restoreTarget: "../checkouts/sites", line: "main",
        policy: { remote: "separate", requirement: "required" }, binding,
      }, null, 2)}\n`);
      const setupPath = join(anchor.root, "peer-setup.json");
      const peerEntry = JSON.parse(await readFile(join(peer.mount, ".endroit/entry.json"), "utf8"));
      await writeFile(setupPath, `${JSON.stringify({
        kind: "WorkplaceSetupRequest", version: 1, anchor: anchor.workplace,
        targets: [{ workplace: peer.workplace, relation: "attachment", required: true, mount: { mode: "managed", path: "checkouts/workplaces/peer" }, source: productRemote, entry: peerEntry, providers: [] }],
      }, null, 2)}\n`);
      const roots = capture.roots.map((root) => ({
        ref: root.ref,
        worktrees: root.worktrees.map((worktree) => {
          const [site, route] = worktree.logicalPath.split("/");
          return { id: worktree.id, logicalPath: worktree.logicalPath, site: site!, route: route! };
        }),
      }));
      const recoveryPath = join(anchor.root, "peer-recovery.json");
      await writeFile(recoveryPath, `${JSON.stringify({
        kind: "WorkplaceRecoveryRequest", version: 1, anchor: anchor.workplace, setup: setupPath, sites: [],
        continuity: [{ workplace: peer.workplace, descriptor: descriptorPath }],
        checkpoints: [{ id: "peer-sites", workplace: peer.workplace, checkpoint: join(anchor.root, "absent-peer-checkpoint"), target: "checkouts/sites", checkpointId: created.checkpointId, portableFingerprint: created.verification.portableFingerprint, roots }],
        position: { workplace: anchor.workplace },
      }, null, 2)}\n`);

      const result = await setupFromRoot({ start: anchor.mount, from: recoveryPath, as: "operator" });
      const peerMount = join(anchor.mount, "checkouts/workplaces/peer");
      expect(result.status).toBe("ready");
      expect(result.continuity.fetched).toEqual([{ id: "peer-sites", workplace: peer.workplace, requirement: "required", checkpointId: created.checkpointId, status: "installed", remoteStatus: "fetched-verified" }]);
      expect(result.receipt.continuity).toEqual([{ workplace: peer.workplace, target: join(await realpath(peerMount), ".endroit/continuity.json"), status: "created" }]);
      expect(result.receipt.checkpoints[0]?.workplace).toBe(peer.workplace);
      expect(result.receipt.checkpoints[0]?.action).toBe("restore");
      expect(result.receipt.checkpoints[0]?.status).toBe("restored-equivalent");
      expect(result.receipt.checkpoints[0]?.portableFingerprint).toBe(created.verification.portableFingerprint);
      expect((await statusFromRoot(peerMount)).check.operationStatus).toBe("ready");
      expect(git(continuityRemote, ["show-ref"])).toBe(continuityBefore);
      expect(git(productRemote, ["show-ref"])).toBe(productBefore);
      const replay = await setupFromRoot({ start: anchor.mount, from: recoveryPath, as: "operator" });
      expect(replay.continuity.fetched).toBe(undefined);
      expect(replay.receipt.checkpoints[0]?.action).toBe("verify");
      expect(replay.receipt.continuity?.[0]?.status).toBe("unchanged");

      await writeFile(join(anchor.mount, ".endroit/continuity.json"), `${JSON.stringify({
        kind: "ContinuityDescriptor", version: 1, anchor: anchor.workplace, workplace: anchor.workplace,
        capture: "unused.json", store: "checkpoints", restoreTarget: "../checkouts/sites", line: "main",
        policy: { remote: "none", requirement: "optional" },
      }, null, 2)}\n`);
      const declared = JSON.parse(await readFile(recoveryPath, "utf8")) as WorkplaceRecoveryRequest;
      const optionalId = `checkpoint:sha256:${"7".repeat(64)}`;
      const mixedPath = join(anchor.root, "mixed-policy-recovery.json");
      await writeFile(mixedPath, `${JSON.stringify({
        ...declared,
        checkpoints: [...declared.checkpoints, {
          id: "anchor-optional", workplace: anchor.workplace, checkpoint: join(anchor.root, "absent-anchor-checkpoint"), target: "checkouts/sites",
          checkpointId: optionalId, portableFingerprint: `sha256:${"8".repeat(64)}`,
          roots: [{ ref: `${anchor.workplace}/root/product`, worktrees: [{ id: "product-main", logicalPath: "product/main", site: "product", route: "main" }] }],
        }],
      }, null, 2)}\n`);
      const mixed = await setupFromRoot({ start: anchor.mount, from: mixedPath, as: "operator" });
      expect(mixed.status).toBe("degraded");
      expect(mixed.receipt.status).toBe("ready");
      expect(mixed.plan.positionBlock).toBe(undefined);
      expect(mixed.continuity).toEqual({
        status: "degraded", requirement: "required",
        missing: [{ id: "anchor-optional", workplace: anchor.workplace, requirement: "optional", checkpointId: optionalId, action: `endroit checkpoint fetch ${optionalId} --json` }],
      });

      const peerRequiredId = `checkpoint:sha256:${"9".repeat(64)}`;
      const peerRequiredPath = join(anchor.root, "peer-required-recovery.json");
      await writeFile(peerRequiredPath, `${JSON.stringify({
        ...declared,
        checkpoints: [{
          ...declared.checkpoints[0], id: "peer-required", checkpoint: join(anchor.root, "absent-required-peer-checkpoint"), checkpointId: peerRequiredId,
        }],
      }, null, 2)}\n`);
      const peerRequired = await setupFromRoot({ start: anchor.mount, from: peerRequiredPath, as: "operator" });
      expect(peerRequired.status).toBe("degraded");
      expect(peerRequired.receipt.status).toBe("ready");
      expect(peerRequired.plan.positionBlock).toBe(undefined);
      expect(peerRequired.continuity).toEqual({
        status: "degraded", requirement: "required",
        missing: [{ id: "peer-required", workplace: peer.workplace, requirement: "required", checkpointId: peerRequiredId, action: `endroit checkpoint fetch ${peerRequiredId} --json` }],
      });
    } finally {
      await rm(anchor.root, { recursive: true, force: true });
      await rm(peer.root, { recursive: true, force: true });
    }
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
        kind: "ContinuityDescriptor", version: 1, anchor: "workplace://anchor", workplace: "workplace://anchor", capture: "capture.json", store: "checkpoints", restoreTarget: "../unused-restore", line: "main", policy: { remote: "none", requirement: "optional" },
      }, null, 2)}\n`);

      expect(git(topology.detached, ["branch", "--show-current"])).toBe("");
      expect(git(topology.desk, ["status", "--porcelain=v2", "--untracked-files=all"])).toContain("work.txt");
      expect(git(topology.site, ["diff", "--name-only", "--diff-filter=U"])).toBe("conflict.txt");
      for (const worktree of capture.roots.flatMap((root) => root.worktrees)) {
        expect(relative(topology.source, worktree.path).replaceAll("\\", "/")).toBe(worktree.logicalPath);
      }

      jsonCli(machineA.mount, ["setup", "--as", member, "--json"]);
      const created = jsonCli(join(machineA.mount, "workplace"), ["checkpoint", "--json"]) as ContinuityStoreReceipt;
      expect(created.operation).toBe("create");
      expect(created.verification.coverage).toEqual({
        repositories: 3, worktrees: 4, untracked: 1,
        exclusions: ["filesystem-metadata", "special-files", "ignored-files", "provider-state", "credentials"],
      });
      expect(git(join(machineA.mount, "workplace"), ["remote"])).toBe("");
      for (const worktree of capture.roots.flatMap((root) => root.worktrees)) expect(git(worktree.path, ["remote"])).toBe("");

      const continuityRemote = join(machineA.root, "continuity.git");
      const productRemote = join(machineA.root, "product.git");
      git(machineA.root, ["init", "-q", "--bare", continuityRemote]);
      git(machineA.root, ["init", "-q", "--bare", productRemote]);
      const binding = {
        kind: "ContinuityBinding", version: 1, workplace: "workplace://anchor", role: "separate", locator: continuityRemote,
        productLocator: productRemote, productVisibility: "public", continuityVisibility: "private", credentialBinding: "git:fixture",
      };
      await writeFile(join(machineA.mount, ".endroit/continuity.json"), `${JSON.stringify({
        kind: "ContinuityDescriptor", version: 1, anchor: "workplace://anchor", workplace: "workplace://anchor", capture: "capture.json", store: "checkpoints", restoreTarget: "../unused-restore", line: "main",
        policy: { remote: "separate", requirement: "optional" }, binding,
      }, null, 2)}\n`);
      const pushed = jsonCli(machineA.mount, ["checkpoint", "push", created.checkpointId, "--json"]) as { receipt: { status: string } };
      expect(pushed.receipt.status).toBe("verified-remote");
      const remoteBeforeSetup = git(continuityRemote, ["show-ref"]);
      expect(remoteBeforeSetup).not.toBe("");
      expect(git(productRemote, ["show-ref"], 1)).toBe("");

      const targetStore = join(machineB.mount, ".endroit/checkpoints");
      await writeFile(join(machineB.mount, ".endroit/continuity.json"), `${JSON.stringify({
        kind: "ContinuityDescriptor", version: 1, anchor: "workplace://anchor", workplace: "workplace://anchor", capture: "unused.json", store: "checkpoints", restoreTarget: "../manual-restore", line: "main",
        policy: { remote: "separate", requirement: "required" }, binding,
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
      expect(status.recovery.continuity).toEqual({
        status: "blocked", requirement: "required", missing: [{ id: "anchor-sites", workplace: "workplace://anchor", requirement: "required", checkpointId: created.checkpointId, action: `endroit checkpoint fetch ${created.checkpointId} --json` }], verification: "not-run",
      });
      const target = join(machineB.mount, "checkouts/sites");
      expect(await Bun.file(target).exists()).toBe(false);
      expect(await Bun.file(join(machineB.mount, ".endroit/current-member.json")).exists()).toBe(false);

      const first = jsonCli(join(machineB.mount, "workplace"), ["setup", "--json"]) as RootSetupResult;
      expect(first.status).toBe("ready");
      expect(first.continuity.fetched).toEqual([{ id: "anchor-sites", workplace: "workplace://anchor", requirement: "required", checkpointId: created.checkpointId, status: "installed", remoteStatus: "fetched-verified" }]);
      expect(first.receipt.checkpoints).toEqual([{
        id: "anchor-sites", workplace: "workplace://anchor", target: await realpath(target), action: "restore",
        status: "restored-equivalent", checkpointId: created.checkpointId, portableFingerprint: created.verification.portableFingerprint,
      }]);
      const sourceEvidence = new Map(capture.roots.flatMap((root) => root.worktrees).map((worktree) => [worktree.id, evidence(worktree.path)]));
      for (const worktree of capture.roots.flatMap((root) => root.worktrees)) {
        expect(resolve(join(target, worktree.logicalPath))).not.toBe(resolve(worktree.path));
        expect(evidence(join(target, worktree.logicalPath))).toBe(sourceEvidence.get(worktree.id));
        expect(git(join(target, worktree.logicalPath), ["remote"])).toBe("");
      }
      expect(git(continuityRemote, ["show-ref"])).toBe(remoteBeforeSetup);
      expect(git(productRemote, ["show-ref"], 1)).toBe("");
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
        checkpointId: created.checkpointId, sourceFingerprint: created.verification.portableFingerprint, targetFingerprint: first.receipt.checkpoints[0]?.portableFingerprint,
        firstAction: first.receipt.checkpoints[0]?.action, replayAction: replay.receipt.checkpoints[0]?.action, replayUnchanged: true,
      }));
    } finally {
      await rm(machineA.root, { recursive: true, force: true });
      await rm(machineB.root, { recursive: true, force: true });
    }
  });
});
