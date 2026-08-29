import { describe, expect, test } from "bun:test";
import { cp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { captureCheckpoint, checkpointRestorePlan, restoreCheckpoint, verifyCheckpoint } from "../src/checkpoint.ts";
import { fetchCheckpoint, publishCheckpoint, restoreCheckpointFromRemote } from "../src/checkpoint-remote.ts";
import { checkpointFixture, cli, evidence, git, repository, run } from "./helpers/checkpoint-fixture.ts";

describe("Git State Portability", () => {
  test("round-trips clean, linked, detached, dirty, ignored and conflicted state through the CLI", async () => {
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
    const state = await checkpointFixture();
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
