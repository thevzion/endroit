import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { hash } from "./compiler/index.ts";

const FULL_REF = /^refs\/(?:heads|tags)\/[A-Za-z0-9][A-Za-z0-9._/-]*$/;

export type BootstrapRefReceipt = {
  kind: "BootstrapRefReceipt";
  version: 1;
  locator: string;
  ref: string;
  oid: string;
  path: string;
  digest: string;
};

export type ResolvedBootstrapRef = {
  checkout: string;
  recoveryPath: string;
  receipt: BootstrapRefReceipt;
  cleanup: () => Promise<void>;
};

export class BootstrapRefError extends Error {
  constructor(readonly code: "invalid-bootstrap-ref" | "bootstrap-ref-unavailable", message: string) {
    super(message);
    this.name = "BootstrapRefError";
  }
}

function fail(code: BootstrapRefError["code"], message: string): never { throw new BootstrapRefError(code, message); }

function inside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !/^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(path));
}

function runRaw(args: string[], cwd: string, allowFailure = false): { status: number; stdout: Uint8Array; stderr: string } {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const output = { status: result.exitCode, stdout: new Uint8Array(result.stdout), stderr: new TextDecoder().decode(result.stderr).trim() };
  if (!allowFailure && output.status !== 0) fail("bootstrap-ref-unavailable", `git ${args[0]} failed: ${output.stderr}`);
  return output;
}

function run(args: string[], cwd: string): string {
  return new TextDecoder().decode(runRaw(args, cwd).stdout).trim();
}

export function isBootstrapRef(value: string): boolean { return value.startsWith("git+"); }

function parse(value: string): { locator: string; ref: string; path: string } {
  if (!isBootstrapRef(value) || value.includes("\0")) fail("invalid-bootstrap-ref", "Bootstrap Ref must start with git+");
  const separator = value.indexOf("#", 4);
  if (separator < 0) fail("invalid-bootstrap-ref", "Bootstrap Ref needs one exact ref and path");
  const locator = value.slice(4, separator);
  const fragment = value.slice(separator + 1);
  const pathSeparator = fragment.indexOf(":");
  if (pathSeparator < 0) fail("invalid-bootstrap-ref", "Bootstrap Ref needs <full-ref>:<relative-path>");
  const ref = fragment.slice(0, pathSeparator);
  const path = fragment.slice(pathSeparator + 1);
  let parsed: URL;
  try { parsed = new URL(locator); }
  catch { fail("invalid-bootstrap-ref", "Bootstrap locator must be an absolute URL"); }
  if (!["https:", "file:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) fail("invalid-bootstrap-ref", "Bootstrap locator must be credential-free https or file URL");
  if (!FULL_REF.test(ref) || ref.includes("..") || ref.includes("//") || ref.includes("@{") || ref.endsWith(".lock")) fail("invalid-bootstrap-ref", "Bootstrap ref must be one exact full branch or tag ref");
  const segments = path.split("/");
  if (!path || path.includes("\\") || path.includes(":") || path.startsWith("/") || /^[A-Za-z]:/.test(path) || path.includes("//") || segments.some((segment) => segment === "" || segment === "." || segment === "..")) fail("invalid-bootstrap-ref", "Bootstrap path must be one safe normalized relative path");
  return { locator: parsed.toString(), ref, path };
}

function object(value: unknown, subject: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid-bootstrap-ref", `${subject} must be an object`);
  return value as Record<string, unknown>;
}

function packagePath(recovery: string, value: unknown, subject: string): string {
  if (typeof value !== "string" || !value || /[\0\r\n:]/.test(value) || value.includes("\\") || value.startsWith("/") || /^[A-Za-z]:/.test(value)) fail("invalid-bootstrap-ref", `${subject} must be one safe relative package path`);
  const segments = recovery.split("/").slice(0, -1);
  for (const segment of value.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (!segments.length) fail("invalid-bootstrap-ref", `${subject} escapes the Bootstrap package`);
      segments.pop();
    } else segments.push(segment);
  }
  if (!segments.length) fail("invalid-bootstrap-ref", `${subject} must resolve to one package path`);
  return segments.join("/");
}

function declaredClosure(recoveryPath: string, bytes: Uint8Array): Array<{ path: string; required: boolean }> {
  let value: unknown;
  try { value = JSON.parse(new TextDecoder().decode(bytes)) as unknown; }
  catch { fail("invalid-bootstrap-ref", "Bootstrap Recovery Request must be valid JSON"); }
  const source = object(value, "Bootstrap Recovery Request");
  const paths: Array<{ path: string; required: boolean }> = [{ path: recoveryPath, required: true }];
  paths.push({ path: packagePath(recoveryPath, source.setup, "WorkplaceRecoveryRequest.setup"), required: true });
  if (!Array.isArray(source.sites) || !Array.isArray(source.checkpoints) || source.continuity !== undefined && !Array.isArray(source.continuity)) fail("invalid-bootstrap-ref", "Bootstrap Recovery Request has invalid package references");
  for (const [index, value] of source.sites.entries()) paths.push({ path: packagePath(recoveryPath, object(value, `sites[${index}]`).request, `sites[${index}].request`), required: true });
  for (const [index, value] of (source.continuity ?? [] as unknown[]).entries()) paths.push({ path: packagePath(recoveryPath, object(value, `continuity[${index}]`).descriptor, `continuity[${index}].descriptor`), required: true });
  for (const [index, value] of source.checkpoints.entries()) paths.push({ path: packagePath(recoveryPath, object(value, `checkpoints[${index}]`).checkpoint, `checkpoints[${index}].checkpoint`), required: false });
  return [...new Map(paths.map((entry) => [entry.path, entry])).values()];
}

function treeEntries(repository: string, oid: string, path: string): Array<{ path: string; mode: string; type: string }> | undefined {
  const result = runRaw(["--literal-pathspecs", "-C", repository, "ls-tree", "-r", "-z", oid, "--", path], dirname(repository), true);
  if (result.status !== 0) fail("bootstrap-ref-unavailable", `git ls-tree failed: ${result.stderr}`);
  const records = new TextDecoder().decode(result.stdout).split("\0").filter(Boolean).map((record) => {
    const match = /^(\d+) (\w+) [a-f0-9]+\t(.+)$/.exec(record) ?? fail("invalid-bootstrap-ref", "Bootstrap tree entry is malformed");
    return { mode: match[1]!, type: match[2]!, path: match[3]! };
  });
  return records.length ? records : undefined;
}

async function extractClosure(repository: string, oid: string, recoveryPath: string, root: string, singleFile = false): Promise<void> {
  const recovery = runRaw(["-C", repository, "show", `${oid}:${recoveryPath}`], dirname(repository), true);
  if (recovery.status !== 0) fail("bootstrap-ref-unavailable", `${recoveryPath} is unavailable in the fetched commit`);
  const declared = singleFile ? [{ path: recoveryPath, required: true }] : declaredClosure(recoveryPath, recovery.stdout);
  const files = new Map<string, Uint8Array>();
  for (const item of declared) {
    const entries = treeEntries(repository, oid, item.path);
    if (!entries) {
      if (item.required) fail("bootstrap-ref-unavailable", `${item.path} is unavailable in the fetched commit`);
      continue;
    }
    for (const entry of entries) {
      if (entry.type !== "blob" || entry.mode === "120000") fail("invalid-bootstrap-ref", `${entry.path} must be a regular Bootstrap file`);
      files.set(entry.path, runRaw(["-C", repository, "show", `${oid}:${entry.path}`], dirname(repository)).stdout);
    }
  }
  for (const [path, bytes] of files) {
    const target = join(root, ...path.split("/"));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes, { flag: "wx" });
  }
}

export async function resolveBootstrapRef(value: string, options: { singleFile?: boolean } = {}): Promise<ResolvedBootstrapRef> {
  const source = parse(value);
  const temporary = await mkdtemp(join(tmpdir(), "endroit-bootstrap-ref-"));
  const repository = join(temporary, "repository");
  const checkout = join(temporary, "package");
  try {
    run(["init", "-q", repository], temporary);
    run(["-C", repository, "fetch", "-q", "--depth=1", "--no-tags", source.locator, source.ref], temporary);
    const oid = run(["-C", repository, "rev-parse", "--verify", "FETCH_HEAD^{commit}"], temporary);
    await mkdir(checkout, { recursive: false });
    await extractClosure(repository, oid, source.path, checkout, options.singleFile);
    const canonicalCheckout = await realpath(checkout);
    const recoveryPath = resolve(canonicalCheckout, source.path);
    const info = await lstat(recoveryPath).catch(() => fail("bootstrap-ref-unavailable", `${source.path} is unavailable at ${source.ref}`));
    if (!inside(canonicalCheckout, recoveryPath) || info.isSymbolicLink() || !info.isFile() || await realpath(recoveryPath) !== recoveryPath) fail("invalid-bootstrap-ref", "Bootstrap recovery path must be one physical file inside the fetched commit");
    const digest = hash(await readFile(recoveryPath, "utf8"));
    return {
      checkout: canonicalCheckout,
      recoveryPath,
      receipt: { kind: "BootstrapRefReceipt", version: 1, locator: source.locator, ref: source.ref, oid, path: source.path, digest },
      cleanup: () => rm(temporary, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}
