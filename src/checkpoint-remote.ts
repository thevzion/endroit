import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { CheckpointError, restoreCheckpoint, verifyCheckpoint, type CheckpointManifest, type CheckpointReceipt } from "./checkpoint.ts";
import { hash, stable } from "./compiler/index.ts";

const CHECKPOINT_ID = /^checkpoint:sha256:[a-f0-9]{64}$/;
const REVISION = /^sha256:[a-f0-9]{64}$/;
const RECIPIENT_REF = /^recipient:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
const AGE_RECIPIENT = /^age1[a-z0-9]+$/;
const CONTROL_SCHEMA = "workplace-checkpoint-remote-control/1" as const;
const RECORD_SCHEMA = "workplace-checkpoint-envelope-record/1" as const;

export type CheckpointPublishRequest = { kind: "CheckpointPublishRequest"; version: 1; remote: string; recipients: Array<{ ref: string; value: string }>; identities: string[]; baseCheckpoint: string | null };
export type CheckpointFetchRequest = { kind: "CheckpointFetchRequest"; version: 1; remote: string; identities: string[] };
type RemoteObject = { sha256: string; size: number };
type RemoteControl = { schema: typeof CONTROL_SCHEMA; checkpointId: string; algorithm: "age/1"; recipientRefs: string[]; objects: RemoteObject[] };
type LatestResult = { status: "advanced" | "diverged"; baseCheckpoint: string | null; observedCheckpoint: string | null };
export type CheckpointRemoteReceipt = { schema: "workplace-checkpoint-remote-receipt/1"; operation: "publish" | "fetch"; checkpointId: string; status: "verified-remote" | "fetched-verified" | "diverged"; controlRef: string; controlCommit: string; remoteIdentity: string; algorithm: "age/1"; recipientRefs: string[]; objects: number; latest: LatestResult | null };

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
function portablePath(value: unknown, subject: string): string {
  const path = text(value, subject).replaceAll("\\", "/");
  if (path.startsWith("/") || /^[A-Za-z]:\//.test(path) || path.split("/").some((part) => !part || part === "." || part === "..")) fail("checkpoint-path-invalid", `${subject} must be a safe relative path`);
  return path;
}
function remoteValue(value: unknown, requestDirectory: string): string {
  const remote = text(value, "remote");
  if (/^https?:\/\/[^/]*@/i.test(remote)) fail("checkpoint-credential-forbidden", "remote must not contain credentials");
  return /^(?:[a-z][a-z0-9+.-]*:\/\/|[^/]+@[^:]+:)/i.test(remote) ? remote : resolve(requestDirectory, remote);
}
function identities(value: unknown, requestDirectory: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string" || !item.trim())) fail("checkpoint-schema-invalid", "identities must be a non-empty string array");
  const paths = value.map((item) => resolve(requestDirectory, String(item)));
  if (new Set(paths).size !== paths.length) fail("checkpoint-schema-invalid", "identities must be unique");
  return paths;
}

export function parsePublishRequest(value: unknown, requestDirectory: string): CheckpointPublishRequest {
  const source = object(value, "CheckpointPublishRequest");
  exact(source, ["kind", "version", "remote", "recipients", "identities", "baseCheckpoint"], "CheckpointPublishRequest");
  if (source.kind !== "CheckpointPublishRequest" || source.version !== 1 || !Array.isArray(source.recipients) || source.recipients.length === 0) fail("checkpoint-schema-invalid", "Unsupported CheckpointPublishRequest");
  if (source.baseCheckpoint !== null && (typeof source.baseCheckpoint !== "string" || !CHECKPOINT_ID.test(source.baseCheckpoint))) fail("checkpoint-schema-invalid", "baseCheckpoint must be null or a checkpoint ID");
  const recipients = source.recipients.map((value, index) => {
    const subject = `recipients[${index}]`; const item = object(value, subject); exact(item, ["ref", "value"], subject);
    if (typeof item.ref !== "string" || !RECIPIENT_REF.test(item.ref) || typeof item.value !== "string" || !AGE_RECIPIENT.test(item.value)) fail("checkpoint-schema-invalid", `${subject} is invalid`);
    return { ref: item.ref, value: item.value };
  }).sort((a, b) => a.ref.localeCompare(b.ref));
  if (new Set(recipients.map((item) => item.ref)).size !== recipients.length || new Set(recipients.map((item) => item.value)).size !== recipients.length) fail("checkpoint-schema-invalid", "recipients must be unique");
  return { kind: "CheckpointPublishRequest", version: 1, remote: remoteValue(source.remote, requestDirectory), recipients, identities: identities(source.identities, requestDirectory), baseCheckpoint: source.baseCheckpoint as string | null };
}

export function parseFetchRequest(value: unknown, requestDirectory: string): CheckpointFetchRequest {
  const source = object(value, "CheckpointFetchRequest"); exact(source, ["kind", "version", "remote", "identities"], "CheckpointFetchRequest");
  if (source.kind !== "CheckpointFetchRequest" || source.version !== 1) fail("checkpoint-schema-invalid", "Unsupported CheckpointFetchRequest");
  return { kind: "CheckpointFetchRequest", version: 1, remote: remoteValue(source.remote, requestDirectory), identities: identities(source.identities, requestDirectory) };
}

function run(cwd: string, command: string, args: string[], input?: Uint8Array, code = "checkpoint-remote-failed"): Uint8Array {
  const result = spawnSync(command, args, { cwd, ...(input ? { input } : {}), env: { ...process.env, LC_ALL: "C" }, maxBuffer: 1024 * 1024 * 1024 });
  if (result.status !== 0) fail(code, `${command} ${args.slice(0, 3).join(" ")} failed: ${new TextDecoder().decode(result.stderr).trim()}`);
  return result.stdout;
}
function git(cwd: string, args: string[], input?: Uint8Array): Uint8Array { return run(cwd, "git", args, input, "checkpoint-remote-git-failed"); }
function output(bytes: Uint8Array): string { return new TextDecoder().decode(bytes).trim(); }
function ageEncrypt(cwd: string, bytes: Uint8Array, recipients: CheckpointPublishRequest["recipients"]): Uint8Array { return run(cwd, "age", ["--encrypt", ...recipients.flatMap((recipient) => ["--recipient", recipient.value])], bytes, "checkpoint-encryption-failed"); }
function ageDecrypt(cwd: string, bytes: Uint8Array, identityPaths: string[]): Uint8Array { return run(cwd, "age", ["--decrypt", ...identityPaths.flatMap((identity) => ["--identity", identity])], bytes, "checkpoint-decryption-failed"); }
function concat(first: Uint8Array, second: Uint8Array): Uint8Array { const result = new Uint8Array(first.length + second.length); result.set(first); result.set(second, first.length); return result; }

async function filesBelow(root: string, current = root): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) files.push(...await filesBelow(root, path));
    else if (entry.isFile()) files.push(relative(root, path).split(sep).join("/"));
    else fail("checkpoint-file-unsupported", `${relative(root, path)} is not a regular package file`);
  }
  return files.sort();
}
function encodeRecord(path: string, bytes: Uint8Array): Uint8Array { return concat(new TextEncoder().encode(`${JSON.stringify({ schema: RECORD_SCHEMA, path, sha256: hash(bytes), size: bytes.length })}\n`), bytes); }
function decodeRecord(bytes: Uint8Array): { path: string; bytes: Uint8Array } {
  const newline = bytes.indexOf(10); if (newline < 0) fail("checkpoint-envelope-invalid", "Encrypted record has no header boundary");
  let source: Record<string, unknown>;
  try { source = object(JSON.parse(new TextDecoder().decode(bytes.slice(0, newline))), "EnvelopeRecord"); }
  catch (error) { if (error instanceof CheckpointError) throw error; fail("checkpoint-envelope-invalid", `Encrypted record header is invalid: ${error instanceof Error ? error.message : String(error)}`); }
  exact(source, ["schema", "path", "sha256", "size"], "EnvelopeRecord");
  const path = portablePath(source.path, "EnvelopeRecord.path"); const payload = bytes.slice(newline + 1);
  if (source.schema !== RECORD_SCHEMA || typeof source.sha256 !== "string" || !REVISION.test(source.sha256) || !Number.isSafeInteger(source.size) || source.size !== payload.length || source.sha256 !== hash(payload)) fail("checkpoint-envelope-invalid", `${path} envelope content is invalid`);
  return { path, bytes: payload };
}
function controlRef(checkpointId: string): string {
  if (!CHECKPOINT_ID.test(checkpointId)) fail("checkpoint-schema-invalid", "checkpointId is invalid");
  return `refs/endroit/checkpoints/${checkpointId.slice("checkpoint:sha256:".length)}/control`;
}
function validateControl(value: unknown): RemoteControl {
  const source = object(value, "CONTROL.json"); exact(source, ["schema", "checkpointId", "algorithm", "recipientRefs", "objects"], "CONTROL.json");
  if (source.schema !== CONTROL_SCHEMA || typeof source.checkpointId !== "string" || !CHECKPOINT_ID.test(source.checkpointId) || source.algorithm !== "age/1" || !Array.isArray(source.recipientRefs) || source.recipientRefs.length === 0 || !Array.isArray(source.objects) || source.objects.length === 0) fail("checkpoint-schema-invalid", "CONTROL.json identity is invalid");
  const recipientRefs = source.recipientRefs.map((value) => typeof value === "string" && RECIPIENT_REF.test(value) ? value : fail("checkpoint-schema-invalid", "CONTROL.json has an invalid recipient Ref"));
  const objects = source.objects.map((value, index) => {
    const item = object(value, `objects[${index}]`); exact(item, ["sha256", "size"], `objects[${index}]`);
    if (typeof item.sha256 !== "string" || !REVISION.test(item.sha256) || !Number.isSafeInteger(item.size) || Number(item.size) <= 0) fail("checkpoint-schema-invalid", `objects[${index}] is invalid`);
    return { sha256: item.sha256, size: Number(item.size) };
  });
  if (new Set(recipientRefs).size !== recipientRefs.length || new Set(objects.map((item) => item.sha256)).size !== objects.length || stable(recipientRefs) !== stable([...recipientRefs].sort()) || stable(objects) !== stable([...objects].sort((a, b) => a.sha256.localeCompare(b.sha256)))) fail("checkpoint-schema-invalid", "CONTROL.json contains duplicates or unsorted sets");
  return { schema: CONTROL_SCHEMA, checkpointId: source.checkpointId, algorithm: "age/1", recipientRefs, objects };
}
async function readControl(checkout: string): Promise<RemoteControl> {
  try {
    if (!(await lstat(join(checkout, "CONTROL.json"))).isFile()) fail("checkpoint-file-set-mismatch", "CONTROL.json is not a regular file");
    const content = await readFile(join(checkout, "CONTROL.json"), "utf8"); const control = validateControl(JSON.parse(content));
    if (content !== stable(control)) fail("checkpoint-component-mismatch", "CONTROL.json is not canonical"); return control;
  } catch (error) { if (error instanceof SyntaxError) fail("checkpoint-schema-invalid", `CONTROL.json is invalid JSON: ${error.message}`); throw error; }
}

async function decryptCheckout(checkout: string, identityPaths: string[], outputRoot: string): Promise<{ control: RemoteControl; manifest: CheckpointManifest }> {
  const control = await readControl(checkout); const objectRoot = join(checkout, "objects");
  const expected = control.objects.map((item) => `${item.sha256.slice("sha256:".length)}.age`).sort();
  const actual = (await readdir(objectRoot, { withFileTypes: true })).map((entry) => entry.isFile() ? entry.name : fail("checkpoint-file-set-mismatch", `objects/${entry.name} is not a file`)).sort();
  if (stable(actual) !== stable(expected)) fail("checkpoint-file-set-mismatch", "Remote envelope object set changed");
  const tracked = new TextDecoder().decode(git(checkout, ["ls-files", "-z"])).split("\0").filter(Boolean).sort();
  if (stable(tracked) !== stable(["CONTROL.json", ...expected.map((name) => `objects/${name}`)].sort())) fail("checkpoint-file-set-mismatch", "Remote control tree contains unexpected files");
  const paths = new Set<string>();
  for (const item of control.objects) {
    const cipher = await readFile(join(objectRoot, `${item.sha256.slice("sha256:".length)}.age`));
    if (cipher.length !== item.size || hash(cipher) !== item.sha256) fail("checkpoint-envelope-mismatch", `${item.sha256} changed`);
    const record = decodeRecord(ageDecrypt(checkout, cipher, identityPaths));
    if (paths.has(record.path)) fail("checkpoint-envelope-invalid", `${record.path} is duplicated`); paths.add(record.path);
    const target = resolve(outputRoot, record.path); if (!target.startsWith(`${resolve(outputRoot)}${sep}`)) fail("checkpoint-path-invalid", `${record.path} escapes the checkpoint target`);
    await mkdir(dirname(target), { recursive: true }); await writeFile(target, record.bytes, { flag: "wx" });
  }
  const verified = await verifyCheckpoint(outputRoot);
  if (verified.manifest.checkpointId !== control.checkpointId) fail("checkpoint-id-mismatch", "Remote control and decrypted checkpoint differ");
  return { control, manifest: verified.manifest };
}
function normalizedRemote(remote: string): string { return remote.replace(/\/+$/, ""); }
function rejectProductRemote(manifest: CheckpointManifest, remote: string): void {
  const expected = normalizedRemote(remote);
  if (manifest.repositories.flatMap((repository) => repository.remotes).flatMap((item) => item.urls).some((url) => normalizedRemote(url) === expected)) fail("checkpoint-remote-collision", "Checkpoint remote collides with a captured product remote");
}
async function fetchCheckout(remote: string, ref: string, destination: string): Promise<string> {
  await mkdir(destination, { recursive: true }); git(destination, ["init", "-q"]); git(destination, ["fetch", "-q", "--no-tags", remote, ref]); git(destination, ["checkout", "-q", "--detach", "FETCH_HEAD"]);
  return output(git(destination, ["rev-parse", "HEAD"]));
}
function remoteReceipt(operation: "publish" | "fetch", status: CheckpointRemoteReceipt["status"], control: RemoteControl, remote: string, commit: string, latest: LatestResult | null): CheckpointRemoteReceipt {
  return { schema: "workplace-checkpoint-remote-receipt/1", operation, checkpointId: control.checkpointId, status, controlRef: controlRef(control.checkpointId), controlCommit: commit, remoteIdentity: hash(remote), algorithm: "age/1", recipientRefs: control.recipientRefs, objects: control.objects.length, latest };
}

const LATEST_REF = "refs/endroit/checkpoints/latest";

async function observedLatest(remote: string, parent: string): Promise<{ commit: string; checkpointId: string } | null> {
  const line = output(git(process.cwd(), ["ls-remote", remote, LATEST_REF]));
  if (!line) return null;
  const checkout = await mkdtemp(join(parent, ".checkpoint-latest-"));
  try { const commit = await fetchCheckout(remote, LATEST_REF, checkout); return { commit, checkpointId: (await readControl(checkout)).checkpointId }; }
  finally { await rm(checkout, { recursive: true, force: true }); }
}

export async function resolveLatestRemoteCheckpoint(value: unknown, options: { requestDirectory?: string } = {}): Promise<{ controlCommit: string; checkpointId: string } | null> {
  const requestDirectory = resolve(options.requestDirectory ?? process.cwd());
  const request = parseFetchRequest(value, requestDirectory);
  const latest = await observedLatest(request.remote, requestDirectory);
  return latest ? { controlCommit: latest.commit, checkpointId: latest.checkpointId } : null;
}

async function advanceLatest(checkout: string, remote: string, control: RemoteControl, commit: string, baseCheckpoint: string | null): Promise<LatestResult> {
  const current = await observedLatest(remote, dirname(checkout));
  if (current?.checkpointId === control.checkpointId) return { status: "advanced", baseCheckpoint, observedCheckpoint: control.checkpointId };
  if ((current?.checkpointId ?? null) !== baseCheckpoint) return { status: "diverged", baseCheckpoint, observedCheckpoint: current?.checkpointId ?? null };
  const lease = current ? `${LATEST_REF}:${current.commit}` : `${LATEST_REF}:`;
  const pushed = spawnSync("git", ["push", "-q", `--force-with-lease=${lease}`, remote, `${commit}:${LATEST_REF}`], { cwd: checkout, env: { ...process.env, LC_ALL: "C" }, maxBuffer: 1024 * 1024 * 1024 });
  if (pushed.status !== 0) return { status: "diverged", baseCheckpoint, observedCheckpoint: (await observedLatest(remote, dirname(checkout)))?.checkpointId ?? null };
  const after = await observedLatest(remote, dirname(checkout));
  if (after?.commit !== commit || after.checkpointId !== control.checkpointId) fail("checkpoint-remote-mismatch", "latest did not resolve to the verified control commit");
  return { status: "advanced", baseCheckpoint, observedCheckpoint: control.checkpointId };
}

export async function publishCheckpoint(checkpointPath: string, value: unknown, options: { requestDirectory?: string } = {}): Promise<{ receipt: CheckpointRemoteReceipt }> {
  const request = parsePublishRequest(value, resolve(options.requestDirectory ?? process.cwd())); const verified = await verifyCheckpoint(checkpointPath); rejectProductRemote(verified.manifest, request.remote); const ref = controlRef(verified.manifest.checkpointId);
  const recipientRefs = request.recipients.map((item) => item.ref);
  const existing = output(git(process.cwd(), ["ls-remote", request.remote, ref]));
  if (existing) {
    const checkout = await mkdtemp(join(dirname(verified.path), ".checkpoint-remote-fetch-")); const decrypted = await mkdtemp(join(dirname(verified.path), ".checkpoint-remote-decrypt-"));
    try {
      const commit = await fetchCheckout(request.remote, ref, checkout); const observed = await decryptCheckout(checkout, request.identities, decrypted);
      if (observed.control.checkpointId !== verified.manifest.checkpointId || stable(observed.control.recipientRefs) !== stable(recipientRefs)) fail("checkpoint-remote-diverged", "Existing remote ref has different checkpoint or recipients");
      const latest = await advanceLatest(checkout, request.remote, observed.control, commit, request.baseCheckpoint);
      return { receipt: remoteReceipt("publish", latest.status === "diverged" ? "diverged" : "verified-remote", observed.control, request.remote, commit, latest) };
    }
    finally { await rm(checkout, { recursive: true, force: true }); await rm(decrypted, { recursive: true, force: true }); }
  }
  const staging = await mkdtemp(join(dirname(verified.path), ".checkpoint-remote-stage-")); const localProof = await mkdtemp(join(dirname(verified.path), ".checkpoint-remote-proof-"));
  try {
    await mkdir(join(staging, "objects"), { recursive: true }); const objects: RemoteObject[] = [];
    // ponytail: one age process per file; batch only after real-package profiling proves process overhead material.
    for (const path of await filesBelow(verified.path)) {
      const cipher = ageEncrypt(staging, encodeRecord(path, await readFile(join(verified.path, path))), request.recipients); const digest = hash(cipher);
      await writeFile(join(staging, `objects/${digest.slice("sha256:".length)}.age`), cipher, { flag: "wx" }); objects.push({ sha256: digest, size: cipher.length });
    }
    objects.sort((a, b) => a.sha256.localeCompare(b.sha256));
    const control: RemoteControl = { schema: CONTROL_SCHEMA, checkpointId: verified.manifest.checkpointId, algorithm: "age/1", recipientRefs, objects };
    await writeFile(join(staging, "CONTROL.json"), stable(control)); git(staging, ["init", "-q"]); git(staging, ["add", "CONTROL.json", "objects"]);
    const local = await decryptCheckout(staging, request.identities, localProof); rejectProductRemote(local.manifest, request.remote);
    git(staging, ["-c", "user.name=Endroit Checkpoint", "-c", "user.email=checkpoint@endroit.invalid", "commit", "-qm", `Checkpoint ${verified.manifest.checkpointId}`]); git(staging, ["push", "-q", request.remote, `HEAD:${ref}`]);
    const checkout = await mkdtemp(join(dirname(verified.path), ".checkpoint-remote-fetch-")); const remoteProof = await mkdtemp(join(dirname(verified.path), ".checkpoint-remote-proof-"));
    try {
      const commit = await fetchCheckout(request.remote, ref, checkout); const observed = await decryptCheckout(checkout, request.identities, remoteProof);
      if (observed.control.checkpointId !== verified.manifest.checkpointId || stable(observed.control.recipientRefs) !== stable(recipientRefs)) fail("checkpoint-remote-diverged", "Fetched remote ref differs from the published checkpoint");
      const latest = await advanceLatest(checkout, request.remote, observed.control, commit, request.baseCheckpoint);
      return { receipt: remoteReceipt("publish", latest.status === "diverged" ? "diverged" : "verified-remote", observed.control, request.remote, commit, latest) };
    }
    finally { await rm(checkout, { recursive: true, force: true }); await rm(remoteProof, { recursive: true, force: true }); }
  } finally { await rm(staging, { recursive: true, force: true }); await rm(localProof, { recursive: true, force: true }); }
}

export async function fetchCheckpoint(checkpointId: string, value: unknown, targetPath: string, options: { requestDirectory?: string } = {}): Promise<{ path: string; receipt: CheckpointRemoteReceipt }> {
  const request = parseFetchRequest(value, resolve(options.requestDirectory ?? process.cwd())); const ref = controlRef(checkpointId); const target = resolve(targetPath);
  if (await lstat(target).then(() => true).catch(() => false)) fail("checkpoint-output-exists", `${target} already exists`);
  await mkdir(dirname(target), { recursive: true }); const parent = await realpath(dirname(target)); const final = join(parent, basename(target)); const checkout = await mkdtemp(join(parent, ".checkpoint-remote-fetch-")); const decrypted = await mkdtemp(join(parent, ".checkpoint-remote-decrypt-"));
  try {
    const commit = await fetchCheckout(request.remote, ref, checkout); const observed = await decryptCheckout(checkout, request.identities, decrypted); rejectProductRemote(observed.manifest, request.remote); await rename(decrypted, final);
    return { path: final, receipt: remoteReceipt("fetch", "fetched-verified", observed.control, request.remote, commit, null) };
  } catch (error) { await rm(decrypted, { recursive: true, force: true }); throw error; }
  finally { await rm(checkout, { recursive: true, force: true }); }
}

export async function restoreCheckpointFromRemote(checkpointId: string, value: unknown, targetPath: string, options: { requestDirectory?: string } = {}): Promise<{ path: string; receipt: CheckpointReceipt; remote: CheckpointRemoteReceipt }> {
  const target = resolve(targetPath);
  if (await lstat(target).then(() => true).catch(() => false)) fail("checkpoint-target-exists", `${target} already exists`);
  await mkdir(dirname(target), { recursive: true });
  const temporary = await mkdtemp(join(await realpath(dirname(target)), ".checkpoint-fresh-machine-"));
  try {
    const fetched = await fetchCheckpoint(checkpointId, value, join(temporary, "checkpoint"), options);
    const restored = await restoreCheckpoint(fetched.path, target);
    return { ...restored, remote: fetched.receipt };
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
