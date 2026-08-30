import { chmod, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { CheckpointCaptureRequest } from "../../src/checkpoint.ts";

export const repository = resolve(import.meta.dir, "../..");
export const cli = [Bun.argv[0]!, resolve(repository, "src/cli.ts")];

export function run(cwd: string, args: string[], expected = 0): string {
  const result = Bun.spawnSync(args, { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== expected) throw new Error(`${args.join(" ")} exited ${result.exitCode}: ${new TextDecoder().decode(result.stderr)}`);
  return new TextDecoder().decode(result.stdout).trim();
}

export function git(cwd: string, args: string[], expected = 0): string {
  return run(cwd, ["git", ...args], expected);
}

async function init(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
  git(path, ["init", "-q", "-b", "develop"]);
  git(path, ["config", "user.name", "Checkpoint Fixture"]);
  git(path, ["config", "user.email", "fixture@example.test"]);
}

export async function checkpointFixture(options: { root?: string; source?: string; siteLayout?: boolean; platformNeutral?: boolean } = {}) {
  const root = options.root ? resolve(options.root) : resolve(tmpdir(), `endroit-checkpoint-test-${crypto.randomUUID()}`);
  const platformNeutral = options.platformNeutral ?? process.platform === "win32";
  const source = resolve(options.source ?? join(root, "source"));
  const shared = join(source, options.siteLayout ? "product/main" : "shared-main");
  const detached = join(source, options.siteLayout ? "product/detached" : "shared-detached");
  const desk = join(source, options.siteLayout ? "desk/main" : "desk");
  const site = join(source, options.siteLayout ? "service/main" : "site");
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
  if (!platformNeutral) await chmod(join(desk, "tool.sh"), 0o755);
  git(desk, ["add", "."]); git(desk, ["commit", "-qm", "desk base"]);
  git(desk, ["update-index", "--assume-unchanged", "assume.txt"]);
  git(desk, ["update-index", "--skip-worktree", "skip.txt"]);
  await writeFile(join(desk, "work.txt"), "staged\n"); git(desk, ["add", "work.txt"]);
  await writeFile(join(desk, "work.txt"), "staged and unstaged\n");
  await writeFile(join(desk, "untracked.txt"), "untracked\n");
  await writeFile(join(desk, "intent.txt"), "intent\n"); git(desk, ["add", "-N", "intent.txt"]);
  await writeFile(join(desk, "cache.bin"), "ignored selected\n");
  if (!platformNeutral) await (symlink as unknown as (target: string, path: string, type: "file") => Promise<void>)("work.txt", join(desk, "untracked-link"), "file");

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
    ownerMember: "workplace://fixture/member/operator", line: "main", parentCheckpoint: null,
    sourceRoot: source, output: join(root, "checkpoint"),
    roots: [
      { ref: "workplace://fixture/root/shared", worktrees: [{ id: "shared-main", path: shared, logicalPath: options.siteLayout ? "product/main" : "roots/shared/main" }, { id: "shared-detached", path: detached, logicalPath: options.siteLayout ? "product/detached" : "roots/shared/detached" }] },
      { ref: "workplace://fixture/root/desk", worktrees: [{ id: "desk-main", path: desk, logicalPath: options.siteLayout ? "desk/main" : "roots/desk/main" }] },
      { ref: "workplace://fixture/root/site", worktrees: [{ id: "site-main", path: site, logicalPath: options.siteLayout ? "service/main" : "roots/site/main" }] },
    ],
    policy: { includeUntracked: true },
  };
  return { root, source, shared, detached, desk, site, request, includesSymlink: !platformNeutral };
}

export function evidence(path: string): string {
  return [
    git(path, ["show-ref", "--head"]),
    git(path, ["status", "--porcelain=v2", "--branch", "--untracked-files=all"]),
    git(path, ["diff", "--cached", "--binary", "--full-index"]),
    git(path, ["diff", "--binary", "--full-index"]),
    git(path, ["ls-files", "--stage"]),
    git(path, ["ls-files", "-v"]),
  ].join("\n---\n");
}
