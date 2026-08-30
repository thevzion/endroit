import { describe, expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { checkWorkplaceMount, materializeMeeting, readyWorkplace } from "../src/compiler/index.ts";
import { checkGitHistory, checkGitStaged, gitGuardExecutable } from "../src/compiler/git-witness.ts";
import { applyNewWorkplace, loadStandardProfile, planNewWorkplace, type NewWorkplaceRequest } from "../src/compiler/new-workplace.ts";

const repository = resolve(import.meta.dir, "..");
const cliCommand = [Bun.argv[0]!, resolve(repository, "src/cli.ts")];

function git(root: string, args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
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

describe("Git witness", () => {
  test("treats Windows Git hooks as executable without POSIX mode bits", () => {
    expect(gitGuardExecutable(0o644, "win32")).toBe(true);
    expect(gitGuardExecutable(0o644, "linux")).toBe(false);
    expect(gitGuardExecutable(0o755, "linux")).toBe(true);
  });

  test("guards staged bytes and finds a bypassed dangling Meeting in history", async () => {
    const target = resolve(tmpdir(), `endroit-git-witness-${crypto.randomUUID()}`);
    await rm(target, { recursive: true, force: true });
    try {
      const profile = await loadStandardProfile(resolve(repository, "profiles/standard/profile.json"));
      const plan = planNewWorkplace(request(target), { profile, cliCommand });
      expect(plan.gitGuards.hooks).toHaveLength(2);
      const created = await applyNewWorkplace(plan, plan.revision);
      for (const root of [created.roots.shared]) for (const name of ["pre-commit", "commit-msg"]) {
        const hook = await readFile(resolve(root, `.git/hooks/${name}`), "utf8");
        expect(hook).toContain("endroit-git-guard:v1");
        expect(hook).toContain("check");
        expect(hook).toContain("--staged");
      }

      const workplace = "workplace://witness-studio";
      const room = `${workplace}/room/product`;
      const meeting = materializeMeeting({ workplace, meetingId: "20260825t140000z-build-1234abcd", owner: `${workplace}/member/alexis`, room, intent: "Build one bounded result", nextBoundary: "Verify the result." });
      const roomBytes = `---\nref: ${JSON.stringify(room)}\nentity: place\nroles: [room]\nslot: rooms\nowner: ${JSON.stringify(`${workplace}/member/alexis`)}\nscope: ${JSON.stringify(workplace)}\nlabel: Product\nsummary: Own bounded product work.\nwhen: [A product needs durable continuity.]\nrelations:\n  contains: [${JSON.stringify(meeting.ref)}]\n---\n\n# Product\n`;
      const roomPath = resolve(created.roots.shared, "sources/rooms/product/ROOM.md");
      const meetingPath = resolve(created.roots.shared, "sources", meeting.relativePath);
      await mkdir(resolve(roomPath, ".."), { recursive: true });
      await mkdir(resolve(meetingPath, ".."), { recursive: true });
      await writeFile(roomPath, roomBytes);
      await writeFile(meetingPath, meeting.bytes);
      git(created.roots.shared, ["add", "sources"]);
      const message = `open-room(place:product): declare Room and Meeting\n\nMeeting: ${meeting.ref}\nAuthority: human-invoked\n`;
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
