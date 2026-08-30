import { describe, expect, test } from "bun:test";
import { cp, lstat, mkdir, readFile, readlink, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { assertCheckpointRestoreCapabilities, captureCheckpoint, checkpointRestorePlan, restoreCheckpoint, verifyCheckpoint } from "../src/checkpoint.ts";
import { fetchCheckpoint, publishCheckpoint, restoreCheckpointFromRemote } from "../src/checkpoint-remote.ts";
import { gitArguments, gitTransportArguments } from "../src/platform.ts";
import { checkpointFixture, cli, evidence, git, repository, run } from "./helpers/checkpoint-fixture.ts";

describe("Git State Portability", () => {
  test("rebases resolved Git pointers while refusing a pointer outside restored repositories", async () => {
    const state = await checkpointFixture({ platformNeutral: true });
    try {
      const root = state.request.roots[0]!;
      const captured = await captureCheckpoint({ ...state.request, roots: [{ ...root, worktrees: [root.worktrees[0]!] }] });
      const before = evidence(state.shared);
      const target = join(state.root, "canonical-target");
      const restored = await restoreCheckpoint(captured.path, target, { beforeInstall: async (staging) => {
        const pointer = join(staging, "roots/shared/main/.git");
        const admin = resolve(dirname(pointer), (await readFile(pointer, "utf8")).trim().slice("gitdir: ".length));
        await writeFile(pointer, `gitdir: ${relative(dirname(pointer), admin)}\n`);
        await writeFile(join(admin, "gitdir"), `${relative(admin, pointer)}\n`);
      } });
      expect(restored.receipt.status).toBe("restored-equivalent");
      expect(evidence(join(target, "roots/shared/main"))).toBe(before);
      const unsafe = join(state.root, "unsafe-target");
      let blocked = "";
      try { await restoreCheckpoint(captured.path, unsafe, { beforeInstall: async (staging) => {
        await writeFile(join(staging, "roots/shared/main/.git"), `gitdir: ${join(state.shared, ".git")}\n`);
      } }); } catch (error) { blocked = error instanceof Error ? error.message : String(error); }
      expect(blocked).toContain("unexpected Git pointer");
      expect(await lstat(unsafe).catch(() => undefined)).toBe(undefined);
      expect(evidence(state.shared)).toBe(before);
    } finally { await rm(state.root, { recursive: true, force: true }); }
  });

  test("round-trips clean, linked, detached, dirty and conflicted state while excluding ignored files", async () => {
    const state = await checkpointFixture();
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
      expect(await Bun.file(join(restoredPath, "roots/desk/main/cache.bin")).exists()).toBe(false);
      if (state.includesSymlink) expect(await readlinkText(join(restoredPath, "roots/desk/main/untracked-link"))).toBe("work.txt");
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
    const state = await checkpointFixture();
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

      for (const name of ["capture-request", "repository", "worktree", "index", "payload", "compatibility", "manifest", "receipt", "continuity-binding", "publish-request", "fetch-request", "remote-receipt", "restore-plan", "toolchain"]) {
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

  test("fails a required file-symlink capability before restore mutation", async () => {
    const state = await checkpointFixture({ platformNeutral: true });
    try {
      const captured = await captureCheckpoint(state.request);
      const manifest = (await verifyCheckpoint(captured.path)).manifest;
      manifest.worktrees[0]!.untracked.push({ path: "link", kind: "symlink", mode: "120000", sha256: "a".repeat(64), size: 6, payload: `payloads/${"a".repeat(64)}` });
      let message = "";
      let observedParent = "";
      try { await assertCheckpointRestoreCapabilities(manifest, state.root, async (parent) => { observedParent = parent; throw Object.assign(new Error("operation not permitted"), { code: "EPERM" }); }); }
      catch (error) { message = error instanceof Error ? error.message : String(error); }
      expect(observedParent).toBe(state.root);
      expect(message).toContain("file symlinks");
      expect(message).toContain("EPERM");
    } finally {
      await rm(state.root, { recursive: true, force: true });
    }
  });

  test("publishes immutable Git-native Member Lines and preserves divergence", async () => {
    const state = await checkpointFixture();
    try {
      const productRemote = join(state.root, "product.git");
      git(state.root, ["init", "-q", "--bare", productRemote]);
      git(state.shared, ["remote", "add", "origin", productRemote]);
      git(state.shared, ["push", "-q", "origin", "develop"]);
      const before = new Map([["shared-main", evidence(state.shared)], ["shared-detached", evidence(state.detached)], ["desk-main", evidence(state.desk)], ["site-main", evidence(state.site)]]);
      const captured = await captureCheckpoint(state.request);

      const binding = { kind: "ContinuityBinding", version: 1, workplace: "workplace://fixture", role: "product", locator: productRemote, productLocator: productRemote, productVisibility: "private", continuityVisibility: "private", credentialBinding: "git:fixture" };
      const publishRequest = { kind: "CheckpointPublishRequest", version: 1, binding, ownerMember: state.request.ownerMember, line: "main", parentCheckpoint: null };
      const publishPath = join(state.root, "publish.json");
      await writeFile(publishPath, `${JSON.stringify(publishRequest, null, 2)}\n`);
      const published = JSON.parse(run(repository, [...cli, "checkpoint", "publish", captured.path, "--from", publishPath, "--json"])) as Awaited<ReturnType<typeof publishCheckpoint>>;
      expect(published.receipt.status).toBe("verified-remote");
      expect(published.receipt.lineUpdate).toEqual({ status: "advanced", expectedParent: null, observedCheckpoint: captured.receipt.checkpointId, expectedCommit: null, observedCommit: null, resultingCommit: published.receipt.checkpointCommit });
      git(state.root, ["--git-dir", productRemote, "update-ref", "-d", published.receipt.lineRef]);
      const crashRetry = await publishCheckpoint(captured.path, publishRequest);
      expect(crashRetry.receipt.checkpointCommit).toBe(published.receipt.checkpointCommit);
      expect(crashRetry.receipt.lineUpdate).toEqual({ status: "advanced", expectedParent: null, observedCheckpoint: captured.receipt.checkpointId, expectedCommit: null, observedCommit: null, resultingCommit: published.receipt.checkpointCommit });
      const replay = JSON.parse(run(repository, [...cli, "checkpoint", "publish", captured.path, "--from", publishPath, "--json"])) as Awaited<ReturnType<typeof publishCheckpoint>>;
      expect(replay.receipt.checkpointCommit).toBe(published.receipt.checkpointCommit);
      expect(replay.receipt.lineUpdate?.status).toBe("unchanged");
      expect(git(state.root, ["ls-remote", ...gitTransportArguments("ls-remote", productRemote), productRemote, "refs/heads/develop"]).split("\t")[0]).toBe(git(state.shared, ["rev-parse", "develop"]));

      const checkout = join(state.root, "remote-checkout");
      await mkdir(checkout, { recursive: true });
      git(checkout, ["init", "-q"]); git(checkout, ["fetch", ...gitTransportArguments("fetch", productRemote), "-q", "--no-tags", productRemote, published.receipt.checkpointRef]); git(checkout, ["checkout", "-q", "--detach", "FETCH_HEAD"]);
      const remoteFiles = git(checkout, ["ls-tree", "-r", "--name-only", "HEAD"]).split("\n").filter(Boolean);
      expect(remoteFiles.every((path) => path.startsWith("checkpoint/"))).toBe(true);
      expect(remoteContains(checkout, remoteFiles, "workplace://fixture")).toBe(true);
      expect(remoteContains(checkout, remoteFiles, "ignored selected")).toBe(false);

      const fetchRequest = { kind: "CheckpointFetchRequest", version: 1, binding, ownerMember: state.request.ownerMember, line: "main" };
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
      const firstBranch = await captureCheckpoint({ ...state.request, parentCheckpoint: captured.receipt.checkpointId, output: join(state.root, "checkpoint-branch-one") });
      const firstPublished = await publishCheckpoint(firstBranch.path, { ...publishRequest, parentCheckpoint: captured.receipt.checkpointId });
      expect(firstPublished.receipt.status).toBe("verified-remote");
      expect(firstPublished.receipt.lineUpdate).toEqual({ status: "advanced", expectedParent: captured.receipt.checkpointId, observedCheckpoint: firstBranch.receipt.checkpointId, expectedCommit: published.receipt.checkpointCommit, observedCommit: published.receipt.checkpointCommit, resultingCommit: firstPublished.receipt.checkpointCommit });
      await writeFile(join(state.desk, "untracked.txt"), "branch two\n");
      const secondBranch = await captureCheckpoint({ ...state.request, parentCheckpoint: captured.receipt.checkpointId, output: join(state.root, "checkpoint-branch-two") });
      const secondPublished = await publishCheckpoint(secondBranch.path, { ...publishRequest, parentCheckpoint: captured.receipt.checkpointId });
      expect(secondPublished.receipt.status).toBe("diverged");
      expect(secondPublished.receipt.lineUpdate?.observedCheckpoint).toBe(firstBranch.receipt.checkpointId);
      expect(secondPublished.receipt.lineUpdate).toEqual({ status: "diverged", expectedParent: captured.receipt.checkpointId, observedCheckpoint: firstBranch.receipt.checkpointId, expectedCommit: published.receipt.checkpointCommit, observedCommit: firstPublished.receipt.checkpointCommit, resultingCommit: firstPublished.receipt.checkpointCommit });
      expect(git(state.root, ["ls-remote", ...gitTransportArguments("ls-remote", productRemote), productRemote, firstPublished.receipt.checkpointRef]).startsWith(firstPublished.receipt.checkpointCommit)).toBe(true);
      expect(git(state.root, ["ls-remote", ...gitTransportArguments("ls-remote", productRemote), productRemote, secondPublished.receipt.checkpointRef]).startsWith(secondPublished.receipt.checkpointCommit)).toBe(true);
      expect(git(state.root, ["ls-remote", ...gitTransportArguments("ls-remote", productRemote), productRemote, published.receipt.lineRef]).startsWith(firstPublished.receipt.checkpointCommit)).toBe(true);

      const colleague = "workplace://fixture/member/reviewer";
      const colleagueCheckpoint = await captureCheckpoint({ ...state.request, ownerMember: colleague, output: join(state.root, "checkpoint-reviewer") });
      const colleaguePublished = await publishCheckpoint(colleagueCheckpoint.path, { ...publishRequest, ownerMember: colleague });
      expect(colleaguePublished.receipt.lineRef).not.toBe(published.receipt.lineRef);
      expect(git(state.root, ["ls-remote", ...gitTransportArguments("ls-remote", productRemote), productRemote, colleaguePublished.receipt.lineRef]).startsWith(colleaguePublished.receipt.checkpointCommit)).toBe(true);

      let roleMismatch = "";
      try { await publishCheckpoint(captured.path, { ...publishRequest, binding: { ...binding, role: "separate" } }); }
      catch (error) { roleMismatch = error instanceof Error ? error.message : String(error); }
      expect(roleMismatch).toContain("must not reuse");
      let publicProduct = "";
      try { await publishCheckpoint(captured.path, { ...publishRequest, binding: { ...binding, productVisibility: "public" } }); }
      catch (error) { publicProduct = error instanceof Error ? error.message : String(error); }
      expect(publicProduct).toContain("requires separate private continuity");

      const deleted = remoteFiles.find((path) => path.startsWith("checkpoint/payloads/"))!;
      await rm(join(checkout, deleted), { force: true, recursive: false });
      git(checkout, ["add", "-u"]); git(checkout, ["-c", "user.name=Tamper", "-c", "user.email=tamper@example.test", "commit", "-qm", "tamper"]); git(checkout, ["push", ...gitTransportArguments("push", productRemote), "-q", "--force", productRemote, `HEAD:${published.receipt.checkpointRef}`]);
      const tamperedTarget = join(state.root, "tampered-fetch");
      let tampered = "";
      try { await fetchCheckpoint(captured.receipt.checkpointId, fetchRequest, tamperedTarget); }
      catch (error) { tampered = error instanceof Error ? error.message : String(error); }
      expect(/ENOENT|unavailable|changed|mismatch/.test(tampered)).toBe(true);
      expect(await Bun.file(tamperedTarget).exists()).toBe(false);
      expect(evidence(state.shared)).toBe(before.get("shared-main"));
      expect(evidence(state.detached)).toBe(before.get("shared-detached"));
      expect(evidence(state.site)).toBe(before.get("site-main"));
    } finally {
      await rm(state.root, { recursive: true, force: true });
    }
  }, process.platform === "win32" ? 180_000 : 30_000); // Multi-generation capture, publish, fetch, divergence and restore.
});

async function readlinkText(path: string): Promise<string> {
  return readlink(path);
}

function textCommon(path: string): string {
  return git(path, ["rev-parse", "--git-common-dir"]);
}

function remoteContains(checkout: string, files: string[], expected: string): boolean {
  const needle = new TextEncoder().encode(expected);
  return files.some((path) => {
    const result = Bun.spawnSync(["git", ...gitArguments(["show", `HEAD:${path}`])], { cwd: checkout, stdout: "pipe", stderr: "pipe" });
    const bytes = result.stdout;
    return bytes.some((_, index) => index + needle.length <= bytes.length && needle.every((value, offset) => bytes[index + offset] === value));
  });
}
