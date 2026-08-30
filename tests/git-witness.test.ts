import { describe, expect, test } from "bun:test";
import { mkdir, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { checkWorkplaceMount, materializeMeeting, readyWorkplace } from "../src/compiler/index.ts";
import { checkGitHistory, checkGitStaged, gitGuardExecutable } from "../src/compiler/git-witness.ts";
import { applyNewWorkplace, loadStandardProfile, planNewWorkplace, type NewWorkplaceRequest } from "../src/compiler/new-workplace.ts";
import { validatePortableDeclaration } from "../src/compiler/portable-declarations.ts";
import { gitArguments } from "../src/platform.ts";

const repository = resolve(import.meta.dir, "..");
const cliCommand = [Bun.argv[0]!, resolve(repository, "src/cli.ts")];

function git(root: string, args: string[]): string {
  const result = Bun.spawnSync(["git", ...gitArguments(args)], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
  return new TextDecoder().decode(result.stdout).trim();
}

function request(target: string): NewWorkplaceRequest {
  return {
    kind: "NewWorkplaceRequest", version: 1, target,
    workplace: { id: "witness-studio", name: "Witness Studio" },
    member: { id: "alexis", name: "Alexis", language: "fr" },
    desk: { id: "alexis", name: "Alexis Desk", welcome: { tone: "Direct.", humor: "Light.", durableChanges: "Update WELCOME.md." } },
    providers: ["codex"],
    git: { initialize: true, commits: true, author: { name: "Witness Fixture", email: "witness@example.test" } },
  };
}

async function createWitness(target: string) {
  const profile = await loadStandardProfile(resolve(repository, "profiles/standard/profile.json"));
  const plan = planNewWorkplace(request(target), { profile, cliCommand });
  const created = await applyNewWorkplace(plan, plan.revision);
  return { plan, created, workplace: "workplace://witness-studio" };
}

async function stageMeeting(shared: string, workplace: string) {
  const room = `${workplace}/room/product`;
  const meeting = materializeMeeting({ workplace, meetingId: "20260825t140000z-build-1234abcd", owner: `${workplace}/member/alexis`, room, intent: "Build one bounded result", nextBoundary: "Verify the result." });
  const roomBytes = `---\nref: ${JSON.stringify(room)}\nentity: place\nroles: [room]\nslot: rooms\nowner: ${JSON.stringify(`${workplace}/member/alexis`)}\nscope: ${JSON.stringify(workplace)}\nlabel: Product\nsummary: Own bounded product work.\nwhen: [A product needs durable continuity.]\nrelations:\n  contains: [${JSON.stringify(meeting.ref)}]\n---\n\n# Product\n`;
  const roomPath = resolve(shared, "sources/rooms/product/ROOM.md");
  const meetingPath = resolve(shared, "sources", meeting.relativePath);
  await mkdir(resolve(roomPath, ".."), { recursive: true });
  await mkdir(resolve(meetingPath, ".."), { recursive: true });
  await writeFile(roomPath, roomBytes);
  await writeFile(meetingPath, meeting.bytes);
  git(shared, ["add", "sources"]);
  const message = `open-room(place:product): declare Room and Meeting\n\nMeeting: ${meeting.ref}\nAuthority: human-invoked\n`;
  return { meeting, roomBytes, roomPath, meetingPath, message };
}

describe("Git witness", () => {
  test("keeps portable declarations closed, bounded and separate from local bindings", () => {
    const root = resolve(tmpdir(), "declaration-fixture/workplace");
    const workplace = "workplace://fixture";
    const path = ".workplace/continuity.json";
    const continuity = { kind: "ContinuityDescriptor", version: 1, anchor: workplace, workplace, capture: "../../.endroit/capture.json", store: "../../.endroit/checkpoints", restoreTarget: "../../checkouts/sites", line: "main", policy: { remote: "none", requirement: "optional" } };
    const validate = (file: string, value: unknown) => validatePortableDeclaration(root, file, JSON.stringify(value), workplace);
    expect(validate(path, continuity)).toEqual([]);
    for (const field of ["capture", "store", "restoreTarget"]) expect(() => validate(path, { ...continuity, [field]: "../../../../outside" })).toThrow();
    expect(() => validate(path, { ...continuity, restoreTarget: "../../workplace" })).toThrow();
    expect(() => validate(path, { ...continuity, ignoredPaths: ["secret"] })).toThrow();
    expect(() => validate(path, { ...continuity, capture: "D:payload" })).toThrow();
    expect(() => validate(".workplace/unknown.json", continuity)).toThrow();
    expect(() => validate(path, { ...continuity, anchor: "workplace://other" })).toThrow();
    const target = { workplace: "workplace://peer", relation: "attachment", required: true, mount: { mode: "managed", path: "checkouts/workplaces/peer" }, source: "https://example.test/peer", entry: { kind: "EntryBinding", workplace: "workplace://peer", member: "workplace://peer/member/operator", desk: "workplace://peer/desk/operator", rootBindings: { shared: "workplace" } }, providers: [] };
    const setup = { kind: "WorkplaceSetupRequest", version: 1, anchor: workplace, targets: [target] };
    expect(validate(".workplace/setup.json", setup)).toEqual([]);
    expect(() => validate(".workplace/setup.json", { ...setup, targets: [{ ...target, source: "https://example.test/peer?token=secret" }] })).toThrow();
    expect(() => validate(".workplace/setup.json", { ...setup, targets: [{ ...target, source: "git@example.test:repo\nignored" }] })).toThrow();
    expect(() => validate(".workplace/setup.json", { ...setup, targets: [{ ...target, entry: { ...target.entry, rootBindings: { shared: "workplace", private: "../../outside" } } }] })).toThrow();
    expect(validate(".workplace/bootstrap/peer/setup.json", { ...setup, anchor: "workplace://peer", targets: [] })).toEqual([]);
    const recovery = { kind: "WorkplaceRecoveryRequest", version: 1, anchor: workplace, setup: "setup.json", sites: [], checkpoints: [], position: { workplace } };
    expect(() => validate(".workplace/recovery.json", { ...recovery, continuity: [{ workplace, descriptor: "continuity.json" }] })).toThrow();
    expect(() => validate(".workplace/recovery.json", { ...recovery, checkpoints: [{ id: "selected", workplace, checkpoint: "../../../../outside", target: "checkouts/sites", checkpointId: `checkpoint:sha256:${"1".repeat(64)}`, portableFingerprint: `sha256:${"2".repeat(64)}`, roots: [{ ref: `${workplace}/root/product`, worktrees: [{ id: "main", logicalPath: "product/main", site: "product", route: "main" }] }] }] })).toThrow();
  });

  test("treats Windows Git hooks as executable without POSIX mode bits", () => {
    expect(gitGuardExecutable(0o644, "win32")).toBe(true);
    expect(gitGuardExecutable(0o644, "linux")).toBe(false);
    expect(gitGuardExecutable(0o755, "linux")).toBe(true);
  });

  test("guards staged sources and projection commits through real Git hooks", async () => {
    const target = resolve(tmpdir(), `endroit-git-witness-${crypto.randomUUID()}`);
    await rm(target, { recursive: true, force: true });
    try {
      const { plan, created, workplace } = await createWitness(target);
      expect(plan.gitGuards.hooks).toHaveLength(2);
      for (const root of [created.roots.shared]) for (const name of ["pre-commit", "commit-msg"]) {
        const hook = await readFile(resolve(root, `.git/hooks/${name}`), "utf8");
        expect(hook).toContain("endroit-git-guard:v1");
        expect(hook).toContain("check");
        expect(hook).toContain("--staged");
      }

      const { meeting, roomBytes, roomPath, meetingPath, message } = await stageMeeting(created.roots.shared, workplace);
      const providerPath = resolve(target, ".endroit/providers/codex.json");
      const provider = await readFile(providerPath, "utf8");
      await writeFile(providerPath, "{\n");
      expect((await checkGitStaged({ start: created.roots.shared, commitMessage: message })).diagnostics.some((item) => item.code === "staged-graph-invalid")).toBe(true);
      await writeFile(providerPath, provider);
      expect((await checkGitStaged({ start: created.roots.shared, commitMessage: message })).status).toBe("valid");

      await writeFile(meetingPath, meeting.bytes.replace("intent:", "unknown: forbidden\nintent:"));
      git(created.roots.shared, ["add", "sources"]);
      expect((await checkGitStaged({ start: created.roots.shared })).diagnostics.some((item) => item.code === "staged-source-invalid")).toBe(true);
      await writeFile(meetingPath, meeting.bytes);
      git(created.roots.shared, ["add", "sources"]);

      await writeFile(roomPath, `${roomBytes}\nUnstaged note.\n`);
      expect((await checkGitStaged({ start: created.roots.shared })).diagnostics.some((item) => item.code === "staged-partial-file")).toBe(true);
      await writeFile(roomPath, roomBytes);
      git(created.roots.shared, ["-c", "user.name=Witness Fixture", "-c", "user.email=witness@example.test", "commit", "-m", message]);
      expect((await checkGitHistory(created.roots.shared, target)).status).toBe("valid");

      await writeFile(resolve(created.roots.shared, "links.json"), `${JSON.stringify({
        kind: "WorkplaceLinks", version: 1, workplace,
        links: [{ target: "workplace://peer" }],
      }, null, 2)}\n`);
      git(created.roots.shared, ["add", "links.json"]);
      const linkMessage = `work(workplace:federation): declare portable Workplace Link\n\nMeeting: ${meeting.ref}\nAuthority: human-invoked\n`;
      expect((await checkGitStaged({ start: created.roots.shared, commitMessage: linkMessage })).status).toBe("valid");
      git(created.roots.shared, ["-c", "user.name=Witness Fixture", "-c", "user.email=witness@example.test", "commit", "-m", linkMessage]);

      const sourceOid = git(created.roots.shared, ["rev-parse", "HEAD"]);
      const ready = await readyWorkplace({ start: target });
      expect(ready.check.operationStatus).toBe("ready");
      git(created.roots.shared, ["add", "WORKPLACE.md", ".workplace"]);
      const compile = `compile(workplace:witness-studio): project portable control plane\n\nMeeting: ${meeting.ref}\nAuthority: projection\nBuild: ${sourceOid}\n`;
      expect((await checkGitStaged({ start: created.roots.shared, commitMessage: compile })).status).toBe("valid");
      git(created.roots.shared, ["-c", "user.name=Witness Fixture", "-c", "user.email=witness@example.test", "commit", "-m", compile]);
    } finally {
      await rm(target, { recursive: true, force: true });
    }
  });

  test("guards portable declaration closure without changing semantic revisions", async () => {
    const target = resolve(tmpdir(), `endroit-git-witness-${crypto.randomUUID()}`);
    try {
      const { created, workplace } = await createWitness(target);
      const { meeting, message } = await stageMeeting(created.roots.shared, workplace);
      git(created.roots.shared, ["-c", "user.name=Witness Fixture", "-c", "user.email=witness@example.test", "commit", "-m", message]);
      const sourceOid = git(created.roots.shared, ["rev-parse", "HEAD"]);
      expect((await readyWorkplace({ start: target })).check.operationStatus).toBe("ready");
      git(created.roots.shared, ["add", "WORKPLACE.md", ".workplace"]);
      git(created.roots.shared, ["-c", "user.name=Witness Fixture", "-c", "user.email=witness@example.test", "commit", "-m", `compile(workplace:witness-studio): project portable control plane\n\nMeeting: ${meeting.ref}\nAuthority: projection\nBuild: ${sourceOid}\n`]);
      const mapPath = resolve(created.roots.shared, ".workplace/workplace-map.json");
      const semanticRevision = JSON.parse(await readFile(mapPath, "utf8")).sourceRevision;
      const setupPath = resolve(created.roots.shared, ".workplace/setup.json");
      const recoveryPath = resolve(created.roots.shared, ".workplace/recovery.json");
      const setup = { kind: "WorkplaceSetupRequest", version: 1, anchor: workplace, targets: [] };
      const recovery = { kind: "WorkplaceRecoveryRequest", version: 1, anchor: workplace, setup: "setup.json", sites: [], checkpoints: [], position: { workplace } };
      await writeFile(setupPath, `${JSON.stringify(setup)}\n`);
      await writeFile(recoveryPath, `${JSON.stringify(recovery)}\n`);
      await writeFile(resolve(created.roots.shared, ".gitattributes"), `${await readFile(resolve(created.roots.shared, ".gitattributes"), "utf8")}# Portable text policy.\n`);
      git(created.roots.shared, ["add", ".gitattributes", ".workplace/setup.json", ".workplace/recovery.json"]);
      const declarationMessage = `work(workplace:recovery): declare portable recovery\n\nMeeting: ${meeting.ref}\nAuthority: human-invoked\n`;
      expect((await checkGitStaged({ start: created.roots.shared, commitMessage: declarationMessage })).diagnostics).toEqual([]);
      await writeFile(recoveryPath, `${JSON.stringify({ ...recovery, unknown: true })}\n`);
      git(created.roots.shared, ["add", ".workplace/recovery.json"]);
      expect((await checkGitStaged({ start: created.roots.shared })).diagnostics.some((item) => item.code === "portable-declaration-invalid")).toBe(true);
      expect((await checkWorkplaceMount({ mount: target })).operationStatus).toBe("degraded");
      const hookBeforeInvalidReady = await readFile(resolve(created.roots.shared, ".git/hooks/pre-commit"), "utf8");
      expect((await readyWorkplace({ start: target })).changed).toBe(false);
      expect(await readFile(resolve(created.roots.shared, ".git/hooks/pre-commit"), "utf8")).toBe(hookBeforeInvalidReady);
      expect(JSON.parse(await readFile(mapPath, "utf8")).sourceRevision).toBe(semanticRevision);
      await writeFile(recoveryPath, `${JSON.stringify(recovery)}\n`);
      git(created.roots.shared, ["add", ".workplace/recovery.json"]);
      const dependencyPath = ".workplace/bootstrap/witness-studio/setup.json";
      await mkdir(resolve(created.roots.shared, dependencyPath, ".."), { recursive: true });
      await writeFile(resolve(created.roots.shared, dependencyPath), `${JSON.stringify(setup)}\n`);
      await writeFile(recoveryPath, `${JSON.stringify({ ...recovery, setup: "bootstrap/witness-studio/setup.json" })}\n`);
      git(created.roots.shared, ["add", ".workplace/recovery.json"]);
      expect((await checkGitStaged({ start: created.roots.shared })).diagnostics.some((item) => item.code === "portable-declaration-invalid")).toBe(true);
      git(created.roots.shared, ["add", dependencyPath]);
      expect((await checkGitStaged({ start: created.roots.shared })).status).toBe("valid");
      const indexedBlob = git(created.roots.shared, ["rev-parse", `:${dependencyPath}`]);
      git(created.roots.shared, ["update-index", "--cacheinfo", `120000,${indexedBlob},${dependencyPath}`]);
      expect((await checkGitStaged({ start: created.roots.shared })).diagnostics.some((item) => item.code === "portable-declaration-invalid")).toBe(true);
      git(created.roots.shared, ["add", dependencyPath]);
      const outside = resolve(target, "outside");
      await mkdir(outside, { recursive: true });
      await writeFile(resolve(outside, "setup.json"), `${JSON.stringify(setup)}\n`);
      await rm(resolve(created.roots.shared, dependencyPath, ".."), { recursive: true, force: true });
      await symlink(outside, resolve(created.roots.shared, dependencyPath, ".."), process.platform === "win32" ? "junction" : "dir");
      expect((await checkWorkplaceMount({ mount: target })).diagnostics.some((item) => item.code === "portable-declaration-invalid")).toBe(true);
      await unlink(resolve(created.roots.shared, dependencyPath, ".."));
      expect(await readFile(resolve(outside, "setup.json"), "utf8")).toBe(`${JSON.stringify(setup)}\n`);
      await mkdir(resolve(created.roots.shared, dependencyPath, ".."), { recursive: true });
      await writeFile(resolve(created.roots.shared, dependencyPath), `${JSON.stringify({ ...setup, anchor: "workplace://wrong" })}\n`);
      git(created.roots.shared, ["add", dependencyPath]);
      expect((await checkGitStaged({ start: created.roots.shared })).diagnostics.some((item) => item.code === "portable-declaration-invalid")).toBe(true);
      git(created.roots.shared, ["rm", "--cached", dependencyPath]);
      await rm(resolve(created.roots.shared, dependencyPath), { recursive: false, force: false });
      await writeFile(recoveryPath, `${JSON.stringify(recovery)}\n`);
      git(created.roots.shared, ["add", ".workplace/recovery.json"]);
      await writeFile(resolve(created.roots.shared, ".workplace/unknown.json"), "{}\n");
      git(created.roots.shared, ["add", ".workplace/unknown.json"]);
      expect((await checkGitStaged({ start: created.roots.shared })).diagnostics.some((item) => item.code === "staged-projection-not-compiler-owned")).toBe(true);
      git(created.roots.shared, ["rm", "--cached", ".workplace/unknown.json"]);
      await rm(resolve(created.roots.shared, ".workplace/unknown.json"), { recursive: false, force: false });
      git(created.roots.shared, ["-c", "user.name=Witness Fixture", "-c", "user.email=witness@example.test", "commit", "-m", declarationMessage]);
      expect((await readyWorkplace({ start: target })).changed).toBe(false);
      expect(JSON.parse(await readFile(mapPath, "utf8")).sourceRevision).toBe(semanticRevision);
      for (const digit of ["1", "2"]) {
        await writeFile(recoveryPath, `${JSON.stringify({ ...recovery, checkpoints: [{ id: "selected", workplace, checkpoint: `../../.endroit/checkpoints/${digit.repeat(64)}`, target: "checkouts/sites", checkpointId: `checkpoint:sha256:${digit.repeat(64)}`, portableFingerprint: `sha256:${"3".repeat(64)}`, roots: [{ ref: `${workplace}/root/product`, worktrees: [{ id: "product-main", logicalPath: "product/main", site: "product", route: "main" }] }] }] })}\n`);
        expect((await readyWorkplace({ start: target })).changed).toBe(false);
        expect(JSON.parse(await readFile(mapPath, "utf8")).sourceRevision).toBe(semanticRevision);
      }
      await writeFile(recoveryPath, `${JSON.stringify(recovery)}\n`);
    } finally {
      await rm(target, { recursive: true, force: true });
    }
  });

  test("repairs only owned hooks and rejects a bypassed dangling Meeting in history", async () => {
    const target = resolve(tmpdir(), `endroit-git-witness-${crypto.randomUUID()}`);
    try {
      const { plan, created, workplace } = await createWitness(target);
      await rm(resolve(created.roots.shared, ".git/hooks/pre-commit"), { force: true, recursive: false });
      expect((await checkWorkplaceMount({ mount: target })).operationStatus).toBe("degraded");
      expect((await readyWorkplace({ start: target })).check.operationStatus).toBe("ready");

      const preCommit = resolve(created.roots.shared, ".git/hooks/pre-commit");
      await writeFile(preCommit, "#!/bin/sh\nexit 0\n");
      let collision = "";
      try { await readyWorkplace({ start: target }); }
      catch (error) { collision = error instanceof Error ? error.message : String(error); }
      expect(collision).toContain("foreign Git hook collision");
      expect(await readFile(preCommit, "utf8")).toBe("#!/bin/sh\nexit 0\n");
      await writeFile(preCommit, plan.gitGuards.hooks.find((hook) => hook.root === "shared" && hook.name === "pre-commit")!.content);

      const doctrine = resolve(created.roots.shared, "sources/DOCTRINE.md");
      await writeFile(doctrine, `${await readFile(doctrine, "utf8")}\nBounded observation.\n`);
      git(created.roots.shared, ["add", "sources/DOCTRINE.md"]);
      const orphan = `work(material:doctrine): record bounded observation\n\nMeeting: ${workplace}/meeting/missing\nAuthority: human-invoked\n`;
      git(created.roots.shared, ["-c", "user.name=Witness Fixture", "-c", "user.email=witness@example.test", "commit", "--no-verify", "-m", orphan]);
      const history = await checkGitHistory(created.roots.shared, target);
      expect(history.status).toBe("invalid");
      expect(history.diagnostics.some((item) => item.message.includes("orphan"))).toBe(true);
      const blocked = await readyWorkplace({ start: target });
      expect(blocked.changed).toBe(false);
      expect(blocked.check.operationStatus).toBe("degraded");
    } finally {
      await rm(target, { recursive: true, force: true });
    }
  });
});
