import { cp, lstat, mkdir, mkdtemp, realpath, rename, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { gitArguments, gitTransportArguments } from "./platform.ts";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { assertCheckpointGitPlacement, CheckpointError, restoreCheckpoint, verifyCheckpoint, type CheckpointManifest, type CheckpointReceipt } from "./checkpoint.ts";
import { hash, stable } from "./compiler/index.ts";

const CHECKPOINT_ID = /^checkpoint:sha256:[a-f0-9]{64}$/;
const MEMBER = /^workplace:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\/member\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const LINE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export type ContinuityBinding = {
  kind: "ContinuityBinding";
  version: 1;
  workplace: string;
  role: "product" | "separate";
  locator: string;
  productLocator: string;
  productVisibility: "public" | "private";
  continuityVisibility: "private";
  credentialBinding: string;
};

export type CheckpointPublishRequest = {
  kind: "CheckpointPublishRequest";
  version: 1;
  binding: ContinuityBinding;
  ownerMember: string;
  line: string;
  parentCheckpoint: string | null;
};

export type CheckpointFetchRequest = {
  kind: "CheckpointFetchRequest";
  version: 1;
  binding: ContinuityBinding;
  ownerMember: string;
  line: string;
};

export type LineUpdate = {
  status: "advanced" | "unchanged" | "diverged";
  expectedParent: string | null;
  observedCheckpoint: string | null;
  expectedCommit: string | null;
  observedCommit: string | null;
  resultingCommit: string | null;
};

export type CheckpointRemoteReceipt = {
  schema: "workplace-checkpoint-remote-receipt/1";
  operation: "publish" | "fetch";
  checkpointId: string;
  status: "verified-remote" | "fetched-verified" | "diverged";
  checkpointRef: string;
  checkpointCommit: string;
  lineRef: string;
  ownerMember: string;
  line: string;
  parentCheckpoint: string | null;
  remoteIdentity: string;
  files: number;
  lineUpdate: LineUpdate | null;
};

function fail(code: string, message: string): never { throw new CheckpointError(code, message); }
function object(value: unknown, subject: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("checkpoint-schema-invalid", `${subject} must be an object`);
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, fields: string[], subject: string): void {
  const unknown = Object.keys(value).filter((key) => !fields.includes(key));
  const missing = fields.filter((key) => !(key in value));
  if (unknown.length || missing.length) fail("checkpoint-schema-invalid", `${subject} has invalid fields${unknown.length ? `; unknown: ${unknown.join(", ")}` : ""}${missing.length ? `; missing: ${missing.join(", ")}` : ""}`);
}
function text(value: unknown, subject: string): string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) fail("checkpoint-schema-invalid", `${subject} must be non-empty text`);
  return value.trim();
}
function locator(value: unknown, requestDirectory: string, subject: string): string {
  const raw = text(value, subject);
  if (/^https?:\/\/[^/]*@/i.test(raw)) fail("checkpoint-credential-forbidden", `${subject} must not contain credentials`);
  return /^(?:[a-z][a-z0-9+.-]*:\/\/|[^/]+@[^:]+:)/i.test(raw) ? raw : resolve(requestDirectory, raw);
}
function normalizedLocator(value: string): string { return value.replace(/\/+$/, ""); }

export function parseContinuityBinding(value: unknown, requestDirectory: string): ContinuityBinding {
  const source = object(value, "ContinuityBinding");
  exact(source, ["kind", "version", "workplace", "role", "locator", "productLocator", "productVisibility", "continuityVisibility", "credentialBinding"], "ContinuityBinding");
  if (source.kind !== "ContinuityBinding" || source.version !== 1 || !["product", "separate"].includes(String(source.role)) || !["public", "private"].includes(String(source.productVisibility)) || source.continuityVisibility !== "private") fail("checkpoint-schema-invalid", "Unsupported ContinuityBinding");
  const binding: ContinuityBinding = {
    kind: "ContinuityBinding", version: 1,
    workplace: text(source.workplace, "ContinuityBinding.workplace"),
    role: source.role as ContinuityBinding["role"],
    locator: locator(source.locator, requestDirectory, "ContinuityBinding.locator"),
    productLocator: locator(source.productLocator, requestDirectory, "ContinuityBinding.productLocator"),
    productVisibility: source.productVisibility as ContinuityBinding["productVisibility"],
    continuityVisibility: "private",
    credentialBinding: text(source.credentialBinding, "ContinuityBinding.credentialBinding"),
  };
  if (!/^workplace:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/.test(binding.workplace)) fail("checkpoint-schema-invalid", "ContinuityBinding.workplace must be a Workplace ref");
  const same = normalizedLocator(binding.locator) === normalizedLocator(binding.productLocator);
  if ((binding.role === "product") !== same) fail("checkpoint-remote-role-mismatch", binding.role === "product" ? "product continuity must use the declared Product Remote" : "separate continuity must not reuse the declared Product Remote");
  if (binding.role === "product" && binding.productVisibility !== "private") fail("checkpoint-remote-role-mismatch", "a public Product Remote requires separate private continuity");
  return binding;
}
function member(value: unknown, subject: string): string {
  const result = text(value, subject);
  if (!MEMBER.test(result)) fail("checkpoint-schema-invalid", `${subject} must be a fully qualified Member ref`);
  return result;
}
function line(value: unknown, subject: string): string {
  const result = text(value, subject);
  if (!LINE.test(result)) fail("checkpoint-schema-invalid", `${subject} must be a portable line name`);
  return result;
}
function parent(value: unknown, subject: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !CHECKPOINT_ID.test(value)) fail("checkpoint-schema-invalid", `${subject} must be null or a checkpoint ID`);
  return value;
}

export function parsePublishRequest(value: unknown, requestDirectory: string): CheckpointPublishRequest {
  const source = object(value, "CheckpointPublishRequest");
  exact(source, ["kind", "version", "binding", "ownerMember", "line", "parentCheckpoint"], "CheckpointPublishRequest");
  if (source.kind !== "CheckpointPublishRequest" || source.version !== 1) fail("checkpoint-schema-invalid", "Unsupported CheckpointPublishRequest");
  return { kind: "CheckpointPublishRequest", version: 1, binding: parseContinuityBinding(source.binding, requestDirectory), ownerMember: member(source.ownerMember, "CheckpointPublishRequest.ownerMember"), line: line(source.line, "CheckpointPublishRequest.line"), parentCheckpoint: parent(source.parentCheckpoint, "CheckpointPublishRequest.parentCheckpoint") };
}

export function parseFetchRequest(value: unknown, requestDirectory: string): CheckpointFetchRequest {
  const source = object(value, "CheckpointFetchRequest");
  exact(source, ["kind", "version", "binding", "ownerMember", "line"], "CheckpointFetchRequest");
  if (source.kind !== "CheckpointFetchRequest" || source.version !== 1) fail("checkpoint-schema-invalid", "Unsupported CheckpointFetchRequest");
  return { kind: "CheckpointFetchRequest", version: 1, binding: parseContinuityBinding(source.binding, requestDirectory), ownerMember: member(source.ownerMember, "CheckpointFetchRequest.ownerMember"), line: line(source.line, "CheckpointFetchRequest.line") };
}

function run(cwd: string, args: string[], options: { allowFailure?: boolean; env?: Record<string, string> } = {}): { status: number; stdout: string; stderr: string } {
  const result = spawnSync("git", gitArguments(args), { cwd, env: { ...process.env, LC_ALL: "C", ...options.env }, maxBuffer: 1024 * 1024 * 1024 });
  const value = { status: result.status ?? 1, stdout: new TextDecoder().decode(result.stdout).trim(), stderr: new TextDecoder().decode(result.stderr).trim() };
  if (!options.allowFailure && value.status !== 0) fail("checkpoint-remote-git-failed", `git ${args.slice(0, 4).join(" ")} failed: ${value.stderr}`);
  return value;
}
function git(cwd: string, args: string[], options?: { env?: Record<string, string> }): string { return run(cwd, args, options).stdout; }
async function initializeTransportRepository(repository: string): Promise<void> {
  // Only fresh, owned transport repositories: never inherit templates or rewrite a product's policy.
  git(repository, ["init", "--template=", "-q"]);
  await mkdir(join(repository, ".git/info"), { recursive: true });
  // Highest-precedence attributes preserve the envelope bytes on both add and checkout.
  await writeFile(join(repository, ".git/info/attributes"), "checkpoint/** -text -filter -ident -working-tree-encoding\n", { flag: "wx" });
}
function memberKey(ownerMember: string): string { return hash(ownerMember).slice("sha256:".length); }
function checkpointKey(checkpointId: string): string {
  if (!CHECKPOINT_ID.test(checkpointId)) fail("checkpoint-schema-invalid", "checkpointId is invalid");
  return checkpointId.slice("checkpoint:sha256:".length);
}
export function checkpointRef(ownerMember: string, lineName: string, checkpointId: string): string {
  return `refs/endroit/checkpoints/owners/${memberKey(member(ownerMember, "ownerMember"))}/lines/${line(lineName, "line")}/checkpoints/${checkpointKey(checkpointId)}`;
}
export function checkpointLineRef(ownerMember: string, lineName: string): string {
  return `refs/endroit/checkpoints/owners/${memberKey(member(ownerMember, "ownerMember"))}/lines/${line(lineName, "line")}/head`;
}
function listRemote(locatorValue: string, ref: string): string | null {
  const result = run(process.cwd(), ["ls-remote", ...gitTransportArguments("ls-remote", locatorValue), locatorValue, ref], { allowFailure: true });
  if (result.status !== 0) fail("checkpoint-remote-git-failed", `git ls-remote failed: ${result.stderr}`);
  return result.stdout.split(/\s+/)[0] || null;
}
async function fetchCommit(locatorValue: string, ref: string, destination: string): Promise<string> {
  await mkdir(destination, { recursive: true });
  await initializeTransportRepository(destination);
  git(destination, ["fetch", ...gitTransportArguments("fetch", locatorValue), "-q", "--no-tags", locatorValue, ref]);
  git(destination, ["checkout", "-q", "--detach", "FETCH_HEAD"]);
  return git(destination, ["rev-parse", "HEAD"]);
}
async function readRemoteManifest(checkout: string): Promise<{ manifest: CheckpointManifest; files: number }> {
  const verified = await verifyCheckpoint(join(checkout, "checkpoint"));
  const tracked = git(checkout, ["ls-files", "-z"]).split("\0").filter(Boolean).sort();
  if (tracked.some((path) => !path.startsWith("checkpoint/"))) fail("checkpoint-file-set-mismatch", "Remote checkpoint commit contains files outside checkpoint/");
  return { manifest: verified.manifest, files: tracked.length };
}
async function remoteCheckpoint(locatorValue: string, ownerMember: string, lineName: string, checkpointId: string, temporaryRoot: string): Promise<{ commit: string; manifest: CheckpointManifest; files: number } | null> {
  const ref = checkpointRef(ownerMember, lineName, checkpointId);
  if (!listRemote(locatorValue, ref)) return null;
  const checkout = await mkdtemp(join(temporaryRoot, ".checkpoint-remote-read-"));
  try {
    const commit = await fetchCommit(locatorValue, ref, checkout);
    return { commit, ...await readRemoteManifest(checkout) };
  } finally { await rm(checkout, { recursive: true, force: true }); }
}
async function observedLine(locatorValue: string, ownerMember: string, lineName: string, temporaryRoot: string): Promise<{ commit: string; checkpointId: string } | null> {
  const ref = checkpointLineRef(ownerMember, lineName);
  if (!listRemote(locatorValue, ref)) return null;
  const checkout = await mkdtemp(join(temporaryRoot, ".checkpoint-line-read-"));
  try {
    const commit = await fetchCommit(locatorValue, ref, checkout);
    const { manifest } = await readRemoteManifest(checkout);
    if (manifest.ownerMember !== ownerMember || manifest.line !== lineName) fail("checkpoint-remote-mismatch", "Checkpoint Line resolves to another owner or line");
    return { commit, checkpointId: manifest.checkpointId };
  } finally { await rm(checkout, { recursive: true, force: true }); }
}

export async function resolveRemoteCheckpointLine(value: unknown, options: { requestDirectory?: string } = {}): Promise<{ checkpointCommit: string; checkpointId: string; ownerMember: string; line: string } | null> {
  const request = parseFetchRequest(value, resolve(options.requestDirectory ?? process.cwd()));
  const temporary = await mkdtemp(join(tmpdir(), "endroit-checkpoint-line-"));
  try {
    const observed = await observedLine(request.binding.locator, request.ownerMember, request.line, temporary);
    return observed ? { checkpointCommit: observed.commit, checkpointId: observed.checkpointId, ownerMember: request.ownerMember, line: request.line } : null;
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
function assertManifestRequest(manifest: CheckpointManifest, request: CheckpointPublishRequest): void {
  if (manifest.workplaceRef !== request.binding.workplace || manifest.ownerMember !== request.ownerMember || manifest.line !== request.line || manifest.parentCheckpoint !== request.parentCheckpoint) fail("checkpoint-remote-mismatch", "Checkpoint manifest and publish request continuity metadata differ");
}
function receipt(operation: "publish" | "fetch", status: CheckpointRemoteReceipt["status"], manifest: CheckpointManifest, binding: ContinuityBinding, commit: string, files: number, lineUpdate: LineUpdate | null): CheckpointRemoteReceipt {
  return { schema: "workplace-checkpoint-remote-receipt/1", operation, checkpointId: manifest.checkpointId, status, checkpointRef: checkpointRef(manifest.ownerMember, manifest.line, manifest.checkpointId), checkpointCommit: commit, lineRef: checkpointLineRef(manifest.ownerMember, manifest.line), ownerMember: manifest.ownerMember, line: manifest.line, parentCheckpoint: manifest.parentCheckpoint, remoteIdentity: hash(binding.locator), files, lineUpdate };
}
async function createCheckpointCommit(checkpointPath: string, manifest: CheckpointManifest, remote: string, temporaryRoot: string): Promise<{ repository: string; commit: string; files: number }> {
  const repository = await mkdtemp(join(temporaryRoot, ".checkpoint-remote-stage-"));
  await mkdir(join(repository, "checkpoint"), { recursive: false });
  await cp(checkpointPath, join(repository, "checkpoint"), { recursive: true });
  await initializeTransportRepository(repository);
  git(repository, ["add", "checkpoint"]);
  const tree = git(repository, ["write-tree"]);
  let parentCommit: string | null = null;
  if (manifest.parentCheckpoint) {
    const fetched = run(repository, ["fetch", ...gitTransportArguments("fetch", remote), "-q", "--no-tags", remote, checkpointRef(manifest.ownerMember, manifest.line, manifest.parentCheckpoint)], { allowFailure: true });
    if (fetched.status !== 0) fail("checkpoint-parent-unavailable", `${manifest.parentCheckpoint} is not published on this Checkpoint Line`);
    parentCommit = git(repository, ["rev-parse", "FETCH_HEAD"]);
  }
  const commitDate = "2000-01-01T00:00:00Z";
  const commit = git(repository, ["commit-tree", tree, ...(parentCommit ? ["-p", parentCommit] : []), "-m", `Checkpoint ${manifest.checkpointId}`], { env: { GIT_AUTHOR_NAME: "Endroit Checkpoint", GIT_AUTHOR_EMAIL: "checkpoint@endroit.invalid", GIT_AUTHOR_DATE: commitDate, GIT_COMMITTER_NAME: "Endroit Checkpoint", GIT_COMMITTER_EMAIL: "checkpoint@endroit.invalid", GIT_COMMITTER_DATE: commitDate } });
  return { repository, commit, files: git(repository, ["ls-files", "-z"]).split("\0").filter(Boolean).length };
}
async function advanceLine(repository: string, binding: ContinuityBinding, manifest: CheckpointManifest, commit: string, temporaryRoot: string): Promise<LineUpdate> {
  const current = await observedLine(binding.locator, manifest.ownerMember, manifest.line, temporaryRoot);
  const expectedCommit = manifest.parentCheckpoint ? listRemote(binding.locator, checkpointRef(manifest.ownerMember, manifest.line, manifest.parentCheckpoint)) ?? fail("checkpoint-parent-unavailable", `${manifest.parentCheckpoint} is not published on this Checkpoint Line`) : null;
  if (current?.checkpointId === manifest.checkpointId) return { status: "unchanged", expectedParent: manifest.parentCheckpoint, observedCheckpoint: manifest.checkpointId, expectedCommit, observedCommit: current.commit, resultingCommit: current.commit };
  if ((current?.checkpointId ?? null) !== manifest.parentCheckpoint) return { status: "diverged", expectedParent: manifest.parentCheckpoint, observedCheckpoint: current?.checkpointId ?? null, expectedCommit, observedCommit: current?.commit ?? null, resultingCommit: current?.commit ?? null };
  const ref = checkpointLineRef(manifest.ownerMember, manifest.line);
  const lease = current ? `${ref}:${current.commit}` : `${ref}:`;
  const pushed = run(repository, ["push", ...gitTransportArguments("push", binding.locator), "-q", `--force-with-lease=${lease}`, binding.locator, `${commit}:${ref}`], { allowFailure: true });
  if (pushed.status !== 0) {
    const observed = await observedLine(binding.locator, manifest.ownerMember, manifest.line, temporaryRoot);
    return { status: "diverged", expectedParent: manifest.parentCheckpoint, observedCheckpoint: observed?.checkpointId ?? null, expectedCommit, observedCommit: current?.commit ?? null, resultingCommit: observed?.commit ?? null };
  }
  const after = await observedLine(binding.locator, manifest.ownerMember, manifest.line, temporaryRoot);
  if (after?.commit !== commit || after.checkpointId !== manifest.checkpointId) fail("checkpoint-remote-mismatch", "Checkpoint Line did not advance to the published checkpoint");
  return { status: "advanced", expectedParent: manifest.parentCheckpoint, observedCheckpoint: manifest.checkpointId, expectedCommit, observedCommit: current?.commit ?? null, resultingCommit: after.commit };
}

export async function publishCheckpoint(checkpointPath: string, value: unknown, options: { requestDirectory?: string } = {}): Promise<{ receipt: CheckpointRemoteReceipt }> {
  const request = parsePublishRequest(value, resolve(options.requestDirectory ?? process.cwd()));
  const verified = await verifyCheckpoint(checkpointPath);
  assertManifestRequest(verified.manifest, request);
  const immutableRef = checkpointRef(request.ownerMember, request.line, verified.manifest.checkpointId);
  const temporary = await mkdtemp(join(dirname(verified.path), ".checkpoint-publish-"));
  try {
    const existing = await remoteCheckpoint(request.binding.locator, request.ownerMember, request.line, verified.manifest.checkpointId, temporary);
    if (existing) {
      if (stable(existing.manifest) !== stable(verified.manifest)) fail("checkpoint-remote-diverged", "Immutable checkpoint ref resolves to different content");
      const repository = await mkdtemp(join(temporary, ".checkpoint-publish-retry-"));
      try {
        const commit = await fetchCommit(request.binding.locator, immutableRef, repository);
        if (commit !== existing.commit) fail("checkpoint-remote-mismatch", "Immutable checkpoint changed before retry");
        const update = await advanceLine(repository, request.binding, verified.manifest, existing.commit, temporary);
        return { receipt: receipt("publish", update.status === "diverged" ? "diverged" : "verified-remote", verified.manifest, request.binding, existing.commit, existing.files, update) };
      } finally { await rm(repository, { recursive: true, force: true }); }
    }
    const created = await createCheckpointCommit(verified.path, verified.manifest, request.binding.locator, temporary);
    try {
      git(created.repository, ["push", ...gitTransportArguments("push", request.binding.locator), "-q", request.binding.locator, `${created.commit}:${immutableRef}`]);
      const published = await remoteCheckpoint(request.binding.locator, request.ownerMember, request.line, verified.manifest.checkpointId, temporary) ?? fail("checkpoint-remote-mismatch", "Published checkpoint ref is unavailable");
      if (published.commit !== created.commit || stable(published.manifest) !== stable(verified.manifest)) fail("checkpoint-remote-mismatch", "Published checkpoint differs from the local package");
      const update = await advanceLine(created.repository, request.binding, verified.manifest, created.commit, temporary);
      return { receipt: receipt("publish", update.status === "diverged" ? "diverged" : "verified-remote", verified.manifest, request.binding, created.commit, created.files, update) };
    } finally { await rm(created.repository, { recursive: true, force: true }); }
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

export async function fetchCheckpoint(checkpointId: string, value: unknown, targetPath: string, options: { requestDirectory?: string } = {}): Promise<{ path: string; receipt: CheckpointRemoteReceipt }> {
  const request = parseFetchRequest(value, resolve(options.requestDirectory ?? process.cwd()));
  if (!CHECKPOINT_ID.test(checkpointId)) fail("checkpoint-schema-invalid", "checkpointId is invalid");
  const target = resolve(targetPath);
  if (await lstat(target).then(() => true).catch(() => false)) fail("checkpoint-output-exists", `${target} already exists`);
  await mkdir(dirname(target), { recursive: true });
  const parentDirectory = await realpath(dirname(target));
  const checkout = await mkdtemp(join(parentDirectory, ".checkpoint-fetch-"));
  try {
    const commit = await fetchCommit(request.binding.locator, checkpointRef(request.ownerMember, request.line, checkpointId), checkout);
    const { manifest, files } = await readRemoteManifest(checkout);
    if (manifest.checkpointId !== checkpointId || manifest.workplaceRef !== request.binding.workplace || manifest.ownerMember !== request.ownerMember || manifest.line !== request.line) fail("checkpoint-remote-mismatch", "Fetched checkpoint belongs to another Workplace, ID, owner, or line");
    const temporary = await mkdtemp(join(parentDirectory, ".checkpoint-install-"));
    try {
      await rm(temporary, { recursive: true, force: true });
      await cp(join(checkout, "checkpoint"), temporary, { recursive: true });
      const verified = await verifyCheckpoint(temporary);
      await rename(temporary, join(parentDirectory, basename(target)));
      return { path: target, receipt: receipt("fetch", "fetched-verified", verified.manifest, request.binding, commit, files, null) };
    } catch (error) { await rm(temporary, { recursive: true, force: true }); throw error; }
  } finally { await rm(checkout, { recursive: true, force: true }); }
}

export async function restoreCheckpointFromRemote(checkpointId: string, value: unknown, targetPath: string, options: { requestDirectory?: string } = {}): Promise<{ path: string; receipt: CheckpointReceipt; remote: CheckpointRemoteReceipt }> {
  const target = resolve(targetPath);
  if (await lstat(target).then(() => true).catch(() => false)) fail("checkpoint-target-exists", `${target} already exists`);
  await assertCheckpointGitPlacement(undefined, target);
  // Remote acquisition is separate from installation; do not create destination ancestors to fetch.
  const temporary = await mkdtemp(join(tmpdir(), ".checkpoint-fresh-machine-"));
  try {
    const fetched = await fetchCheckpoint(checkpointId, value, join(temporary, "checkpoint"), options);
    const restored = await restoreCheckpoint(fetched.path, target);
    return { ...restored, remote: fetched.receipt };
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
