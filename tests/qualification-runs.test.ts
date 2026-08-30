import { describe, expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { firstPathDivergence, createQualificationRun, snapshotQualificationRun, verdictQualificationRun } from "../src/qualification/runs.ts";
import { outsideInstructionPaths, trajectoryFromCodexEvents } from "../src/qualification/case-run.ts";

const repository = resolve(import.meta.dir, "..");

describe("immutable qualification runs", () => {
  test("extracts a nested Manager and Worker dispatch graph without retaining prompts", () => {
    const meetingRef = "workplace://viral/meeting/20260826t200000z-game-1234abcd";
    const mount = resolve(tmpdir(), "endroit-qualification-mount");
    const outside = resolve(tmpdir(), "endroit-qualification-outside/RTK.md");
    const globalSkill = resolve(tmpdir(), "endroit-qualification-outside/skills/testing/SKILL.md");
    const trajectory = trajectoryFromCodexEvents(mount, [
      { type: "thread.started", thread_id: "main" },
      { type: "item.completed", item: { type: "collab_tool_call", tool: "spawn_agent", status: "completed", sender_thread_id: "main", receiver_thread_ids: ["manager"], prompt: `Position Hall. Meeting ${meetingRef}.` } },
      { type: "item.completed", item: { type: "command_execution", command: "bun inspect z-last.md a-first.md", status: "completed" } },
      { type: "item.completed", item: { type: "command_execution", command: "bun inspect AGENTS.md", status: "completed" } },
      { type: "item.completed", item: { type: "collab_tool_call", tool: "spawn_agent", status: "completed", sender_thread_id: "manager", receiver_thread_ids: ["worker"], prompt: `Position Site. Meeting ${meetingRef}.` } },
      { type: "item.completed", item: { type: "file_change", sender_thread_id: "worker", changes: [{ path: resolve(mount, "checkouts/sites/game/index.html"), kind: "add" }] } },
      { type: "item.completed", item: { type: "collab_tool_call", tool: "wait", status: "completed", sender_thread_id: "manager", receiver_thread_ids: ["worker"], agents_states: { worker: { status: "completed" } } } },
      { type: "item.completed", item: { type: "collab_tool_call", tool: "wait", status: "completed", sender_thread_id: "main", receiver_thread_ids: ["manager"], agents_states: { manager: { status: "completed" } } } },
    ]);
    expect(trajectory.dispatches.map((item) => `${item.role}:${item.action}`)).toEqual(["manager:spawn", "worker:spawn", "worker:complete", "manager:complete"]);
    expect(trajectory.dispatches.every((item) => item.meetingRef === meetingRef)).toBe(true);
    expect(trajectory.reads).toContain("AGENTS.md");
    expect(trajectory.reads).not.toContain("bun");
    expect(trajectory.reads.indexOf("z-last.md") < trajectory.reads.indexOf("a-first.md")).toBe(true);
    expect(trajectory.effects.some((item) => item.root === "site" && item.kind === "write")).toBe(true);
    expect(JSON.stringify(trajectory)).not.toContain("Position Hall");
    expect(firstPathDivergence(["Hall", "Room"], ["Hall", "Meeting"])).toEqual({ index: 1, expected: "Room", observed: "Meeting" });
    expect(outsideInstructionPaths([resolve(mount, "AGENTS.md"), outside, globalSkill].map((path) => JSON.stringify(path)).join(" "), mount)).toEqual([outside]);
  });

  test("allocates unique explicit CLI targets without latest or overwrite", async () => {
    const sandbox = resolve(tmpdir(), `endroit-runs-${crypto.randomUUID()}`);
    await rm(sandbox, { recursive: true, force: true });
    try {
      const caseRoot = resolve(sandbox, "tests/workplaces/cases/fresh-personal");
      await mkdir(caseRoot, { recursive: true });
      await writeFile(resolve(caseRoot, "request.json"), await readFile(resolve(repository, "tests/workplaces/cases/fresh-personal/request.json"), "utf8"));
      await writeFile(resolve(caseRoot, "scenario.json"), await readFile(resolve(repository, "tests/workplaces/cases/fresh-personal/scenario.json"), "utf8"));
      await writeFile(resolve(caseRoot, "expected.json"), await readFile(resolve(repository, "tests/workplaces/cases/fresh-personal/expected.json"), "utf8"));
      const first = await createQualificationRun({ repository: sandbox, caseId: "fresh-personal", compilerRevision: "a".repeat(40), profileRevision: "sha256:profile", now: new Date("2026-08-25T14:00:00Z") });
      const second = await createQualificationRun({ repository: sandbox, caseId: "fresh-personal", compilerRevision: "a".repeat(40), profileRevision: "sha256:profile", now: new Date("2026-08-25T14:00:01Z") });
      expect(first.root).not.toBe(second.root);
      expect(first.mount).toContain(first.id);
      expect(second.mount).toContain(second.id);
      expect(await Bun.file(resolve(sandbox, "checkouts/workplaces/fresh-personal/latest")).exists()).toBe(false);
      const preview = Bun.spawnSync([Bun.argv[0]!, resolve(repository, "src/cli.ts"), "new", "--request", first.requestPath, "--preview", "--json"], { cwd: repository, stdout: "pipe", stderr: "pipe" });
      expect(preview.exitCode).toBe(0);
      const revision = (JSON.parse(new TextDecoder().decode(preview.stdout)) as { revision: string }).revision;
      const apply = Bun.spawnSync([Bun.argv[0]!, resolve(repository, "src/cli.ts"), "new", "--request", first.requestPath, "--apply", revision, "--json"], { cwd: repository, stdout: "pipe", stderr: "pipe" });
      if (apply.exitCode !== 0) throw new Error(new TextDecoder().decode(apply.stderr) || new TextDecoder().decode(apply.stdout));
      expect(apply.exitCode).toBe(0);
      expect(await Bun.file(resolve(first.mount, "FRONTDOOR.md")).exists()).toBe(true);
      const recorded = JSON.parse(await readFile(resolve(first.root, "RUN.json"), "utf8")) as { status: string; mount: string };
      expect(recorded.status).toBe("prepared");
      expect(recorded.mount).toBe("mount");
      const trajectory = resolve(first.evidence, "trajectory.json");
      const meetingRef = "workplace://witness/meeting/one";
      await writeFile(trajectory, `${JSON.stringify({ kind: "QualificationTrajectory", version: 1, reads: ["FRONTDOOR.md", "workplace/sources/members/alexis/desk/WELCOME.md"], skills: ["enter"], observations: [
        { kind: "read", path: "FRONTDOOR.md" },
        { kind: "read", path: "workplace/sources/members/alexis/desk/WELCOME.md" }
      ], dispatches: [
        { role: "manager", action: "spawn", meetingRef },
        { role: "worker", action: "spawn", meetingRef },
        { role: "worker", action: "complete", meetingRef },
        { role: "manager", action: "complete", meetingRef },
      ], effects: [], provider: { modelRequested: "gpt-5.6-terra", cliVersion: "codex-cli fixture" } }, null, 2)}\n`);
      const firstSnapshot = await snapshotQualificationRun({ repository: sandbox, runId: first.id, task: "task-fixture", trajectoryPath: trajectory, now: new Date("2026-08-25T14:01:00Z") });
      const expectedPath = resolve(caseRoot, "expected.json");
      const pinnedExpected = await readFile(expectedPath, "utf8");
      await writeFile(expectedPath, pinnedExpected.replace('"no-delivery"', '"no-delivery", "no-provider-memory"'));
      let drift = "";
      try { await snapshotQualificationRun({ repository: sandbox, runId: first.id, task: "task-fixture", trajectoryPath: trajectory, now: new Date("2026-08-25T14:01:30Z") }); }
      catch (error) { drift = error instanceof Error ? error.message : String(error); }
      expect(drift).toContain("case sources changed");
      await writeFile(expectedPath, pinnedExpected);
      await rm(resolve(first.mount, "workplace/sources/members/alexis/desk/WELCOME.md"), { recursive: false, force: false });
      await writeFile(trajectory, `${JSON.stringify({ kind: "QualificationTrajectory", version: 1, reads: [join(tmpdir(), "outside/MEMORY.md")], skills: ["impeccable"], effects: [{ actor: "main", root: "site", kind: "write" }, { actor: "main", root: "mount", kind: "write", path: join(tmpdir(), ".codex/memories/MEMORY.md") }] }, null, 2)}\n`);
      const secondSnapshot = await snapshotQualificationRun({ repository: sandbox, runId: first.id, task: "task-fixture", trajectoryPath: trajectory, now: new Date("2026-08-25T14:02:00Z") });
      expect(firstSnapshot.path).not.toBe(secondSnapshot.path);
      expect(await readFile(firstSnapshot.path, "utf8")).toContain('"status": "valid"');
      expect(await readFile(firstSnapshot.path, "utf8")).toContain('"observedPath"');
      expect(await readFile(firstSnapshot.path, "utf8")).toContain('"modelRequested": "gpt-5.6-terra"');
      expect(await readFile(secondSnapshot.path, "utf8")).toContain('"status": "red"');
      expect(await readFile(secondSnapshot.path, "utf8")).toContain("main-site-write");
      expect(await readFile(secondSnapshot.path, "utf8")).toContain("coordination-trajectory-missing");
      expect(await readFile(secondSnapshot.path, "utf8")).toContain("outcome-source-missing");
      expect(await readFile(secondSnapshot.path, "utf8")).toContain("forbidden-observed");
      expect((await verdictQualificationRun({ repository: sandbox, runId: first.id, verdict: "changes-needed", now: new Date("2026-08-25T14:03:00Z") })).status).toBe("changes-needed");
      let terminal = "";
      try { await verdictQualificationRun({ repository: sandbox, runId: first.id, verdict: "pass" }); }
      catch (error) { terminal = error instanceof Error ? error.message : String(error); }
      expect(terminal).toContain("must be observed");
      let collision = "";
      try { await createQualificationRun({ repository: sandbox, caseId: "fresh-personal", compilerRevision: "a".repeat(40), profileRevision: "sha256:profile", now: new Date("2026-08-25T14:00:00Z") }); }
      catch (error) { collision = error instanceof Error ? error.message : String(error); }
      expect(collision).toContain("will not be overwritten");
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });
});
