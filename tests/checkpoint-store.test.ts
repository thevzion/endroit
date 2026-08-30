import { describe, expect, test } from "bun:test";
import { lstat, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import {
  CheckpointStoreError,
  createLocalCheckpoint,
  fetchContinuityCheckpoint,
  loadContinuityDescriptor,
  pushContinuityCheckpoint,
  restoreContinuityCheckpoint,
  selectLocalCheckpoint,
  type ContinuityDescriptor,
  type ContinuityStoreReceipt,
} from "../src/checkpoint-store.ts";
import type { CheckpointCaptureRequest } from "../src/checkpoint.ts";
import { gitArguments, gitTransportArguments } from "../src/platform.ts";

const cli = [Bun.argv[0]!, resolve(import.meta.dir, "../src/cli.ts")];
// Multi-generation capture/push/fetch/restore only; other tests keep the 30s default.
const heavyGitTimeout = process.platform === "win32" ? 180_000 : 30_000;

function run(cwd: string, args: string[], expected = 0): string {
  const result = Bun.spawnSync(args[0] === "git" ? ["git", ...gitArguments(args.slice(1))] : args, { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== expected) throw new Error(`${args.join(" ")} exited ${result.exitCode}: ${new TextDecoder().decode(result.stderr)}`);
  return new TextDecoder().decode(result.stdout).trim();
}

function git(cwd: string, args: string[], expected = 0): string {
  return run(cwd, ["git", ...args], expected);
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) {
    if (error instanceof Error && error.message.includes("ENOENT")) return false;
    throw error;
  }
}

async function errorCode(effect: () => Promise<unknown>): Promise<string> {
  try {
    await effect();
    return "none";
  } catch (error) {
    return error instanceof CheckpointStoreError
      ? error.code
      : error instanceof Error
        ? error.message
        : String(error);
  }
}

async function files(root: string, current = root): Promise<string[]> {
  if (!await exists(root)) return [];
  const result: string[] = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) result.push(...await files(root, path));
    else result.push(relative(root, path));
  }
  return result.sort();
}

async function fixture() {
  const root = resolve(tmpdir(), `endroit-continuity-store-${crypto.randomUUID()}`);
  const sourceRoot = join(root, "source");
  const worktree = join(sourceRoot, "product/main");
  const requests = join(root, "requests");
  const mount = join(root, "mount");
  await mkdir(worktree, { recursive: true });
  git(worktree, ["init", "-q", "-b", "develop"]);
  git(worktree, ["config", "user.name", "Continuity Fixture"]);
  git(worktree, ["config", "user.email", "fixture@example.test"]);
  await writeFile(join(worktree, "tracked.txt"), "base\n");
  git(worktree, ["add", "."]);
  git(worktree, ["commit", "-qm", "base"]);
  await writeFile(join(worktree, "tracked.txt"), "dirty\n");
  await writeFile(join(worktree, "untracked.txt"), "selected\n");
  await mkdir(join(mount, "workplace/.workplace"), { recursive: true });
  await writeFile(join(mount, "workplace/workplace.json"), `${JSON.stringify({ kind: "WorkplaceBuildContract", version: 2, workplace: "workplace://fixture" }, null, 2)}\n`);
  await mkdir(join(mount, ".endroit"), { recursive: true });
  await writeFile(join(mount, ".endroit/current-member.json"), `${JSON.stringify({ kind: "CurrentMemberBindings", version: 1, anchor: "workplace://fixture", members: [{ workplace: "workplace://fixture", member: "workplace://fixture/member/operator", desk: "workplace://fixture/desk/operator" }] }, null, 2)}\n`);
  await mkdir(requests, { recursive: true });
  const capture: CheckpointCaptureRequest = {
    kind: "CheckpointCaptureRequest",
    version: 1,
    workplace: "workplace://fixture",
    workplaceRevision: `sha256:${"1".repeat(64)}`,
    ownerMember: "workplace://fixture/member/operator",
    line: "main",
    parentCheckpoint: null,
    sourceRoot,
    output: join(root, "ignored-by-store"),
    roots: [{ ref: "workplace://fixture/root/product", worktrees: [{ id: "product-main", path: worktree, logicalPath: "product/main" }] }],
    policy: { includeUntracked: true },
  };
  const capturePath = join(requests, "capture.json");
  await writeFile(capturePath, `${JSON.stringify(capture, null, 2)}\n`);
  return { root, mount, requests, capturePath, worktree };
}

function descriptorAt(path: string, state: Awaited<ReturnType<typeof fixture>>, overrides: Partial<ContinuityDescriptor> = {}): ContinuityDescriptor {
  return {
    kind: "ContinuityDescriptor",
    version: 1,
    anchor: "workplace://fixture",
    workplace: "workplace://fixture",
    capture: relative(dirname(path), state.capturePath),
    store: relative(dirname(path), join(state.mount, ".endroit/checkpoints")),
    restoreTarget: relative(dirname(path), join(state.mount, "restored")),
    line: "main",
    policy: { remote: "none", requirement: "optional" },
    ...overrides,
  };
}

async function rememberOperator(mount: string): Promise<void> {
  await mkdir(join(mount, ".endroit"), { recursive: true });
  await writeFile(join(mount, ".endroit/current-member.json"), `${JSON.stringify({ kind: "CurrentMemberBindings", version: 1, anchor: "workplace://fixture", members: [{ workplace: "workplace://fixture", member: "workplace://fixture/member/operator", desk: "workplace://fixture/desk/operator" }] }, null, 2)}\n`);
}

function separateBinding(remote: string, product: string) {
  return { kind: "ContinuityBinding" as const, version: 1 as const, workplace: "workplace://fixture", role: "separate" as const, locator: remote, productLocator: product, productVisibility: "public" as const, continuityVisibility: "private" as const, credentialBinding: "git:fixture" };
}

async function writeDescriptor(path: string, value: ContinuityDescriptor | Record<string, unknown>): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

describe("root-driven checkpoint store", () => {
  test("keeps local create push-free and exposes explicit push, fetch and restore", async () => {
    const state = await fixture();
    try {
      const descriptorPath = join(state.mount, ".endroit/continuity.json");
      await writeDescriptor(descriptorPath, descriptorAt(descriptorPath, state));
      run(state.mount, [...cli, "checkpoint", "pussh", "--json"], 2);
      expect(await exists(join(state.mount, ".endroit/checkpoints"))).toBe(false);
      const outsidePath = join(state.root, "outside-path/child");
      await mkdir(outsidePath, { recursive: true });
      await symlink(dirname(outsidePath), join(state.mount, "linked-path"), process.platform === "win32" ? "junction" : "dir");
      run(state.mount, [...cli, "checkpoint", "linked-path/child", "--json"], 2);
      expect(await exists(join(state.mount, ".endroit/checkpoints"))).toBe(false);
      const absentRemote = JSON.parse(run(state.mount, [...cli, "checkpoint", "push", "--json"])) as { receipt: { status: string; checkpointId: string | null } };
      expect(absentRemote.receipt).toEqual({ kind: "ContinuityRemoteReceipt", version: 1, operation: "push", status: "no-continuity-remote", checkpointId: null });
      expect(await exists(join(state.mount, ".endroit/checkpoints"))).toBe(false);
      const created = JSON.parse(run(state.mount, [...cli, "checkpoint", "--json"])) as ContinuityStoreReceipt;
      expect(created.status).toBe("installed");
      const storeBefore = await files(join(state.mount, ".endroit/checkpoints"));
      const skipped = JSON.parse(run(state.mount, [...cli, "checkpoint", "push", "--json"])) as { receipt: { status: string } };
      expect(skipped.receipt.status).toBe("no-continuity-remote");
      expect(await files(join(state.mount, ".endroit/checkpoints"))).toEqual(storeBefore);

      const remote = join(state.root, "continuity.git");
      git(state.root, ["init", "-q", "--bare", remote]);
      const product = join(state.root, "product.git");
      git(state.root, ["init", "-q", "--bare", product]);
      await writeDescriptor(descriptorPath, descriptorAt(descriptorPath, state, { policy: { remote: "separate", requirement: "optional" }, binding: separateBinding(remote, product) }));
      expect(git(state.root, ["ls-remote", ...gitTransportArguments("ls-remote", remote), remote, "refs/endroit/checkpoints/*"])).toBe("");
      const pushed = JSON.parse(run(state.mount, [...cli, "checkpoint", "push", "--json"])) as { receipt: { status: string } };
      expect(pushed.receipt.status).toBe("verified-remote");
      expect(git(state.root, ["ls-remote", ...gitTransportArguments("ls-remote", remote), remote, "refs/endroit/checkpoints/*"])).not.toBe("");
      expect(git(state.root, ["--git-dir", product, "show-ref"], 1)).toBe("");

      const secondMount = join(state.root, "second-mount");
      await mkdir(join(secondMount, "workplace"), { recursive: true });
      await writeFile(join(secondMount, "workplace/workplace.json"), `${JSON.stringify({ kind: "WorkplaceBuildContract", version: 2, workplace: "workplace://fixture" }, null, 2)}\n`);
      await rememberOperator(secondMount);
      const secondPath = join(secondMount, ".endroit/continuity.json");
      await writeDescriptor(secondPath, {
        ...descriptorAt(secondPath, state), store: "checkpoints", restoreTarget: "../restored",
        policy: { remote: "separate", requirement: "optional" }, binding: separateBinding(remote, product),
      });
      const fetched = JSON.parse(run(secondMount, [...cli, "checkpoint", "fetch", "--json"])) as { store: { checkpointId: string } };
      expect(fetched.store.checkpointId).toBe(created.checkpointId);
      expect(await exists(join(secondMount, "restored"))).toBe(false);
      const restored = JSON.parse(run(secondMount, [...cli, "checkpoint", "restore", "--json"])) as { receipt: { status: string } };
      expect(restored.receipt.status).toBe("restored-equivalent");
      expect(await exists(join(secondMount, "restored/product/main"))).toBe(true);
      expect(await exists(join(secondMount, "FRONTDOOR.md"))).toBe(false);
      expect(await exists(join(secondMount, ".endroit/projection-manifest.json"))).toBe(false);
    } finally {
      await rm(state.root, { recursive: true, force: true });
    }
  }, heavyGitTimeout);

  test("loads local before portable and rejects a closed or escaping descriptor", async () => {
    const state = await fixture();
    try {
      const portablePath = join(state.mount, "workplace/.workplace/continuity.json");
      await writeDescriptor(portablePath, descriptorAt(portablePath, state));
      expect((await loadContinuityDescriptor(state.mount)).path).toBe(portablePath);

      const localPath = join(state.mount, ".endroit/continuity.json");
      await writeDescriptor(localPath, descriptorAt(localPath, state, { policy: { remote: "none", requirement: "required" } }));
      expect((await loadContinuityDescriptor(state.mount)).path).toBe(localPath);
      expect((await loadContinuityDescriptor(state.mount)).policy.requirement).toBe("required");

      await writeDescriptor(localPath, { ...descriptorAt(localPath, state), unexpected: true });
      expect(await errorCode(() => loadContinuityDescriptor(state.mount))).toBe("invalid-continuity-descriptor");
      await writeDescriptor(localPath, descriptorAt(localPath, state, { store: relative(dirname(localPath), join(state.root, "outside")) }));
      expect(await errorCode(() => loadContinuityDescriptor(state.mount))).toBe("continuity-collision");
      expect(await exists(join(state.root, "outside"))).toBe(false);
    } finally {
      await rm(state.root, { recursive: true, force: true });
    }
  });

  test("installs by checkpoint ID, selects the Current Member line, replays unchanged and restores without ready", async () => {
    const state = await fixture();
    try {
      const descriptorPath = join(state.mount, ".endroit/continuity.json");
      await writeDescriptor(descriptorPath, descriptorAt(descriptorPath, state));
      const descriptor = await loadContinuityDescriptor(state.mount);
      await rm(join(state.mount, ".endroit/current-member.json"), { recursive: false, force: true });
      expect(await errorCode(() => createLocalCheckpoint(descriptor))).toBe("continuity-unavailable");
      await rememberOperator(state.mount);
      const created = await createLocalCheckpoint(descriptor);
      expect(created.status).toBe("installed");
      expect(created.ownerMember).toBe("workplace://fixture/member/operator");
      expect(created.path).toBe(join(descriptor.store, created.checkpointId.slice("checkpoint:sha256:".length)));
      expect((await selectLocalCheckpoint(descriptor)).receipt.checkpointId).toBe(created.checkpointId);
      expect((await selectLocalCheckpoint(descriptor, created.checkpointId)).path).toBe(created.path);

      const replay = await createLocalCheckpoint(descriptor);
      expect(replay.status).toBe("unchanged");
      const beforePush = await files(descriptor.store);
      const skipped = await pushContinuityCheckpoint(descriptor);
      expect(skipped.receipt).toEqual({ kind: "ContinuityRemoteReceipt", version: 1, operation: "push", status: "no-continuity-remote", checkpointId: null });
      expect(await files(descriptor.store)).toEqual(beforePush);

      const restored = await restoreContinuityCheckpoint(descriptor);
      const restoredWorktree = join(restored.path, "product/main");
      expect(restored.receipt.status).toBe("restored-equivalent");
      expect(git(restoredWorktree, ["status", "--porcelain"])).toContain("tracked.txt");
      expect(await readFile(join(restoredWorktree, "tracked.txt"), "utf8")).toBe("dirty\n");
      expect(await readFile(join(restoredWorktree, "untracked.txt"), "utf8")).toBe("selected\n");
      expect(await exists(join(state.mount, "FRONTDOOR.md"))).toBe(false);
      expect(await exists(join(state.mount, ".endroit/projection-manifest.json"))).toBe(false);
    } finally {
      await rm(state.root, { recursive: true, force: true });
    }
  });

  test("fetches the remote Current Member line into a separate store without restoring it", async () => {
    const state = await fixture();
    try {
      const remote = join(state.root, "continuity.git");
      git(state.root, ["init", "-q", "--bare", remote]);
      const product = join(state.root, "product.git");
      git(state.root, ["init", "-q", "--bare", product]);

      const firstPath = join(state.mount, ".endroit/continuity.json");
      await writeDescriptor(firstPath, descriptorAt(firstPath, state, { policy: { remote: "separate", requirement: "optional" }, binding: separateBinding(remote, product) }));
      const first = await loadContinuityDescriptor(state.mount);
      const firstLocal = await createLocalCheckpoint(first);
      expect((await pushContinuityCheckpoint(first)).receipt.status).toBe("verified-remote");
      await writeFile(join(state.worktree, "tracked.txt"), "dirty second generation\n");
      const secondLocal = await createLocalCheckpoint(first);
      expect(secondLocal.parentCheckpoint).toBe(firstLocal.checkpointId);
      expect((await pushContinuityCheckpoint(first)).receipt.status).toBe("verified-remote");

      const secondMount = join(state.root, "second-mount");
      await mkdir(join(secondMount, "workplace"), { recursive: true });
      await writeFile(join(secondMount, "workplace/workplace.json"), `${JSON.stringify({ kind: "WorkplaceBuildContract", version: 2, workplace: "workplace://fixture" }, null, 2)}\n`);
      await rememberOperator(secondMount);
      const secondPath = join(secondMount, ".endroit/continuity.json");
      const secondDescriptor: ContinuityDescriptor = {
        ...descriptorAt(secondPath, state),
        store: "checkpoints",
        restoreTarget: "../restored",
        policy: { remote: "separate", requirement: "optional" }, binding: separateBinding(remote, product),
      };
      await writeDescriptor(secondPath, secondDescriptor);
      const second = await loadContinuityDescriptor(secondMount);
      const fetched = await fetchContinuityCheckpoint(second);
      expect(fetched.store.checkpointId).toBe(secondLocal.checkpointId);
      expect(fetched.remote.status).toBe("fetched-verified");
      expect(await exists(second.restoreTarget)).toBe(false);
      expect((await selectLocalCheckpoint(second)).receipt.checkpointId).toBe(secondLocal.checkpointId);

      const historical = await fetchContinuityCheckpoint(second, firstLocal.checkpointId);
      expect(historical.store.lineUpdate).toBe("not-selected");
      expect((await selectLocalCheckpoint(second)).receipt.checkpointId).toBe(secondLocal.checkpointId);

      const restored = await restoreContinuityCheckpoint(second);
      expect(restored.receipt.status).toBe("restored-equivalent");
      expect(await readFile(join(restored.path, "product/main/tracked.txt"), "utf8")).toBe("dirty second generation\n");
      expect(await exists(join(secondMount, "FRONTDOOR.md"))).toBe(false);
    } finally {
      await rm(state.root, { recursive: true, force: true });
    }
  }, heavyGitTimeout);

  test("fails closed when the local-state family is a symlink", async () => {
    const state = await fixture();
    try {
      const portablePath = join(state.mount, "workplace/.workplace/continuity.json");
      await writeDescriptor(portablePath, descriptorAt(portablePath, state));
      const outside = join(state.root, "outside-local-state");
      await mkdir(outside, { recursive: true });
      await rm(join(state.mount, ".endroit"), { recursive: true, force: true });
      await symlink(outside, join(state.mount, ".endroit"), process.platform === "win32" ? "junction" : "dir");
      expect(await errorCode(() => loadContinuityDescriptor(state.mount))).toBe("continuity-collision");
      expect(await readdir(outside, { withFileTypes: true })).toEqual([]);
    } finally {
      await rm(state.root, { recursive: true, force: true });
    }
  });
});
