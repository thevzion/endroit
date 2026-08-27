import { resolve } from "node:path";
import { verdictQualificationRun } from "./runs.ts";

const args = Bun.argv.slice(2);
const runId = args[0];
const verdictIndex = args.indexOf("--verdict");
const verdict = args[verdictIndex + 1];
if (!runId || verdictIndex < 0 || (verdict !== "pass" && verdict !== "changes-needed")) throw new Error("usage: bun run case:verdict -- <run-id> --verdict pass|changes-needed");
console.log(JSON.stringify(await verdictQualificationRun({ repository: resolve(import.meta.dir, "../.."), runId, verdict }), null, 2));
