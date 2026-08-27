import { qualifyScenario, readScenario, readTrajectory } from "./index.ts";

const [scenarioPath, trajectoryPath] = Bun.argv.slice(2);
if (!scenarioPath || !trajectoryPath) {
  console.error("usage: endroit qualify <scenario.json> <trajectory.json>");
  process.exit(2);
}

try {
  const result = qualifyScenario(
    await readScenario(scenarioPath),
    await readTrajectory(trajectoryPath),
  );
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.status === "pass" ? 0 : 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
}
