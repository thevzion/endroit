#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw new Error("usage: node scripts/checkpoint-validate.mjs <checkpoint-directory>");

function stable(value) {
  const normalize = (item) => Array.isArray(item) ? item.map(normalize) : item && typeof item === "object" ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, normalize(item[key])])) : item;
  return `${JSON.stringify(normalize(value), null, 2)}\n`;
}
function exact(value, fields, subject, required = fields) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${subject} must be an object`);
  const unknown = Object.keys(value).filter((key) => !fields.includes(key));
  const missing = required.filter((key) => !(key in value));
  if (unknown.length || missing.length) throw new Error(`${subject} has invalid fields`);
}
function digest(path) { return createHash("sha256").update(readFileSync(path)).digest("hex"); }
function revision(bytes) { return `sha256:${createHash("sha256").update(bytes).digest("hex")}`; }
function portable(value, subject) {
  if (typeof value !== "string" || !value || value.startsWith("/") || /^[A-Za-z]:\//.test(value) || value.includes("\\") || value.split("/").some((part) => !part || part === "." || part === "..")) throw new Error(`${subject} is not a portable path`);
  return value;
}
function filesBelow(current = root) {
  return readdirSync(current, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? filesBelow(join(current, entry.name)) : [relative(root, join(current, entry.name)).split(sep).join("/")]).sort();
}
function parse(path) { const content = readFileSync(join(root, path), "utf8"); const value = JSON.parse(content); if (content !== stable(value)) throw new Error(`${path} is not canonical`); return value; }

const manifest = parse("MANIFEST.json");
exact(manifest, ["schema", "checkpointId", "workplaceRef", "workplaceRevision", "fidelityPolicy", "repositories", "worktrees", "payloads", "compatibility", "portableFingerprint"], "MANIFEST.json");
if (manifest.schema !== "workplace-checkpoint-manifest/1" || !/^checkpoint:sha256:[a-f0-9]{64}$/.test(manifest.checkpointId) || !Array.isArray(manifest.repositories) || !Array.isArray(manifest.worktrees) || !Array.isArray(manifest.payloads)) throw new Error("Unsupported checkpoint manifest");
exact(manifest.fidelityPolicy, ["includeUntracked", "ignoredPaths"], "fidelityPolicy");
if (typeof manifest.fidelityPolicy.includeUntracked !== "boolean" || !Array.isArray(manifest.fidelityPolicy.ignoredPaths)) throw new Error("Invalid fidelity policy");
for (const ignored of manifest.fidelityPolicy.ignoredPaths) { exact(ignored, ["worktree", "path"], "ignored path"); portable(ignored.path, "ignored path"); }
exact(manifest.compatibility, ["platform", "objectFormats", "symlinks"], "compatibility");
const expected = new Set(["CHECKPOINT.md", "MANIFEST.json", "RECEIPT.json", "RESTORE.md"]);
for (const payload of manifest.payloads) {
  exact(payload, ["sha256", "size", "path"], "payload");
  portable(payload.path, "payload.path");
  if (payload.path !== `payloads/${payload.sha256}` || digest(join(root, payload.path)) !== payload.sha256) throw new Error(`${payload.path} changed`);
  expected.add(payload.path);
}
for (const repository of manifest.repositories) {
  exact(repository, ["schema", "repositoryId", "rootRef", "objectFormat", "refs", "remotes", "config", "worktrees", "objectClosure", "bundle"], "repository");
  if (!/^[a-f0-9]{16}$/.test(repository.repositoryId) || !["sha1", "sha256"].includes(repository.objectFormat) || !Array.isArray(repository.refs) || !Array.isArray(repository.remotes) || !Array.isArray(repository.worktrees)) throw new Error("Invalid repository identity");
  for (const ref of repository.refs) { exact(ref, ["name", "oid"], "ref"); if (typeof ref.name !== "string" || !ref.name.startsWith("refs/") || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(ref.oid)) throw new Error("Invalid ref"); }
  for (const remote of repository.remotes) { exact(remote, ["name", "urls"], "remote"); if (!Array.isArray(remote.urls) || remote.urls.some((url) => typeof url !== "string" || /^https?:\/\/[^/]*@/i.test(url))) throw new Error("Invalid remote"); }
  if (Object.keys(repository.config).some((key) => !["core.autocrlf", "core.eol", "core.filemode", "core.symlinks"].includes(key)) || Object.values(repository.config).some((value) => typeof value !== "string")) throw new Error("Invalid portable Git config");
  exact(repository.objectClosure, ["digest", "objects"], "objectClosure");
  exact(repository.bundle, ["path", "sha256", "size"], "bundle"); portable(repository.bundle.path, "bundle.path");
  const sidecar = `repositories/${repository.repositoryId}.json`;
  if (stable(repository) !== readFileSync(join(root, sidecar), "utf8") || digest(join(root, repository.bundle.path)) !== repository.bundle.sha256) throw new Error(`${repository.repositoryId} changed`);
  const bare = mkdtempSync(join(tmpdir(), "checkpoint-static-"));
  try {
    if (spawnSync("git", ["init", "--bare", "-q", `--object-format=${repository.objectFormat}`], { cwd: bare }).status !== 0 || spawnSync("git", ["bundle", "verify", join(root, repository.bundle.path)], { cwd: bare }).status !== 0) throw new Error(`${repository.repositoryId} bundle is invalid`);
  } finally { rmSync(bare, { recursive: true, force: true }); }
  expected.add(sidecar); expected.add(repository.bundle.path);
}
for (const worktree of manifest.worktrees) {
  exact(worktree, ["schema", "worktreeId", "repositoryId", "logicalPath", "head", "branchRef", "index", "tracked", "untracked", "ignored", "operation"], "worktree");
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(worktree.worktreeId)) throw new Error("Invalid worktree identity");
  portable(worktree.logicalPath, "worktree.logicalPath");
  exact(worktree.index, ["schema", "entries", "unsupportedExtensions"], "index");
  for (const entry of worktree.index.entries) { exact(entry, ["path", "stage", "mode", "oid", "assumeUnchanged", "skipWorktree", "intentToAdd"], "index entry"); portable(entry.path, "index path"); }
  for (const record of [...worktree.tracked, ...worktree.untracked, ...worktree.ignored]) { exact(record, ["path", "kind", "mode", "sha256", "size", "payload"], "content record", ["path", "kind", "mode"]); portable(record.path, "content path"); if (record.payload) portable(record.payload, "content payload"); }
  for (const record of worktree.operation) { exact(record, ["path", "sha256", "size", "payload"], "operation record"); portable(record.path, "operation path"); portable(record.payload, "operation payload"); }
  const sidecar = `worktrees/${worktree.worktreeId}.json`;
  if (stable(worktree) !== readFileSync(join(root, sidecar), "utf8")) throw new Error(`${worktree.worktreeId} changed`);
  expected.add(sidecar);
}
const { checkpointId, ...checkpointBase } = manifest;
if (`checkpoint:${revision(stable(checkpointBase))}` !== checkpointId) throw new Error("Checkpoint ID changed");
const semanticRepositories = manifest.repositories.map(({ bundle: _bundle, ...repository }) => repository);
if (revision(stable({ fidelityPolicy: manifest.fidelityPolicy, repositories: semanticRepositories, worktrees: manifest.worktrees })) !== manifest.portableFingerprint) throw new Error("Portable fingerprint changed");
const expectedReceipt = {
  schema: "workplace-checkpoint-receipt/1", operation: "capture", checkpointId, workplaceRef: manifest.workplaceRef, portableFingerprint: manifest.portableFingerprint, status: "captured",
  coverage: { repositories: manifest.repositories.length, worktrees: manifest.worktrees.length, untracked: manifest.worktrees.reduce((count, worktree) => count + worktree.untracked.length, 0), ignored: manifest.worktrees.reduce((count, worktree) => count + worktree.ignored.length, 0), exclusions: ["filesystem-metadata", "special-files", "ignored-files-not-selected", "provider-state", "credentials"] },
};
if (readFileSync(join(root, "RECEIPT.json"), "utf8") !== stable(expectedReceipt)) throw new Error("RECEIPT.json changed");
if (readFileSync(join(root, "CHECKPOINT.md"), "utf8") !== `# Workplace Checkpoint\n\n- ID: \`${checkpointId}\`\n- Workplace: \`${manifest.workplaceRef}\`\n- Repositories: ${manifest.repositories.length}\n- Worktrees: ${manifest.worktrees.length}\n- Status: captured and locally verifiable\n`) throw new Error("CHECKPOINT.md changed");
if (readFileSync(join(root, "RESTORE.md"), "utf8") !== "# Restore\n\nVerify before restore:\n\n```sh\nendroit checkpoint verify <checkpoint-directory>\nendroit checkpoint restore <checkpoint-directory> --to <absent-target>\n```\n\nRestore never runs Workplace check, compile or ready.\n") throw new Error("RESTORE.md changed");
const actual = filesBelow();
if (actual.some((path) => !expected.has(path)) || [...expected].some((path) => !actual.includes(path))) throw new Error("Checkpoint file set changed");
const plan = {
  schema: "workplace-checkpoint-restore-plan/1",
  checkpointId: manifest.checkpointId,
  repositories: manifest.repositories.map((repository) => ({ repositoryId: repository.repositoryId, rootRef: repository.rootRef, objectFormat: repository.objectFormat, bundle: repository.bundle.path, refs: repository.refs.length, worktrees: repository.worktrees })),
  worktrees: manifest.worktrees.map((worktree) => ({ worktreeId: worktree.worktreeId, repositoryId: worktree.repositoryId, logicalPath: worktree.logicalPath, head: worktree.head, branchRef: worktree.branchRef, indexEntries: worktree.index.entries.length, tracked: worktree.tracked.length, untracked: worktree.untracked.length, ignored: worktree.ignored.length, operation: worktree.operation.length })),
};
process.stdout.write(stable({ status: "verified-static", plan }));
