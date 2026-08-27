import { lstat, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { hash, stable } from "../compiler/index.ts";
import { findQualificationRun } from "./runs.ts";

const PRESERVED_V9 = "20260826T203355Z-viral-game-9d0a56d5";

function fail(message: string): never { throw new Error(message); }

export function validateArchiveMembers(members: string[]): void {
  if (members.length === 0) fail("Qualification archive is empty");
  for (const member of members) {
    if (!member || member.startsWith("/") || member.split("/").includes("..") || (member !== "mount" && !member.startsWith("mount/"))) fail(`Qualification archive has unsafe member: ${member}`);
  }
  if (!members.some((member) => /(?:^|\/)\.git(?:\/|$)/.test(member))) fail("Qualification archive does not contain Git metadata");
}

function command(argv: string[], cwd: string): string {
  const result = Bun.spawnSync(argv, { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) fail(new TextDecoder().decode(result.stderr).trim() || `${argv[0]} failed`);
  return new TextDecoder().decode(result.stdout);
}

async function verifyArchive(path: string, root: string) {
  // Frozen archives are evidence stores only. Endroit never extracts them.
  command(["gzip", "-t", path], root);
  const members = command(["tar", "-tzf", path], root).split("\n").filter(Boolean);
  validateArchiveMembers(members);
  const bytes = await readFile(path);
  return { digest: hash(bytes), bytes: bytes.byteLength, members: members.length };
}

export async function freezeQualificationRun(options: { repository: string; runId: string }) {
  if (options.runId === PRESERVED_V9) fail(`Qualification run ${options.runId} is preserved and cannot be frozen`);
  const root = await findQualificationRun(options.repository, options.runId);
  const runPath = join(root, "RUN.json");
  const run = JSON.parse(await readFile(runPath, "utf8")) as Record<string, unknown>;
  if (run.mount !== "mount") fail("Qualification run mount locator must be exactly mount");
  if (run.status === "prepared") fail(`Qualification run ${options.runId} must be captured before freeze`);
  const archiveRecord = run.archive && typeof run.archive === "object" ? run.archive as Record<string, unknown> : null;
  if (run.mountState === "frozen" && archiveRecord) {
    if (archiveRecord.path !== "archive/mount.tar.gz") fail("Frozen Qualification archive path is invalid");
    const archivePath = join(root, "archive/mount.tar.gz");
    const verified = await verifyArchive(archivePath, root);
    if (verified.digest !== archiveRecord.digest || verified.bytes !== archiveRecord.bytes) fail("Frozen Qualification archive no longer matches RUN.json");
    const mount = join(root, "mount");
    const mountExists = await lstat(mount).then(() => true, () => false);
    if (mountExists) await rm(mount, { recursive: true, force: false });
    return { run: options.runId, mountState: "frozen", archive: archiveRecord, changed: mountExists };
  }
  const mount = join(root, "mount");
  const mountLink = await lstat(mount).catch(() => null);
  const mountStat = await stat(mount).catch(() => null);
  if (!mountLink || !mountStat || !(mountStat as unknown as { isDirectory(): boolean }).isDirectory() || mountLink.isSymbolicLink()) fail("Qualification Mount is missing or unsafe");
  const archiveDirectory = join(root, "archive");
  const finalPath = join(archiveDirectory, "mount.tar.gz");
  await mkdir(archiveDirectory, { recursive: true });
  const temporaryPath = join(archiveDirectory, `.mount-${crypto.randomUUID()}.tar.gz`);
  try {
    let verified;
    if (await stat(finalPath).then(() => true, () => false)) {
      verified = await verifyArchive(finalPath, root);
    } else {
      command(["tar", "-czf", temporaryPath, "-C", root, "mount"], root);
      verified = await verifyArchive(temporaryPath, root);
      await rename(temporaryPath, finalPath);
    }
    const archive = { path: relative(root, finalPath), format: "tar.gz", digest: verified.digest, bytes: verified.bytes, members: verified.members };
    const updated = { ...run, mountState: "frozen", archive };
    const runTemporary = `${runPath}.freeze-${crypto.randomUUID()}.tmp`;
    await writeFile(runTemporary, stable(updated), { flag: "wx" });
    await rename(runTemporary, runPath);
    await rm(mount, { recursive: true, force: false });
    return { run: options.runId, mountState: "frozen", archive, changed: true };
  } catch (error) {
    await rm(temporaryPath, { recursive: false, force: true }).catch(() => undefined);
    throw error;
  }
}

if (resolve(Bun.argv[1] ?? "") === resolve(import.meta.dir, "case-freeze.ts")) {
  const runId = Bun.argv[2];
  if (!runId) fail("usage: bun run case:freeze -- <run-id>");
  console.log(JSON.stringify(await freezeQualificationRun({ repository: resolve(import.meta.dir, "../.."), runId }), null, 2));
}
