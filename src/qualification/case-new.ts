import { resolve } from "node:path";
import { createQualificationRun } from "./runs.ts";
import { loadProfilePackage } from "../compiler/profile-package.ts";
import { gitArguments } from "../platform.ts";

const repository = resolve(import.meta.dir, "../..");
const caseId = Bun.argv[2];
if (!caseId) throw new Error("usage: bun run case:new -- <case>");
const revision = Bun.spawnSync(["git", ...gitArguments(["rev-parse", "HEAD"])], { cwd: repository, stdout: "pipe", stderr: "pipe" });
if (revision.exitCode !== 0) throw new Error("Cannot resolve compiler revision");
const profile = await loadProfilePackage(resolve(repository, "profiles/standard/profile.json"));
console.log(JSON.stringify(await createQualificationRun({ repository, caseId, compilerRevision: new TextDecoder().decode(revision.stdout).trim(), profileRevision: profile.digest }), null, 2));
