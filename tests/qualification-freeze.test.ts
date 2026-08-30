import { describe, expect, test } from "bun:test";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { freezeQualificationRun, validateArchiveMembers } from "../src/qualification/case-freeze.ts";
import { createQualificationRun } from "../src/qualification/runs.ts";

const repository = resolve(import.meta.dir, "..");

describe("qualification run freeze", () => {
  test("freezes once, resumes interrupted cleanup and preserves unsafe runs", async () => {
    const sandbox = resolve(tmpdir(), `endroit-freeze-${crypto.randomUUID()}`);
    try {
      const caseRoot = resolve(sandbox, "tests/workplaces/cases/fresh-personal");
      await mkdir(caseRoot, { recursive: true });
      for (const name of ["request.json", "scenario.json", "expected.json"]) {
        await writeFile(resolve(caseRoot, name), await readFile(resolve(repository, "tests/workplaces/cases/fresh-personal", name), "utf8"));
      }
      const create = (second: number) => createQualificationRun({ repository: sandbox, caseId: "fresh-personal", compilerRevision: "a".repeat(40), profileRevision: "sha256:profile", now: new Date(`2026-08-25T14:00:0${second}Z`) });
      const run = await create(0);
      await mkdir(resolve(run.mount, "workplace/.git"), { recursive: true });
      await writeFile(resolve(run.mount, "workplace/.git/HEAD"), "ref: refs/heads/develop\n");
      const runPath = resolve(run.root, "RUN.json");
      const record = JSON.parse(await readFile(runPath, "utf8")) as Record<string, unknown>;
      await writeFile(runPath, `${JSON.stringify({ ...record, status: "observed" }, null, 2)}\n`);

      const frozen = await freezeQualificationRun({ repository: sandbox, runId: run.id });
      expect(frozen.changed).toBe(true);
      expect(frozen.archive.path).toBe("archive/mount.tar.gz");
      expect(JSON.parse(await readFile(runPath, "utf8")).archive.path).toBe("archive/mount.tar.gz");
      const archivePath = resolve(run.root, "archive/mount.tar.gz");
      expect((await stat(archivePath)).size > 0).toBe(true);
      expect(await Bun.file(run.mount).exists()).toBe(false);
      await mkdir(run.mount, { recursive: false });
      expect((await freezeQualificationRun({ repository: sandbox, runId: run.id })).changed).toBe(true);
      expect((await freezeQualificationRun({ repository: sandbox, runId: run.id })).changed).toBe(false);
      expect(() => validateArchiveMembers(["/mount/file"])).toThrow("unsafe member");
      expect(() => validateArchiveMembers(["mount/../escape"])).toThrow("unsafe member");

      const prepared = await create(1);
      let failure = "";
      try { await freezeQualificationRun({ repository: sandbox, runId: prepared.id }); }
      catch (error) { failure = error instanceof Error ? error.message : String(error); }
      expect(failure).toContain("must be captured");
      failure = "";
      try { await freezeQualificationRun({ repository: sandbox, runId: "20260826T203355Z-viral-game-9d0a56d5" }); }
      catch (error) { failure = error instanceof Error ? error.message : String(error); }
      expect(failure).toContain("preserved");

      const failed = await create(2);
      await mkdir(failed.mount, { recursive: false });
      await writeFile(resolve(failed.mount, "keep.txt"), "keep\n");
      const failedPath = resolve(failed.root, "RUN.json");
      const failedRecord = JSON.parse(await readFile(failedPath, "utf8")) as Record<string, unknown>;
      await writeFile(failedPath, `${JSON.stringify({ ...failedRecord, status: "observed" }, null, 2)}\n`);
      await mkdir(resolve(failed.root, "archive"), { recursive: false });
      await writeFile(resolve(failed.root, "archive/mount.tar.gz"), "not an archive");
      failure = "";
      try { await freezeQualificationRun({ repository: sandbox, runId: failed.id }); }
      catch (error) { failure = error instanceof Error ? error.message : String(error); }
      expect(failure).not.toBe("");
      expect(await Bun.file(resolve(failed.mount, "keep.txt")).exists()).toBe(true);
      await writeFile(failedPath, `${JSON.stringify({ ...failedRecord, status: "observed", mount: "../escape" }, null, 2)}\n`);
      failure = "";
      try { await freezeQualificationRun({ repository: sandbox, runId: failed.id }); }
      catch (error) { failure = error instanceof Error ? error.message : String(error); }
      expect(failure).toContain("locator must be exactly mount");
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });
});
