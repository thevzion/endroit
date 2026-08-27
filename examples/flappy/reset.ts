import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { readyWorkplace, resolveMeeting, stable, writeMeetingPresence } from "../../src/compiler/index.ts";
import { loadProfilePackage } from "../../src/compiler/profile-package.ts";

const fixture = resolve(import.meta.dir, "world");
const profile = resolve(import.meta.dir, "../../profiles/standard/profile.json");
const mount = resolve("/tmp/endroit-flappy-manual");
const sharedRoot = resolve(mount, "workplace");
const desk = resolve(mount, "checkouts/desks/alexis");
const site = resolve(mount, "checkouts/sites/flappy-bird");

await rm(mount, { recursive: true, force: true });
await cp(fixture, mount, { recursive: true });
await rm(resolve(mount, ".endroit"), { recursive: true, force: true });
await rm(resolve(mount, ".agents"), { recursive: true, force: true });
for (const path of ["FRONTDOOR.md", "AGENTS.md", "CLAUDE.md", "MEMORY.md", "rooms", "work", "sites", "desks", "scopes"]) {
  await rm(resolve(mount, path), { recursive: true, force: true });
}
await rm(resolve(sharedRoot, ".workplace"), { recursive: true, force: true });
await rm(resolve(sharedRoot, "WORKPLACE.md"), { recursive: false, force: true });
const profilePackage = await loadProfilePackage(profile);
await writeFile(resolve(sharedRoot, "profile.json"), stable({ kind: "ProfileSelection", version: 1, ref: profilePackage.manifest.ref, digest: profilePackage.digest }));

const workplacePath = resolve(sharedRoot, "workplace.json");
const workplace = JSON.parse(await readFile(workplacePath, "utf8")) as { profile: { path: string; ref: string; revision: string } };
workplace.profile.path = "profile.json";
workplace.profile.ref = profilePackage.manifest.ref;
workplace.profile.revision = profilePackage.digest;
await writeFile(workplacePath, `${JSON.stringify(workplace, null, 2)}\n`);

await mkdir(resolve(mount, ".endroit/providers"), { recursive: true });
await writeFile(resolve(mount, ".endroit/entry.json"), await readFile(resolve(mount, "bindings/entry.json"), "utf8"));
await writeFile(resolve(mount, ".endroit/providers/codex.json"), await readFile(resolve(mount, "bindings/provider.codex.json"), "utf8"));
await rm(resolve(mount, "bindings"), { recursive: true, force: true });

function git(cwd: string, ...args: string[]): void {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
}

git(site, "init", "--initial-branch=develop");
git(site, "add", "README.md", "SPEC.md", "CONTRIBUTING.md");
git(site, "-c", "user.name=Endroit Fixture", "-c", "user.email=fixture@endroit.invalid", "commit", "-m", "seed(site:flappy): create sovereign product root");

git(desk, "init", "--initial-branch=develop");
git(desk, "add", "DESK.md", "WELCOME.md", "MEMORY.md");
git(desk, "-c", "user.name=Endroit Fixture", "-c", "user.email=fixture@endroit.invalid", "commit", "-m", "adopt(desk:alexis): retain private entry sources\n\nAuthority: human-invoked");

git(sharedRoot, "init", "--initial-branch=develop");
git(sharedRoot, "add", ".");
git(sharedRoot, "-c", "user.name=Endroit Fixture", "-c", "user.email=fixture@endroit.invalid", "commit", "-m", "adopt(workplace:flappy): retain owned sources\n\nAuthority: human-invoked");
const sourceOid = new TextDecoder().decode(Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: sharedRoot, stdout: "pipe", stderr: "pipe" }).stdout).trim();

const meetingRef = "workplace://demo/flappy-studio/meeting/flappy-qualification";
const roomRef = "workplace://demo/flappy-studio/room/product";
const workRef = "workplace://demo/flappy-studio/work/flappy-bird";
const resolvedMeeting = resolveMeeting({
  workplace: "workplace://demo/flappy-studio",
  meetings: [{ ref: meetingRef, room: roomRef, lifecycle: "active", primaryWork: workRef, relatedWorks: [] }],
  explicitMeeting: meetingRef,
  room: roomRef,
  work: workRef,
  intent: "Qualify the Flappy demonstration fixture.",
  sessionKey: "flappy-reset-fixture",
  now: new Date("2026-08-25T12:00:00.000Z"),
  entropy: "flappy-reset-fixture",
});
if (resolvedMeeting.status === "ambiguous" || resolvedMeeting.status === "ephemeral") throw new Error("Flappy fixture Meeting did not resolve");
await writeMeetingPresence(mount, resolvedMeeting.presence);

const ready = await readyWorkplace({ start: mount, provider: "codex" });
if (ready.check.operationStatus !== "ready") throw new Error(JSON.stringify(ready.check));
git(sharedRoot, "add", ".workplace", "WORKPLACE.md");
git(sharedRoot, "-c", "user.name=Endroit Compiler", "-c", "user.email=compiler@endroit.invalid", "commit", "-m", `compile(workplace:flappy): project portable control plane\n\nAuthority: projection\nBuild: ${sourceOid}`);

console.log(JSON.stringify({ mount, sharedRoot, desk, site, status: ready.check.operationStatus }, null, 2));
