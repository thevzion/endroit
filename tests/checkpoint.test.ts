import { describe, expect, test } from "bun:test";
import { chmod, cp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { captureCheckpoint, checkpointRestorePlan, restoreCheckpoint, verifyCheckpoint, type CheckpointCaptureRequest } from "../src/checkpoint.ts";
import { fetchCheckpoint, publishCheckpoint, restoreCheckpointFromRemote } from "../src/checkpoint-remote.ts";

const repository = resolve(import.meta.dir, "..");
const cli = [Bun.argv[0]!, resolve(repository, "src/cli.ts")];

function run(cwd: string, args: string[], expected = 0): string {
  const result = Bun.spawnSync(args, { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== expected) throw new Error(`${args.join(" ")} exited ${result.exitCode}: ${new TextDecoder().decode(result.stderr)}`);
  return new TextDecoder().decode(result.stdout).trim();
}

function git(cwd: string, args: string[], expected = 0): string {
  return run(cwd, ["git", ...args], expected);
}

async function init(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
  git(path, ["init", "-q", "-b", "develop"]);
  git(path, ["config", "user.name", "Checkpoint Fixture"]);
  git(path, ["config", "user.email", "fixture@example.test"]);
}

async function fixture() {
  const root = resolve("/tmp", `endroit-checkpoint-test-${crypto.randomUUID()}`);
  const source = join(root, "source");
  const shared = join(source, "shared-main");
  const detached = join(source, "shared-detached");
  const desk = join(source, "desk");
  const site = join(source, "site");
  await rm(root, { recursive: true, force: true });
  await init(shared);
  await writeFile(join(shared, "shared.txt"), "shared\n");
  git(shared, ["add", "."]); git(shared, ["commit", "-qm", "shared base"]);
  git(shared, ["update-ref", "refs/custom/proof", "HEAD"]);
  await writeFile(join(shared, "shared.txt"), "stash candidate\n");
  git(shared, ["stash", "push", "-qm", "fixture stash"]);
  git(shared, ["notes", "add", "-m", "fixture note", "HEAD"]);
  git(shared, ["worktree", "add", "-q", "--detach", detached, "HEAD"]);
  await writeFile(join(detached, "detached.txt"), "local only\n");
  git(detached, ["add", "."]); git(detached, ["commit", "-qm", "detached local"]);

  await init(desk);
  await writeFile(join(desk, ".gitignore"), "cache.bin\n");
  await writeFile(join(desk, "work.txt"), "base\n");
  await writeFile(join(desk, "assume.txt"), "assume\n");
  await writeFile(join(desk, "skip.txt"), "skip\n");
  await writeFile(join(desk, "tool.sh"), "#!/bin/sh\necho fixture\n");
  await chmod(join(desk, "tool.sh"), 0o755);
  git(desk, ["add", "."]); git(desk, ["commit", "-qm", "desk base"]);
  git(desk, ["update-index", "--assume-unchanged", "assume.txt"]);
  git(desk, ["update-index", "--skip-worktree", "skip.txt"]);
  await writeFile(join(desk, "work.txt"), "staged\n"); git(desk, ["add", "work.txt"]);
  await writeFile(join(desk, "work.txt"), "staged and unstaged\n");
  await writeFile(join(desk, "untracked.txt"), "untracked\n");
  await writeFile(join(desk, "intent.txt"), "intent\n"); git(desk, ["add", "-N", "intent.txt"]);
  await writeFile(join(desk, "cache.bin"), "ignored selected\n");
  await symlink("work.txt", join(desk, "untracked-link"));

  await init(site);
  await writeFile(join(site, "conflict.txt"), "base\n");
  git(site, ["add", "."]); git(site, ["commit", "-qm", "site base"]);
  git(site, ["branch", "other"]);
  git(site, ["checkout", "-q", "other"]);
  await writeFile(join(site, "conflict.txt"), "theirs\n"); git(site, ["commit", "-qam", "theirs"]);
  git(site, ["checkout", "-q", "develop"]);
  await writeFile(join(site, "conflict.txt"), "ours\n"); git(site, ["commit", "-qam", "ours"]);
  git(site, ["merge", "other"], 1);

  const request: CheckpointCaptureRequest = {
    kind: "CheckpointCaptureRequest", version: 1,
    workplace: "workplace://fixture", workplaceRevision: `sha256:${"1".repeat(64)}`,
    sourceRoot: source, output: join(root, "checkpoint"),
    roots: [
      { ref: "workplace://fixture/root/shared", worktrees: [{ id: "shared-main", path: shared, logicalPath: "roots/shared/main" }, { id: "shared-detached", path: detached, logicalPath: "roots/shared/detached" }] },
      { ref: "workplace://fixture/root/desk", worktrees: [{ id: "desk-main", path: desk, logicalPath: "roots/desk/main" }] },
      { ref: "workplace://fixture/root/site", worktrees: [{ id: "site-main", path: site, logicalPath: "roots/site/main" }] },
    ],
    policy: { includeUntracked: true, ignoredPaths: [{ worktree: "desk-main", path: "cache.bin" }] },
  };
  return { root, source, shared, detached, desk, site, request };
}

function evidence(path: string): string {
  return [
    git(path, ["show-ref", "--head"]),
    git(path, ["status", "--porcelain=v2", "--branch", "--untracked-files=all"]),
    git(path, ["diff", "--cached", "--binary", "--full-index"]),
    git(path, ["diff", "--binary", "--full-index"]),
    git(path, ["ls-files", "--stage"]),
    git(path, ["ls-files", "-v"]),
  ].join("\n---\n");
}

describe("Git State Portability", () => {
  test("round-trips clean, linked, detached, dirty, ignored and conflicted state through the CLI", async () => {
    const state = await fixture();
    try {
      const before = new Map([["shared-main", evidence(state.shared)], ["shared-detached", evidence(state.detached)], ["desk-main", evidence(state.desk)], ["site-main", evidence(state.site)]]);
      const requestPath = join(state.root, "request.json");
      await writeFile(requestPath, `${JSON.stringify(state.request, null, 2)}\n`);
      const captured = JSON.parse(run(repository, [...cli, "checkpoint", "capture", "--from", requestPath, "--json"])) as Awaited<ReturnType<typeof captureCheckpoint>>;
      expect(captured.receipt.status).toBe("captured");
      expect(captured.receipt.coverage.repositories).toBe(3);
      expect(captured.receipt.coverage.worktrees).toBe(4);
      expect(JSON.parse(run(repository, [...cli, "checkpoint", "verify", captured.path, "--json"]).trim()).receipt.status).toBe("verified-local");
      const verified = await verifyCheckpoint(captured.path);
      const staticProof = JSON.parse(run(repository, ["node", resolve(repository, "scripts/checkpoint-validate.mjs"), captured.path]));
      expect(staticProof.status).toBe("verified-static");
      expect(staticProof.plan).toEqual(checkpointRestorePlan(verified.manifest));

      const restoredPath = join(state.root, "restored");
      const restored = JSON.parse(run(repository, [...cli, "checkpoint", "restore", captured.path, "--to", restoredPath, "--json"])) as Awaited<ReturnType<typeof restoreCheckpoint>>;
      expect(restored.receipt.status).toBe("restored-equivalent");
      const targets = new Map([["shared-main", join(restoredPath, "roots/shared/main")], ["shared-detached", join(restoredPath, "roots/shared/detached")], ["desk-main", join(restoredPath, "roots/desk/main")], ["site-main", join(restoredPath, "roots/site/main")]]);
      for (const [id, path] of targets) expect(evidence(path)).toBe(before.get(id));
      expect(await readFile(join(restoredPath, "roots/desk/main/cache.bin"), "utf8")).toBe("ignored selected\n");
      expect(await readlinkText(join(restoredPath, "roots/desk/main/untracked-link"))).toBe("work.txt");
      expect(await realpath(resolve(join(restoredPath, "roots/shared/main"), textCommon(join(restoredPath, "roots/shared/main"))))).toBe(await realpath(resolve(join(restoredPath, "roots/shared/detached"), textCommon(join(restoredPath, "roots/shared/detached")))));
      for (const [id, path] of [["shared-main", state.shared], ["shared-detached", state.detached], ["desk-main", state.desk], ["site-main", state.site]] as const) expect(evidence(path)).toBe(before.get(id));

      const secondRequest = { ...state.request, output: join(state.root, "checkpoint-two") };
      const second = await captureCheckpoint(secondRequest);
      expect(second.receipt.checkpointId).toBe(captured.receipt.checkpointId);
      expect(second.receipt.portableFingerprint).toBe(captured.receipt.portableFingerprint);
    } finally {
      await rm(state.root, { recursive: true, force: true });
    }
  });

  test("fails closed on manifest tampering and an existing restore target", async () => {
    const state = await fixture();
    try {
      const captured = await captureCheckpoint(state.request);
      const tampered = join(state.root, "tampered");
      await cp(captured.path, tampered, { recursive: true });
      const manifestPath = join(tampered, "MANIFEST.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      await writeFile(manifestPath, `${JSON.stringify({ ...manifest, unknown: true }, null, 2)}\n`);
      let schema = "";
      try { await verifyCheckpoint(tampered); } catch (error) { schema = error instanceof Error ? error.message : String(error); }
      expect(schema).toContain("unknown fields");
      run(repository, ["node", resolve(repository, "scripts/checkpoint-validate.mjs"), tampered], 1);

      const payloadTampered = join(state.root, "payload-tampered");
      await cp(captured.path, payloadTampered, { recursive: true });
      const validManifest = JSON.parse(await readFile(join(payloadTampered, "MANIFEST.json"), "utf8"));
      await writeFile(join(payloadTampered, validManifest.payloads[0].path), "tampered\n");
      let payload = "";
      try { await verifyCheckpoint(payloadTampered); } catch (error) { payload = error instanceof Error ? error.message : String(error); }
      expect(payload).toContain("changed");
      run(repository, ["node", resolve(repository, "scripts/checkpoint-validate.mjs"), payloadTampered], 1);

      const existing = join(state.root, "existing");
      await mkdir(existing, { recursive: true });
      await writeFile(join(existing, "keep.txt"), "keep\n");
      let blocked = "";
      try { await restoreCheckpoint(captured.path, existing); } catch (error) { blocked = error instanceof Error ? error.message : String(error); }
      expect(blocked).toContain("already exists");
      expect(await readFile(join(existing, "keep.txt"), "utf8")).toBe("keep\n");

      for (const name of ["capture-request", "repository", "worktree", "index", "payload", "compatibility", "manifest", "receipt", "publish-request", "fetch-request", "envelope-record", "remote-control", "remote-receipt", "restore-plan", "toolchain"]) {
        const schemaDocument = JSON.parse(await readFile(join(repository, `schemas/checkpoint/${name}-v1.schema.json`), "utf8"));
        expect(schemaDocument.additionalProperties).toBe(false);
      }
      const toolchain = JSON.parse(await readFile(join(repository, "schemas/checkpoint/TOOLCHAIN.json"), "utf8"));
      const packageDocument = JSON.parse(await readFile(join(repository, "package.json"), "utf8"));
      expect(toolchain.toolchain.version).toBe(packageDocument.version);
    } finally {
      await rm(state.root, { recursive: true, force: true });
    }
  });

  test("publishes only age ciphertext and fetches a deeply verified package", async () => {
    const state = await fixture();
    try {
      const checkpointRemote = join(state.root, "checkpoint.git");
      const productRemote = join(state.root, "product.git");
      git(state.root, ["init", "-q", "--bare", checkpointRemote]);
      git(state.root, ["init", "-q", "--bare", productRemote]);
      git(state.shared, ["remote", "add", "origin", productRemote]);
      const before = new Map([["shared-main", evidence(state.shared)], ["shared-detached", evidence(state.detached)], ["desk-main", evidence(state.desk)], ["site-main", evidence(state.site)]]);
      const captured = await captureCheckpoint(state.request);

      const identity = join(state.root, "identity.txt");
      run(state.root, ["age-keygen", "-o", identity]);
      const recipient = run(state.root, ["age-keygen", "-y", identity]);
      const publishRequest = { kind: "CheckpointPublishRequest", version: 1, remote: checkpointRemote, recipients: [{ ref: "recipient://synthetic/member", value: recipient }], identities: [identity], baseCheckpoint: null };
      const publishPath = join(state.root, "publish.json");
      await writeFile(publishPath, `${JSON.stringify(publishRequest, null, 2)}\n`);
      const published = JSON.parse(run(repository, [...cli, "checkpoint", "publish", captured.path, "--from", publishPath, "--json"])) as Awaited<ReturnType<typeof publishCheckpoint>>;
      expect(published.receipt.status).toBe("verified-remote");
      const replay = JSON.parse(run(repository, [...cli, "checkpoint", "publish", captured.path, "--from", publishPath, "--json"])) as Awaited<ReturnType<typeof publishCheckpoint>>;
      expect(replay.receipt.controlCommit).toBe(published.receipt.controlCommit);
      expect(replay.receipt.latest?.status).toBe("advanced");

      const checkout = join(state.root, "remote-checkout");
      await mkdir(checkout, { recursive: true });
      git(checkout, ["init", "-q"]); git(checkout, ["fetch", "-q", "--no-tags", checkpointRemote, published.receipt.controlRef]); git(checkout, ["checkout", "-q", "--detach", "FETCH_HEAD"]);
      const remoteFiles = git(checkout, ["ls-tree", "-r", "--name-only", "HEAD"]).split("\n").filter(Boolean);
      expect(remoteFiles[0]).toBe("CONTROL.json");
      expect(remoteFiles.slice(1).every((path) => /^objects\/[a-f0-9]{64}\.age$/.test(path))).toBe(true);
      for (const secret of ["ignored selected", "fixture note", "workplace://fixture", "refs/custom/proof"]) expect(remoteContains(checkout, remoteFiles, secret)).toBe(false);

      const fetchRequest = { kind: "CheckpointFetchRequest", version: 1, remote: checkpointRemote, identities: [identity] };
      const fetchPath = join(state.root, "fetch.json");
      const fetchedPath = join(state.root, "fetched");
      await writeFile(fetchPath, `${JSON.stringify(fetchRequest, null, 2)}\n`);
      const fetched = JSON.parse(run(repository, [...cli, "checkpoint", "fetch", captured.receipt.checkpointId, "--from", fetchPath, "--to", fetchedPath, "--json"])) as Awaited<ReturnType<typeof fetchCheckpoint>>;
      expect(fetched.receipt.status).toBe("fetched-verified");
      expect((await verifyCheckpoint(fetched.path)).manifest.checkpointId).toBe(captured.receipt.checkpointId);

      const remoteRestoredPath = join(state.root, "remote-restored");
      const remoteRestored = JSON.parse(run(repository, [...cli, "checkpoint", "restore-remote", captured.receipt.checkpointId, "--from", fetchPath, "--to", remoteRestoredPath, "--json"])) as Awaited<ReturnType<typeof restoreCheckpointFromRemote>>;
      expect(remoteRestored.receipt.status).toBe("restored-equivalent");
      expect(remoteRestored.remote.status).toBe("fetched-verified");
      for (const [id, path] of [["shared-main", join(remoteRestoredPath, "roots/shared/main")], ["shared-detached", join(remoteRestoredPath, "roots/shared/detached")], ["desk-main", join(remoteRestoredPath, "roots/desk/main")], ["site-main", join(remoteRestoredPath, "roots/site/main")]] as const) expect(evidence(path)).toBe(before.get(id));

      await writeFile(join(state.desk, "untracked.txt"), "branch one\n");
      const firstBranch = await captureCheckpoint({ ...state.request, output: join(state.root, "checkpoint-branch-one") });
      const firstPublished = await publishCheckpoint(firstBranch.path, { ...publishRequest, baseCheckpoint: captured.receipt.checkpointId });
      expect(firstPublished.receipt.status).toBe("verified-remote");
      await writeFile(join(state.desk, "untracked.txt"), "branch two\n");
      const secondBranch = await captureCheckpoint({ ...state.request, output: join(state.root, "checkpoint-branch-two") });
      const secondPublished = await publishCheckpoint(secondBranch.path, { ...publishRequest, baseCheckpoint: captured.receipt.checkpointId });
      expect(secondPublished.receipt.status).toBe("diverged");
      expect(secondPublished.receipt.latest?.observedCheckpoint).toBe(firstBranch.receipt.checkpointId);
      expect(git(state.root, ["ls-remote", checkpointRemote, firstPublished.receipt.controlRef]).startsWith(firstPublished.receipt.controlCommit)).toBe(true);
      expect(git(state.root, ["ls-remote", checkpointRemote, secondPublished.receipt.controlRef]).startsWith(secondPublished.receipt.controlCommit)).toBe(true);
      expect(git(state.root, ["ls-remote", checkpointRemote, "refs/endroit/checkpoints/latest"]).startsWith(firstPublished.receipt.controlCommit)).toBe(true);

      const wrongIdentity = join(state.root, "wrong-identity.txt");
      run(state.root, ["age-keygen", "-o", wrongIdentity]);
      const wrongTarget = join(state.root, "wrong-target");
      let wrong = "";
      try { await fetchCheckpoint(captured.receipt.checkpointId, { ...fetchRequest, identities: [wrongIdentity] }, wrongTarget); }
      catch (error) { wrong = error instanceof Error ? error.message : String(error); }
      expect(wrong).toContain("failed");
      expect(await Bun.file(wrongTarget).exists()).toBe(false);

      let collision = "";
      try { await publishCheckpoint(captured.path, { ...publishRequest, remote: productRemote }); }
      catch (error) { collision = error instanceof Error ? error.message : String(error); }
      expect(collision).toContain("collides");
      expect(git(state.root, ["--git-dir", productRemote, "show-ref"], 1)).toBe("");

      const deleted = remoteFiles.find((path) => path.startsWith("objects/"))!;
      await rm(join(checkout, deleted), { force: true, recursive: false });
      git(checkout, ["add", "-u"]); git(checkout, ["-c", "user.name=Tamper", "-c", "user.email=tamper@example.test", "commit", "-qm", "tamper"]); git(checkout, ["push", "-q", "--force", checkpointRemote, `HEAD:${published.receipt.controlRef}`]);
      const tamperedTarget = join(state.root, "tampered-fetch");
      let tampered = "";
      try { await fetchCheckpoint(captured.receipt.checkpointId, fetchRequest, tamperedTarget); }
      catch (error) { tampered = error instanceof Error ? error.message : String(error); }
      expect(tampered).toContain("object set changed");
      expect(await Bun.file(tamperedTarget).exists()).toBe(false);
      expect(evidence(state.shared)).toBe(before.get("shared-main"));
      expect(evidence(state.detached)).toBe(before.get("shared-detached"));
      expect(evidence(state.site)).toBe(before.get("site-main"));
    } finally {
      await rm(state.root, { recursive: true, force: true });
    }
  });
});

async function readlinkText(path: string): Promise<string> {
  return run(repository, ["readlink", path]);
}

function textCommon(path: string): string {
  return git(path, ["rev-parse", "--git-common-dir"]);
}

function remoteContains(checkout: string, files: string[], expected: string): boolean {
  const needle = new TextEncoder().encode(expected);
  return files.some((path) => {
    const result = Bun.spawnSync(["git", "show", `HEAD:${path}`], { cwd: checkout, stdout: "pipe", stderr: "pipe" });
    const bytes = result.stdout;
    return bytes.some((_, index) => index + needle.length <= bytes.length && needle.every((value, offset) => bytes[index + offset] === value));
  });
}
