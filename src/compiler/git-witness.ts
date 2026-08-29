import { chmod, mkdir, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { checkStaticWorkplace, discoverMount, hash, loadCompileInput, parseSourceEnvelope, stable } from "./index.ts";
import type { Diagnostic, SourceRecord } from "./model.ts";

export type GitGuardHook = {
  root: "shared";
  rootPath: string;
  name: "pre-commit" | "commit-msg";
  digest: `sha256:${string}`;
  content: string;
};

export type GitGuardManifest = {
  kind: "GitGuardManifest";
  version: 1;
  policy: "fail-closed";
  hooks: GitGuardHook[];
};

export type GitWitnessResult = {
  status: "valid" | "degraded" | "invalid";
  diagnostics: Diagnostic[];
};

const MARKER = "# endroit-git-guard:v1";
const AUTHORITY = new Set(["human-invoked", "delegated", "prepared", "projection"]);
const SUBJECT = /^([a-z][a-z0-9-]*)\(([a-z][a-z0-9-]*):([a-z0-9][a-z0-9-]*)\): (\S.*)$/;

function fail(message: string): never { throw new Error(message); }

function git(root: string, args: string[], optional = false): string | undefined {
  const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    if (optional) return undefined;
    fail(`git ${args[0]} failed in ${root}: ${new TextDecoder().decode(result.stderr).trim()}`);
  }
  return new TextDecoder().decode(result.stdout).trim();
}

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; }
  catch (error) {
    if (error instanceof Error && error.message.includes("ENOENT")) return false;
    throw error;
  }
}

async function loadMountCompileInput(mount: string) {
  const providerRoot = join(mount, ".endroit/providers");
  const providerPaths = (await readdir(providerRoot, { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => join(providerRoot, entry.name))
    .sort();
  return loadCompileInput({
    workplacePath: join(mount, "workplace/workplace.json"),
    entryPath: join(mount, ".endroit/entry.json"),
    ...(providerPaths.length ? { providerPaths } : {}),
  });
}

function shell(value: string): string { return `'${value.replaceAll("'", `'"'"'`)}'`; }

export function planGitGuards(cliCommand: string[]): GitGuardManifest {
  const command = cliCommand.map(shell).join(" ");
  const make = (root: "shared", rootPath: string, name: "pre-commit" | "commit-msg"): GitGuardHook => {
    const message = name === "commit-msg" ? ' --commit-message "$1"' : "";
    const content = `#!/bin/sh\n${MARKER}\nexec ${command} check "$(git rev-parse --show-toplevel)" --staged${message}\n`;
    return { root, rootPath, name, digest: hash(content), content };
  };
  return {
    kind: "GitGuardManifest",
    version: 1,
    policy: "fail-closed",
    hooks: [
      make("shared", "workplace", "pre-commit"),
      make("shared", "workplace", "commit-msg"),
    ],
  };
}

export async function installGitGuards(mount: string, manifest: GitGuardManifest, repair = false): Promise<void> {
  for (const hook of manifest.hooks) {
    const root = resolve(mount, hook.rootPath);
    const hooksPath = git(root, ["config", "--local", "--get", "core.hooksPath"], true);
    if (hooksPath) fail(`Refusing existing core.hooksPath in ${root}: ${hooksPath}`);
    const target = join(root, ".git/hooks", hook.name);
    if (await exists(target)) {
      const current = await readFile(target, "utf8");
      if (current === hook.content) { await chmod(target, 0o755); continue; }
      if (!repair || !current.includes(MARKER)) fail(`Refusing foreign Git hook collision at ${target}`);
    }
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, hook.content);
    await chmod(target, 0o755);
  }
  await mkdir(join(mount, ".endroit"), { recursive: true });
  await writeFile(join(mount, ".endroit/git-guards.json"), stable(manifest));
}

async function readGuardManifest(mount: string): Promise<GitGuardManifest | undefined> {
  const path = join(mount, ".endroit/git-guards.json");
  if (!await exists(path)) return undefined;
  const value = JSON.parse(await readFile(path, "utf8")) as GitGuardManifest;
  if (value.kind !== "GitGuardManifest" || value.version !== 1 || value.policy !== "fail-closed" || !Array.isArray(value.hooks)) fail("Git guard manifest is invalid");
  return value;
}

export async function checkGitGuards(mount: string): Promise<GitWitnessResult> {
  const manifest = await readGuardManifest(mount);
  if (!manifest) return { status: "valid", diagnostics: [] };
  const diagnostics: Diagnostic[] = [];
  for (const hook of manifest.hooks) {
    const target = join(mount, hook.rootPath, ".git/hooks", hook.name);
    try {
      const bytes = await readFile(target, "utf8");
      const mode = (await stat(target)).mode;
      if (!bytes.includes(MARKER) || hash(bytes) !== hook.digest) diagnostics.push({ severity: "warning", code: "git-guard-altered", subject: target, message: "Endroit Git guard differs from its consented Preview." });
      if ((mode & 0o111) === 0) diagnostics.push({ severity: "warning", code: "git-guard-not-executable", subject: target, message: "Endroit Git guard is not executable." });
    } catch (error) {
      diagnostics.push({ severity: "warning", code: "git-guard-missing", subject: target, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return { status: diagnostics.length > 0 ? "degraded" : "valid", diagnostics };
}

export async function repairGitGuards(mount: string): Promise<boolean> {
  const manifest = await readGuardManifest(mount);
  if (!manifest) return false;
  const before = await checkGitGuards(mount);
  if (before.status === "valid") return false;
  await installGitGuards(mount, manifest, true);
  return true;
}

type CommitContract = {
  operation: string;
  kind: string;
  slug: string;
  trailers: Map<string, string>;
};

export function parseCommitContract(message: string): CommitContract {
  const lines = message.replace(/\r\n/g, "\n").trimEnd().split("\n");
  const subject = SUBJECT.exec(lines[0] ?? "") ?? fail("Commit subject must be <operation>(<kind>:<slug>): <observed effect>");
  const trailers = new Map<string, string>();
  let index = lines.length - 1;
  while (index > 0 && /^[A-Za-z][A-Za-z-]*: \S/.test(lines[index] ?? "")) {
    const line = lines[index]!;
    const separator = line.indexOf(": ");
    const key = line.slice(0, separator);
    if (trailers.has(key)) fail(`Duplicate commit trailer ${key}`);
    trailers.set(key, line.slice(separator + 2));
    index--;
  }
  const unknown = [...trailers.keys()].filter((key) => !["Meeting", "Authority", "Mandate", "Work", "Plan-Revision", "Build", "State"].includes(key));
  if (unknown.length > 0) fail(`Unknown commit trailers: ${unknown.sort().join(", ")}`);
  return { operation: subject[1]!, kind: subject[2]!, slug: subject[3]!, trailers };
}

function validateTrailerShape(contract: CommitContract, bootstrap = false): void {
  const authority = contract.trailers.get("Authority");
  if (!authority || !AUTHORITY.has(authority)) fail("Commit requires one valid Authority trailer");
  if (!bootstrap && !contract.trailers.get("Meeting")) fail("Non-bootstrap commit requires Meeting");
  if (authority === "delegated" && !contract.trailers.get("Mandate")) fail("Delegated commit requires Mandate");
  if (authority !== "delegated" && contract.trailers.has("Mandate")) fail("Mandate is valid only with delegated Authority");
  if (contract.kind === "work" && !contract.trailers.get("Work")) fail("Work mutation requires Work trailer");
  if (contract.kind === "site" && (!contract.trailers.get("Work") || !/^\S+@[0-9a-f]{7,64}$/.test(contract.trailers.get("Plan-Revision") ?? ""))) fail("Site commit requires Work and Plan-Revision <root-ref>@<oid>");
  if (contract.operation === "compile" && (!contract.trailers.get("Build") || authority !== "projection")) fail("compile commit requires projection Authority and Build");
  if (contract.operation !== "compile" && contract.trailers.has("Build")) fail("Build is valid only for compile commits");
}

function treeMeeting(root: string, revision: string, ref: string): SourceRecord | undefined {
  const paths = (git(root, ["ls-tree", "-r", "--name-only", revision], true) ?? "").split("\n").filter((path) => path.endsWith("MEETING.md"));
  for (const path of paths) {
    const bytes = git(root, ["show", `${revision}:${path}`], true);
    if (!bytes) continue;
    try {
      const source = parseSourceEnvelope(`${bytes}\n`, path);
      if (source.envelope.ref === ref) return source;
    } catch { /* another profile's Meeting is not a witness here */ }
  }
  return undefined;
}

async function mountRoots(mount: string): Promise<string[]> {
  const roots = [join(mount, "workplace")];
  try {
    const entry = JSON.parse(await readFile(join(mount, ".endroit/entry.json"), "utf8")) as { rootBindings?: Record<string, string> };
    for (const [id, path] of Object.entries(entry.rootBindings ?? {})) if (id.split(":", 1)[0] !== "site") roots.push(resolve(mount, path));
  } catch { /* neutral mount */ }
  const exact: string[] = [];
  for (const root of new Set(roots)) {
    const top = git(root, ["rev-parse", "--show-toplevel"], true);
    if (top && await realpath(top) === await realpath(root)) exact.push(root);
  }
  return exact;
}

async function meetingWitness(mount: string, currentRoot: string, revision: string, contract: CommitContract): Promise<SourceRecord | undefined> {
  const ref = contract.trailers.get("Meeting");
  if (!ref) return undefined;
  const local = treeMeeting(currentRoot, revision, ref);
  if (local) return local;
  const planRevision = contract.trailers.get("Plan-Revision")?.split("@").at(-1);
  if (!planRevision) return undefined;
  for (const root of await mountRoots(mount)) if (root !== currentRoot && git(root, ["cat-file", "-e", `${planRevision}^{commit}`], true) !== undefined) {
    const source = treeMeeting(root, planRevision, ref);
    if (source) return source;
  }
  return undefined;
}

function requireIntegrationDispatch(meeting: SourceRecord, workRef: string): void {
  const manager = meeting.envelope.occupants?.some((occupant) => occupant.role === "manager");
  const workers = meeting.envelope.occupants?.filter((occupant) => occupant.role === "worker") ?? [];
  if (!manager || workers.length === 0) fail(`Meeting ${meeting.envelope.ref} lacks Manager or Worker Occupants for ${workRef}`);
  for (const worker of workers) {
    const dispatch = meeting.envelope.dispatches?.find((item) => item.occupant === worker.id && item.work === workRef && ["active", "complete"].includes(item.status));
    if (!dispatch) fail(`Meeting ${meeting.envelope.ref} lacks a complete-envelope dispatch for Worker ${worker.id}`);
  }
}

async function hasMeetingPresence(mount: string, meetingRef: string): Promise<boolean> {
  const root = join(mount, ".endroit/meetings");
  const entries = await readdir(root, { withFileTypes: true }).catch((error) => error instanceof Error && error.message.includes("ENOENT") ? [] : Promise.reject(error));
  for (const entry of entries) if (entry.isDirectory()) {
    try {
      const value = JSON.parse(await readFile(join(root, entry.name, "presence.json"), "utf8")) as { kind?: string; version?: number; meetingRef?: string; lifecycle?: string };
      if (value.kind === "MeetingPresence" && value.version === 1 && value.meetingRef === meetingRef && value.lifecycle === "active") return true;
    } catch { /* malformed or unrelated presence cannot prove coordination */ }
  }
  return false;
}

export async function checkGitHistory(root: string, mount?: string): Promise<GitWitnessResult> {
  const resolvedRoot = resolve(root);
  const resolvedMount = mount ?? await discoverMount(resolvedRoot) ?? fail(`No Workplace Mount found from ${resolvedRoot}`);
  const diagnostics: Diagnostic[] = [];
  const commits = (git(resolvedRoot, ["rev-list", "--first-parent", "--reverse", "HEAD"], true) ?? "").split("\n").filter(Boolean);
  for (const [commitIndex, oid] of commits.entries()) {
    const parents = (git(resolvedRoot, ["show", "-s", "--format=%P", oid]) ?? "").split(/\s+/).filter(Boolean);
    if (parents.length > 1) { diagnostics.push({ severity: "error", code: "git-merge-implicit", subject: oid, message: "First-parent history contains a merge commit." }); continue; }
    try {
      const contract = parseCommitContract(git(resolvedRoot, ["show", "-s", "--format=%B", oid]) ?? "");
      const bootstrap = (commitIndex === 0 && contract.operation === "adopt") || (commitIndex === 1 && contract.operation === "compile" && parents.length === 1);
      validateTrailerShape(contract, bootstrap);
      if (contract.operation === "compile" && contract.trailers.get("Build") !== parents[0]) fail(`Build must equal the exact parent source OID ${parents[0] ?? "missing"}`);
      const meetingRef = contract.trailers.get("Meeting");
      if (!meetingRef) continue;
      const witness = await meetingWitness(resolvedMount, resolvedRoot, oid, contract);
      const parentWitness = parents[0] ? await meetingWitness(resolvedMount, resolvedRoot, parents[0], contract) : undefined;
      const valid = witness && (["active", "settling"].includes(String(witness.envelope.lifecycle)) || (witness.envelope.lifecycle === "closed" && ["active", "settling"].includes(String(parentWitness?.envelope.lifecycle))));
      if (!valid) fail(`Meeting ${meetingRef} is orphan, inactive, out of scope or not causally pinned`);
      if (contract.operation === "open-work") requireIntegrationDispatch(witness, contract.trailers.get("Work") ?? fail("open-work requires Work"));
    } catch (error) {
      diagnostics.push({ severity: "error", code: "git-witness-invalid", subject: oid, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return { status: diagnostics.length > 0 ? "invalid" : "valid", diagnostics };
}

function classify(root: string, mount: string, path: string): "source" | "projection" | "foreign" {
  const shared = resolve(root) === resolve(mount, "workplace");
  if (shared && (path === "WORKPLACE.md" || path.startsWith(".workplace/"))) return "projection";
  if (shared && (path.startsWith("sources/") || ["profile.json", "composition.json", "coordination.json", "workplace.json", "links.json", ".workplaceignore"].includes(path))) return "source";
  if (!shared && path.endsWith(".md")) return "source";
  return "foreign";
}

export async function checkGitStaged(options: { start: string; commitMessage?: string }): Promise<GitWitnessResult> {
  const root = git(resolve(options.start), ["rev-parse", "--show-toplevel"])!;
  const mount = await discoverMount(root) ?? fail(`No Workplace Mount found from ${root}`);
  const diagnostics: Diagnostic[] = [];
  const rows = (git(root, ["diff", "--cached", "--name-status", "--diff-filter=ACDMRTUXB"]) ?? "").split("\n").filter(Boolean).map((line) => {
    const [status, ...paths] = line.split("\t");
    return { status: status!, path: paths.at(-1)! };
  });
  const classes = new Set(rows.map((row) => classify(root, mount, row.path)));
  if (classes.has("foreign")) diagnostics.push({ severity: "error", code: "staged-foreign", subject: root, message: "Staged paths include files outside the Root contract." });
  if (classes.has("source") && classes.has("projection")) diagnostics.push({ severity: "error", code: "staged-mixed-responsibility", subject: root, message: "Owned sources and projections require separate commits." });
  const unstagedSources = (git(root, ["diff", "--name-only"]) ?? "").split("\n").filter((path) => classify(root, mount, path) === "source");
  if (classes.has("source") && unstagedSources.length > 0) diagnostics.push({ severity: "error", code: "staged-source-worktree-ambiguous", subject: root, message: `Unstaged source changes prevent exact index validation: ${unstagedSources.join(", ")}` });
  for (const row of rows) {
    if (row.status.startsWith("R") || row.status.startsWith("C")) diagnostics.push({ severity: "error", code: "staged-rename-unsupported", subject: row.path, message: "Stage rename as explicit delete/add after validating the semantic effect." });
    if (row.status === "D") continue;
    const indexed = git(root, ["show", `:${row.path}`]) ?? "";
    const working = await readFile(join(root, row.path), "utf8").catch(() => "");
    if (indexed !== working.trimEnd()) diagnostics.push({ severity: "error", code: "staged-partial-file", subject: row.path, message: "Partial-file staging is unsupported; staged bytes must equal the working file." });
    if (classify(root, mount, row.path) === "source" && row.path.endsWith(".md")) {
      try { parseSourceEnvelope(`${indexed}\n`, row.path); }
      catch (error) { diagnostics.push({ severity: "error", code: "staged-source-invalid", subject: row.path, message: error instanceof Error ? error.message : String(error) }); }
    }
  }
  try { await loadMountCompileInput(mount); }
  catch (error) { diagnostics.push({ severity: "error", code: "staged-graph-invalid", subject: root, message: error instanceof Error ? error.message : String(error) }); }
  if (classes.has("projection")) {
    const compiled = await checkStaticWorkplace({ mount });
    if (compiled.compileStatus !== "valid") diagnostics.push({ severity: "error", code: "staged-projection-not-compiler-owned", subject: root, message: "Projection bytes do not match the public Manifest." });
  }
  if (options.commitMessage) {
    try {
      const contract = parseCommitContract(options.commitMessage);
      const count = Number(git(root, ["rev-list", "--count", "HEAD"], true) ?? "0");
      const bootstrap = (count === 0 && contract.operation === "adopt") || (count === 1 && contract.operation === "compile");
      validateTrailerShape(contract, bootstrap);
      if (contract.operation === "compile" && contract.trailers.get("Build") !== git(root, ["rev-parse", "HEAD"], true)) fail("Build must equal the exact current source OID");
      const meetingRef = contract.trailers.get("Meeting");
      if (meetingRef) {
        const input = await loadMountCompileInput(mount);
        const meeting = input.sources.find((source) => source.envelope.ref === meetingRef && source.envelope.entity === "meeting");
        if (!meeting || !["active", "settling", "closed"].includes(String(meeting.envelope.lifecycle))) fail(`Meeting ${meetingRef} is unresolved or inactive`);
        if (meeting.envelope.lifecycle === "closed") {
          const parent = treeMeeting(root, "HEAD", meetingRef);
          if (!parent || !["active", "settling"].includes(String(parent.envelope.lifecycle))) fail(`Closed Meeting ${meetingRef} was not active in the parent`);
        }
        if (contract.operation === "open-work") {
          const workRef = contract.trailers.get("Work") ?? fail("open-work requires Work");
          requireIntegrationDispatch(meeting, workRef);
          if (!await hasMeetingPresence(mount, meetingRef)) fail(`Meeting ${meetingRef} has no active local presence for integration`);
        }
      }
      if (classes.has("projection") && contract.operation !== "compile") fail("Projection batch requires compile operation");
      if (classes.has("source") && contract.operation === "compile") fail("compile operation cannot commit owned sources");
    } catch (error) { diagnostics.push({ severity: "error", code: "commit-message-invalid", subject: root, message: error instanceof Error ? error.message : String(error) }); }
  }
  return { status: diagnostics.length > 0 ? "invalid" : "valid", diagnostics };
}

export async function checkMountGit(mount: string): Promise<GitWitnessResult> {
  const diagnostics: Diagnostic[] = [];
  for (const root of await mountRoots(mount)) diagnostics.push(...(await checkGitHistory(root, mount)).diagnostics);
  const guards = await checkGitGuards(mount);
  diagnostics.push(...guards.diagnostics);
  if (await exists(join(mount, ".endroit/entry.json"))) try {
    const input = await loadMountCompileInput(mount);
    const integrationWorks = input.sources.filter((source) => source.envelope.entity === "work" && (source.envelope.relations.targets?.length ?? 0) > 0);
    const qualifiedRoles = new Set((input.provider?.targets ?? []).filter((target) => target.kind === "agent" && target.loadGuarantee === "qualified").map((target) => target.path.split("/").at(-1)?.replace(/\.md$/, "")));
    for (const work of integrationWorks) {
      const meeting = input.sources.find((source) => source.envelope.entity === "meeting" && ["active", "settling"].includes(String(source.envelope.lifecycle)) && (source.envelope.primaryWork === work.envelope.ref || source.envelope.relatedWorks?.includes(work.envelope.ref) || source.envelope.relations.advances?.includes(work.envelope.ref)));
      if (!meeting) continue;
      if (!qualifiedRoles.has("manager") || !qualifiedRoles.has("worker")) diagnostics.push({ severity: "error", code: "coordination-provider-blocked", subject: work.envelope.ref, message: "Integration requires qualified Manager and Worker provider targets; no Main fallback is allowed." });
      if (!await hasMeetingPresence(mount, meeting.envelope.ref)) diagnostics.push({ severity: "error", code: "coordination-presence-missing", subject: meeting.envelope.ref, message: "Integration has no active local Meeting presence." });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/Profile Package|ProfileSelection|Profile selection or Package/.test(message)) diagnostics.push({ severity: "error", code: "coordination-proof-invalid", subject: mount, message });
  }
  return {
    status: diagnostics.some((item) => item.severity === "error") ? "invalid" : diagnostics.length > 0 ? "degraded" : "valid",
    diagnostics,
  };
}
