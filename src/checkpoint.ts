import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { hash, stable } from "./compiler/index.ts";
import { gitArguments, gitTransportArguments } from "./platform.ts";

const REF = /^workplace:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
const REVISION = /^sha256:[a-f0-9]{64}$/;
const OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const ID = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const CHECKPOINT_ID = /^checkpoint:sha256:[a-f0-9]{64}$/;
const INDEX_SCHEMA = "workplace-checkpoint-index/1" as const;

export type CheckpointCaptureRequest = {
  kind: "CheckpointCaptureRequest";
  version: 1;
  workplace: string;
  workplaceRevision: string;
  ownerMember: string;
  line: string;
  parentCheckpoint: string | null;
  sourceRoot: string;
  output: string;
  roots: Array<{
    ref: string;
    worktrees: Array<{ id: string; path: string; logicalPath: string }>;
  }>;
  policy: { includeUntracked: boolean };
};

type RefRecord = { name: string; oid: string };
type RemoteRecord = { name: string; urls: string[] };
type IndexEntry = { path: string; stage: number; mode: string; oid: string; assumeUnchanged: boolean; skipWorktree: boolean; intentToAdd: boolean };
type ContentRecord = { path: string; kind: "regular" | "symlink" | "absent"; mode: string; sha256?: string; size?: number; payload?: string };
type OperationRecord = { path: string; sha256: string; size: number; payload: string };

export type RepositorySnapshot = {
  schema: "workplace-checkpoint-repository/1";
  repositoryId: string;
  rootRef: string;
  objectFormat: string;
  refs: RefRecord[];
  remotes: RemoteRecord[];
  config: Record<string, string>;
  worktrees: string[];
  objectClosure: { digest: string; objects: number };
  bundle: { path: string; sha256: string; size: number };
};

export type WorktreeSnapshot = {
  schema: "workplace-checkpoint-worktree/1";
  worktreeId: string;
  repositoryId: string;
  logicalPath: string;
  head: string;
  branchRef: string | null;
  index: { schema: typeof INDEX_SCHEMA; entries: IndexEntry[]; unsupportedExtensions: string[] };
  tracked: ContentRecord[];
  untracked: ContentRecord[];
  operation: OperationRecord[];
};

type PayloadRecord = { sha256: string; size: number; path: string };

export type CheckpointManifest = {
  schema: "workplace-checkpoint-manifest/1";
  checkpointId: string;
  workplaceRef: string;
  workplaceRevision: string;
  ownerMember: string;
  line: string;
  parentCheckpoint: string | null;
  fidelityPolicy: CheckpointCaptureRequest["policy"];
  repositories: RepositorySnapshot[];
  worktrees: WorktreeSnapshot[];
  payloads: PayloadRecord[];
  compatibility: { platform: string; objectFormats: string[]; symlinks: true };
  portableFingerprint: string;
};

export type CheckpointReceipt = {
  schema: "workplace-checkpoint-receipt/1";
  operation: "capture" | "verify" | "restore";
  checkpointId: string;
  workplaceRef: string;
  portableFingerprint: string;
  status: "captured" | "verified-local" | "restored-equivalent";
  coverage: { repositories: number; worktrees: number; untracked: number; exclusions: string[] };
};

export type CheckpointRestorePlan = {
  schema: "workplace-checkpoint-restore-plan/1";
  checkpointId: string;
  repositories: Array<{ repositoryId: string; rootRef: string; objectFormat: string; bundle: string; refs: number; worktrees: string[] }>;
  worktrees: Array<{ worktreeId: string; repositoryId: string; logicalPath: string; head: string; branchRef: string | null; indexEntries: number; tracked: number; untracked: number; operation: number }>;
};

export class CheckpointError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "CheckpointError";
  }
}

function fail(code: string, message: string): never {
  throw new CheckpointError(code, message);
}

function object(value: unknown, subject: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("checkpoint-schema-invalid", `${subject} must be an object`);
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, allowed: string[], subject: string, required = allowed): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  const missing = required.filter((key) => !(key in value));
  if (unknown.length) fail("checkpoint-schema-invalid", `${subject} has unknown fields: ${unknown.join(", ")}`);
  if (missing.length) fail("checkpoint-schema-invalid", `${subject} is missing fields: ${missing.join(", ")}`);
}

function semanticRef(value: unknown, subject: string): string {
  if (typeof value !== "string" || !REF.test(value)) fail("checkpoint-schema-invalid", `${subject} must be a fully qualified Workplace ref`);
  return value;
}

function ownerMember(value: unknown, workplace: string, subject: string): string {
  const member = semanticRef(value, subject);
  if (!member.startsWith(`${workplace}/member/`)) fail("checkpoint-schema-invalid", `${subject} must belong to ${workplace}`);
  return member;
}

function localText(value: unknown, subject: string): string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) fail("checkpoint-schema-invalid", `${subject} must be non-empty text`);
  return value.trim();
}

function logicalPath(value: unknown, subject: string): string {
  const path = localText(value, subject).replaceAll("\\", "/");
  if (path.startsWith("/") || /^[A-Za-z]:\//.test(path) || path.split("/").some((part) => !part || part === "." || part === "..")) fail("checkpoint-path-invalid", `${subject} must be a safe relative path`);
  return path;
}

function parseCaptureRequest(value: unknown, requestDirectory: string): CheckpointCaptureRequest {
  const source = object(value, "CheckpointCaptureRequest");
  exact(source, ["kind", "version", "workplace", "workplaceRevision", "ownerMember", "line", "parentCheckpoint", "sourceRoot", "output", "roots", "policy"], "CheckpointCaptureRequest", ["kind", "version", "workplace", "workplaceRevision", "ownerMember", "sourceRoot", "output", "roots", "policy"]);
  if (source.kind !== "CheckpointCaptureRequest" || source.version !== 1) fail("checkpoint-schema-invalid", "Unsupported CheckpointCaptureRequest");
  if (typeof source.workplaceRevision !== "string" || !REVISION.test(source.workplaceRevision)) fail("checkpoint-schema-invalid", "workplaceRevision must be sha256");
  if (!Array.isArray(source.roots) || source.roots.length === 0) fail("checkpoint-schema-invalid", "roots must be a non-empty array");
  const workplace = semanticRef(source.workplace, "workplace");
  const line = source.line === undefined ? "main" : localText(source.line, "line");
  if (!ID.test(line)) fail("checkpoint-schema-invalid", "line must be a slug");
  const parentCheckpoint = source.parentCheckpoint === undefined || source.parentCheckpoint === null ? null : localText(source.parentCheckpoint, "parentCheckpoint");
  if (parentCheckpoint !== null && !CHECKPOINT_ID.test(parentCheckpoint)) fail("checkpoint-schema-invalid", "parentCheckpoint must be a checkpoint ID or null");
  const sourceRoot = resolve(requestDirectory, localText(source.sourceRoot, "sourceRoot"));
  const output = resolve(requestDirectory, localText(source.output, "output"));
  const worktreeIds = new Set<string>();
  const logicalPaths = new Set<string>();
  const roots = source.roots.map((value, rootIndex) => {
    const subject = `roots[${rootIndex}]`;
    const root = object(value, subject);
    exact(root, ["ref", "worktrees"], subject);
    if (!Array.isArray(root.worktrees) || root.worktrees.length === 0) fail("checkpoint-schema-invalid", `${subject}.worktrees must be non-empty`);
    return {
      ref: semanticRef(root.ref, `${subject}.ref`),
      worktrees: root.worktrees.map((value, worktreeIndex) => {
        const worktreeSubject = `${subject}.worktrees[${worktreeIndex}]`;
        const worktree = object(value, worktreeSubject);
        exact(worktree, ["id", "path", "logicalPath"], worktreeSubject);
        if (typeof worktree.id !== "string" || !ID.test(worktree.id) || worktreeIds.has(worktree.id)) fail("checkpoint-schema-invalid", `${worktreeSubject}.id must be a unique slug`);
        const portable = logicalPath(worktree.logicalPath, `${worktreeSubject}.logicalPath`);
        if (logicalPaths.has(portable)) fail("checkpoint-schema-invalid", `${portable} is a duplicate logicalPath`);
        worktreeIds.add(worktree.id);
        logicalPaths.add(portable);
        const path = resolve(sourceRoot, localText(worktree.path, `${worktreeSubject}.path`));
        if (!inside(sourceRoot, path)) fail("checkpoint-path-invalid", `${worktreeSubject}.path escapes sourceRoot`);
        return { id: worktree.id, path, logicalPath: portable };
      }),
    };
  });
  if (new Set(roots.map((root) => root.ref)).size !== roots.length) fail("checkpoint-schema-invalid", "Root refs must be unique");
  const policy = object(source.policy, "policy");
  exact(policy, ["includeUntracked"], "policy");
  if (typeof policy.includeUntracked !== "boolean") fail("checkpoint-schema-invalid", "policy is invalid");
  return { kind: "CheckpointCaptureRequest", version: 1, workplace, workplaceRevision: source.workplaceRevision, ownerMember: ownerMember(source.ownerMember, workplace, "ownerMember"), line, parentCheckpoint, sourceRoot, output, roots, policy: { includeUntracked: policy.includeUntracked } };
}

function command(cwd: string, args: string[], input?: string | Uint8Array, extraEnv: Record<string, string> = {}): Uint8Array {
  const result = spawnSync(args[0]!, args[0] === "git" ? gitArguments(args.slice(1)) : args.slice(1), { cwd, ...(input === undefined ? {} : { input }), env: { ...process.env, LC_ALL: "C", GIT_NO_REPLACE_OBJECTS: "1", ...extraEnv }, maxBuffer: 512 * 1024 * 1024 });
  if (result.status !== 0) fail("checkpoint-git-failed", `${args.slice(0, 3).join(" ")} failed: ${new TextDecoder().decode(result.stderr).trim()}`);
  return result.stdout;
}

function git(cwd: string, args: string[], input?: string | Uint8Array, env: Record<string, string> = {}): Uint8Array {
  return command(cwd, ["git", ...args], input, env);
}

function text(bytes: Uint8Array): string { return new TextDecoder().decode(bytes).trim(); }
function nul(bytes: Uint8Array): string[] { return new TextDecoder().decode(bytes).split("\0").filter(Boolean); }

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) {
    if (error instanceof Error && error.message.includes("ENOENT")) return false;
    throw error;
  }
}

function inside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !/^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(path));
}

function portableMode(statMode: number, symlinked = false): string {
  return symlinked ? "120000" : statMode & 0o111 ? "100755" : "100644";
}

async function digestFile(path: string): Promise<{ sha256: string; size: number; bytes: Uint8Array }> {
  const bytes = new Uint8Array(await readFile(path));
  return { sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"), size: bytes.byteLength, bytes };
}

async function storePayload(packageRoot: string, bytes: Uint8Array, payloads: Map<string, PayloadRecord>): Promise<PayloadRecord> {
  const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  const path = `payloads/${sha256}`;
  const record = { sha256, size: bytes.byteLength, path };
  if (!payloads.has(sha256)) {
    payloads.set(sha256, record);
    await mkdir(join(packageRoot, "payloads"), { recursive: true });
    await writeFile(join(packageRoot, path), bytes, { flag: "wx" });
  }
  return record;
}

async function contentRecord(worktree: string, path: string, packageRoot: string, payloads: Map<string, PayloadRecord>): Promise<ContentRecord> {
  logicalPath(path, "captured path");
  const absolute = resolve(worktree, path);
  if (!inside(worktree, absolute)) fail("checkpoint-path-invalid", `${path} escapes its worktree`);
  let info;
  try { info = await lstat(absolute); }
  catch (error) {
    if (error instanceof Error && error.message.includes("ENOENT")) return { path, kind: "absent", mode: "000000" };
    throw error;
  }
  let bytes: Uint8Array;
  let kind: "regular" | "symlink";
  if (info.isSymbolicLink()) {
    kind = "symlink";
    bytes = new TextEncoder().encode(await readlink(absolute));
  } else if (info.isFile()) {
    kind = "regular";
    bytes = new Uint8Array(await readFile(absolute));
  } else fail("checkpoint-file-unsupported", `${path} is not a regular file or symlink`);
  const payload = await storePayload(packageRoot, bytes, payloads);
  return { path, kind, mode: portableMode(info.mode, kind === "symlink"), sha256: payload.sha256, size: payload.size, payload: payload.path };
}

function indexFlags(worktree: string, path: string): { assumeUnchanged: boolean; skipWorktree: boolean; intentToAdd: boolean } {
  const debug = new TextDecoder().decode(git(worktree, ["ls-files", "--debug", "--", path]));
  const match = debug.match(/flags: ([0-9a-f]+)\s*$/i);
  const flags = match ? Number.parseInt(match[1]!, 16) : 0;
  return { assumeUnchanged: Boolean(flags & 0x8000), intentToAdd: Boolean(flags & 0x20000000), skipWorktree: Boolean(flags & 0x40000000) };
}

function indexSnapshot(worktree: string) {
  const entries = nul(git(worktree, ["ls-files", "--stage", "-z"])).map((record) => {
    const tab = record.indexOf("\t");
    if (tab < 0) fail("checkpoint-index-invalid", "git emitted an invalid index record");
    const [mode, oid, stageText] = record.slice(0, tab).split(" ");
    const path = logicalPath(record.slice(tab + 1), "index path");
    if (!mode || !oid || !stageText || !OID.test(oid)) fail("checkpoint-index-invalid", `Invalid index entry for ${path}`);
    return { path, stage: Number(stageText), mode, oid, ...indexFlags(worktree, path) };
  }).sort((a, b) => a.path.localeCompare(b.path) || a.stage - b.stage);
  return { schema: INDEX_SCHEMA, entries, unsupportedExtensions: [] };
}

const OPERATION_FILES = ["MERGE_HEAD", "MERGE_MSG", "MERGE_MODE", "AUTO_MERGE", "CHERRY_PICK_HEAD", "REVERT_HEAD", "REBASE_HEAD"];
const OPERATION_DIRECTORIES = ["rebase-merge", "rebase-apply", "sequencer"];

function allowedOperationPath(path: string): boolean {
  return OPERATION_FILES.includes(path) || OPERATION_DIRECTORIES.some((directory) => path.startsWith(`${directory}/`));
}

async function inspectWorktree(declared: CheckpointCaptureRequest["roots"][number]["worktrees"][number], repositoryId: string, request: CheckpointCaptureRequest, packageRoot: string, payloads: Map<string, PayloadRecord>): Promise<WorktreeSnapshot & { commonGitDir: string; requiredOids: string[] }> {
  const root = await realpath(declared.path).catch(() => fail("checkpoint-worktree-unavailable", `${declared.path} is unavailable`));
  const common = await realpath(resolve(root, text(git(root, ["rev-parse", "--git-common-dir"]))));
  const gitDir = resolve(root, text(git(root, ["rev-parse", "--git-dir"])));
  if (text(git(root, ["submodule", "status", "--recursive"]))) fail("checkpoint-submodule-unsupported", `${declared.id} contains a checked-out submodule`);
  const index = indexSnapshot(root);
  const trackedPaths = [...new Set(nul(git(root, ["ls-files", "-z"])))].sort();
  const tracked = await Promise.all(trackedPaths.map((path) => contentRecord(root, path, packageRoot, payloads)));
  const untrackedPaths = request.policy.includeUntracked ? nul(git(root, ["ls-files", "--others", "--exclude-standard", "-z"])).sort() : [];
  const untracked = await Promise.all(untrackedPaths.map((path) => contentRecord(root, path, packageRoot, payloads)));
  const operation: OperationRecord[] = [];
  const operationPaths = [...OPERATION_FILES];
  for (const directory of OPERATION_DIRECTORIES) {
    const absolute = join(gitDir, directory);
    if (await exists(absolute)) operationPaths.push(...await filesBelow(gitDir, absolute));
  }
  const operationOids: string[] = [];
  for (const path of [...new Set(operationPaths)].sort()) {
    const absolute = join(gitDir, path);
    if (!await exists(absolute)) continue;
    const info = await lstat(absolute);
    if (!info.isFile()) fail("checkpoint-operation-unsupported", `${declared.id}:${path} is not a file`);
    const bytes = new Uint8Array(await readFile(absolute));
    const stored = await storePayload(packageRoot, bytes, payloads);
    operation.push({ path, sha256: stored.sha256, size: stored.size, payload: stored.path });
    operationOids.push(...new TextDecoder().decode(bytes).split(/[^a-f0-9]+/i).filter((value) => {
      if (!OID.test(value)) return false;
      return Bun.spawnSync(["git", ...gitArguments(["cat-file", "-e", `${value}^{object}`])], { cwd: root, stdout: "pipe", stderr: "pipe" }).exitCode === 0;
    }));
  }
  const head = text(git(root, ["rev-parse", "HEAD"]));
  const branch = Bun.spawnSync(["git", ...gitArguments(["symbolic-ref", "--quiet", "HEAD"])], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const branchRef = branch.exitCode === 0 ? text(branch.stdout) : null;
  const requiredOids = [...new Set([head, ...index.entries.map((entry) => entry.oid), ...operationOids])];
  return { schema: "workplace-checkpoint-worktree/1", worktreeId: declared.id, repositoryId, logicalPath: declared.logicalPath, head, branchRef, index, tracked, untracked, operation, commonGitDir: common, requiredOids };
}

function refs(root: string): RefRecord[] {
  return text(git(root, ["for-each-ref", "--format=%(refname) %(objectname)"]))
    .split("\n").filter(Boolean)
    .map((line) => { const space = line.indexOf(" "); return { name: line.slice(0, space), oid: line.slice(space + 1) }; })
    .filter((ref) => !ref.name.startsWith("refs/endroit/checkpoints/") && !ref.name.startsWith("refs/endroit/capture/"))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function sanitizeUrl(value: string): string {
  if (!/^https?:\/\//i.test(value)) return value;
  const url = new URL(value);
  url.username = "";
  url.password = "";
  return url.toString();
}

function remotes(root: string): RemoteRecord[] {
  return text(git(root, ["remote"])).split("\n").filter(Boolean).sort().map((name) => ({
    name,
    urls: text(git(root, ["remote", "get-url", "--all", name])).split("\n").filter(Boolean).map(sanitizeUrl),
  }));
}

function portableConfig(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of ["core.autocrlf", "core.eol", "core.filemode", "core.symlinks"]) {
    const observed = Bun.spawnSync(["git", ...gitArguments(["config", "--local", "--get", key])], { cwd: root, stdout: "pipe", stderr: "pipe" });
    if (observed.exitCode === 0) result[key] = text(observed.stdout);
  }
  return result;
}

function objectClosure(root: string, sourceRefs: RefRecord[], requiredOids: string[]): { digest: string; objects: number } {
  const objects = new Set<string>();
  for (const oid of [...new Set([...sourceRefs.map((ref) => ref.oid), ...requiredOids])]) {
    objects.add(oid);
    const type = text(git(root, ["cat-file", "-t", oid]));
    if (type === "blob") continue;
    for (const line of text(git(root, ["rev-list", "--objects", oid, "--"])).split("\n").filter(Boolean)) objects.add(line.split(" ", 1)[0]!);
  }
  const sorted = [...objects].sort();
  return { digest: hash(stable(sorted)), objects: sorted.length };
}

async function copyObject(source: string, targetBare: string, oid: string): Promise<string> {
  const type = text(git(source, ["cat-file", "-t", oid]));
  if (type === "blob") {
    const bytes = git(source, ["cat-file", "blob", oid]);
    const observed = text(git(targetBare, ["hash-object", "-w", "--stdin"], bytes));
    if (observed !== oid) fail("checkpoint-object-mismatch", `Object ${oid} changed while copying`);
    return type;
  }
  git(targetBare, ["fetch", ...gitTransportArguments("fetch", source), "--no-tags", source, oid]);
  git(targetBare, ["update-ref", `refs/endroit/capture/object-${oid}`, oid]);
  return type;
}

async function createBundle(source: string, destination: string, sourceRefs: RefRecord[], worktrees: Array<WorktreeSnapshot & { requiredOids: string[] }>): Promise<void> {
  await mkdir(dirname(destination), { recursive: true });
  const temporary = await mkdtemp(join(dirname(destination), ".repository-build-"));
  try {
    git(temporary, ["init", "--bare", "-q"]);
    for (const ref of sourceRefs) git(temporary, ["fetch", ...gitTransportArguments("fetch", source), "--no-tags", source, `+${ref.name}:${ref.name}`]);
    const indexEntries = worktrees.flatMap((worktree) => worktree.index.entries);
    const required = [...new Set(worktrees.flatMap((worktree) => worktree.requiredOids))].sort();
    for (const oid of required) await copyObject(source, temporary, oid);
    if (indexEntries.length > 0) {
      const syntheticIndex = join(temporary, "capture-index");
      const uniqueBlobs = [...new Map(indexEntries.filter((entry) => entry.mode !== "160000").map((entry) => [entry.oid, entry])).values()];
      const input = uniqueBlobs.map((entry, index) => `${entry.mode} ${entry.oid}\tobjects/${String(index).padStart(8, "0")}\0`).join("");
      git(temporary, ["read-tree", "--empty"], undefined, { GIT_INDEX_FILE: syntheticIndex });
      git(temporary, ["update-index", "-z", "--index-info"], input, { GIT_INDEX_FILE: syntheticIndex });
      const tree = text(git(temporary, ["write-tree"], undefined, { GIT_INDEX_FILE: syntheticIndex }));
      const commit = text(git(temporary, ["commit-tree", tree, "-m", "Endroit checkpoint object anchor"], undefined, {
        GIT_AUTHOR_NAME: "Endroit Checkpoint", GIT_AUTHOR_EMAIL: "checkpoint@endroit.invalid", GIT_AUTHOR_DATE: "@0 +0000",
        GIT_COMMITTER_NAME: "Endroit Checkpoint", GIT_COMMITTER_EMAIL: "checkpoint@endroit.invalid", GIT_COMMITTER_DATE: "@0 +0000",
      }));
      git(temporary, ["update-ref", "refs/endroit/capture/index", commit]);
    }
    git(temporary, ["bundle", "create", destination, "--all"]);
    git(temporary, ["bundle", "verify", destination]);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

function semanticRepository(repository: RepositorySnapshot) {
  const { bundle: _bundle, ...semantic } = repository;
  return semantic;
}

function portableFingerprint(manifest: Pick<CheckpointManifest, "fidelityPolicy" | "repositories" | "worktrees">): string {
  return hash(stable({ fidelityPolicy: manifest.fidelityPolicy, repositories: manifest.repositories.map(semanticRepository), worktrees: manifest.worktrees }));
}

function checkpointId(manifest: Omit<CheckpointManifest, "checkpointId">): string {
  return `checkpoint:${hash(stable(manifest))}`;
}

function receipt(operation: CheckpointReceipt["operation"], status: CheckpointReceipt["status"], manifest: CheckpointManifest): CheckpointReceipt {
  return {
    schema: "workplace-checkpoint-receipt/1", operation, checkpointId: manifest.checkpointId,
    workplaceRef: manifest.workplaceRef, portableFingerprint: manifest.portableFingerprint, status,
    coverage: {
      repositories: manifest.repositories.length, worktrees: manifest.worktrees.length,
      untracked: manifest.worktrees.reduce((count, worktree) => count + worktree.untracked.length, 0),
      exclusions: ["filesystem-metadata", "special-files", "ignored-files", "provider-state", "credentials"],
    },
  };
}

function checkpointDocument(manifest: CheckpointManifest): string {
  return `# Workplace Checkpoint\n\n- ID: \`${manifest.checkpointId}\`\n- Workplace: \`${manifest.workplaceRef}\`\n- Repositories: ${manifest.repositories.length}\n- Worktrees: ${manifest.worktrees.length}\n- Status: captured and locally verifiable\n`;
}

function restoreDocument(): string {
  return "# Restore\n\nVerify before restore:\n\n```sh\nendroit checkpoint verify <checkpoint-directory>\nendroit checkpoint restore <checkpoint-directory> --to <absent-target>\n```\n\nRestore never runs Workplace check, compile or ready.\n";
}

async function filesBelow(root: string, current = root): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) result.push(...await filesBelow(root, path));
    else result.push(relative(root, path).split(sep).join("/"));
  }
  return result.sort();
}

export async function captureCheckpoint(value: unknown, options: { requestDirectory?: string } = {}): Promise<{ path: string; receipt: CheckpointReceipt }> {
  const request = parseCaptureRequest(value, resolve(options.requestDirectory ?? process.cwd()));
  if (await exists(request.output)) fail("checkpoint-output-exists", `${request.output} already exists`);
  await mkdir(dirname(request.output), { recursive: true });
  const parent = await realpath(dirname(request.output));
  const output = join(parent, basename(request.output));
  const declaredPaths = request.roots.flatMap((root) => root.worktrees.map((worktree) => resolve(worktree.path)));
  if (declaredPaths.some((path) => inside(path, output))) fail("checkpoint-output-inside-source", `${output} is inside a captured worktree`);
  const temporary = await mkdtemp(join(parent, ".workplace-checkpoint-"));
  const payloads = new Map<string, PayloadRecord>();
  try {
    const worktrees: Array<WorktreeSnapshot & { commonGitDir: string; requiredOids: string[]; rootRef: string }> = [];
    const repositories: RepositorySnapshot[] = [];
    const repositorySources = new Map<string, string>();
    for (const root of request.roots) {
      const repositoryId = hash(root.ref).slice("sha256:".length, "sha256:".length + 16);
      const observed = await Promise.all(root.worktrees.map((worktree) => inspectWorktree(worktree, repositoryId, request, temporary, payloads)));
      if (new Set(observed.map((worktree) => worktree.commonGitDir)).size !== 1) fail("checkpoint-root-invalid", `${root.ref} worktrees do not share one Git common directory`);
      worktrees.push(...observed.map((worktree) => ({ ...worktree, rootRef: root.ref })));
      const source = root.worktrees[0]!.path;
      repositorySources.set(repositoryId, source);
      const sourceRefs = refs(source);
      const bundlePath = `repositories/${repositoryId}.bundle`;
      await createBundle(source, join(temporary, bundlePath), sourceRefs, observed);
      const bundle = await digestFile(join(temporary, bundlePath));
      repositories.push({
        schema: "workplace-checkpoint-repository/1", repositoryId, rootRef: root.ref,
        objectFormat: text(git(source, ["rev-parse", "--show-object-format"])), refs: sourceRefs,
        remotes: remotes(source), config: portableConfig(source), worktrees: observed.map((worktree) => worktree.worktreeId).sort(),
        objectClosure: objectClosure(source, sourceRefs, observed.flatMap((worktree) => worktree.requiredOids)),
        bundle: { path: bundlePath, sha256: bundle.sha256, size: bundle.size },
      });
    }
    if (new Set(worktrees.map((worktree) => worktree.commonGitDir)).size !== request.roots.length) fail("checkpoint-root-invalid", "Two declared Roots share one Git common directory");
    const closing: WorktreeSnapshot[] = [];
    for (const item of worktrees) {
      const declared = request.roots.flatMap((root) => root.worktrees).find((worktree) => worktree.id === item.worktreeId)!;
      const observed = await inspectWorktree(declared, item.repositoryId, request, temporary, payloads);
      if (observed.commonGitDir !== item.commonGitDir) fail("checkpoint-source-changed", `${item.worktreeId} changed Git topology during capture`);
      const { commonGitDir: _common, requiredOids: _required, ...snapshot } = observed;
      closing.push(snapshot);
    }
    const captured = worktrees.map(({ commonGitDir: _common, requiredOids: _required, rootRef: _root, ...snapshot }) => snapshot);
    if (stable(captured) !== stable(closing)) fail("checkpoint-source-changed", "A declared worktree changed during capture");
    for (const repository of repositories) {
      const source = repositorySources.get(repository.repositoryId)!;
      if (stable(refs(source)) !== stable(repository.refs) || stable(remotes(source)) !== stable(repository.remotes) || stable(portableConfig(source)) !== stable(repository.config)) fail("checkpoint-source-changed", `${repository.rootRef} changed during capture`);
    }
    repositories.sort((a, b) => a.repositoryId.localeCompare(b.repositoryId));
    captured.sort((a, b) => a.worktreeId.localeCompare(b.worktreeId));
    const base = {
      schema: "workplace-checkpoint-manifest/1" as const,
      workplaceRef: request.workplace, workplaceRevision: request.workplaceRevision,
      ownerMember: request.ownerMember, line: request.line, parentCheckpoint: request.parentCheckpoint,
      fidelityPolicy: request.policy, repositories, worktrees: captured,
      payloads: [...payloads.values()].sort((a, b) => a.sha256.localeCompare(b.sha256)),
      compatibility: { platform: process.platform, objectFormats: [...new Set(repositories.map((repository) => repository.objectFormat))].sort(), symlinks: true as const },
      portableFingerprint: portableFingerprint({ fidelityPolicy: request.policy, repositories, worktrees: captured }),
    };
    const manifest: CheckpointManifest = { ...base, checkpointId: checkpointId(base) };
    await mkdir(join(temporary, "repositories"), { recursive: true });
    await mkdir(join(temporary, "worktrees"), { recursive: true });
    for (const repository of repositories) await writeFile(join(temporary, `repositories/${repository.repositoryId}.json`), stable(repository));
    for (const worktree of captured) await writeFile(join(temporary, `worktrees/${worktree.worktreeId}.json`), stable(worktree));
    await writeFile(join(temporary, "MANIFEST.json"), stable(manifest));
    const capturedReceipt = receipt("capture", "captured", manifest);
    await writeFile(join(temporary, "RECEIPT.json"), stable(capturedReceipt));
    await writeFile(join(temporary, "CHECKPOINT.md"), checkpointDocument(manifest));
    await writeFile(join(temporary, "RESTORE.md"), restoreDocument());
    const verified = await verifyCheckpoint(temporary);
    await rename(temporary, output);
    return { path: output, receipt: { ...verified.receipt, operation: "capture", status: "captured" } };
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

function validateManifest(value: unknown): CheckpointManifest {
  const manifest = object(value, "MANIFEST.json");
  exact(manifest, ["schema", "checkpointId", "workplaceRef", "workplaceRevision", "ownerMember", "line", "parentCheckpoint", "fidelityPolicy", "repositories", "worktrees", "payloads", "compatibility", "portableFingerprint"], "MANIFEST.json");
  if (manifest.schema !== "workplace-checkpoint-manifest/1" || typeof manifest.checkpointId !== "string" || !manifest.checkpointId.startsWith("checkpoint:sha256:")) fail("checkpoint-schema-invalid", "Unsupported checkpoint manifest");
  const workplaceRef = semanticRef(manifest.workplaceRef, "workplaceRef");
  if (typeof manifest.workplaceRevision !== "string" || !REVISION.test(manifest.workplaceRevision) || typeof manifest.portableFingerprint !== "string" || !REVISION.test(manifest.portableFingerprint)) fail("checkpoint-schema-invalid", "Manifest revisions are invalid");
  if (!Array.isArray(manifest.repositories) || !Array.isArray(manifest.worktrees) || !Array.isArray(manifest.payloads)) fail("checkpoint-schema-invalid", "Manifest components must be arrays");
  const line = localText(manifest.line, "line");
  if (!ID.test(line)) fail("checkpoint-schema-invalid", "line is invalid");
  const parentCheckpoint = manifest.parentCheckpoint === null ? null : localText(manifest.parentCheckpoint, "parentCheckpoint");
  if (parentCheckpoint !== null && !CHECKPOINT_ID.test(parentCheckpoint)) fail("checkpoint-schema-invalid", "parentCheckpoint is invalid");
  const policy = object(manifest.fidelityPolicy, "fidelityPolicy");
  exact(policy, ["includeUntracked"], "fidelityPolicy");
  if (typeof policy.includeUntracked !== "boolean") fail("checkpoint-schema-invalid", "fidelityPolicy is invalid");
  const repositories = manifest.repositories.map((value, index): RepositorySnapshot => {
    const subject = `repositories[${index}]`;
    const repository = object(value, subject);
    exact(repository, ["schema", "repositoryId", "rootRef", "objectFormat", "refs", "remotes", "config", "worktrees", "objectClosure", "bundle"], subject);
    if (repository.schema !== "workplace-checkpoint-repository/1" || typeof repository.repositoryId !== "string" || !/^[a-f0-9]{16}$/.test(repository.repositoryId)) fail("checkpoint-schema-invalid", `${subject} identity is invalid`);
    if (repository.objectFormat !== "sha1" && repository.objectFormat !== "sha256") fail("checkpoint-schema-invalid", `${subject}.objectFormat is invalid`);
    if (!Array.isArray(repository.refs) || !Array.isArray(repository.remotes) || !Array.isArray(repository.worktrees)) fail("checkpoint-schema-invalid", `${subject} arrays are invalid`);
    const refs = repository.refs.map((value, refIndex) => {
      const refSubject = `${subject}.refs[${refIndex}]`;
      const item = object(value, refSubject);
      exact(item, ["name", "oid"], refSubject);
      if (typeof item.name !== "string" || !item.name.startsWith("refs/") || item.name.includes("..") || typeof item.oid !== "string" || !OID.test(item.oid)) fail("checkpoint-schema-invalid", `${refSubject} is invalid`);
      return { name: item.name, oid: item.oid };
    });
    const remotes = repository.remotes.map((value, remoteIndex) => {
      const remoteSubject = `${subject}.remotes[${remoteIndex}]`;
      const item = object(value, remoteSubject);
      exact(item, ["name", "urls"], remoteSubject);
      if (typeof item.name !== "string" || !item.name || /\s|\0/.test(item.name) || !Array.isArray(item.urls) || item.urls.some((url) => typeof url !== "string" || !url || /^https?:\/\/[^/]*@/i.test(url))) fail("checkpoint-schema-invalid", `${remoteSubject} is invalid`);
      return { name: item.name, urls: item.urls as string[] };
    });
    const configSource = object(repository.config, `${subject}.config`);
    const allowedConfig = ["core.autocrlf", "core.eol", "core.filemode", "core.symlinks"];
    if (Object.keys(configSource).some((key) => !allowedConfig.includes(key)) || Object.values(configSource).some((item) => typeof item !== "string")) fail("checkpoint-schema-invalid", `${subject}.config is invalid`);
    const worktrees = repository.worktrees.map((id) => typeof id === "string" && ID.test(id) ? id : fail("checkpoint-schema-invalid", `${subject}.worktrees has an invalid ID`));
    if (new Set(refs.map((item) => item.name)).size !== refs.length || new Set(remotes.map((item) => item.name)).size !== remotes.length || new Set(worktrees).size !== worktrees.length) fail("checkpoint-schema-invalid", `${subject} repeats refs, remotes or worktrees`);
    const closure = object(repository.objectClosure, `${subject}.objectClosure`);
    exact(closure, ["digest", "objects"], `${subject}.objectClosure`);
    if (typeof closure.digest !== "string" || !REVISION.test(closure.digest) || !Number.isSafeInteger(closure.objects) || Number(closure.objects) < 1) fail("checkpoint-schema-invalid", `${subject}.objectClosure is invalid`);
    const bundle = object(repository.bundle, `${subject}.bundle`);
    exact(bundle, ["path", "sha256", "size"], `${subject}.bundle`);
    const expectedBundle = `repositories/${repository.repositoryId}.bundle`;
    if (bundle.path !== expectedBundle || typeof bundle.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(bundle.sha256) || !Number.isSafeInteger(bundle.size) || Number(bundle.size) < 0) fail("checkpoint-schema-invalid", `${subject}.bundle is invalid`);
    return { schema: "workplace-checkpoint-repository/1", repositoryId: repository.repositoryId, rootRef: semanticRef(repository.rootRef, `${subject}.rootRef`), objectFormat: repository.objectFormat, refs, remotes, config: configSource as Record<string, string>, worktrees, objectClosure: { digest: closure.digest, objects: Number(closure.objects) }, bundle: { path: expectedBundle, sha256: bundle.sha256, size: Number(bundle.size) } };
  });
  const parseContent = (value: unknown, subject: string): ContentRecord => {
    const record = object(value, subject);
    const absent = record.kind === "absent";
    exact(record, absent ? ["path", "kind", "mode"] : ["path", "kind", "mode", "sha256", "size", "payload"], subject);
    const path = logicalPath(record.path, `${subject}.path`);
    if (absent) return { path, kind: "absent", mode: "000000" };
    if (record.kind !== "regular" && record.kind !== "symlink") fail("checkpoint-schema-invalid", `${subject}.kind is invalid`);
    if (!['100644', '100755', '120000'].includes(String(record.mode)) || typeof record.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(record.sha256) || !Number.isSafeInteger(record.size) || Number(record.size) < 0 || record.payload !== `payloads/${record.sha256}`) fail("checkpoint-schema-invalid", `${subject} payload is invalid`);
    return { path, kind: record.kind, mode: String(record.mode), sha256: record.sha256, size: Number(record.size), payload: record.payload };
  };
  const worktrees = manifest.worktrees.map((value, index): WorktreeSnapshot => {
    const subject = `worktrees[${index}]`;
    const worktree = object(value, subject);
    exact(worktree, ["schema", "worktreeId", "repositoryId", "logicalPath", "head", "branchRef", "index", "tracked", "untracked", "operation"], subject);
    if (worktree.schema !== "workplace-checkpoint-worktree/1" || typeof worktree.worktreeId !== "string" || !ID.test(worktree.worktreeId) || typeof worktree.repositoryId !== "string" || !/^[a-f0-9]{16}$/.test(worktree.repositoryId) || typeof worktree.head !== "string" || !OID.test(worktree.head)) fail("checkpoint-schema-invalid", `${subject} identity is invalid`);
    if (worktree.branchRef !== null && (typeof worktree.branchRef !== "string" || !worktree.branchRef.startsWith("refs/heads/"))) fail("checkpoint-schema-invalid", `${subject}.branchRef is invalid`);
    const indexSource = object(worktree.index, `${subject}.index`);
    exact(indexSource, ["schema", "entries", "unsupportedExtensions"], `${subject}.index`);
    if (indexSource.schema !== INDEX_SCHEMA || !Array.isArray(indexSource.entries) || !Array.isArray(indexSource.unsupportedExtensions) || indexSource.unsupportedExtensions.some((item) => typeof item !== "string")) fail("checkpoint-schema-invalid", `${subject}.index is invalid`);
    const entries = indexSource.entries.map((value, entryIndex): IndexEntry => {
      const entrySubject = `${subject}.index.entries[${entryIndex}]`;
      const entry = object(value, entrySubject);
      exact(entry, ["path", "stage", "mode", "oid", "assumeUnchanged", "skipWorktree", "intentToAdd"], entrySubject);
      if (![0, 1, 2, 3].includes(Number(entry.stage)) || !["100644", "100755", "120000", "160000"].includes(String(entry.mode)) || typeof entry.oid !== "string" || !OID.test(entry.oid) || [entry.assumeUnchanged, entry.skipWorktree, entry.intentToAdd].some((flag) => typeof flag !== "boolean")) fail("checkpoint-schema-invalid", `${entrySubject} is invalid`);
      return { path: logicalPath(entry.path, `${entrySubject}.path`), stage: Number(entry.stage), mode: String(entry.mode), oid: entry.oid, assumeUnchanged: entry.assumeUnchanged as boolean, skipWorktree: entry.skipWorktree as boolean, intentToAdd: entry.intentToAdd as boolean };
    });
    if (new Set(entries.map((entry) => `${entry.path}\0${entry.stage}`)).size !== entries.length) fail("checkpoint-schema-invalid", `${subject}.index repeats an entry`);
    if (!["tracked", "untracked", "operation"].every((key) => Array.isArray(worktree[key]))) fail("checkpoint-schema-invalid", `${subject} content arrays are invalid`);
    const operation = (worktree.operation as unknown[]).map((value, operationIndex): OperationRecord => {
      const operationSubject = `${subject}.operation[${operationIndex}]`;
      const item = object(value, operationSubject);
      exact(item, ["path", "sha256", "size", "payload"], operationSubject);
      if (!allowedOperationPath(String(item.path)) || typeof item.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(item.sha256) || !Number.isSafeInteger(item.size) || Number(item.size) < 0 || item.payload !== `payloads/${item.sha256}`) fail("checkpoint-schema-invalid", `${operationSubject} is invalid`);
      return { path: String(item.path), sha256: item.sha256, size: Number(item.size), payload: item.payload };
    });
    const tracked = (worktree.tracked as unknown[]).map((item, itemIndex) => parseContent(item, `${subject}.tracked[${itemIndex}]`));
    const untracked = (worktree.untracked as unknown[]).map((item, itemIndex) => parseContent(item, `${subject}.untracked[${itemIndex}]`));
    if ([tracked, untracked].some((records) => new Set(records.map((record) => record.path)).size !== records.length) || new Set(operation.map((record) => record.path)).size !== operation.length) fail("checkpoint-schema-invalid", `${subject} repeats content paths`);
    return { schema: "workplace-checkpoint-worktree/1", worktreeId: worktree.worktreeId, repositoryId: worktree.repositoryId, logicalPath: logicalPath(worktree.logicalPath, `${subject}.logicalPath`), head: worktree.head, branchRef: worktree.branchRef as string | null, index: { schema: INDEX_SCHEMA, entries, unsupportedExtensions: indexSource.unsupportedExtensions as string[] }, tracked, untracked, operation };
  });
  const payloads = manifest.payloads.map((value, index): PayloadRecord => {
    const subject = `payloads[${index}]`;
    const payload = object(value, subject);
    exact(payload, ["sha256", "size", "path"], subject);
    if (typeof payload.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(payload.sha256) || !Number.isSafeInteger(payload.size) || Number(payload.size) < 0 || payload.path !== `payloads/${payload.sha256}`) fail("checkpoint-schema-invalid", `${subject} is invalid`);
    return { sha256: payload.sha256, size: Number(payload.size), path: payload.path };
  });
  const compatibility = object(manifest.compatibility, "compatibility");
  exact(compatibility, ["platform", "objectFormats", "symlinks"], "compatibility");
  if (typeof compatibility.platform !== "string" || !Array.isArray(compatibility.objectFormats) || compatibility.objectFormats.some((item) => item !== "sha1" && item !== "sha256") || compatibility.symlinks !== true) fail("checkpoint-schema-invalid", "compatibility is invalid");
  if (new Set(repositories.map((item) => item.repositoryId)).size !== repositories.length || new Set(repositories.map((item) => item.rootRef)).size !== repositories.length || new Set(worktrees.map((item) => item.worktreeId)).size !== worktrees.length || new Set(worktrees.map((item) => item.logicalPath)).size !== worktrees.length || new Set(payloads.map((item) => item.sha256)).size !== payloads.length) fail("checkpoint-schema-invalid", "Manifest component identities must be unique");
  for (const worktree of worktrees) if (!repositories.some((repository) => repository.repositoryId === worktree.repositoryId && repository.worktrees.includes(worktree.worktreeId))) fail("checkpoint-schema-invalid", `${worktree.worktreeId} is not owned by its RepositorySnapshot`);
  return { schema: "workplace-checkpoint-manifest/1", checkpointId: manifest.checkpointId, workplaceRef, workplaceRevision: manifest.workplaceRevision, ownerMember: ownerMember(manifest.ownerMember, workplaceRef, "ownerMember"), line, parentCheckpoint, fidelityPolicy: { includeUntracked: policy.includeUntracked }, repositories, worktrees, payloads, compatibility: { platform: compatibility.platform, objectFormats: compatibility.objectFormats as string[], symlinks: true }, portableFingerprint: manifest.portableFingerprint };
}

async function readManifest(root: string): Promise<CheckpointManifest> {
  try { return validateManifest(JSON.parse(await readFile(join(root, "MANIFEST.json"), "utf8")) as unknown); }
  catch (error) {
    if (error instanceof SyntaxError) fail("checkpoint-schema-invalid", `MANIFEST.json is invalid JSON: ${error.message}`);
    throw error;
  }
}

export async function inspectCheckpoint(path: string): Promise<{ path: string; manifest: CheckpointManifest }> {
  const root = await realpath(resolve(path)).catch(() => fail("checkpoint-unavailable", `${path} is unavailable`));
  return { path: root, manifest: await readManifest(root) };
}

async function physicalFuturePath(path: string): Promise<string> {
  let cursor = resolve(path);
  const absent: string[] = [];
  for (;;) {
    try { return join(await realpath(cursor), ...absent); }
    catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT") || await exists(cursor)) throw error;
      const parent = dirname(cursor);
      if (parent === cursor) throw error;
      absent.unshift(basename(cursor)); cursor = parent;
    }
  }
}

/** Git for Windows 2.55 uses MAX_PATH before repository config enables long-path expansion. */
export async function assertCheckpointGitPath(path: string, role: string, platform: string = process.platform): Promise<void> {
  if (platform !== "win32") return;
  // Resolve existing junctions/short names first; an NT namespace prefix does not enlarge Git's buffer.
  const physical = (await physicalFuturePath(path)).replace(/^\\\\\?\\UNC\\/i, "\\\\").replace(/^\\\\\?\\/, "");
  if (physical.length >= 260) fail("checkpoint-git-cwd-unsupported", `${role} requires a Windows Git startup path of ${physical.length} UTF-16 units (qualified limit: <260): ${physical}. Choose a shorter Mount or checkpoint store; core.longpaths does not remove this Git startup limit.`);
}

async function assertCheckpointGitDirectory(path: string, role: string, platform: string = process.platform): Promise<void> {
  // setup.c reads HEAD/commondir, checks objects/refs, then config and optional config.worktree.
  // Reserve the optional names too: ordinary Git discovery must work without a special wrapper.
  for (const name of ["", "HEAD", "commondir", "objects", "refs", "config", "config.worktree"]) {
    await assertCheckpointGitPath(join(path, name), `${role}${name ? `/${name}` : ""}`, platform);
  }
}

/** Pure placement admission: no probes, temporary repositories, or destination directories. */
export async function assertCheckpointGitPlacement(manifest: CheckpointManifest | undefined, target: string, options: { restoring?: boolean; platform?: string } = {}): Promise<void> {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") return;
  const final = await physicalFuturePath(target);
  const roots = [final, ...(options.restoring === false ? [] : [join(dirname(final), ".workplace-restore-XXXXXX")])];
  for (const root of roots) {
    await assertCheckpointGitPath(root, "Checkpoint placement", platform);
    if (!manifest) continue;
    for (const repository of manifest.repositories) {
      const common = join(root, ".git-repositories", `${repository.repositoryId}.git`);
      await assertCheckpointGitDirectory(common, "Repository directory", platform);
      // Fresh repository: at most N-1 existing admin names. Reserve digits(N) for Git's collision suffix.
      const suffix = "9".repeat(String(repository.worktrees.length).length);
      for (const worktree of manifest.worktrees.filter((entry) => entry.repositoryId === repository.repositoryId)) {
        const directory = join(root, worktree.logicalPath);
        await assertCheckpointGitPath(directory, `Worktree ${worktree.worktreeId}`, platform);
        await assertCheckpointGitPath(join(directory, ".git"), `Worktree ${worktree.worktreeId}/.git`, platform);
        if (options.restoring === false) {
          const pointer = (await readFile(join(directory, ".git"), "utf8")).trim();
          if (!pointer.startsWith("gitdir: ") || /[\r\n\0]/.test(pointer)) fail("checkpoint-restore-mismatch", `${worktree.worktreeId} has an unexpected Git pointer`);
          await assertCheckpointGitDirectory(resolve(directory, pointer.slice(8)), `Worktree admin ${worktree.worktreeId}`, platform);
        } else {
          await assertCheckpointGitDirectory(join(common, "worktrees", `${basename(worktree.logicalPath)}${suffix}`), `Worktree admin ${worktree.worktreeId} (collision reserve)`, platform);
        }
      }
    }
  }
}

export async function verifyCheckpoint(path: string): Promise<{ path: string; receipt: CheckpointReceipt; manifest: CheckpointManifest }> {
  const root = await realpath(resolve(path)).catch(() => fail("checkpoint-unavailable", `${path} is unavailable`));
  const manifest = await readManifest(root);
  await assertCheckpointGitDirectory(join(dirname(root), ".checkpoint-bundle-verify-XXXXXX"), "Bundle verification directory");
  const { checkpointId: _id, ...base } = manifest;
  if (checkpointId(base) !== manifest.checkpointId) fail("checkpoint-id-mismatch", "Manifest checkpoint ID changed");
  if (portableFingerprint(manifest) !== manifest.portableFingerprint) fail("checkpoint-fingerprint-mismatch", "Portable fingerprint changed");
  const expected = new Set(["CHECKPOINT.md", "MANIFEST.json", "RECEIPT.json", "RESTORE.md"]);
  if (await readFile(join(root, "CHECKPOINT.md"), "utf8") !== checkpointDocument(manifest) || await readFile(join(root, "RESTORE.md"), "utf8") !== restoreDocument()) fail("checkpoint-component-mismatch", "Static recovery documents changed");
  if (await readFile(join(root, "RECEIPT.json"), "utf8") !== stable(receipt("capture", "captured", manifest))) fail("checkpoint-component-mismatch", "RECEIPT.json changed");
  for (const payload of manifest.payloads) {
    logicalPath(payload.path, "payload.path");
    const observed = await digestFile(join(root, payload.path));
    if (observed.sha256 !== payload.sha256 || observed.size !== payload.size) fail("checkpoint-payload-mismatch", `${payload.path} changed`);
    expected.add(payload.path);
  }
  for (const repository of manifest.repositories) {
    const sidecar = `repositories/${repository.repositoryId}.json`;
    if (await readFile(join(root, sidecar), "utf8") !== stable(repository)) fail("checkpoint-component-mismatch", `${sidecar} changed`);
    const bundle = await digestFile(join(root, repository.bundle.path));
    if (bundle.sha256 !== repository.bundle.sha256 || bundle.size !== repository.bundle.size) fail("checkpoint-bundle-mismatch", `${repository.bundle.path} changed`);
    const verification = await mkdtemp(join(dirname(root), ".checkpoint-bundle-verify-"));
    try {
      git(verification, ["init", "--bare", "-q", `--object-format=${repository.objectFormat}`]);
      git(verification, ["bundle", "verify", join(root, repository.bundle.path)]);
    } finally {
      await rm(verification, { recursive: true, force: true });
    }
    expected.add(sidecar); expected.add(repository.bundle.path);
  }
  for (const worktree of manifest.worktrees) {
    const sidecar = `worktrees/${worktree.worktreeId}.json`;
    if (await readFile(join(root, sidecar), "utf8") !== stable(worktree)) fail("checkpoint-component-mismatch", `${sidecar} changed`);
    expected.add(sidecar);
  }
  const actual = await filesBelow(root);
  const extras = actual.filter((file) => !expected.has(file));
  const missing = [...expected].filter((file) => !actual.includes(file));
  if (extras.length || missing.length) fail("checkpoint-file-set-mismatch", `Unexpected: ${extras.join(", ") || "none"}; missing: ${missing.join(", ") || "none"}`);
  return { path: root, receipt: receipt("verify", "verified-local", manifest), manifest };
}

async function probeFileSymlink(parent: string): Promise<void> {
  const root = await mkdtemp(join(parent, ".endroit-symlink-probe-"));
  try {
    await writeFile(join(root, "target"), "probe\n", { flag: "wx" });
    await (symlink as unknown as (target: string, path: string, type: "file") => Promise<void>)("target", join(root, "link"), "file");
    if (!(await lstat(join(root, "link"))).isSymbolicLink()) throw new Error("symlink probe did not create a symbolic link");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export async function assertCheckpointRestoreCapabilities(manifest: CheckpointManifest, parent = tmpdir(), probe: (parent: string) => Promise<void> = probeFileSymlink): Promise<void> {
  const requiresFileSymlinks = manifest.worktrees.some((worktree) => [...worktree.tracked, ...worktree.untracked].some((record) => record.kind === "symlink"));
  if (!requiresFileSymlinks) return;
  try { await probe(parent); }
  catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : error instanceof Error ? error.message : String(error);
    fail("checkpoint-symlink-unavailable", `Checkpoint requires file symlinks, but this runtime cannot create them: ${code}`);
  }
}

export function checkpointRestorePlan(manifest: CheckpointManifest): CheckpointRestorePlan {
  return {
    schema: "workplace-checkpoint-restore-plan/1",
    checkpointId: manifest.checkpointId,
    repositories: manifest.repositories.map((repository) => ({ repositoryId: repository.repositoryId, rootRef: repository.rootRef, objectFormat: repository.objectFormat, bundle: repository.bundle.path, refs: repository.refs.length, worktrees: repository.worktrees })),
    worktrees: manifest.worktrees.map((worktree) => ({ worktreeId: worktree.worktreeId, repositoryId: worktree.repositoryId, logicalPath: worktree.logicalPath, head: worktree.head, branchRef: worktree.branchRef, indexEntries: worktree.index.entries.length, tracked: worktree.tracked.length, untracked: worktree.untracked.length, operation: worktree.operation.length })),
  };
}

async function materialize(record: ContentRecord | OperationRecord, root: string, packageRoot: string): Promise<void> {
  const target = resolve(root, record.path);
  if (!inside(root, target)) fail("checkpoint-path-invalid", `${record.path} escapes restore target`);
  if ("kind" in record && record.kind === "absent") {
    await rm(target, { recursive: true, force: true });
    return;
  }
  const payload = "payload" in record ? record.payload : undefined;
  if (!payload) fail("checkpoint-payload-mismatch", `${record.path} has no payload`);
  const bytes = new Uint8Array(await readFile(join(packageRoot, payload)));
  await mkdir(dirname(target), { recursive: true });
  await rm(target, { recursive: true, force: true });
  if ("kind" in record && record.kind === "symlink") await symlink(new TextDecoder().decode(bytes), target);
  else {
    await writeFile(target, bytes, { flag: "wx" });
    if ("mode" in record && record.mode === "100755") await chmod(target, 0o755);
  }
}

async function rebaseWorktreePointers(manifest: CheckpointManifest, temporary: string, final: string): Promise<void> {
  const canonical = await realpath(temporary);
  const patches: Array<{ pointer: string; bytes: string }> = [];
  const worktreePointers = new Set<string>();
  for (const worktree of manifest.worktrees) {
    const pointer = join(temporary, worktree.logicalPath, ".git");
    const current = (await readFile(pointer, "utf8")).trim();
    const admin = current.startsWith("gitdir: ") && !/[\r\n\0]/.test(current)
      ? await realpath(resolve(dirname(pointer), current.slice("gitdir: ".length))).catch(() => "") : "";
    const expected = join(canonical, ".git-repositories", `${worktree.repositoryId}.git`, "worktrees");
    if (!admin || !inside(expected, admin) || admin === expected) fail("checkpoint-restore-mismatch", `${worktree.worktreeId} has an unexpected Git pointer`);
    worktreePointers.add(await realpath(pointer));
    patches.push({ pointer, bytes: `gitdir: ${join(final, relative(canonical, admin)).split(sep).join("/")}\n` });
  }
  for (const repository of manifest.repositories) {
    const adminRoot = join(temporary, ".git-repositories", `${repository.repositoryId}.git`, "worktrees");
    if (!await exists(adminRoot)) continue;
    for (const entry of await readdir(adminRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const pointer = join(adminRoot, entry.name, "gitdir");
      const current = (await readFile(pointer, "utf8")).trim();
      const worktreePointer = !/[\r\n\0]/.test(current) ? await realpath(resolve(dirname(pointer), current)).catch(() => "") : "";
      if (!worktreePointers.delete(worktreePointer)) fail("checkpoint-restore-mismatch", `${repository.repositoryId}/${entry.name} has an unexpected worktree pointer`);
      patches.push({ pointer, bytes: `${join(final, relative(canonical, worktreePointer)).split(sep).join("/")}\n` });
    }
  }
  if (worktreePointers.size) fail("checkpoint-restore-mismatch", "Restored worktree pointers are incomplete");
  for (const patch of patches) await writeFile(patch.pointer, patch.bytes);
}

function restoreIndex(worktree: string, snapshot: WorktreeSnapshot): void {
  git(worktree, ["read-tree", "--empty"]);
  const input = snapshot.index.entries.map((entry) => `${entry.mode} ${entry.oid} ${entry.stage}\t${entry.path}\0`).join("");
  if (input) git(worktree, ["update-index", "-z", "--index-info"], input);
}

async function observeRestored(manifest: CheckpointManifest, target: string, packageRoot: string): Promise<{ fingerprint: string; repositories: RepositorySnapshot[]; worktrees: WorktreeSnapshot[] }> {
  const payloads = new Map<string, PayloadRecord>();
  const worktrees: WorktreeSnapshot[] = [];
  const repositories: RepositorySnapshot[] = [];
  for (const repository of manifest.repositories) {
    const declaredWorktrees = repository.worktrees.map((id) => {
      const expected = manifest.worktrees.find((worktree) => worktree.worktreeId === id) ?? fail("checkpoint-schema-invalid", `${repository.repositoryId} names missing worktree ${id}`);
      return { id, path: resolve(target, expected.logicalPath), logicalPath: expected.logicalPath };
    });
    const request: CheckpointCaptureRequest = {
      kind: "CheckpointCaptureRequest", version: 1, workplace: manifest.workplaceRef, workplaceRevision: manifest.workplaceRevision,
      ownerMember: manifest.ownerMember, line: manifest.line, parentCheckpoint: manifest.parentCheckpoint,
      sourceRoot: target, output: resolve(target, ".verification-unused"), roots: [{ ref: repository.rootRef, worktrees: declaredWorktrees }], policy: manifest.fidelityPolicy,
    };
    const observed = await Promise.all(declaredWorktrees.map((worktree) => inspectWorktree(worktree, repository.repositoryId, request, packageRoot, payloads)));
    worktrees.push(...observed.map(({ commonGitDir: _common, requiredOids: _oids, ...snapshot }) => snapshot));
    const source = declaredWorktrees[0]!.path;
    const observedRefs = refs(source);
    repositories.push({ ...repository, refs: observedRefs, remotes: remotes(source), config: portableConfig(source), objectClosure: objectClosure(source, observedRefs, observed.flatMap((worktree) => worktree.requiredOids)), bundle: repository.bundle });
    const gitDir = resolve(source, text(git(source, ["rev-parse", "--git-dir"])));
    // Keep this worktree's HEAD/index, without passing a long absolute GIT_DIR to fsck's children.
    git(gitDir, ["--git-dir=.", "fsck", "--full", "--no-reflogs"]);
  }
  repositories.sort((a, b) => a.repositoryId.localeCompare(b.repositoryId));
  worktrees.sort((a, b) => a.worktreeId.localeCompare(b.worktreeId));
  return { fingerprint: portableFingerprint({ fidelityPolicy: manifest.fidelityPolicy, repositories, worktrees }), repositories, worktrees };
}

async function assertRestoredEquivalent(manifest: CheckpointManifest, target: string): Promise<void> {
  const observation = await mkdtemp(join(dirname(target), ".workplace-observe-"));
  let observed: Awaited<ReturnType<typeof observeRestored>>;
  try { observed = await observeRestored(manifest, target, observation); }
  finally { await rm(observation, { recursive: true, force: true }); }
  if (observed.fingerprint === manifest.portableFingerprint) return;
  const repository = manifest.repositories.find((item) => stable(semanticRepository(item)) !== stable(semanticRepository(observed.repositories.find((candidate) => candidate.repositoryId === item.repositoryId) ?? item)));
  const worktree = manifest.worktrees.find((item) => stable(item) !== stable(observed.worktrees.find((candidate) => candidate.worktreeId === item.worktreeId) ?? item));
  fail("checkpoint-restore-mismatch", `Expected ${manifest.portableFingerprint}, observed ${observed.fingerprint}; first difference: ${repository?.repositoryId ?? worktree?.worktreeId ?? "unknown"}`);
}

export async function verifyRestoredCheckpoint(checkpoint: string, targetPath: string): Promise<{ path: string; receipt: CheckpointReceipt }> {
  const inspected = await inspectCheckpoint(checkpoint);
  await assertCheckpointGitPlacement(inspected.manifest, targetPath, { restoring: false });
  const verified = await verifyCheckpoint(checkpoint);
  await assertCheckpointGitPlacement(verified.manifest, targetPath, { restoring: false });
  const target = await realpath(resolve(targetPath)).catch(() => fail("checkpoint-unavailable", `${targetPath} is unavailable`));
  await assertRestoredEquivalent(verified.manifest, target);
  return { path: target, receipt: receipt("restore", "restored-equivalent", verified.manifest) };
}

export async function restoreCheckpoint(checkpoint: string, targetPath: string, options: { beforeInstall?: (staging: string) => Promise<void> } = {}): Promise<{ path: string; receipt: CheckpointReceipt }> {
  const inspected = await inspectCheckpoint(checkpoint);
  await assertCheckpointGitPlacement(inspected.manifest, targetPath);
  const verified = await verifyCheckpoint(checkpoint);
  await assertCheckpointGitPlacement(verified.manifest, targetPath);
  const target = resolve(targetPath);
  if (await exists(target)) fail("checkpoint-target-exists", `${target} already exists`);
  let capabilityParent = dirname(target);
  while (!await exists(capabilityParent)) {
    const parent = dirname(capabilityParent);
    if (parent === capabilityParent) fail("checkpoint-unavailable", `${dirname(target)} has no existing parent`);
    capabilityParent = parent;
  }
  capabilityParent = await realpath(capabilityParent);
  await assertCheckpointRestoreCapabilities(verified.manifest, capabilityParent);
  await mkdir(dirname(target), { recursive: true });
  const parent = await realpath(dirname(target));
  const final = join(parent, basename(target));
  const temporary = await mkdtemp(join(parent, ".workplace-restore-"));
  try {
    const commonRoot = join(temporary, ".git-repositories");
    await mkdir(commonRoot, { recursive: true });
    for (const repository of verified.manifest.repositories) {
      const common = join(commonRoot, `${repository.repositoryId}.git`);
      await mkdir(common, { recursive: false });
      // Git init changes to a directory argument before loading long-path configuration.
      git(common, ["--git-dir=.", "init", "--bare", "-q", `--object-format=${repository.objectFormat}`]);
      git(common, ["--git-dir=.", "fetch", "--no-tags", join(verified.path, repository.bundle.path), "+refs/*:refs/*"]);
      const captureRefs = text(git(common, ["--git-dir=.", "for-each-ref", "--format=%(refname)", "refs/endroit/capture/"])).split("\n").filter(Boolean);
      for (const ref of captureRefs) git(common, ["--git-dir=.", "update-ref", "-d", ref]);
      for (const remote of repository.remotes) {
        if (remote.urls[0]) git(common, ["--git-dir=.", "remote", "add", remote.name, remote.urls[0]]);
        for (const url of remote.urls.slice(1)) git(common, ["--git-dir=.", "remote", "set-url", "--add", remote.name, url]);
      }
      for (const [key, value] of Object.entries(repository.config)) git(common, ["--git-dir=.", "config", key, value]);
      for (const worktreeId of repository.worktrees) {
        const snapshot = verified.manifest.worktrees.find((worktree) => worktree.worktreeId === worktreeId) ?? fail("checkpoint-schema-invalid", `Missing worktree ${worktreeId}`);
        const destination = resolve(temporary, snapshot.logicalPath);
        if (!inside(temporary, destination)) fail("checkpoint-path-invalid", `${snapshot.logicalPath} escapes restore target`);
        await mkdir(dirname(destination), { recursive: true });
        const ref = snapshot.branchRef ? snapshot.branchRef.slice("refs/heads/".length) : snapshot.head;
        // The checkpoint supplies the complete index and tracked files, not just dirty overlays.
        git(common, ["--git-dir=.", "worktree", "add", "--no-checkout", "--force", ...(snapshot.branchRef ? [] : ["--detach"]), destination, ref]);
        restoreIndex(destination, snapshot);
        for (const record of snapshot.tracked) await materialize(record, destination, verified.path);
        for (const record of snapshot.untracked) await materialize(record, destination, verified.path);
        const gitDir = resolve(destination, text(git(destination, ["rev-parse", "--git-dir"])));
        for (const record of snapshot.operation) await materialize(record, gitDir, verified.path);
        for (const entry of snapshot.index.entries.filter((entry) => entry.stage === 0)) {
          if (entry.intentToAdd) {
            git(destination, ["update-index", "--force-remove", "--", entry.path]);
            git(destination, ["add", "--intent-to-add", "--", entry.path]);
          }
          if (entry.assumeUnchanged) git(destination, ["update-index", "--assume-unchanged", "--", entry.path]);
          if (entry.skipWorktree) git(destination, ["update-index", "--skip-worktree", "--", entry.path]);
        }
      }
    }
    await assertRestoredEquivalent(verified.manifest, temporary);
    await options.beforeInstall?.(temporary);
    if (await exists(final)) fail("checkpoint-target-exists", `${final} appeared before installation`);
    await rebaseWorktreePointers(verified.manifest, temporary, final);
    await rename(temporary, final);
    try {
      for (const worktree of verified.manifest.worktrees) git(resolve(final, worktree.logicalPath), ["rev-parse", "--git-common-dir"]);
    } catch (error) {
      await rename(final, temporary).catch(() => undefined);
      throw error;
    }
    return { path: final, receipt: receipt("restore", "restored-equivalent", verified.manifest) };
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}
