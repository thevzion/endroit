import { lstat, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseSourceEnvelope, stable } from "./compiler/index.ts";

const REF = /^workplace:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
const ID = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export type CurrentMemberBinding = {
  kind: "CurrentMemberBindings";
  version: 1;
  anchor: string;
  members: Array<{ workplace: string; member: string; desk: string }>;
};

export type CurrentMemberResolution =
  | { status: "resolved"; source: "request" | "local"; workplace: string; member: string; desk: string }
  | { status: "pending-member"; source: "none"; workplace: string };

export class CurrentMemberError extends Error {
  constructor(readonly code: "invalid-current-member-binding" | "current-member-collision", message: string) {
    super(message);
    this.name = "CurrentMemberError";
  }
}

function fail(code: CurrentMemberError["code"], message: string): never {
  throw new CurrentMemberError(code, message);
}

function object(value: unknown, subject: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid-current-member-binding", `${subject} must be an object`);
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, keys: string[], subject: string): void {
  const unknown = Object.keys(value).filter((key) => !keys.includes(key));
  const missing = keys.filter((key) => !(key in value));
  if (unknown.length) fail("invalid-current-member-binding", `${subject} has unknown fields: ${unknown.join(", ")}`);
  if (missing.length) fail("invalid-current-member-binding", `${subject} is missing fields: ${missing.join(", ")}`);
}

function ref(value: unknown, subject: string): string {
  if (typeof value !== "string" || !REF.test(value)) fail("invalid-current-member-binding", `${subject} must be a fully qualified Workplace ref`);
  return value;
}

function memberEntry(value: unknown, subject: string): CurrentMemberBinding["members"][number] {
  const entry = object(value, subject);
  exact(entry, ["workplace", "member", "desk"], subject);
  const workplace = ref(entry.workplace, `${subject}.workplace`);
  const member = ref(entry.member, `${subject}.member`);
  const desk = ref(entry.desk, `${subject}.desk`);
  if (!member.startsWith(`${workplace}/member/`) || !desk.startsWith(`${workplace}/desk/`)) fail("invalid-current-member-binding", `${subject} Member and Desk must belong to ${workplace}`);
  return { workplace, member, desk };
}

function parseBinding(value: unknown, anchor: string): CurrentMemberBinding {
  const source = object(value, "CurrentMemberBindings");
  exact(source, ["kind", "version", "anchor", "members"], "CurrentMemberBindings");
  if (source.kind !== "CurrentMemberBindings" || source.version !== 1 || ref(source.anchor, "CurrentMemberBindings.anchor") !== anchor || !Array.isArray(source.members)) fail("invalid-current-member-binding", `CurrentMemberBindings must target ${anchor}`);
  const members = source.members.map((entry, index) => memberEntry(entry, `CurrentMemberBindings.members[${index}]`));
  if (new Set(members.map((entry) => entry.workplace)).size !== members.length) fail("invalid-current-member-binding", "CurrentMemberBindings repeats a Workplace");
  return { kind: "CurrentMemberBindings", version: 1, anchor, members: members.sort((a, b) => a.workplace.localeCompare(b.workplace)) };
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) {
    if (error instanceof Error && error.message.includes("ENOENT")) return false;
    throw error;
  }
}

function bindingPath(anchorMount: string): string {
  return join(resolve(anchorMount), ".endroit/current-member.json");
}

async function assertLocalStatePath(anchorMount: string, path: string): Promise<void> {
  const mount = await realpath(resolve(anchorMount)).catch(() => fail("current-member-collision", `${anchorMount} is unavailable`));
  const localRoot = dirname(path);
  if (await exists(localRoot)) {
    const info = await lstat(localRoot);
    if (info.isSymbolicLink() || !info.isDirectory() || await realpath(localRoot) !== join(mount, ".endroit")) fail("current-member-collision", `${localRoot} must be a physical local-state directory`);
  }
  if (await exists(path)) {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile()) fail("current-member-collision", `${path} must be a physical local binding file`);
  }
}

async function readBinding(anchorMount: string, anchor: string): Promise<CurrentMemberBinding | undefined> {
  const path = bindingPath(anchorMount);
  await assertLocalStatePath(anchorMount, path);
  if (!await exists(path)) return undefined;
  try { return parseBinding(JSON.parse(await readFile(path, "utf8")) as unknown, anchor); }
  catch (error) {
    if (error instanceof SyntaxError) fail("invalid-current-member-binding", `${path} is invalid JSON`);
    throw error;
  }
}

export async function verifyCurrentMemberSources(input: { workplaceMount: string; workplace: string; member: string; desk: string }): Promise<{ workplace: string; member: string; desk: string }> {
  const workplace = ref(input.workplace, "workplace");
  const member = ref(input.member, "member");
  const desk = ref(input.desk, "desk");
  const prefix = `${workplace}/member/`;
  const id = member.startsWith(prefix) ? member.slice(prefix.length) : "";
  if (!ID.test(id) || desk !== `${workplace}/desk/${id}`) fail("invalid-current-member-binding", "Current Member needs one same-id v1 Desk in its Workplace");
  const mount = await realpath(resolve(input.workplaceMount)).catch(() => fail("current-member-collision", `${input.workplaceMount} is unavailable`));
  const sources = [
    { path: join(mount, `workplace/sources/members/${id}/MEMBER.md`), ref: member, entity: "member", role: undefined },
    { path: join(mount, `workplace/sources/members/${id}/desk/DESK.md`), ref: desk, entity: "place", role: "desk" },
  ];
  for (const source of sources) {
    const info = await lstat(source.path).catch(() => fail("invalid-current-member-binding", `${source.ref} has no source`));
    if (info.isSymbolicLink() || !info.isFile() || await realpath(source.path) !== source.path) fail("current-member-collision", `${source.path} must be a physical source file`);
    const envelope = parseSourceEnvelope(await readFile(source.path, "utf8"), source.path).envelope;
    if (envelope.ref !== source.ref || envelope.entity !== source.entity || source.role && !envelope.roles?.includes(source.role)) fail("invalid-current-member-binding", `${source.path} does not prove ${source.ref}`);
    if (source.role && (envelope.owner !== member || !envelope.relations["owned-by"]?.includes(member))) fail("invalid-current-member-binding", `${source.ref} is not owned by ${member}`);
  }
  return { workplace, member, desk };
}

export async function resolveCurrentMember(input: { anchorMount: string; anchor: string; workplace: string; member?: string; desk?: string }): Promise<CurrentMemberResolution> {
  const anchor = ref(input.anchor, "anchor");
  const workplace = ref(input.workplace, "workplace");
  if ((input.member === undefined) !== (input.desk === undefined)) fail("invalid-current-member-binding", "Current Member needs both member and desk or neither");
  if (input.member !== undefined && input.desk !== undefined) {
    const explicit = memberEntry({ workplace, member: input.member, desk: input.desk }, "Current Member request");
    return { status: "resolved", source: "request", ...explicit };
  }
  const local = await readBinding(input.anchorMount, anchor);
  const remembered = local?.members.find((entry) => entry.workplace === workplace);
  return remembered ? { status: "resolved", source: "local", ...remembered } : { status: "pending-member", source: "none", workplace };
}

export async function rememberCurrentMember(input: { anchorMount: string; anchor: string; workplace: string; member: string; desk: string }): Promise<{ path: string; changed: boolean; binding: CurrentMemberBinding }> {
  const anchor = ref(input.anchor, "anchor");
  const current = memberEntry({ workplace: input.workplace, member: input.member, desk: input.desk }, "Current Member request");
  const path = bindingPath(input.anchorMount);
  await assertLocalStatePath(input.anchorMount, path);
  const previous = await readBinding(input.anchorMount, anchor);
  const binding: CurrentMemberBinding = {
    kind: "CurrentMemberBindings", version: 1, anchor,
    members: [...(previous?.members.filter((entry) => entry.workplace !== current.workplace) ?? []), current].sort((a, b) => a.workplace.localeCompare(b.workplace)),
  };
  if (previous && stable(previous) === stable(binding)) return { path, changed: false, binding };
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${crypto.randomUUID()}`;
  await writeFile(temporary, stable(binding), { flag: "wx" });
  await rename(temporary, path);
  return { path, changed: true, binding };
}
