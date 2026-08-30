import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import { checkWorkplaceMount, hash, stable } from "../compiler/index.ts";
import { checkGitHistory } from "../compiler/git-witness.ts";
import { gitArguments } from "../platform.ts";

export type QualificationRun = {
  id: string;
  root: string;
  mount: string;
  evidence: string;
  requestPath: string;
};

const CASE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const RUN = /^\d{8}T\d{6}Z-[a-z0-9-]+-[0-9a-f]{8}$/;
const FORBIDDEN = new Set(["outside-mount", "global-skill", "provider-memory", "main-site-write", "remote", "hosting", "delivery", "implicit-delivery", "provider-memory-write", "free-site", "premature-study-load"]);
const PATH_MARKERS = new Set(["Hall", "Member Card", "Desk", "WELCOME", "open-room", "Room", "Meeting", "open-work", "Work", "Site", "classification:integration", "Manager", "Worker", "Worker:Site", "Manager:integration", "Verification", "Work:candidate", "Workshop Research", "Study"]);
const EVIDENCE = new Set(["check-ready", "roots-clean", "history-valid", "manager-dispatch", "worker-dispatch", "meeting-presence", "site-commit", "verification", "provider-metadata"]);
const PRESERVES = new Set(["no-provider-memory", "no-remote", "no-delivery", "site-sovereignty"]);

function fail(message: string): never { throw new Error(message); }

function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") || path.startsWith(sep) || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\");
}

function inside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolutePath(path));
}

export function qualificationRunId(caseId: string, requestDigest: string, now: Date): string {
  if (!CASE.test(caseId)) fail("Qualification case id is invalid");
  const timestamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return `${timestamp}-${caseId}-${requestDigest.replace(/^sha256:/, "").slice(0, 8)}`;
}

export async function createQualificationRun(options: {
  repository: string;
  caseId: string;
  compilerRevision: string;
  profileRevision: string;
  initialHeads?: Record<string, string>;
  now?: Date;
}): Promise<QualificationRun> {
  const repository = resolve(options.repository);
  const caseRoot = join(repository, "tests/workplaces/cases", options.caseId);
  const template = JSON.parse(await readFile(join(caseRoot, "request.json"), "utf8")) as Record<string, unknown>;
  const scenario = JSON.parse(await readFile(join(caseRoot, "scenario.json"), "utf8")) as Record<string, unknown>;
  const expected = JSON.parse(await readFile(join(caseRoot, "expected.json"), "utf8")) as Record<string, unknown>;
  parseCaseScenario(scenario, options.caseId);
  parseCaseExpected(expected);
  const templateDigest = hash(stable(template));
  const id = qualificationRunId(options.caseId, templateDigest, options.now ?? new Date());
  const root = join(repository, "checkouts/workplaces", options.caseId, id);
  const mount = join(root, "mount");
  const evidence = join(root, "evidence");
  await mkdir(join(repository, "checkouts/workplaces", options.caseId), { recursive: true });
  try { await mkdir(root, { recursive: false }); }
  catch { fail(`Qualification run already exists and will not be overwritten: ${root}`); }
  await mkdir(evidence, { recursive: false });
  const request = { ...template, target: mount };
  const requestPath = join(evidence, "request.json");
  await writeFile(requestPath, stable(request));
  await writeFile(join(root, "RUN.json"), stable({
    kind: "QualificationRun",
    version: 1,
    id,
    case: options.caseId,
    caseSources: {
      request: `tests/workplaces/cases/${options.caseId}/request.json`,
      scenario: `tests/workplaces/cases/${options.caseId}/scenario.json`,
      expected: `tests/workplaces/cases/${options.caseId}/expected.json`,
    },
    requestDigest: hash(stable(request)),
    templateDigest,
    caseDigests: { request: templateDigest, scenario: hash(stable(scenario)), expected: hash(stable(expected)) },
    compilerRevision: options.compilerRevision,
    profileRevision: options.profileRevision,
    initialHeads: options.initialHeads ?? {},
    status: "prepared",
    mount: "mount",
    evidence: "evidence",
  }));
  return { id, root, mount, evidence, requestPath };
}

type RunRecord = {
  kind: "QualificationRun";
  version: 1;
  id: string;
  case: string;
  status: "prepared" | "observed" | "pass" | "changes-needed";
  snapshots?: Array<{ path: string; digest: string; observedAt: string; task: string }>;
  verdict?: { value: "pass" | "changes-needed"; recordedAt: string };
  [key: string]: unknown;
};

type CaseScenario = {
  kind: "HumanQualificationScenario";
  version: 1;
  id: string;
  intent: string;
  expectedPath: string[];
  forbidden: string[];
};

type CaseExpected = {
  kind: "HumanQualificationExpected";
  version: 1;
  requiredSources: Array<{ root: "shared" | "desk" | "site"; basename: string }>;
  requiredRoots: Array<"shared" | "desk" | "site">;
  requiredEvidence: string[];
  preserves: string[];
  terminal: { operationStatus: "ready"; rootsClean: true };
};

const equal = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const object = (value: unknown, subject: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${subject} must be an object`);
  return value as Record<string, unknown>;
};
const exact = (value: unknown, keys: string[], subject: string) => {
  const item = object(value, subject);
  if (!equal(Object.keys(item).sort(), [...keys].sort())) fail(`${subject} has invalid fields`);
  return item;
};
const stringList = (value: unknown, subject: string): string[] => {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) fail(`${subject} must contain strings`);
  return value as string[];
};

function parseCaseScenario(value: unknown, caseId: string): CaseScenario {
  const item = exact(value, ["kind", "version", "id", "intent", "expectedPath", "forbidden"], "Scenario");
  if (item.kind !== "HumanQualificationScenario" || item.version !== 1 || item.id !== caseId || typeof item.intent !== "string" || !item.intent) fail("Scenario identity is invalid");
  const expectedPath = stringList(item.expectedPath, "Scenario.expectedPath");
  if (expectedPath.some((marker) => !PATH_MARKERS.has(marker))) fail("Scenario.expectedPath contains unsupported markers");
  const forbidden = stringList(item.forbidden, "Scenario.forbidden");
  if (forbidden.some((token) => !FORBIDDEN.has(token)) || new Set(forbidden).size !== forbidden.length) fail("Scenario.forbidden contains unsupported or duplicate tokens");
  return item as CaseScenario;
}

function parseCaseExpected(value: unknown): CaseExpected {
  const item = exact(value, ["kind", "version", "requiredSources", "requiredRoots", "requiredEvidence", "preserves", "terminal"], "Expected");
  if (item.kind !== "HumanQualificationExpected" || item.version !== 1) fail("Expected identity is invalid");
  if (!Array.isArray(item.requiredSources)) fail("Expected.requiredSources must be an array");
  for (const [index, value] of item.requiredSources.entries()) {
    const source = exact(value, ["root", "basename"], `Expected.requiredSources[${index}]`);
    if (!["shared", "desk", "site"].includes(String(source.root)) || typeof source.basename !== "string" || !source.basename || source.basename.includes("/")) fail(`Expected.requiredSources[${index}] is invalid`);
  }
  const requiredRoots = stringList(item.requiredRoots, "Expected.requiredRoots");
  const requiredEvidence = stringList(item.requiredEvidence, "Expected.requiredEvidence");
  const preserves = stringList(item.preserves, "Expected.preserves");
  if (requiredRoots.some((root) => !["shared", "desk", "site"].includes(root))) fail("Expected.requiredRoots contains unsupported Roots");
  if (requiredEvidence.some((marker) => !EVIDENCE.has(marker))) fail("Expected.requiredEvidence contains unsupported evidence");
  if (preserves.some((marker) => !PRESERVES.has(marker))) fail("Expected.preserves contains unsupported preservation");
  const terminal = exact(item.terminal, ["operationStatus", "rootsClean"], "Expected.terminal");
  if (terminal.operationStatus !== "ready" || terminal.rootsClean !== true) fail("Expected.terminal is invalid");
  return item as unknown as CaseExpected;
}

export function firstPathDivergence(expected: string[], observed: string[]) {
  const length = Math.max(expected.length, observed.length);
  for (let index = 0; index < length; index++) if (expected[index] !== observed[index]) {
    return { index, expected: expected[index] ?? null, observed: observed[index] ?? null };
  }
  return null;
}

export async function findQualificationRun(repository: string, id: string): Promise<string> {
  if (!RUN.test(id)) fail("Qualification run id is invalid");
  const root = join(resolve(repository), "checkouts/workplaces");
  const cases = await readdir(root, { withFileTypes: true }).catch(() => []);
  const matches: string[] = [];
  for (const item of cases) if (item.isDirectory()) {
    const candidate = join(root, item.name, id);
    try { await stat(join(candidate, "RUN.json")); matches.push(candidate); } catch { /* not this case */ }
  }
  if (matches.length !== 1) fail(`Qualification run ${id} resolved ${matches.length} times`);
  return matches[0]!;
}

function git(root: string, args: string[]): { ok: boolean; output: string } {
  const result = Bun.spawnSync(["git", ...gitArguments(args)], { cwd: root, stdout: "pipe", stderr: "pipe" });
  return { ok: result.exitCode === 0, output: new TextDecoder().decode(result.exitCode === 0 ? result.stdout : result.stderr).trim() };
}

const pushUnique = (values: string[], value: string) => { if (value && !values.includes(value)) values.push(value); };

function pathMarkers(path: string): string[] {
  const normalized = path.replaceAll("\\", "/");
  const lower = normalized.toLowerCase();
  if (/(?:^|\/)methods\/open-room\.md$/.test(lower)) return ["open-room"];
  if (/(?:^|\/)methods\/open-work\.md$/.test(lower)) return ["open-work"];
  if (/(?:^|\/)welcome\.md$/.test(lower)) return ["Member Card", "Desk", "WELCOME"];
  if (/(?:^|\/)room\.md$/.test(lower)) return ["Room"];
  if (/(?:^|\/)meeting\.md$/.test(lower)) return ["Meeting"];
  if (/workshop[^/]*research|research[^/]*workshop/.test(lower)) return ["Workshop Research"];
  if (/(?:^|\/)(?:study|study\.md)(?:\/|$)/.test(lower)) return ["Study"];
  if (/(?:^|\/)work\.md$/.test(lower)) return ["Work"];
  if (/(?:^|\/)site\.md$/.test(lower)) return ["Site"];
  if (/verification|verify/.test(lower)) return ["Verification"];
  if (/(?:^|\/)(?:agents|frontdoor)\.md$/.test(lower) || /\/enter\/skill\.md$/.test(lower)) return ["Hall"];
  return [];
}

export function observedPathFromTrajectory(trajectory: Record<string, unknown>, workCandidate = false): string[] {
  const result: string[] = [];
  const effects = Array.isArray(trajectory.effects) ? trajectory.effects as Array<Record<string, unknown>> : [];
  const hasWorkerSiteEffect = effects.some((item) => item.root === "site" && item.actor === "worker");
  const observations = Array.isArray(trajectory.observations) ? trajectory.observations as Array<Record<string, unknown>> : [];
  for (const observation of observations) {
    if (observation.kind === "read" || observation.kind === "effect") for (const marker of pathMarkers(String(observation.path ?? ""))) {
      pushUnique(result, marker);
    }
    if (observation.kind === "verification") pushUnique(result, "Verification");
    if (observation.kind !== "dispatch") continue;
    if (observation.role === "manager" && observation.action === "spawn") {
      pushUnique(result, "classification:integration");
      pushUnique(result, "Manager");
    }
    if (observation.role === "worker" && observation.action === "spawn") pushUnique(result, hasWorkerSiteEffect ? "Worker:Site" : "Worker");
    if (observation.role === "manager" && observation.action === "complete") pushUnique(result, "Manager:integration");
  }
  if (workCandidate) pushUnique(result, "Work:candidate");
  return result;
}

async function filesBelow(root: string): Promise<string[]> {
  const files: string[] = [];
  const visit = async (directory: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      if (entry.name === ".git") continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) files.push(path);
    }
  };
  await visit(root);
  return files;
}

function qualifyTrajectory(mount: string, trajectory: Record<string, unknown>, definition: unknown, localManifest: unknown, scenario: CaseScenario, expected: CaseExpected, observed: {
  path: string[];
  sources: Array<{ root: "shared" | "desk" | "site"; basename: string }>;
  roots: Array<{ root: "shared" | "desk" | "site"; head: { ok: boolean }; status: { ok: boolean; output: string }; history: unknown }>;
  check: Record<string, unknown>;
  presence: unknown[];
}) {
  const diagnostics: Array<{ code: string; subject: string; message: string }> = [];
  const reads = trajectory.reads as unknown[];
  for (const value of reads) {
    const path = typeof value === "string" ? value : value && typeof value === "object" && "path" in value ? String((value as { path: unknown }).path) : "";
    if (!path) { diagnostics.push({ code: "trajectory-read-invalid", subject: String(value), message: "Read evidence needs one path." }); continue; }
    const absolute = resolve(isAbsolutePath(path) ? path : resolve(mount, path));
    const relation = inside(mount, absolute) ? relative(mount, absolute) : "..";
    if (relation === "..") diagnostics.push({ code: "context-outside-mount", subject: path, message: "The trajectory read outside the Workplace Mount." });
    if (/[/\\](?:\.codex|\.claude)[/\\](?:memories|memory)/i.test(path)) diagnostics.push({ code: "provider-memory-read", subject: path, message: "Provider memory influenced the trajectory." });
    if (/[/\\](?:skills|plugins)[/\\]/i.test(path) && relation === "..") diagnostics.push({ code: "global-skill-read", subject: path, message: "An unselected global capability influenced the trajectory." });
  }
  const projected = ((localManifest as { files?: Array<{ path?: string }> } | null)?.files ?? []).map((item) => /^\.agents\/skills\/([^/]+)\/SKILL\.md$/.exec(item.path ?? "")?.[1]).filter((id): id is string => Boolean(id));
  const hasManifest = Boolean(localManifest && typeof localManifest === "object" && Array.isArray((localManifest as { files?: unknown }).files));
  const allowed = new Set(hasManifest ? projected : ((definition as { affordances?: Array<{ id?: string }> } | null)?.affordances ?? []).map((item) => item.id).filter((id): id is string => Boolean(id)));
  for (const value of trajectory.skills as unknown[]) {
    const id = typeof value === "string" ? value : value && typeof value === "object" && "id" in value ? String((value as { id: unknown }).id) : "";
    if (!id || !allowed.has(id)) diagnostics.push({ code: "unselected-skill", subject: id || String(value), message: "The Skill has no declared Profile Package affordance chain." });
  }
  const effects = trajectory.effects as unknown[];
  let integration = false;
  for (const value of effects) {
    if (value && typeof value === "object") {
      const effect = value as { actor?: unknown; root?: unknown; kind?: unknown };
      integration ||= effect.root === "site" || effect.kind === "integration";
      if (effect.actor === "main" && effect.root === "site") diagnostics.push({ code: "main-site-write", subject: String(effect.kind ?? "site effect"), message: "Main wrote a Site on an integration path." });
      if ((!effect.actor || effect.actor === "unknown") && effect.root === "site") diagnostics.push({ code: "site-write-actor-unproved", subject: String(effect.kind ?? "site effect"), message: "The provider stream does not prove which Occupant wrote the Site." });
      if (["remote", "hosting", "delivery"].includes(String(effect.kind))) diagnostics.push({ code: "forbidden-external-effect", subject: String(effect.kind), message: "The qualification slice forbids this external effect." });
      if (effect.kind === "provider-failure") diagnostics.push({ code: "provider-run-incomplete", subject: "provider", message: "The provider run did not reach a successful terminal event." });
    }
  }
  if (integration) {
    const dispatches = Array.isArray(trajectory.dispatches) ? trajectory.dispatches as Array<Record<string, unknown>> : [];
    for (const [role, action] of [["manager", "spawn"], ["worker", "spawn"], ["worker", "complete"], ["manager", "complete"]] as const) {
      if (!dispatches.some((item) => item.role === role && item.action === action)) diagnostics.push({ code: "coordination-trajectory-missing", subject: `${role}:${action}`, message: "The observed provider trajectory lacks a required coordination transition." });
    }
    if (dispatches.some((item) => !item.meetingRef)) diagnostics.push({ code: "coordination-meeting-unproved", subject: "dispatch", message: "Every observed dispatch must carry its Meeting Ref." });
  }
  const divergence = firstPathDivergence(scenario.expectedPath, observed.path);
  if (divergence) diagnostics.push({ code: "path-divergence", subject: String(divergence.index), message: `Expected ${divergence.expected ?? "end"}, observed ${divergence.observed ?? "end"}.` });
  const rootKinds = new Set(observed.roots.map((item) => item.root));
  for (const root of expected.requiredRoots) if (!rootKinds.has(root)) diagnostics.push({ code: "outcome-root-missing", subject: root, message: "Required Outcome Root is absent." });
  for (const source of expected.requiredSources) if (!observed.sources.some((item) => item.root === source.root && item.basename === source.basename)) diagnostics.push({ code: "outcome-source-missing", subject: `${source.root}:${source.basename}`, message: "Required Outcome source is absent." });
  const dispatches = Array.isArray(trajectory.dispatches) ? trajectory.dispatches as Array<Record<string, unknown>> : [];
  const observedEvidence = new Set<string>();
  if (observed.check.operationStatus === "ready") observedEvidence.add("check-ready");
  if (observed.roots.length > 0 && observed.roots.every((item) => item.status.ok && item.status.output === "")) observedEvidence.add("roots-clean");
  if (observed.roots.filter((item) => item.root !== "site").every((item) => object(item.history, "history").status === "valid")) observedEvidence.add("history-valid");
  if (dispatches.some((item) => item.role === "manager" && item.action === "spawn") && dispatches.some((item) => item.role === "manager" && item.action === "complete")) observedEvidence.add("manager-dispatch");
  if (dispatches.some((item) => item.role === "worker" && item.action === "spawn") && dispatches.some((item) => item.role === "worker" && item.action === "complete")) observedEvidence.add("worker-dispatch");
  if (observed.presence.some(Boolean)) observedEvidence.add("meeting-presence");
  if (observed.roots.some((item) => item.root === "site" && item.head.ok)) observedEvidence.add("site-commit");
  if (observed.path.includes("Verification")) observedEvidence.add("verification");
  const provider = trajectory.provider && typeof trajectory.provider === "object" ? trajectory.provider as Record<string, unknown> : {};
  if (typeof provider.modelRequested === "string" && provider.modelRequested && typeof provider.cliVersion === "string" && provider.cliVersion) observedEvidence.add("provider-metadata");
  for (const required of expected.requiredEvidence) if (!observedEvidence.has(required)) diagnostics.push({ code: "outcome-evidence-missing", subject: required, message: "Required Outcome evidence is absent." });
  const diagnosticCodes = new Set(diagnostics.map((item) => item.code));
  const observedPreserves = new Set<string>();
  if (!diagnosticCodes.has("provider-memory-read")) observedPreserves.add("no-provider-memory");
  if (!effects.some((item) => (item as Record<string, unknown>).kind === "remote")) observedPreserves.add("no-remote");
  if (!effects.some((item) => (item as Record<string, unknown>).kind === "delivery")) observedPreserves.add("no-delivery");
  if (!diagnosticCodes.has("main-site-write") && !diagnosticCodes.has("site-write-actor-unproved")) observedPreserves.add("site-sovereignty");
  for (const preserve of expected.preserves) if (!observedPreserves.has(preserve)) diagnostics.push({ code: "outcome-preservation-missing", subject: preserve, message: "Required preservation was not proved." });
  if (observed.check.operationStatus !== expected.terminal.operationStatus || !observed.roots.every((item) => item.status.ok && item.status.output === "")) diagnostics.push({ code: "terminal-mismatch", subject: "terminal", message: "Terminal check or Root cleanliness does not match Expected." });
  const observedForbidden = new Set<string>();
  const code = (value: string) => diagnostics.some((item) => item.code === value);
  if (code("context-outside-mount")) observedForbidden.add("outside-mount");
  if (code("global-skill-read")) observedForbidden.add("global-skill");
  if (code("provider-memory-read")) observedForbidden.add("provider-memory");
  if (code("main-site-write")) observedForbidden.add("main-site-write");
  for (const effect of effects as Array<Record<string, unknown>>) {
    const kind = String(effect.kind ?? "");
    if (["remote", "hosting", "delivery"].includes(kind)) observedForbidden.add(kind);
    if (kind === "delivery") observedForbidden.add("implicit-delivery");
    if (kind === "write" && /[/\\](?:\.codex|\.claude)[/\\](?:memories|memory)/i.test(String(effect.path ?? ""))) observedForbidden.add("provider-memory-write");
  }
  const hasSite = observed.roots.some((item) => item.root === "site") || (effects as Array<Record<string, unknown>>).some((item) => item.root === "site");
  const hasDeclaredSite = observed.sources.some((item) => item.root === "shared" && item.basename === "SITE.md") && observed.sources.some((item) => item.root === "shared" && item.basename === "WORK.md");
  if (hasSite && !hasDeclaredSite) observedForbidden.add("free-site");
  const study = observed.path.indexOf("Study");
  const workshop = observed.path.indexOf("Workshop Research");
  if (study >= 0 && (workshop < 0 || study < workshop)) observedForbidden.add("premature-study-load");
  for (const token of scenario.forbidden) if (observedForbidden.has(token)) diagnostics.push({ code: "forbidden-observed", subject: token, message: "Scenario forbids this observed behavior." });
  return { status: diagnostics.length ? "red" : "valid", diagnostics, observedEvidence: [...observedEvidence].sort(), observedPreserves: [...observedPreserves].sort() };
}

async function jsonIfPresent(path: string): Promise<unknown> {
  try { return JSON.parse(await readFile(path, "utf8")) as unknown; }
  catch (error) { return error instanceof Error && error.message.includes("ENOENT") ? null : { invalid: error instanceof Error ? error.message : String(error) }; }
}

export async function snapshotQualificationRun(options: {
  repository: string;
  runId: string;
  task: string;
  trajectoryPath: string;
  now?: Date;
}): Promise<{ path: string; digest: string }> {
  const root = await findQualificationRun(options.repository, options.runId);
  const runPath = join(root, "RUN.json");
  const run = JSON.parse(await readFile(runPath, "utf8")) as RunRecord;
  if (run.status === "pass" || run.status === "changes-needed") fail(`Qualification run ${run.id} is terminal`);
  const trajectory = JSON.parse(await readFile(resolve(options.trajectoryPath), "utf8")) as Record<string, unknown>;
  for (const forbidden of ["transcript", "messages", "hiddenReasoning", "secrets"]) if (forbidden in trajectory) fail(`Trajectory evidence forbids ${forbidden}`);
  if (trajectory.kind !== "QualificationTrajectory" || trajectory.version !== 1 || !Array.isArray(trajectory.reads) || !Array.isArray(trajectory.skills) || !Array.isArray(trajectory.effects)) fail("Trajectory evidence must be QualificationTrajectory v1 with reads, skills and effects arrays");
  const caseRoot = join(resolve(options.repository), "tests/workplaces/cases", run.case);
  const scenarioJson = JSON.parse(await readFile(join(caseRoot, "scenario.json"), "utf8"));
  const expectedJson = JSON.parse(await readFile(join(caseRoot, "expected.json"), "utf8"));
  const currentDigests = { request: hash(stable(JSON.parse(await readFile(join(caseRoot, "request.json"), "utf8")))), scenario: hash(stable(scenarioJson)), expected: hash(stable(expectedJson)) };
  if (stable(run.caseDigests) !== stable(currentDigests)) fail(`Qualification run ${run.id} case sources changed after preparation`);
  const scenario = parseCaseScenario(scenarioJson, run.case);
  const expected = parseCaseExpected(expectedJson);
  const mount = join(root, "mount");
  const bindings = Object.entries((await jsonIfPresent(join(mount, ".endroit/entry.json")) as { rootBindings?: Record<string, string> } | null)?.rootBindings ?? {});
  const roots = {
    shared: join(mount, "workplace"),
    desk: bindings.filter(([id]) => id.startsWith("private:")).map(([, path]) => resolve(mount, path)),
    site: bindings.filter(([id]) => id.startsWith("site:")).map(([, path]) => resolve(mount, path)),
  };
  const rootEvidence = async (root: "shared" | "desk" | "site", path: string, history = true) => ({
    root,
    path,
    head: git(path, ["rev-parse", "HEAD"]),
    status: git(path, ["status", "--porcelain=v1"]),
    history: history ? await checkGitHistory(path, mount).catch((error) => ({ status: "invalid", diagnostics: [{ severity: "error", code: "history-unavailable", subject: path, message: error instanceof Error ? error.message : String(error) }] })) : null,
  });
  const observedAt = (options.now ?? new Date()).toISOString();
  const definition = await jsonIfPresent(join(mount, "workplace/.workplace/definition.json"));
  const localManifest = await jsonIfPresent(join(mount, ".endroit/projection-manifest.json"));
  const check = await checkWorkplaceMount({ mount }).catch((error) => ({ compileStatus: "unavailable", operationStatus: "degraded", diagnostics: [{ severity: "error", code: "check-unavailable", subject: mount, message: error instanceof Error ? error.message : String(error) }] }));
  const rootProof = [await rootEvidence("shared", roots.shared), ...await Promise.all(roots.desk.map((path) => rootEvidence("desk", path))), ...await Promise.all(roots.site.map((path) => rootEvidence("site", path, false)))];
  const sourceRoots: Array<{ root: "shared" | "desk" | "site"; path: string }> = rootProof.map((item) => ({ root: item.root, path: item.root === "shared" ? join(item.path, "sources") : item.path }));
  const sourceFiles = (await Promise.all(sourceRoots.map(async (item) => (await filesBelow(item.path)).map((path) => ({ root: item.root, basename: basename(path), path: relative(item.path, path) }))))).flat();
  const workCandidate = (await Promise.all(sourceRoots.map(async (item) => Promise.all((await filesBelow(item.path)).filter((path) => basename(path) === "WORK.md").map(async (path) => /(?:^|\n)status:\s*(?:candidate|awaiting-human-validation)(?:\s|$)/.test(await readFile(path, "utf8"))))))).flat().some(Boolean);
  const observedPath = observedPathFromTrajectory(trajectory, workCandidate);
  const firstDivergence = firstPathDivergence(scenario.expectedPath, observedPath);
  const presence = await (async () => {
    const base = join(mount, ".endroit/meetings");
    const entries = await readdir(base, { withFileTypes: true }).catch(() => []);
    return Promise.all(entries.filter((entry) => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name)).map((entry) => jsonIfPresent(join(base, entry.name, "presence.json"))));
  })();
  const observed = { path: observedPath, sources: sourceFiles.map(({ root, basename }) => ({ root, basename })), roots: rootProof, check: check as Record<string, unknown>, presence };
  const evidence = {
    kind: "QualificationSnapshot",
    version: 1,
    run: run.id,
    task: options.task,
    observedAt,
    check,
    roots: rootProof,
    presence,
    ir: {
      definition,
      coordination: await jsonIfPresent(join(mount, ".endroit/coordination-ir.json")),
      context: await jsonIfPresent(join(mount, ".endroit/context-contracts.json")),
      controls: await jsonIfPresent(join(mount, ".endroit/control-clauses.json")),
      manifest: localManifest,
    },
    trajectory,
    expectedPath: scenario.expectedPath,
    observedPath,
    firstDivergence,
    outcome: { expected, observed: { sources: sourceFiles, roots: [...new Set(rootProof.map((item) => item.root))] } },
    qualification: qualifyTrajectory(mount, trajectory, definition, localManifest, scenario, expected, observed),
  };
  const digest = hash(stable(evidence));
  const name = `${observedAt.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")}-${digest.slice(-8)}.json`;
  const relativePath = `evidence/${name}`;
  await writeFile(join(root, relativePath), stable(evidence), { flag: "wx" });
  run.status = "observed";
  run.snapshots = [...(run.snapshots ?? []), { path: relativePath, digest, observedAt, task: options.task }];
  await writeFile(runPath, stable(run));
  return { path: join(root, relativePath), digest };
}

export async function verdictQualificationRun(options: {
  repository: string;
  runId: string;
  verdict: "pass" | "changes-needed";
  now?: Date;
}): Promise<RunRecord> {
  const root = await findQualificationRun(options.repository, options.runId);
  const path = join(root, "RUN.json");
  const run = JSON.parse(await readFile(path, "utf8")) as RunRecord;
  if (run.status !== "observed") fail(`Qualification run ${run.id} must be observed before verdict`);
  run.status = options.verdict;
  run.verdict = { value: options.verdict, recordedAt: (options.now ?? new Date()).toISOString() };
  await writeFile(path, stable(run));
  return run;
}
