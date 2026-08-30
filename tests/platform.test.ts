import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitArguments, gitTransportArguments } from "../src/platform.ts";

test("Git long-path configuration is process-local and explicitly reaches only local transports", async () => {
  expect(gitArguments(["status"], "linux")).toEqual(["status"]);
  expect(gitArguments(["status"], "darwin")).toEqual(["status"]);
  expect(gitArguments(["status"], "win32")).toEqual(["-c", "core.longpaths=true", "status"]);
  expect(gitTransportArguments("push", "https://example.test/product.git", "win32")).toEqual([]);
  expect(gitTransportArguments("fetch", "git@example.test:product.git", "win32")).toEqual([]);
  expect(gitTransportArguments("push", "/local/product.git", "linux")).toEqual([]);
  const root = await mkdtemp(join(tmpdir(), "endroit-git-platform-"));
  const git = (cwd: string, args: string[]) => {
    const result = spawnSync("git", gitArguments(args, "win32"), { cwd });
    if (result.status !== 0) throw new Error(new TextDecoder().decode(result.stderr));
    return new TextDecoder().decode(result.stdout).trim();
  };
  try {
    const source = join(root, "source"); const remote = join(root, "remote.git");
    await mkdir(source, { recursive: true });
    git(source, ["init", "-q", "-b", "develop"]);
    git(source, ["-c", "user.name=Synthetic Operator", "-c", "user.email=operator@example.test", "commit", "-qm", "fixture", "--allow-empty"]);
    git(root, ["init", "-q", "--bare", remote]);
    const hook = join(remote, "hooks/pre-receive");
    await writeFile(hook, '#!/bin/sh\ntest "$(git config --get core.longpaths)" = true || exit 93\n');
    await chmod(hook, 0o755);
    const before = [await readFile(join(source, ".git/config"), "utf8"), await readFile(join(remote, "config"), "utf8")];
    const ref = `refs/endroit/checkpoints/owners/${"a".repeat(64)}/lines/main/checkpoints/${"b".repeat(64)}`;
    git(source, ["push", ...gitTransportArguments("push", remote, "win32"), "-q", remote, `HEAD:${ref}`]);
    expect(git(root, ["--git-dir", remote, "rev-parse", ref])).toBe(git(source, ["rev-parse", "HEAD"]));
    expect(git(source, ["ls-remote", ...gitTransportArguments("ls-remote", remote, "win32"), remote, ref])).toContain(ref);
    expect([await readFile(join(source, ".git/config"), "utf8"), await readFile(join(remote, "config"), "utf8")]).toEqual(before);
  } finally { await rm(root, { recursive: true, force: true }); }
});
