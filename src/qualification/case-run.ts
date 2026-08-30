import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { hash, stable } from "../compiler/index.ts";
import { findQualificationRun, snapshotQualificationRun } from "./runs.ts";
import { gitArguments } from "../platform.ts";

type Json = Record<string, unknown>;

const DISABLED = ["memories", "plugins", "apps", "remote_plugin", "recommended_plugins", "skill_search"];
const PATH = /(?:^|[\s"'=])((?:(?:[A-Za-z]:[\\/]|\\\\|\/|\.\.?[\\/])[^\s"';|&)]+)|[A-Za-z0-9_.-]+(?:[\\/][A-Za-z0-9_.-]+)+|[A-Za-z0-9_.-]+\.(?:md|json|ts|tsx|js|mjs|css|html))/g;
const ABSOLUTE_MARKDOWN = /(?:^|[\s"'])((?:(?:[A-Za-z]:[\\/]|\\\\|\/)[^\s"'()\]}]+)\.md)/g;

function fail(message: string): never { throw new Error(message); }

function git(root: string, args: string[]): string | undefined {
  const result = Bun.spawnSync(["git", ...gitArguments(args)], { cwd: root, stdout: "pipe", stderr: "pipe" });
  return result.exitCode === 0 ? new TextDecoder().decode(result.stdout).trim() : undefined;
}

function pathsFromCommand(command: string): string[] {
  const executable = command.trim().split(/\s+/, 1)[0]?.replace(/^['"]|['"]$/g, "");
  return [...command.matchAll(PATH)]
    .map((match) => match[1]!.replace(/[,:]+$/, ""))
    .filter((path) => !path.startsWith("--") && path !== executable);
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") || path.startsWith(sep) || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\");
}

function skillId(path: string): string | undefined {
  return /(?:^|[\\/])(?:skills|plugins)[\\/]([^\\/]+)(?:[\\/][^\\/]+)*[\\/]SKILL\.md$/i.exec(path)?.[1];
}

function inside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolutePath(path));
}

function absolutePath(root: string, path: string): string {
  return resolve(isAbsolutePath(path) ? path : resolve(root, path));
}

function rootFor(mount: string, path: string): "shared" | "desk" | "site" | "mount" {
  const absolute = absolutePath(mount, path);
  if (inside(resolve(mount, "workplace"), absolute)) return "shared";
  if (inside(resolve(mount, "checkouts/desks"), absolute)) return "desk";
  if (inside(resolve(mount, "checkouts/sites"), absolute)) return "site";
  return "mount";
}

export function trajectoryFromCodexEvents(mount: string, events: Json[]) {
  const reads = new Set<string>();
  const skills = new Set<string>();
  const observations: Json[] = [];
  const dispatches: Json[] = [];
  const effects: Json[] = [];
  const depths = new Map<string, number>();
  const meetings = new Map<string, string>();
  const completed = new Set<string>();
  const rootThread = String(events.find((event) => event.type === "thread.started")?.thread_id ?? "");
  if (rootThread) depths.set(rootThread, 0);
  const actor = (thread: unknown) => {
    const id = String(thread ?? "");
    const depth = depths.get(id);
    return id === rootThread || depth === 0 ? "main" : depth === 1 ? "manager" : depth !== undefined ? "worker" : "unknown";
  };

  for (const event of events) {
    if (event.type !== "item.completed" || !event.item || typeof event.item !== "object") continue;
    const item = event.item as Json;
    if (item.type === "command_execution") {
      const command = String(item.command ?? "");
      for (const path of pathsFromCommand(command)) {
        if (!reads.has(path)) observations.push({ kind: "read", path });
        reads.add(path);
        const id = skillId(path);
        if (id) skills.add(id);
      }
      if (/\b(?:test|check|verify|verification)\b/i.test(command)) observations.push({ kind: "verification" });
      const external = /\bgit\s+push\b/i.test(command) ? "remote" : /\b(?:deploy|hosting)\b/i.test(command) ? "hosting" : /\bpublish\b/i.test(command) ? "delivery" : undefined;
      if (external) {
        const effect = { actor: actor(item.sender_thread_id), root: "mount", kind: external };
        effects.push(effect);
        observations.push({ kind: "effect", actor: effect.actor, root: effect.root, effectKind: effect.kind });
      }
    }
    if (item.type === "file_change" && Array.isArray(item.changes)) for (const change of item.changes as Json[]) {
      const path = String(change.path ?? "");
      const effect = { actor: actor(item.sender_thread_id), root: rootFor(mount, path), kind: "write", path };
      effects.push(effect);
      observations.push({ kind: "effect", actor: effect.actor, root: effect.root, effectKind: effect.kind, path });
    }
    if (item.type === "web_search" || item.type === "mcp_tool_call") {
      const effect = { actor: actor(item.sender_thread_id), root: "mount", kind: "remote" };
      effects.push(effect);
      observations.push({ kind: "effect", actor: effect.actor, root: effect.root, effectKind: effect.kind });
    }
    if (item.type !== "collab_tool_call" || item.status !== "completed") continue;
    const sender = String(item.sender_thread_id ?? "");
    const meetingRef = /workplace:\/\/[A-Za-z0-9._~:/-]+\/meeting\/[A-Za-z0-9_~-]+/.exec(String(item.prompt ?? ""))?.[0];
    if (item.tool === "spawn_agent" && Array.isArray(item.receiver_thread_ids)) for (const receiver of item.receiver_thread_ids) {
      const id = String(receiver);
      const depth = (depths.get(sender) ?? 0) + 1;
      depths.set(id, depth);
      if (meetingRef) meetings.set(id, meetingRef);
      const dispatch = { role: depth === 1 ? "manager" : "worker", action: "spawn", thread: id, ...(meetingRef ? { meetingRef } : {}) };
      dispatches.push(dispatch);
      observations.push({ kind: "dispatch", ...dispatch });
    }
    if ((item.tool === "wait" || item.tool === "close_agent") && item.agents_states && typeof item.agents_states === "object") for (const [id, state] of Object.entries(item.agents_states as Json)) {
      if (!state || typeof state !== "object" || !["completed", "shutdown"].includes(String((state as Json).status)) || completed.has(id)) continue;
      completed.add(id);
      const inheritedMeeting = meetingRef ?? meetings.get(id);
      const dispatch = { role: (depths.get(id) ?? 1) === 1 ? "manager" : "worker", action: "complete", thread: id, ...(inheritedMeeting ? { meetingRef: inheritedMeeting } : {}) };
      dispatches.push(dispatch);
      observations.push({ kind: "dispatch", ...dispatch });
    }
  }
  return { kind: "QualificationTrajectory", version: 1, reads: [...reads], skills: [...skills].sort(), dispatches, effects, observations };
}

function parseEvents(output: string): Json[] {
  return output.split("\n").filter(Boolean).flatMap((line) => {
    try { const value = JSON.parse(line) as unknown; return value && typeof value === "object" ? [value as Json] : []; }
    catch { return []; }
  });
}

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch { return false; }
}

async function bootstrap(repository: string, requestPath: string, mount: string): Promise<void> {
  if (await exists(join(mount, "FRONTDOOR.md"))) return;
  const cli = [Bun.argv[0]!, join(repository, "src/cli.ts"), "new", "--request", requestPath];
  const preview = Bun.spawnSync([...cli, "--preview", "--json"], { cwd: repository, stdout: "pipe", stderr: "pipe" });
  if (preview.exitCode !== 0) fail(new TextDecoder().decode(preview.stderr));
  const revision = String((JSON.parse(new TextDecoder().decode(preview.stdout)) as Json).revision ?? "");
  if (!revision) fail("Qualification bootstrap Preview has no digest");
  const apply = Bun.spawnSync([...cli, "--apply", revision, "--json"], { cwd: repository, stdout: "pipe", stderr: "pipe" });
  if (apply.exitCode !== 0) fail(new TextDecoder().decode(apply.stderr));
}

async function initialHeads(mount: string): Promise<Record<string, string>> {
  const heads: Record<string, string> = {};
  const entry = JSON.parse(await readFile(join(mount, ".endroit/entry.json"), "utf8")) as { rootBindings?: Record<string, string> };
  for (const [id, path] of Object.entries(entry.rootBindings ?? {})) {
    const head = git(resolve(mount, path), ["rev-parse", "HEAD"]);
    if (head) heads[id] = head;
  }
  return heads;
}

async function exposedSkills(prompt: string, mount: string) {
  const paths = [...prompt.matchAll(/((?:[A-Za-z]:[\\/]|\\\\|\/)[^\s)\]]+[\\/]SKILL\.md)/g)].map((match) => match[1]!);
  const resolved = [];
  for (const path of [...new Set(paths)].sort()) if (await exists(path)) resolved.push({ path, scope: inside(resolve(mount), resolve(path)) ? "mount" : "global" });
  return resolved;
}

export function outsideInstructionPaths(prompt: string, mount: string): string[] {
  const root = resolve(mount);
  return [...new Set([...prompt.matchAll(ABSOLUTE_MARKDOWN)].map((match) => resolve(match[1]!)))]
    .filter((path) => !/[\\/]SKILL\.md$/i.test(path) && !inside(root, path))
    .sort();
}

async function isolatedCodexHome(): Promise<{ path: string; env: Record<string, string | undefined> }> {
  const path = await mkdtemp(join(tmpdir(), "endroit-codex-home-"));
  await chmod(path, 0o700);
  const source = join(resolve(process.env.CODEX_HOME ?? join(homedir(), ".codex")), "auth.json");
  const auth = await stat(source).catch(() => null);
  if (auth?.isFile()) {
    const target = join(path, "auth.json");
    await writeFile(target, await readFile(source), { flag: "wx" });
    await chmod(target, 0o600);
  }
  else if (!process.env.CODEX_ACCESS_TOKEN && !process.env.OPENAI_API_KEY) {
    await rm(path, { recursive: true, force: true });
    fail("Codex authentication is unavailable for an isolated qualification run");
  }
  return { path, env: { ...process.env, CODEX_HOME: path } };
}

export async function runQualificationCase(options: { repository: string; runId: string; model?: string; timeoutMs?: number }) {
  const repository = resolve(options.repository);
  const root = await findQualificationRun(repository, options.runId);
  const runPath = join(root, "RUN.json");
  const run = JSON.parse(await readFile(runPath, "utf8")) as Json;
  if (run.status !== "prepared") fail(`Qualification run ${options.runId} must be prepared`);
  if (run.mount !== "mount" || run.evidence !== "evidence") fail("Qualification run locators must be exactly mount and evidence");
  const caseRoot = join(repository, "tests/workplaces/cases", String(run.case));
  const caseDigests = {
    request: hash(stable(JSON.parse(await readFile(join(caseRoot, "request.json"), "utf8")))),
    scenario: hash(stable(JSON.parse(await readFile(join(caseRoot, "scenario.json"), "utf8")))),
    expected: hash(stable(JSON.parse(await readFile(join(caseRoot, "expected.json"), "utf8")))),
  };
  if (stable(run.caseDigests) !== stable(caseDigests)) fail(`Qualification run ${options.runId} case sources changed after preparation`);
  const mount = join(root, "mount");
  const requestPath = join(root, "evidence", "request.json");
  await bootstrap(repository, requestPath, mount);

  const codex = "codex";
  const cliVersion = Bun.spawnSync([codex, "--version"], { cwd: repository, stdout: "pipe", stderr: "pipe" });
  if (cliVersion.exitCode !== 0) fail("Codex CLI is unavailable");
  const isolated = await isolatedCodexHome();
  try {
  const disables = DISABLED.flatMap((feature) => ["--disable", feature]);
  const preflight = Bun.spawnSync([codex, ...disables, "-C", mount, "debug", "prompt-input", "qualification preflight"], { cwd: mount, env: isolated.env, stdout: "pipe", stderr: "pipe" });
  const prompt = new TextDecoder().decode(preflight.stdout);
  const outsideInstructions = outsideInstructionPaths(prompt, mount);
  const observedAt = new Date().toISOString();
  const preflightEvidence = {
    kind: "CodexProviderPreflight",
    version: 1,
    observedAt,
    executable: codex,
    cliVersion: new TextDecoder().decode(cliVersion.stdout).trim(),
    modelRequested: options.model ?? null,
    disabledFeatures: DISABLED,
    exposedSkills: await exposedSkills(prompt, mount),
    outsideInstructionPaths: outsideInstructions,
    isolatedCodexHome: true,
    status: preflight.exitCode === 0 && outsideInstructions.length === 0 ? "observed" : "degraded",
  };
  const preflightName = `provider-preflight-${observedAt.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")}.json`;
  await mkdir(dirname(join(root, "evidence", preflightName)), { recursive: true });
  await writeFile(join(root, "evidence", preflightName), stable(preflightEvidence), { flag: "wx" });
  run.initialHeads = await initialHeads(mount);
  run.providerPreflight = { path: `evidence/${preflightName}`, digest: hash(stable(preflightEvidence)), observedAt };
  await writeFile(runPath, stable(run));

  if (preflightEvidence.status !== "observed") {
    fail(outsideInstructions.length ? `Codex preflight exposed instructions outside the Mount: ${outsideInstructions.join(", ")}` : "Codex provider preflight failed");
  }

  const scenario = JSON.parse(await readFile(join(caseRoot, "scenario.json"), "utf8")) as Json;
  const intent = String(scenario.intent ?? "") || fail("Qualification Scenario has no intent");
  const args = ["-a", "never", "exec", "--ignore-user-config", "--ignore-rules", "--ephemeral", "--json", "--color", "never", "-C", mount, "-s", "workspace-write", "--enable", "multi_agent", ...disables, ...(options.model ? ["--model", options.model] : []), intent];
  const process = Bun.spawn([codex, ...args], { cwd: mount, env: isolated.env, stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; process.kill(); }, options.timeoutMs ?? 30 * 60_000);
  const [exitCode, stdout, stderr] = await Promise.all([process.exited, new Response(process.stdout).text(), new Response(process.stderr).text()]);
  clearTimeout(timer);
  const events = parseEvents(stdout);
  const trajectory = trajectoryFromCodexEvents(mount, events);
  const threadId = String(events.find((event) => event.type === "thread.started")?.thread_id ?? "unknown");
  const turnCompleted = events.some((event) => event.type === "turn.completed");
  if (exitCode !== 0 || timedOut || !turnCompleted) trajectory.effects.push({ actor: "provider", root: "mount", kind: "provider-failure" });
  const evidence = {
    ...trajectory,
    provider: { threadId, exitCode, timedOut, turnCompleted, modelRequested: options.model ?? null, cliVersion: new TextDecoder().decode(cliVersion.stdout).trim(), stderrDigest: hash(stderr) },
  };
  const trajectoryPath = join(root, "evidence", `trajectory-${new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")}.json`);
  await writeFile(trajectoryPath, stable(evidence), { flag: "wx" });
  const snapshot = await snapshotQualificationRun({ repository, runId: options.runId, task: threadId, trajectoryPath });
  return { run: options.runId, task: threadId, preflight: relative(root, join(root, "evidence", preflightName)), trajectory: relative(root, trajectoryPath), snapshot, status: "observed" };
  } finally {
    await rm(isolated.path, { recursive: true, force: true });
  }
}

if (resolve(Bun.argv[1] ?? "") === resolve(import.meta.dir, "case-run.ts")) {
  const args = Bun.argv.slice(2);
  const runId = args[0];
  const modelIndex = args.indexOf("--model");
  if (!runId || (modelIndex >= 0 && !args[modelIndex + 1])) fail("usage: bun run case:run -- <run-id> [--model <id>]");
  console.log(JSON.stringify(await runQualificationCase({ repository: resolve(import.meta.dir, "../.."), runId, ...(modelIndex >= 0 ? { model: args[modelIndex + 1]! } : {}) }), null, 2));
}
