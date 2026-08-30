import { describe, expect, test } from "bun:test";
import { lstat, mkdir, readFile, realpath, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { gitArguments } from "../src/platform.ts";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { applySiteRouteSetup, planSiteRouteSetup, SiteRouteSetupError, type SiteRouteSetupRequest } from "../src/site-setup.ts";

const cli = [Bun.argv[0]!, resolve(import.meta.dir, "../src/cli.ts")];

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
  try { await effect(); return "none"; }
  catch (error) { return error instanceof SiteRouteSetupError ? error.code : error instanceof Error ? error.message : String(error); }
}

async function fixture() {
  const root = resolve(tmpdir(), `endroit-site-setup-${crypto.randomUUID()}`);
  const source = join(root, "source");
  const remote = join(root, "remotes/product.git");
  const workplaceMount = join(root, "workplace-mount");
  const requestDirectory = join(root, "requests");
  await mkdir(source, { recursive: true });
  git(source, ["init", "-q", "-b", "develop"]);
  git(source, ["config", "user.name", "Site Fixture"]);
  git(source, ["config", "user.email", "fixture@example.test"]);
  await writeFile(join(source, "product.txt"), "clean product\n");
  git(source, ["add", "."]);
  git(source, ["commit", "-qm", "product base"]);
  const commit = git(source, ["rev-parse", "HEAD"]);
  await mkdir(dirname(remote), { recursive: true });
  git(root, ["clone", "-q", "--bare", "--", source, remote]);
  await mkdir(join(workplaceMount, "workplace"), { recursive: true });
  await writeFile(join(workplaceMount, "workplace/workplace.json"), `${JSON.stringify({ kind: "WorkplaceBuildContract", version: 2, workplace: "workplace://fixture" }, null, 2)}\n`);
  await mkdir(requestDirectory, { recursive: true });
  const request: SiteRouteSetupRequest = {
    kind: "SiteRouteSetupRequest",
    version: 1,
    workplace: "workplace://fixture",
    sites: [{
      id: "product",
      productRemote: { kind: "ProductRemote", locator: relative(requestDirectory, remote) },
      routes: [
        { id: "develop", revision: { kind: "branch", name: "develop" } },
        { id: "pinned", revision: { kind: "commit", sha: commit } },
      ],
    }],
  };
  return { root, remote, workplaceMount, requestDirectory, request, commit };
}

describe("portable Site and Route setup", () => {
  test("previews without Git or writes, clones exact branch and commit, then replays unchanged", async () => {
    const state = await fixture();
    try {
      const family = join(state.workplaceMount, "checkouts/sites");
      const previousPath = process.env.PATH;
      process.env.PATH = "/endroit-site-preview-has-no-tools";
      let preview;
      try { preview = await planSiteRouteSetup(state.request, { workplaceMount: state.workplaceMount, requestDirectory: state.requestDirectory }); }
      finally { process.env.PATH = previousPath; }
      expect(preview.sites[0]?.routes.map((route) => route.action)).toEqual(["materialize", "materialize"]);
      expect(await exists(family)).toBe(false);

      expect(await errorCode(() => applySiteRouteSetup(preview, `sha256:${"0".repeat(64)}`))).toBe("site-route-digest-mismatch");
      expect(await exists(family)).toBe(false);

      const receipt = await applySiteRouteSetup(preview, preview.revision);
      expect(receipt.status).toBe("ready");
      expect(receipt.sites[0]?.routes.map((route) => route.status)).toEqual(["cloned", "cloned"]);
      const branchPath = join(family, "product/develop");
      const pinnedPath = join(family, "product/pinned");
      expect(git(branchPath, ["status", "--porcelain"])).toBe("");
      expect(git(branchPath, ["symbolic-ref", "--short", "HEAD"])).toBe("develop");
      expect(git(branchPath, ["remote", "get-url", "origin"])).toBe(state.remote);
      expect(git(pinnedPath, ["rev-parse", "HEAD"])).toBe(state.commit);
      expect(Bun.spawnSync(["git", "symbolic-ref", "--quiet", "HEAD"], { cwd: pinnedPath, stdout: "pipe", stderr: "pipe" }).exitCode).not.toBe(0);

      const replay = await planSiteRouteSetup(state.request, { workplaceMount: state.workplaceMount, requestDirectory: state.requestDirectory });
      expect(replay.sites[0]?.routes.every((route) => route.action === "verify")).toBe(true);
      const unchanged = await applySiteRouteSetup(replay, replay.revision);
      expect(unchanged.sites[0]?.routes.every((route) => route.status === "unchanged")).toBe(true);

      const outsideGit = join(state.root, "outside-git");
      await rename(join(branchPath, ".git"), outsideGit);
      await symlink(outsideGit, join(branchPath, ".git"), process.platform === "win32" ? "junction" : "dir");
      const unsafeReplay = await planSiteRouteSetup(state.request, { workplaceMount: state.workplaceMount, requestDirectory: state.requestDirectory });
      expect(await errorCode(() => applySiteRouteSetup(unsafeReplay, unsafeReplay.revision))).toBe("site-route-collision");
    } finally {
      await rm(state.root, { recursive: true, force: true });
    }
  });

  test("materializes direct, linked worktree and external-link at stable Route addresses", async () => {
    const state = await fixture();
    try {
      const external = join(state.root, "external-checkout");
      git(state.root, ["clone", "-q", "--branch", "develop", "--", state.remote, external]);
      const site = state.request.sites[0]!;
      const request: SiteRouteSetupRequest = {
        ...state.request,
        sites: [{ ...site, routes: [
          { id: "base", revision: { kind: "branch", name: "develop" }, physical: { kind: "direct" } },
          { id: "linked", revision: { kind: "commit", sha: state.commit }, physical: { kind: "worktree", sourceRoute: "base" } },
          { id: "external", revision: { kind: "branch", name: "develop" }, physical: { kind: "external-link", target: relative(state.requestDirectory, external) } },
        ] }],
      };
      const plan = await planSiteRouteSetup(request, { workplaceMount: state.workplaceMount, requestDirectory: state.requestDirectory });
      const receipt = await applySiteRouteSetup(plan, plan.revision);
      const routes = new Map(receipt.sites[0]!.routes.map((route) => [route.id, route]));
      expect(routes.get("base")?.binding.kind).toBe("managed");
      expect(routes.get("linked")?.binding.kind).toBe("worktree");
      expect(routes.get("external")?.binding.kind).toBe("external-link");
      expect(routes.get("linked")?.binding.commonGitDir).toBe(routes.get("base")?.binding.commonGitDir);
      expect(routes.get("external")?.binding.realpath).toBe(await realpath(external));
      expect(routes.get("external")?.path).toBe(join(state.workplaceMount, "checkouts/sites/product/external"));
      expect((await lstat(routes.get("external")!.path)).isSymbolicLink()).toBe(true);
      const registry = JSON.parse(await readFile(join(state.workplaceMount, ".endroit/site-route-bindings.json"), "utf8")) as { bindings: Array<{ site: string; route: string; binding: { kind: string } }> };
      expect(registry.bindings.map((record) => `${record.site}/${record.route}:${record.binding.kind}`)).toEqual(["product/base:managed", "product/external:external-link", "product/linked:worktree"]);
      const replay = await planSiteRouteSetup(request, { workplaceMount: state.workplaceMount, requestDirectory: state.requestDirectory });
      expect((await applySiteRouteSetup(replay, replay.revision)).sites[0]?.routes.every((route) => route.status === "unchanged")).toBe(true);
      const detached = JSON.parse(run(state.workplaceMount, [...cli, "site", "route", "detach", "product", "external", "--json"])) as { status: string; binding: { kind: string } };
      expect(detached.status).toBe("detached");
      expect(detached.binding.kind).toBe("external-link");
      expect(await exists(routes.get("external")!.path)).toBe(false);
      expect(await readFile(join(external, "product.txt"), "utf8")).toBe("clean product\n");
      const afterDetach = JSON.parse(await readFile(join(state.workplaceMount, ".endroit/site-route-bindings.json"), "utf8")) as { bindings: Array<{ route: string }> };
      expect(afterDetach.bindings.some((record) => record.route === "external")).toBe(false);
    } finally { await rm(state.root, { recursive: true, force: true }); }

    const failed = await fixture();
    try {
      const external = join(failed.root, "external-checkout");
      git(failed.root, ["clone", "-q", "--branch", "develop", "--", failed.remote, external]);
      const site = failed.request.sites[0]!;
      const request: SiteRouteSetupRequest = {
        ...failed.request,
        sites: [{ ...site, routes: [
          { id: "base", revision: { kind: "branch", name: "develop" }, physical: { kind: "direct" } },
          { id: "external", revision: { kind: "branch", name: "develop" }, physical: { kind: "external-link", target: relative(failed.requestDirectory, external) } },
          { id: "z-missing", revision: { kind: "commit", sha: "f".repeat(40) }, physical: { kind: "direct" } },
        ] }],
      };
      const plan = await planSiteRouteSetup(request, { workplaceMount: failed.workplaceMount, requestDirectory: failed.requestDirectory });
      expect(await errorCode(() => applySiteRouteSetup(plan, plan.revision))).toBe("site-route-unavailable");
      expect(await exists(join(failed.workplaceMount, "checkouts/sites/product/external"))).toBe(false);
      expect(await readFile(join(external, "product.txt"), "utf8")).toBe("clean product\n");
    } finally { await rm(failed.root, { recursive: true, force: true }); }
  });

  test("rejects ContinuityRemote, embedded credentials, unknown fields and reserved ids", async () => {
    const state = await fixture();
    try {
      const site = state.request.sites[0]!;
      const invalid = [
        { ...state.request, sites: [{ ...site, productRemote: { kind: "ContinuityRemote", locator: "../remotes/checkpoints.git" } }] },
        { ...state.request, sites: [{ ...site, productRemote: { kind: "ProductRemote", locator: "https://token@example.test/product.git" } }] },
        { ...state.request, sites: [{ ...site, unexpected: true }] },
        { ...state.request, sites: [{ ...site, id: "workplaces" }] },
      ];
      for (const request of invalid) expect(await errorCode(() => planSiteRouteSetup(request, { workplaceMount: state.workplaceMount, requestDirectory: state.requestDirectory }))).toBe("invalid-site-route-request");
      expect(await exists(join(state.workplaceMount, "checkouts"))).toBe(false);
    } finally {
      await rm(state.root, { recursive: true, force: true });
    }
  });

  test("fails closed on a symlinked family and preserves an existing collision", async () => {
    const state = await fixture();
    try {
      const outside = join(state.root, "outside");
      await mkdir(outside, { recursive: true });
      await writeFile(join(outside, "keep.txt"), "external target stays intact\n");
      await symlink(outside, join(state.workplaceMount, "checkouts"), process.platform === "win32" ? "junction" : "dir");
      expect(await errorCode(() => planSiteRouteSetup(state.request, { workplaceMount: state.workplaceMount, requestDirectory: state.requestDirectory }))).toBe("site-route-collision");
      expect(await exists(join(outside, "sites"))).toBe(false);
      await unlink(join(state.workplaceMount, "checkouts"));
      expect(await readFile(join(outside, "keep.txt"), "utf8")).toBe("external target stays intact\n");

      const collision = join(state.workplaceMount, "checkouts/sites/product/develop");
      await mkdir(collision, { recursive: true });
      await writeFile(join(collision, "marker.txt"), "pre-existing\n");
      const preview = await planSiteRouteSetup(state.request, { workplaceMount: state.workplaceMount, requestDirectory: state.requestDirectory });
      expect(preview.sites[0]?.routes[0]?.action).toBe("verify");
      expect(await errorCode(() => applySiteRouteSetup(preview, preview.revision))).toBe("site-route-collision");
      expect(await readFile(join(collision, "marker.txt"), "utf8")).toBe("pre-existing\n");
      expect(await exists(join(state.workplaceMount, "checkouts/sites/product/pinned"))).toBe(false);
    } finally {
      await rm(state.root, { recursive: true, force: true });
    }
  });

  test("supports an internal staging family and rolls back only routes created by a failed apply", async () => {
    const staged = await fixture();
    try {
      const preview = await planSiteRouteSetup(staged.request, { workplaceMount: staged.workplaceMount, requestDirectory: staged.requestDirectory });
      const targetFamily = join(staged.workplaceMount, ".endroit/recovery-sites");
      const receipt = await applySiteRouteSetup(preview, preview.revision, { targetFamily });
      expect(receipt.family).toBe(targetFamily);
      expect(receipt.sites[0]?.routes.every((route) => route.status === "cloned")).toBe(true);
      expect(await realpath(join(targetFamily, "product/develop"))).toBe(join(await realpath(staged.workplaceMount), ".endroit/recovery-sites/product/develop"));
      expect(await exists(join(staged.workplaceMount, "checkouts/sites"))).toBe(false);
    } finally {
      await rm(staged.root, { recursive: true, force: true });
    }

    const failed = await fixture();
    try {
      const site = failed.request.sites[0]!;
      const request: SiteRouteSetupRequest = {
        ...failed.request,
        sites: [{ ...site, routes: [site.routes[0]!, { id: "missing", revision: { kind: "commit", sha: "f".repeat(40) } }] }],
      };
      const preview = await planSiteRouteSetup(request, { workplaceMount: failed.workplaceMount, requestDirectory: failed.requestDirectory });
      expect(await errorCode(() => applySiteRouteSetup(preview, preview.revision))).toBe("site-route-unavailable");
      expect(await exists(join(failed.workplaceMount, "checkouts/sites/product/develop"))).toBe(false);
      expect(await exists(join(failed.workplaceMount, "checkouts/sites/product/missing"))).toBe(false);
      expect(await exists(join(failed.workplaceMount, "checkouts"))).toBe(false);
    } finally {
      await rm(failed.root, { recursive: true, force: true });
    }
  });

  test("plans an explicitly absent required Workplace Mount and revalidates its identity before apply", async () => {
    const state = await fixture();
    try {
      const futureMount = join(state.root, "future-workplace");
      expect(await errorCode(() => planSiteRouteSetup(state.request, { workplaceMount: futureMount, requestDirectory: state.requestDirectory }))).toBe("site-route-unavailable");
      const preview = await planSiteRouteSetup(state.request, { workplaceMount: futureMount, requestDirectory: state.requestDirectory, allowAbsentMount: true });
      expect(preview.sites[0]?.routes.every((route) => route.action === "materialize")).toBe(true);
      expect(await exists(futureMount)).toBe(false);

      await mkdir(join(futureMount, "workplace"), { recursive: true });
      await writeFile(join(futureMount, "workplace/workplace.json"), `${JSON.stringify({ workplace: "workplace://fixture" }, null, 2)}\n`);
      expect(await errorCode(() => applySiteRouteSetup(preview, preview.revision))).toBe("site-route-unavailable");
      expect(await exists(join(futureMount, "checkouts"))).toBe(false);

      await writeFile(join(futureMount, "workplace/workplace.json"), `${JSON.stringify({ kind: "WorkplaceBuildContract", version: 2, workplace: "workplace://other" }, null, 2)}\n`);
      expect(await errorCode(() => applySiteRouteSetup(preview, preview.revision))).toBe("invalid-site-route-request");
      expect(await exists(join(futureMount, "checkouts"))).toBe(false);

      await writeFile(join(futureMount, "workplace/workplace.json"), `${JSON.stringify({ kind: "WorkplaceBuildContract", version: 2, workplace: "workplace://fixture" }, null, 2)}\n`);
      const receipt = await applySiteRouteSetup(preview, preview.revision);
      expect(receipt.status).toBe("ready");
      expect(receipt.sites[0]?.routes.every((route) => route.status === "cloned")).toBe(true);
    } finally {
      await rm(state.root, { recursive: true, force: true });
    }
  });
});
