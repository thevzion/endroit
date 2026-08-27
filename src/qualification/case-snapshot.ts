import { resolve } from "node:path";
import { snapshotQualificationRun } from "./runs.ts";

const args = Bun.argv.slice(2);
const runId = args[0];
const taskIndex = args.indexOf("--task");
const trajectoryIndex = args.indexOf("--trajectory");
if (!runId || taskIndex < 0 || trajectoryIndex < 0 || !args[taskIndex + 1] || !args[trajectoryIndex + 1]) throw new Error("usage: bun run case:snapshot -- <run-id> --task <id> --trajectory <file>");
console.log(JSON.stringify(await snapshotQualificationRun({ repository: resolve(import.meta.dir, "../.."), runId, task: args[taskIndex + 1]!, trajectoryPath: args[trajectoryIndex + 1]! }), null, 2));
