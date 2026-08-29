import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { hash, readyWorkplace, stable, type EntryBinding, type ProviderBinding } from "./compiler/index.ts";
import {
  readWorkplaceFederationState,
  resolveDeclaredWorkplaceMount,
  writeWorkplaceLocalBindings,
  type WorkplaceBinding,
  type WorkplaceLocalBindings,
} from "./federation.ts";

const REF = /^workplace:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
const ID = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const IGNORE = ["/.endroit/", "/.agents/", "/FRONTDOOR.md", "/AGENTS.md", "/CLAUDE.md", "/MEMORY.md", "/rooms/", "/work/", "/sites/", "/desks/", "/scopes/", "/methods/", "/agents/", ".DS_Store", "**/.DS_Store", ""].join("\n");

export type WorkplaceSetupRequest = {
  kind: "WorkplaceSetupRequest";
  version: 1;
  anchor: string;
  targets: Array<{
    workplace: string;
    relation: "link" | "attachment";
    required: boolean;
    mount: { mode: "managed" | "external"; path: string };
    source?: string;
    entry: EntryBinding;
    providers: ProviderBinding[];
  }>;
};

export type WorkplaceSetupPlan = {
  kind: "WorkplaceSetupPlan";
  version: 1;
  revision: string;
  anchor: string;
  anchorMount: string;
  localPath?: string;
  targets: Array<WorkplaceSetupRequest["targets"][number] & {
    resolvedMount: string;
    binding: WorkplaceBinding;
    action: "clone" | "adopt" | "verify" | "unavailable";
  }>;
};

export type WorkplaceSetupReceipt = {
  kind: "WorkplaceSetupReceipt";
  version: 1;
  plan: string;
  anchor: string;
  status: "ready" | "partial";
  targets: Array<{ workplace: string; relation: "link" | "attachment"; required: boolean; status: "cloned" | "adopted" | "unchanged" | "unavailable" }>;
};

export class SetupError extends Error {
  constructor(readonly code: "invalid-setup-request" | "setup-unavailable" | "setup-collision" | "setup-digest-mismatch", message: string) {
    super(message);
    this.name = "SetupError";
  }
}

function fail(code: SetupError["code"], message: string): never {
  throw new SetupError(code, message);
}

function object(value: unknown, subject: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid-setup-request", `${subject} must be an object`);
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, keys: string[], subject: string): void {
  const unknown = Object.keys(value).filter((key) => !keys.includes(key));
  const missing = keys.filter((key) => !(key in value));
  if (unknown.length > 0) fail("invalid-setup-request", `${subject} has unknown fields: ${unknown.join(", ")}`);
  if (missing.length > 0) fail("invalid-setup-request", `${subject} is missing fields: ${missing.join(", ")}`);
}

function ref(value: unknown, subject: string): string {
  if (typeof value !== "string" || !REF.test(value)) fail("invalid-setup-request", `${subject} is not a fully qualified Workplace ref`);
  return value;
}

function normalizeManaged(path: string): string {
  return path.split(sep).join("/");
}

function absolutePath(path: string): boolean {
  return /^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(path);
}

function within(parent: string, child: string): boolean {
  const fromParent = relative(parent, child);
  return fromParent === "" || (!fromParent.startsWith("..") && !absolutePath(fromParent));
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) {
    if (error instanceof Error && error.message.includes("ENOENT")) return false;
    throw error;
  }
}

async function assertManagedAddress(anchorMount: string, target: string, workplaceId: string): Promise<void> {
  const canonicalAnchor = await realpath(anchorMount);
  const addresses: Array<[string, string]> = [
    [resolve(anchorMount, "checkouts"), resolve(canonicalAnchor, "checkouts")],
    [resolve(anchorMount, "checkouts/workplaces"), resolve(canonicalAnchor, "checkouts/workplaces")],
    [target, resolve(canonicalAnchor, `checkouts/workplaces/${workplaceId}`)],
  ];
  for (const [path, expected] of addresses) {
    if (!await exists(path)) continue;
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isDirectory() || await realpath(path) !== expected) fail("setup-collision", `${path} must be a physical directory inside the managed Workplace family`);
  }
}

function parseEntry(value: unknown, workplace: string, subject: string): EntryBinding {
  const entry = object(value, subject);
  exact(entry, ["kind", "workplace", "member", "desk", "rootBindings"], subject);
  if (entry.kind !== "EntryBinding" || entry.workplace !== workplace) fail("invalid-setup-request", `${subject} must target ${workplace}`);
  const member = ref(entry.member, `${subject}.member`);
  const desk = ref(entry.desk, `${subject}.desk`);
  if (!member.startsWith(`${workplace}/member/`) || !desk.startsWith(`${workplace}/desk/`)) fail("invalid-setup-request", `${subject} Member and Desk must belong to ${workplace}`);
  const roots = object(entry.rootBindings, `${subject}.rootBindings`);
  if (roots.shared !== "workplace" || Object.values(roots).some((path) => typeof path !== "string" || !path)) fail("invalid-setup-request", `${subject}.rootBindings must bind shared to workplace and contain paths`);
  return { kind: "EntryBinding", workplace, member, desk, rootBindings: roots as Record<string, string> };
}

function parseProvider(value: unknown, subject: string): ProviderBinding {
  const provider = object(value, subject);
  exact(provider, ["kind", "provider", "targets", "tools"], subject);
  if (provider.kind !== "ProviderBinding" || typeof provider.provider !== "string" || !ID.test(provider.provider)) fail("invalid-setup-request", `${subject} has an invalid provider`);
  if (!Array.isArray(provider.targets) || !Array.isArray(provider.tools)) fail("invalid-setup-request", `${subject}.targets and tools must be arrays`);
  const targetPaths: string[] = [];
  for (const [index, value] of provider.targets.entries()) {
    const targetSubject = `${subject}.targets[${index}]`;
    const target = object(value, targetSubject);
    exact(target, ["provider", "kind", "path", "discovery", "loadGuarantee"], targetSubject);
    if (target.provider !== provider.provider) fail("invalid-setup-request", `${targetSubject} names another provider`);
    if (!["front-door", "skill", "command", "view", "startup", "agent"].includes(String(target.kind))) fail("invalid-setup-request", `${targetSubject}.kind is invalid`);
    if (typeof target.path !== "string" || !target.path || absolutePath(target.path) || target.path.split(/[\\/]/).includes("..")) fail("invalid-setup-request", `${targetSubject}.path is unsafe`);
    targetPaths.push(target.path);
    if (!["automatic", "model-selected", "human-explicit", "manual"].includes(String(target.discovery))) fail("invalid-setup-request", `${targetSubject}.discovery is invalid`);
    if (target.loadGuarantee !== "qualified" && target.loadGuarantee !== "unproven") fail("invalid-setup-request", `${targetSubject}.loadGuarantee is invalid`);
  }
  for (const [index, value] of provider.tools.entries()) {
    const toolSubject = `${subject}.tools[${index}]`;
    const tool = object(value, toolSubject);
    const unknown = Object.keys(tool).filter((key) => !["trait", "tool", "provider", "availability", "command"].includes(key));
    if (unknown.length > 0) fail("invalid-setup-request", `${toolSubject} has unknown fields: ${unknown.join(", ")}`);
    if (typeof tool.trait !== "string" || !tool.trait || typeof tool.tool !== "string" || !tool.tool) fail("invalid-setup-request", `${toolSubject} needs trait and tool`);
    if (tool.provider !== undefined && tool.provider !== provider.provider) fail("invalid-setup-request", `${toolSubject} names another provider`);
    if (!["available", "missing", "degraded"].includes(String(tool.availability))) fail("invalid-setup-request", `${toolSubject}.availability is invalid`);
    if (tool.command !== undefined && (!Array.isArray(tool.command) || tool.command.length === 0 || tool.command.some((part) => typeof part !== "string" || !part))) fail("invalid-setup-request", `${toolSubject}.command must be a non-empty string array`);
  }
  const duplicate = targetPaths.find((path, index) => targetPaths.indexOf(path) !== index);
  if (duplicate) fail("invalid-setup-request", `${subject} repeats target ${duplicate}`);
  return provider as ProviderBinding;
}

function sourceLocator(value: unknown, requestDirectory: string, subject: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) fail("invalid-setup-request", `${subject} must be a non-empty Git source`);
  const source = value.trim();
  if (/^https?:\/\//i.test(source)) {
    let url: URL;
    try { url = new URL(source); }
    catch { fail("invalid-setup-request", `${subject} is not a valid URL`); }
    if (url.username || url.password) fail("invalid-setup-request", `${subject} must not embed credentials`);
    return source;
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(source) || /^[^/]+@[^:]+:/.test(source)) return source;
  return resolve(requestDirectory, source);
}

function parseRequest(value: unknown, requestDirectory: string): WorkplaceSetupRequest {
  const request = object(value, "WorkplaceSetupRequest");
  exact(request, ["kind", "version", "anchor", "targets"], "WorkplaceSetupRequest");
  if (request.kind !== "WorkplaceSetupRequest" || request.version !== 1 || !Array.isArray(request.targets)) fail("invalid-setup-request", "Unsupported WorkplaceSetupRequest");
  const anchor = ref(request.anchor, "WorkplaceSetupRequest.anchor");
  const targets = request.targets.map((value, index) => {
    const subject = `WorkplaceSetupRequest.targets[${index}]`;
    const target = object(value, subject);
    exact(target, ["workplace", "relation", "required", "mount", ...(target.source === undefined ? [] : ["source"]), "entry", "providers"], subject);
    const workplace = ref(target.workplace, `${subject}.workplace`);
    if (workplace === anchor) fail("invalid-setup-request", `${subject} cannot target the Anchor`);
    if (target.relation !== "link" && target.relation !== "attachment") fail("invalid-setup-request", `${subject}.relation must be link or attachment`);
    if (typeof target.required !== "boolean") fail("invalid-setup-request", `${subject}.required must be boolean`);
    const mount = object(target.mount, `${subject}.mount`);
    exact(mount, ["mode", "path"], `${subject}.mount`);
    if (mount.mode !== "managed" && mount.mode !== "external") fail("invalid-setup-request", `${subject}.mount.mode must be managed or external`);
    if (typeof mount.path !== "string" || !mount.path.trim()) fail("invalid-setup-request", `${subject}.mount.path must be non-empty`);
    if (!Array.isArray(target.providers)) fail("invalid-setup-request", `${subject}.providers must be an array`);
    const providers = target.providers.map((provider, providerIndex) => parseProvider(provider, `${subject}.providers[${providerIndex}]`));
    if (new Set(providers.map((provider) => provider.provider)).size !== providers.length) fail("invalid-setup-request", `${subject}.providers repeats a provider`);
    return {
      workplace,
      relation: target.relation,
      required: target.required,
      mount: { mode: mount.mode, path: mount.path.trim() },
      ...(target.source === undefined ? {} : { source: sourceLocator(target.source, requestDirectory, `${subject}.source`) }),
      entry: parseEntry(target.entry, workplace, `${subject}.entry`),
      providers,
    } as WorkplaceSetupRequest["targets"][number];
  });
  if (new Set(targets.map((target) => target.workplace)).size !== targets.length) fail("invalid-setup-request", "WorkplaceSetupRequest.targets repeats a Workplace");
  return { kind: "WorkplaceSetupRequest", version: 1, anchor, targets };
}

export async function planWorkplaceSetup(value: unknown, options: { anchorMount: string; requestDirectory?: string; localPath?: string }): Promise<WorkplaceSetupPlan> {
  const anchorMount = resolve(options.anchorMount);
  const request = parseRequest(value, resolve(options.requestDirectory ?? process.cwd()));
  const state = await readWorkplaceFederationState(anchorMount, options.localPath);
  if (request.anchor !== state.anchor) fail("invalid-setup-request", `Request Anchor ${request.anchor} does not match ${state.anchor}`);
  const managedRoot = resolve(anchorMount, "checkouts/workplaces");
  const targets = await Promise.all(request.targets.map(async (target) => {
    if (target.relation === "link" && !state.links.some((link) => link.target === target.workplace)) fail("invalid-setup-request", `${target.workplace} is not declared by a portable Link`);
    const resolvedMount = target.mount.mode === "managed" ? resolve(anchorMount, target.mount.path) : resolve(options.requestDirectory ?? process.cwd(), target.mount.path);
    const workplaceId = target.workplace.split("/").at(-1)!;
    if (target.mount.mode === "managed" && normalizeManaged(target.mount.path) !== `checkouts/workplaces/${workplaceId}`) fail("invalid-setup-request", `${target.mount.path} must be checkouts/workplaces/${workplaceId}`);
    if (target.mount.mode === "managed") await assertManagedAddress(anchorMount, resolvedMount, workplaceId);
    if (target.mount.mode === "managed" && (!within(managedRoot, resolvedMount) || resolvedMount === managedRoot)) fail("invalid-setup-request", `${target.mount.path} escapes checkouts/workplaces`);
    if (target.mount.mode === "external" && within(anchorMount, resolvedMount)) fail("invalid-setup-request", `External Mount must stay outside the Anchor: ${target.mount.path}`);
    if (within(resolvedMount, anchorMount)) fail("invalid-setup-request", `Mount cannot be the Anchor or its ancestor: ${target.mount.path}`);
    const binding: WorkplaceBinding = { workplace: target.workplace, mode: target.mount.mode, mount: target.mount.mode === "managed" ? normalizeManaged(relative(anchorMount, resolvedMount)) : resolvedMount };
    const previous = state.bindings.find((item) => item.workplace === target.workplace);
    if (previous && stable(previous) !== stable(binding)) fail("setup-collision", `${target.workplace} already has another Binding`);
    if (state.bindings.some((item) => item.workplace !== target.workplace && resolveDeclaredWorkplaceMount(anchorMount, state.localPath, item) === resolvedMount)) fail("setup-collision", `${resolvedMount} is already bound to another Workplace`);
    const present = await exists(resolvedMount);
    const action = previous && present ? "verify" : present && !target.source ? "adopt" : !present && target.source ? "clone" : "unavailable";
    if (present && target.source && !previous) fail("setup-collision", `${resolvedMount} already exists; setup never overwrites it`);
    return { ...target, resolvedMount, binding, action } as WorkplaceSetupPlan["targets"][number];
  }));
  if (new Set(targets.map((target) => target.resolvedMount)).size !== targets.length) fail("setup-collision", "Two targets resolve to the same Mount");
  const preview = { kind: "WorkplaceSetupPlan" as const, version: 1 as const, anchor: request.anchor, anchorMount, ...(options.localPath ? { localPath: options.localPath } : {}), targets };
  return { ...preview, revision: hash(stable(preview)) };
}

function git(root: string, args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) fail("setup-unavailable", `git ${args[0]} failed: ${new TextDecoder().decode(result.stderr).trim()}`);
  return new TextDecoder().decode(result.stdout).trim();
}

async function targetIdentity(mount: string): Promise<string> {
  const contract = object(JSON.parse(await readFile(join(mount, "workplace/workplace.json"), "utf8")) as unknown, "WorkplaceBuildContract");
  if (contract.kind !== "WorkplaceBuildContract" || contract.version !== 2) fail("setup-unavailable", `${mount} has no WorkplaceBuildContract/2`);
  return ref(contract.workplace, "WorkplaceBuildContract.workplace");
}

async function ensureExact(path: string, value: unknown): Promise<boolean> {
  const bytes = typeof value === "string" ? value : stable(value);
  if (await exists(path)) {
    if (await readFile(path, "utf8") !== bytes) fail("setup-collision", `${path} contains different bytes`);
    return false;
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes, { flag: "wx" });
  return true;
}

async function bindAndReady(target: WorkplaceSetupPlan["targets"][number], mount: string): Promise<string[]> {
  if (await targetIdentity(mount) !== target.workplace) fail("setup-unavailable", `${target.workplace} Binding resolves to another Workplace`);
  if (git(join(mount, "workplace"), ["status", "--porcelain"])) fail("setup-unavailable", `${target.workplace} Workplace Root is dirty; checkpoint it before setup`);
  const created: string[] = [];
  try {
    if (await ensureExact(join(mount, ".gitignore"), IGNORE)) created.push(join(mount, ".gitignore"));
    if (await ensureExact(join(mount, ".endroit/entry.json"), target.entry)) created.push(join(mount, ".endroit/entry.json"));
    for (const provider of target.providers) {
      const path = join(mount, `.endroit/providers/${provider.provider}.json`);
      if (await ensureExact(path, provider)) created.push(path);
    }
    const result = await readyWorkplace({ start: mount });
    if (result.check.operationStatus !== "ready") fail("setup-unavailable", `${target.workplace} is not ready: ${result.check.requiredAction ?? "unknown reason"}`);
    if (git(join(mount, "workplace"), ["status", "--porcelain"])) fail("setup-unavailable", `${target.workplace} setup changed tracked Git bytes`);
    return created;
  } catch (error) {
    for (const path of created.reverse()) await rm(path, { recursive: false, force: true });
    await readyWorkplace({ start: mount }).catch(() => undefined);
    throw error;
  }
}

async function cloneTarget(target: WorkplaceSetupPlan["targets"][number]): Promise<void> {
  if (!target.source) fail("setup-unavailable", `${target.workplace} has no Git source`);
  if (absolutePath(target.source) && await exists(target.source)) {
    const bare = Bun.spawnSync(["git", "-C", target.source, "rev-parse", "--is-bare-repository"], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" });
    if (bare.exitCode !== 0) fail("setup-unavailable", `${target.source} is not a Git source`);
    if (new TextDecoder().decode(bare.stdout).trim() !== "true" && git(target.source, ["status", "--porcelain"])) fail("setup-unavailable", `${target.source} is dirty; setup transports committed Git only`);
  }
  const temp = join(dirname(target.resolvedMount), `.${basename(target.resolvedMount)}.endroit-setup-${process.pid}-${crypto.randomUUID()}`);
  await mkdir(temp, { recursive: true });
  try {
    const clone = Bun.spawnSync(["git", "clone", "--", target.source, join(temp, "workplace")], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" });
    if (clone.exitCode !== 0) fail("setup-unavailable", `git clone failed for ${target.workplace}: ${new TextDecoder().decode(clone.stderr).trim()}`);
    await bindAndReady(target, temp);
    await mkdir(dirname(target.resolvedMount), { recursive: true });
    await rename(temp, target.resolvedMount);
  } catch (error) {
    await rm(temp, { recursive: true, force: true });
    throw error;
  }
}

export async function applyWorkplaceSetup(plan: WorkplaceSetupPlan, expectedRevision: string, options: { afterApply?: (receipt: WorkplaceSetupReceipt) => Promise<void> } = {}): Promise<WorkplaceSetupReceipt> {
  if (expectedRevision !== plan.revision) fail("setup-digest-mismatch", `Preview digest mismatch: expected current ${plan.revision}`);
  const state = await readWorkplaceFederationState(plan.anchorMount, plan.localPath);
  if (state.anchor !== plan.anchor) fail("invalid-setup-request", `Plan Anchor ${plan.anchor} no longer matches ${state.anchor}`);
  const createdMounts: string[] = [];
  const touchedExisting: Array<{ target: WorkplaceSetupPlan["targets"][number]; created: string[] }> = [];
  const results: WorkplaceSetupReceipt["targets"] = [];
  const successful: WorkplaceSetupPlan["targets"] = [];
  const previousLocal = await readFile(state.localPath, "utf8").catch((error) => error instanceof Error && error.message.includes("ENOENT") ? undefined : Promise.reject(error));
  let localWritten = false;
  try {
    for (const target of [...plan.targets.filter((item) => item.required), ...plan.targets.filter((item) => !item.required)]) {
      try {
        if (target.mount.mode === "managed") await assertManagedAddress(plan.anchorMount, target.resolvedMount, target.workplace.split("/").at(-1)!);
        if (target.action === "unavailable") fail("setup-unavailable", `${target.workplace} has neither an existing Mount nor a Git source`);
        if (target.action === "clone") {
          if (await exists(target.resolvedMount)) fail("setup-collision", `${target.resolvedMount} appeared after preview`);
          await cloneTarget(target);
          createdMounts.push(target.resolvedMount);
          results.push({ workplace: target.workplace, relation: target.relation, required: target.required, status: "cloned" });
        } else {
          const created = await bindAndReady(target, target.resolvedMount);
          touchedExisting.push({ target, created });
          results.push({ workplace: target.workplace, relation: target.relation, required: target.required, status: target.action === "adopt" ? "adopted" : created.length > 0 ? "adopted" : "unchanged" });
        }
        successful.push(target);
      } catch (error) {
        if (target.required) throw error;
        results.push({ workplace: target.workplace, relation: target.relation, required: false, status: "unavailable" });
      }
    }
    const attachments = [...state.attachments, ...successful.filter((target) => target.relation === "attachment" && !state.attachments.some((item) => item.target === target.workplace)).map((target) => ({ target: target.workplace }))].sort((a, b) => a.target.localeCompare(b.target));
    const bindings = [...state.bindings, ...successful.filter((target) => !state.bindings.some((item) => item.workplace === target.workplace)).map((target) => target.binding)].sort((a, b) => a.workplace.localeCompare(b.workplace));
    if (successful.length > 0) {
      const local: WorkplaceLocalBindings = { kind: "WorkplaceLocalBindings", version: 1, workplace: state.anchor, attachments, bindings };
      await writeWorkplaceLocalBindings(plan.anchorMount, local, plan.localPath);
      localWritten = true;
    }
    const ready = await readyWorkplace({ start: plan.anchorMount });
    if (ready.check.operationStatus !== "ready") fail("setup-unavailable", `Anchor is not ready: ${ready.check.requiredAction ?? "unknown reason"}`);
    const receipt: WorkplaceSetupReceipt = { kind: "WorkplaceSetupReceipt", version: 1, plan: plan.revision, anchor: plan.anchor, status: results.some((target) => target.status === "unavailable") ? "partial" : "ready", targets: results.sort((a, b) => a.workplace.localeCompare(b.workplace)) };
    await options.afterApply?.(receipt);
    return receipt;
  } catch (error) {
    if (localWritten) {
      if (previousLocal === undefined) await rm(state.localPath, { recursive: false, force: true });
      else await writeFile(state.localPath, previousLocal);
      await readyWorkplace({ start: plan.anchorMount }).catch(() => undefined);
    }
    for (const path of createdMounts.reverse()) await rm(path, { recursive: true, force: true });
    for (const touched of touchedExisting.reverse()) {
      for (const path of touched.created.reverse()) await rm(path, { recursive: false, force: true });
      await readyWorkplace({ start: touched.target.resolvedMount }).catch(() => undefined);
    }
    throw error;
  }
}
