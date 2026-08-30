import { lstat, mkdir, readFile, readdir, readlink, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { hash, stable } from "./compiler/index.ts";

const REF = /^workplace:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
const ID = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const RESERVED = new Set(["sites", "workplaces"]);

export type SiteRouteRevision =
  | { kind: "branch"; name: string }
  | { kind: "commit"; sha: string };

export type SiteRoutePhysical =
  | { kind: "direct" }
  | { kind: "worktree"; sourceRoute: string }
  | { kind: "external-link"; target: string };

export type SiteRouteSetupRequest = {
  kind: "SiteRouteSetupRequest";
  version: 1;
  workplace: string;
  sites: Array<{
    id: string;
    productRemote: { kind: "ProductRemote"; locator: string };
    routes: Array<{ id: string; revision: SiteRouteRevision; physical?: SiteRoutePhysical }>;
  }>;
};

export type SiteRouteSetupPlan = {
  kind: "SiteRouteSetupPlan";
  version: 1;
  revision: string;
  workplace: string;
  workplaceMount: string;
  sites: Array<{
    id: string;
    productRemote: { kind: "ProductRemote"; locator: string };
    routes: Array<{ id: string; revision: SiteRouteRevision; physical: SiteRoutePhysical; path: string; action: "materialize" | "verify" }>;
  }>;
};

export type SiteRouteSetupReceipt = {
  kind: "SiteRouteSetupReceipt";
  version: 1;
  plan: string;
  workplace: string;
  status: "ready";
  family: string;
  createdDirectories: string[];
  sites: Array<{
    id: string;
    routes: Array<{ id: string; path: string; commit: string; status: "cloned" | "linked" | "unchanged"; bindingStatus: "created" | "unchanged"; binding: { mount: string; realpath: string; commonGitDir: string; kind: "managed" | "worktree" | "external-link" } }>;
  }>;
};

export type SiteRouteBinding = SiteRouteSetupReceipt["sites"][number]["routes"][number]["binding"];
export type SiteRouteBindingRegistry = {
  kind: "SiteRouteBindingRegistry";
  version: 1;
  workplace: string;
  bindings: Array<{ site: string; route: string; binding: SiteRouteBinding }>;
};
export type SiteRouteDetachReceipt = {
  kind: "SiteRouteDetachReceipt";
  version: 1;
  workplace: string;
  site: string;
  route: string;
  status: "detached";
  binding: SiteRouteBinding;
};

export class SiteRouteSetupError extends Error {
  constructor(readonly code: "invalid-site-route-request" | "site-route-collision" | "site-route-digest-mismatch" | "site-route-unavailable", message: string) {
    super(message);
    this.name = "SiteRouteSetupError";
  }
}

function fail(code: SiteRouteSetupError["code"], message: string): never {
  throw new SiteRouteSetupError(code, message);
}

function object(value: unknown, subject: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid-site-route-request", `${subject} must be an object`);
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, keys: string[], subject: string, required = keys): void {
  const unknown = Object.keys(value).filter((key) => !keys.includes(key));
  const missing = required.filter((key) => !(key in value));
  if (unknown.length) fail("invalid-site-route-request", `${subject} has unknown fields: ${unknown.join(", ")}`);
  if (missing.length) fail("invalid-site-route-request", `${subject} is missing fields: ${missing.join(", ")}`);
}

function ref(value: unknown, subject: string): string {
  if (typeof value !== "string" || !REF.test(value)) fail("invalid-site-route-request", `${subject} must be a fully qualified Workplace ref`);
  return value;
}

function id(value: unknown, subject: string): string {
  if (typeof value !== "string" || !ID.test(value) || RESERVED.has(value)) fail("invalid-site-route-request", `${subject} must be a non-reserved slug`);
  return value;
}

function text(value: unknown, subject: string): string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) fail("invalid-site-route-request", `${subject} must be non-empty text`);
  return value.trim();
}

function branch(value: unknown, subject: string): string {
  const name = text(value, subject);
  const invalid = name.startsWith("-") || name.startsWith("/") || name.endsWith("/") || name.endsWith(".") || name.includes("..") || name.includes("@{") || /[\x00-\x20~^:?*\[\\]/.test(name)
    || name.split("/").some((part) => !part || part.startsWith(".") || part.endsWith(".lock"));
  if (invalid) fail("invalid-site-route-request", `${subject} is not a safe branch name`);
  return name;
}

function revision(value: unknown, subject: string): SiteRouteRevision {
  const source = object(value, subject);
  if (source.kind === "branch") {
    exact(source, ["kind", "name"], subject);
    return { kind: "branch", name: branch(source.name, `${subject}.name`) };
  }
  if (source.kind === "commit") {
    exact(source, ["kind", "sha"], subject);
    if (typeof source.sha !== "string" || !SHA.test(source.sha)) fail("invalid-site-route-request", `${subject}.sha must be a full Git object id`);
    return { kind: "commit", sha: source.sha };
  }
  fail("invalid-site-route-request", `${subject}.kind must be branch or commit`);
}

function physical(value: unknown, requestDirectory: string, subject: string): SiteRoutePhysical {
  if (value === undefined) return { kind: "direct" };
  const source = object(value, subject);
  if (source.kind === "direct") {
    exact(source, ["kind"], subject);
    return { kind: "direct" };
  }
  if (source.kind === "worktree") {
    exact(source, ["kind", "sourceRoute"], subject);
    return { kind: "worktree", sourceRoute: id(source.sourceRoute, `${subject}.sourceRoute`) };
  }
  if (source.kind === "external-link") {
    exact(source, ["kind", "target"], subject);
    return { kind: "external-link", target: resolve(requestDirectory, text(source.target, `${subject}.target`)) };
  }
  fail("invalid-site-route-request", `${subject}.kind must be direct, worktree or external-link`);
}

function productLocator(value: unknown, requestDirectory: string, subject: string): { kind: "ProductRemote"; locator: string } {
  const source = object(value, subject);
  exact(source, ["kind", "locator"], subject);
  if (source.kind === "ContinuityRemote") fail("invalid-site-route-request", `${subject} must be a ProductRemote, not a ContinuityRemote`);
  if (source.kind !== "ProductRemote") fail("invalid-site-route-request", `${subject}.kind must be ProductRemote`);
  const locator = text(source.locator, `${subject}.locator`);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(locator)) {
    let url: URL;
    try { url = new URL(locator); }
    catch { fail("invalid-site-route-request", `${subject}.locator is not a valid URL`); }
    if (!["https:", "http:", "ssh:"].includes(url.protocol)) fail("invalid-site-route-request", `${subject}.locator uses an unsupported URL scheme`);
    if (url.password || (url.protocol !== "ssh:" && url.username)) fail("invalid-site-route-request", `${subject}.locator must not embed credentials`);
    return { kind: "ProductRemote", locator };
  }
  if (/^[^/\\:@]+@[^/:]+:.+/.test(locator)) return { kind: "ProductRemote", locator };
  if (locator.includes("@") && locator.includes(":")) fail("invalid-site-route-request", `${subject}.locator is not a safe SSH locator`);
  return { kind: "ProductRemote", locator: resolve(requestDirectory, locator) };
}

function parseRequest(value: unknown, requestDirectory: string): SiteRouteSetupRequest {
  const source = object(value, "SiteRouteSetupRequest");
  exact(source, ["kind", "version", "workplace", "sites"], "SiteRouteSetupRequest");
  if (source.kind !== "SiteRouteSetupRequest" || source.version !== 1 || !Array.isArray(source.sites) || source.sites.length === 0) fail("invalid-site-route-request", "Unsupported SiteRouteSetupRequest");
  const sites = source.sites.map((value, siteIndex) => {
    const subject = `SiteRouteSetupRequest.sites[${siteIndex}]`;
    const site = object(value, subject);
    exact(site, ["id", "productRemote", "routes"], subject);
    if (!Array.isArray(site.routes) || site.routes.length === 0) fail("invalid-site-route-request", `${subject}.routes must be a non-empty array`);
    const routes = site.routes.map((value, routeIndex) => {
      const routeSubject = `${subject}.routes[${routeIndex}]`;
      const route = object(value, routeSubject);
      exact(route, ["id", "revision", "physical"], routeSubject, ["id", "revision"]);
      return { id: id(route.id, `${routeSubject}.id`), revision: revision(route.revision, `${routeSubject}.revision`), physical: physical(route.physical, requestDirectory, `${routeSubject}.physical`) };
    });
    if (new Set(routes.map((route) => route.id)).size !== routes.length) fail("invalid-site-route-request", `${subject}.routes repeats an id`);
    for (const route of routes) {
      const routePhysical = route.physical;
      if (routePhysical.kind === "worktree" && (routePhysical.sourceRoute === route.id || !routes.some((candidate) => candidate.id === routePhysical.sourceRoute))) fail("invalid-site-route-request", `${subject}.routes has an invalid worktree sourceRoute`);
    }
    return { id: id(site.id, `${subject}.id`), productRemote: productLocator(site.productRemote, requestDirectory, `${subject}.productRemote`), routes: routes.sort((a, b) => a.id.localeCompare(b.id)) };
  });
  if (new Set(sites.map((site) => site.id)).size !== sites.length) fail("invalid-site-route-request", "SiteRouteSetupRequest.sites repeats an id");
  return { kind: "SiteRouteSetupRequest", version: 1, workplace: ref(source.workplace, "SiteRouteSetupRequest.workplace"), sites: sites.sort((a, b) => a.id.localeCompare(b.id)) };
}

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

async function physicalDirectory(path: string, expected: string, subject: string): Promise<boolean> {
  if (!await exists(path)) return false;
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory() || await realpath(path) !== expected) fail("site-route-collision", `${subject} must be a physical directory in its declared family`);
  return true;
}

async function workplaceIdentity(mount: string): Promise<string> {
  try {
    const contract = object(JSON.parse(await readFile(join(mount, "workplace/workplace.json"), "utf8")) as unknown, "WorkplaceBuildContract");
    if (contract.kind !== "WorkplaceBuildContract" || contract.version !== 2) fail("site-route-unavailable", `${mount} has no WorkplaceBuildContract/2`);
    return ref(contract.workplace, "WorkplaceBuildContract.workplace");
  } catch (error) {
    if (error instanceof SiteRouteSetupError) throw error;
    fail("site-route-unavailable", `${mount} has no readable Workplace identity`);
  }
}

async function assertFamily(workplaceMount: string, family: string, sites: Array<{ id: string; routes: Array<{ id: string }> }>): Promise<void> {
  const mount = resolve(workplaceMount);
  if (!await physicalDirectory(mount, await realpath(mount).catch(() => fail("site-route-unavailable", `${mount} is unavailable`)), "Workplace Mount")) fail("site-route-unavailable", `${mount} is unavailable`);
  const canonicalMount = await realpath(mount);
  if (!inside(mount, family)) fail("site-route-collision", `${family} must stay inside ${mount}`);
  const relativeFamily = relative(mount, family);
  let current = mount;
  for (const part of relativeFamily.split(/[\\/]/).filter(Boolean)) {
    current = join(current, part);
    await physicalDirectory(current, resolve(canonicalMount, relative(mount, current)), current);
  }
  for (const site of sites) {
    const sitePath = join(family, site.id);
    await physicalDirectory(sitePath, resolve(canonicalMount, relative(mount, sitePath)), sitePath);
  }
  if (family === resolve(mount, "checkouts/sites")) await physicalDirectory(resolve(mount, "checkouts/workplaces"), resolve(canonicalMount, "checkouts/workplaces"), "Workplace checkout family");
}

export async function planSiteRouteSetup(value: unknown, options: { workplaceMount: string; requestDirectory?: string; allowAbsentMount?: boolean }): Promise<SiteRouteSetupPlan> {
  const request = parseRequest(value, resolve(options.requestDirectory ?? process.cwd()));
  const workplaceMount = resolve(options.workplaceMount);
  const mountPresent = await exists(workplaceMount);
  if (!mountPresent && !options.allowAbsentMount) fail("site-route-unavailable", `${workplaceMount} is unavailable`);
  if (mountPresent && await workplaceIdentity(workplaceMount) !== request.workplace) fail("invalid-site-route-request", `Request Workplace ${request.workplace} does not match ${workplaceMount}`);
  const family = resolve(workplaceMount, "checkouts/sites");
  if (mountPresent) await assertFamily(workplaceMount, family, request.sites);
  const sites: SiteRouteSetupPlan["sites"] = request.sites.map((site) => ({
    ...site,
    routes: site.routes.map((route) => {
      const path = resolve(family, site.id, route.id);
      return { ...route, physical: route.physical ?? { kind: "direct" as const }, path, action: "verify" as "materialize" | "verify" };
    }),
  }));
  for (const site of sites) for (const route of site.routes) if (!await exists(route.path)) route.action = "materialize";
  const preview = { kind: "SiteRouteSetupPlan" as const, version: 1 as const, workplace: request.workplace, workplaceMount, sites };
  return { ...preview, revision: hash(stable(preview)) };
}

function git(cwd: string, args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) fail("site-route-unavailable", `git ${args[0]} failed: ${new TextDecoder().decode(result.stderr).trim()}`);
  return new TextDecoder().decode(result.stdout).trim();
}

async function observeRoute(path: string, locator: string, revision: SiteRouteRevision, physical: SiteRoutePhysical): Promise<{ commit: string; binding: SiteRouteSetupReceipt["sites"][number]["routes"][number]["binding"] }> {
  const pathInfo = await lstat(path).catch(() => fail("site-route-collision", `${path} must be a declared Git checkout`));
  if (physical.kind === "external-link") {
    if (!pathInfo.isSymbolicLink() || resolve(dirname(path), await readlink(path)) !== physical.target || await realpath(path) !== await realpath(physical.target).catch(() => fail("site-route-unavailable", `${physical.target} is unavailable`))) fail("site-route-collision", `${path} must link exactly to its declared external target`);
  } else if (pathInfo.isSymbolicLink() || !pathInfo.isDirectory()) fail("site-route-collision", `${path} must be a physical Git checkout`);
  const gitDirectory = join(path, ".git");
  const gitInfo = await lstat(gitDirectory).catch(() => fail("site-route-collision", `${gitDirectory} must be a physical Git directory`));
  if (gitInfo.isSymbolicLink() || physical.kind === "direct" && !gitInfo.isDirectory() || physical.kind === "worktree" && !gitInfo.isFile() || physical.kind === "external-link" && !gitInfo.isDirectory() && !gitInfo.isFile()) fail("site-route-collision", `${gitDirectory} has the wrong physical Git form`);
  if (git(path, ["status", "--porcelain"])) fail("site-route-unavailable", `${path} is dirty`);
  if (git(path, ["remote"]) !== "origin" || git(path, ["remote", "get-url", "--all", "origin"]) !== locator) fail("site-route-unavailable", `${path} does not use its declared Product Remote`);
  const commit = git(path, ["rev-parse", "HEAD"]);
  if (revision.kind === "branch") {
    if (git(path, ["symbolic-ref", "--quiet", "--short", "HEAD"]) !== revision.name) fail("site-route-unavailable", `${path} is not on branch ${revision.name}`);
    if (git(path, ["rev-parse", `refs/remotes/origin/${revision.name}`]) !== commit) fail("site-route-unavailable", `${path} does not match origin/${revision.name}`);
  } else {
    const symbolic = Bun.spawnSync(["git", "symbolic-ref", "--quiet", "HEAD"], { cwd: path, stdout: "pipe", stderr: "pipe" });
    if (symbolic.exitCode === 0 || commit !== revision.sha) fail("site-route-unavailable", `${path} is not detached at ${revision.sha}`);
  }
  const checkoutRealpath = await realpath(path);
  const routeMount = resolve(await realpath(dirname(path)), basename(path));
  const commonGitDir = await realpath(resolve(checkoutRealpath, git(path, ["rev-parse", "--git-common-dir"])));
  return { commit, binding: { mount: routeMount, realpath: checkoutRealpath, commonGitDir, kind: physical.kind === "direct" ? "managed" : physical.kind } };
}

async function ensureDirectories(workplaceMount: string, target: string, created: string[]): Promise<void> {
  const mount = resolve(workplaceMount);
  const canonicalMount = await realpath(mount);
  if (!inside(mount, target)) fail("site-route-collision", `${target} must stay inside ${mount}`);
  let current = mount;
  for (const part of relative(mount, target).split(/[\\/]/).filter(Boolean)) {
    current = join(current, part);
    if (!await exists(current)) {
      await mkdir(current, { recursive: false });
      created.push(current);
    }
    await physicalDirectory(current, resolve(canonicalMount, relative(mount, current)), current);
  }
}

function bindingRegistryPath(workplaceMount: string): string { return join(resolve(workplaceMount), ".endroit/site-route-bindings.json"); }
function bindingKey(site: string, route: string): string { return `${site}/${route}`; }

async function loadSiteRouteBindingRegistry(workplaceMount: string, workplace: string): Promise<SiteRouteBindingRegistry> {
  const path = bindingRegistryPath(workplaceMount);
  if (!await exists(path)) return { kind: "SiteRouteBindingRegistry", version: 1, workplace, bindings: [] };
  const canonicalMount = await realpath(workplaceMount);
  const localFamily = dirname(path); const localInfo = await lstat(localFamily);
  if (localInfo.isSymbolicLink() || !localInfo.isDirectory() || await realpath(localFamily) !== resolve(canonicalMount, ".endroit")) fail("site-route-collision", `${localFamily} must be a physical local Binding family`);
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile()) fail("site-route-collision", `${path} must be a physical local Binding registry`);
  let source: Record<string, unknown>;
  try { source = object(JSON.parse(await readFile(path, "utf8")) as unknown, "SiteRouteBindingRegistry"); }
  catch (error) { if (error instanceof SiteRouteSetupError) throw error; fail("site-route-collision", `${path} is invalid JSON`); }
  exact(source, ["kind", "version", "workplace", "bindings"], "SiteRouteBindingRegistry");
  if (source.kind !== "SiteRouteBindingRegistry" || source.version !== 1 || source.workplace !== workplace || !Array.isArray(source.bindings)) fail("site-route-collision", `${path} does not match its Workplace`);
  const bindings = source.bindings.map((value, index) => {
    const subject = `SiteRouteBindingRegistry.bindings[${index}]`;
    const record = object(value, subject); exact(record, ["site", "route", "binding"], subject);
    const site = id(record.site, `${subject}.site`); const route = id(record.route, `${subject}.route`);
    const raw = object(record.binding, `${subject}.binding`); exact(raw, ["mount", "realpath", "commonGitDir", "kind"], `${subject}.binding`);
    if (!['managed', 'worktree', 'external-link'].includes(String(raw.kind))) fail("site-route-collision", `${subject}.binding.kind is invalid`);
    const binding: SiteRouteBinding = { mount: text(raw.mount, `${subject}.binding.mount`), realpath: text(raw.realpath, `${subject}.binding.realpath`), commonGitDir: text(raw.commonGitDir, `${subject}.binding.commonGitDir`), kind: raw.kind as SiteRouteBinding["kind"] };
    if (binding.mount !== resolve(canonicalMount, "checkouts/sites", site, route) || binding.realpath !== resolve(binding.realpath) || binding.commonGitDir !== resolve(binding.commonGitDir)) fail("site-route-collision", `${subject}.binding has a non-canonical address`);
    return { site, route, binding };
  });
  if (new Set(bindings.map((record) => bindingKey(record.site, record.route))).size !== bindings.length) fail("site-route-collision", `${path} repeats a Site Route Binding`);
  return { kind: "SiteRouteBindingRegistry", version: 1, workplace, bindings: bindings.sort((a, b) => bindingKey(a.site, a.route).localeCompare(bindingKey(b.site, b.route))) };
}

async function writeSiteRouteBindingRegistry(workplaceMount: string, registry: SiteRouteBindingRegistry): Promise<void> {
  const path = bindingRegistryPath(workplaceMount);
  if (registry.bindings.length === 0) { await rm(path, { recursive: false, force: true }); return; }
  const createdDirectories: string[] = [];
  await ensureDirectories(workplaceMount, dirname(path), createdDirectories);
  const bytes = stable({ ...registry, bindings: [...registry.bindings].sort((a, b) => bindingKey(a.site, a.route).localeCompare(bindingKey(b.site, b.route))) });
  if (await exists(path) && await readFile(path, "utf8") === bytes) return;
  const temporary = `${path}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try { await writeFile(temporary, bytes, { flag: "wx" }); await rename(temporary, path); }
  catch (error) {
    await rm(temporary, { recursive: false, force: true });
    for (const directory of createdDirectories.reverse()) if (await readdir(directory, { withFileTypes: true }).then((entries) => entries.length === 0).catch(() => false)) await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export async function removeSiteRouteBinding(workplaceMount: string, siteValue: string, routeValue: string, expected?: SiteRouteBinding): Promise<SiteRouteBinding> {
  const workplace = await workplaceIdentity(resolve(workplaceMount)); const site = id(siteValue, "site"); const route = id(routeValue, "route");
  const registry = await loadSiteRouteBindingRegistry(workplaceMount, workplace); const key = bindingKey(site, route);
  const record = registry.bindings.find((candidate) => bindingKey(candidate.site, candidate.route) === key) ?? fail("site-route-unavailable", `${key} has no local Site Route Binding`);
  if (expected && stable(record.binding) !== stable(expected)) fail("site-route-collision", `${key} local Binding changed`);
  await writeSiteRouteBindingRegistry(workplaceMount, { ...registry, bindings: registry.bindings.filter((candidate) => bindingKey(candidate.site, candidate.route) !== key) });
  return record.binding;
}

async function cloneRoute(path: string, locator: string, revision: SiteRouteRevision): Promise<void> {
  const temporary = `${path}.endroit-site-setup-${process.pid}-${crypto.randomUUID()}`;
  try {
    if (revision.kind === "branch") git(dirname(path), ["clone", "--no-tags", "--single-branch", "--branch", revision.name, "--", locator, temporary]);
    else {
      git(dirname(path), ["clone", "--no-checkout", "--no-tags", "--", locator, temporary]);
      git(temporary, ["checkout", "--detach", revision.sha]);
    }
    if (await exists(path)) fail("site-route-collision", `${path} appeared during clone`);
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

async function worktreeRoute(path: string, source: string, revision: SiteRouteRevision): Promise<void> {
  try {
    if (revision.kind === "branch") git(source, ["worktree", "add", "--", path, revision.name]);
    else git(source, ["worktree", "add", "--detach", "--", path, revision.sha]);
  } catch (error) {
    if (await exists(path)) {
      Bun.spawnSync(["git", "worktree", "remove", "--force", path], { cwd: source, stdout: "pipe", stderr: "pipe" });
      await rm(path, { recursive: true, force: true });
    }
    throw error;
  }
}

async function linkRoute(path: string, target: string): Promise<void> {
  const targetInfo = await lstat(target).catch(() => fail("site-route-unavailable", `${target} is unavailable`));
  if (targetInfo.isSymbolicLink() || !targetInfo.isDirectory()) fail("site-route-collision", `${target} must be a physical external checkout`);
  const temporary = `${path}.endroit-site-setup-${process.pid}-${crypto.randomUUID()}`;
  try {
    await (symlink as unknown as (target: string, path: string, type: "dir" | "junction") => Promise<void>)(target, temporary, process.platform === "win32" ? "junction" : "dir");
    if (await exists(path)) fail("site-route-collision", `${path} appeared during external link creation`);
    await rename(temporary, path);
  } catch (error) { await rm(temporary, { recursive: false, force: true }); throw error; }
}

export async function applySiteRouteSetup(plan: SiteRouteSetupPlan, expectedRevision: string, options: { targetFamily?: string } = {}): Promise<SiteRouteSetupReceipt> {
  const { revision: _revision, ...preview } = plan;
  const currentRevision = hash(stable(preview));
  if (plan.revision !== currentRevision || expectedRevision !== currentRevision) fail("site-route-digest-mismatch", `Preview digest mismatch: expected current ${currentRevision}`);
  const finalFamily = resolve(plan.workplaceMount, "checkouts/sites");
  const family = resolve(options.targetFamily ?? finalFamily);
  const staging = family !== finalFamily;
  if (await workplaceIdentity(plan.workplaceMount) !== plan.workplace) fail("invalid-site-route-request", `Plan Workplace ${plan.workplace} does not match ${plan.workplaceMount}`);
  const bindingRegistry = staging ? undefined : await loadSiteRouteBindingRegistry(plan.workplaceMount, plan.workplace);
  const registered = new Map(bindingRegistry?.bindings.map((record) => [bindingKey(record.site, record.route), record.binding]) ?? []);
  if (staging && plan.sites.some((site) => site.routes.some((route) => route.action !== "materialize"))) fail("site-route-collision", "Staging accepts materialize actions only");
  for (const site of plan.sites) for (const route of site.routes) {
    if (route.path !== resolve(finalFamily, site.id, route.id)) fail("site-route-collision", `${route.path} is not its closed Site/Route address`);
  }
  await assertFamily(plan.workplaceMount, family, plan.sites);
  const observed = new Map<string, Awaited<ReturnType<typeof observeRoute>>>();
  for (const site of plan.sites) for (const route of site.routes) {
    const target = resolve(family, site.id, route.id);
    const present = await exists(target);
    if (staging || route.action === "materialize") {
      if (present) fail("site-route-collision", `${target} already exists`);
      if (!staging && registered.has(`${site.id}/${route.id}`)) fail("site-route-collision", `${site.id}/${route.id} has a stale local Binding`);
    } else {
      if (!present) fail("site-route-unavailable", `${target} disappeared after Preview`);
      const observation = await observeRoute(target, site.productRemote.locator, route.revision, route.physical);
      const prior = registered.get(`${site.id}/${route.id}`);
      if (prior && stable(prior) !== stable(observation.binding)) fail("site-route-collision", `${site.id}/${route.id} local Binding does not match the Route`);
      observed.set(`${site.id}/${route.id}`, observation);
    }
  }
  const createdRoutes: Array<{ path: string; physical: SiteRoutePhysical; source?: string }> = [];
  const createdDirectories: string[] = [];
  const receiptSites: SiteRouteSetupReceipt["sites"] = [];
  try {
    for (const site of plan.sites) {
      const byId = new Map<string, SiteRouteSetupReceipt["sites"][number]["routes"][number]>();
      const pending = [...site.routes];
      while (pending.length) {
        const routeIndex = pending.findIndex((route) => route.physical.kind !== "worktree" || observed.has(`${site.id}/${route.physical.sourceRoute}`));
        if (routeIndex < 0) fail("site-route-unavailable", `${site.id} has an unresolved worktree dependency`);
        const route = pending.splice(routeIndex, 1)[0]!;
        const target = resolve(family, site.id, route.id);
        let observation = observed.get(`${site.id}/${route.id}`);
        if (route.action === "materialize") {
          await ensureDirectories(plan.workplaceMount, dirname(target), createdDirectories);
          await assertFamily(plan.workplaceMount, family, []);
          if (route.physical.kind === "direct") await cloneRoute(target, site.productRemote.locator, route.revision);
          else if (route.physical.kind === "worktree") await worktreeRoute(target, resolve(family, site.id, route.physical.sourceRoute), route.revision);
          else await linkRoute(target, route.physical.target);
          createdRoutes.push({ path: target, physical: route.physical, ...(route.physical.kind === "worktree" ? { source: resolve(family, site.id, route.physical.sourceRoute) } : {}) });
          observation = await observeRoute(target, site.productRemote.locator, route.revision, route.physical);
          observed.set(`${site.id}/${route.id}`, observation);
        }
        if (!observation) fail("site-route-unavailable", `${target} was not materialized`);
        byId.set(route.id, { id: route.id, path: target, commit: observation.commit, status: route.action === "verify" ? "unchanged" : route.physical.kind === "direct" ? "cloned" : "linked", bindingStatus: registered.has(`${site.id}/${route.id}`) ? "unchanged" : "created", binding: observation.binding });
      }
      const routes = site.routes.map((route) => byId.get(route.id) ?? fail("site-route-unavailable", `${route.id} has no Receipt`));
      receiptSites.push({ id: site.id, routes });
    }
    if (bindingRegistry) {
      const bindings = new Map(bindingRegistry.bindings.map((record) => [bindingKey(record.site, record.route), record]));
      for (const site of receiptSites) for (const route of site.routes) bindings.set(bindingKey(site.id, route.id), { site: site.id, route: route.id, binding: route.binding });
      await writeSiteRouteBindingRegistry(plan.workplaceMount, { ...bindingRegistry, bindings: [...bindings.values()] });
    }
  } catch (error) {
    for (const created of createdRoutes.reverse()) {
      if (created.physical.kind === "worktree" && created.source) Bun.spawnSync(["git", "worktree", "remove", "--force", created.path], { cwd: created.source, stdout: "pipe", stderr: "pipe" });
      await rm(created.path, { recursive: created.physical.kind !== "external-link", force: true });
    }
    for (const path of createdDirectories.reverse()) {
      if (await readdir(path, { withFileTypes: true }).then((entries) => entries.length === 0).catch(() => false)) await rm(path, { recursive: true, force: true });
    }
    throw error;
  }
  return { kind: "SiteRouteSetupReceipt", version: 1, plan: plan.revision, workplace: plan.workplace, status: "ready", family, createdDirectories, sites: receiptSites };
}

export async function detachExternalSiteRoute(workplaceMount: string, siteValue: string, routeValue: string): Promise<SiteRouteDetachReceipt> {
  const workplace = await workplaceIdentity(resolve(workplaceMount)); const site = id(siteValue, "site"); const route = id(routeValue, "route");
  const registry = await loadSiteRouteBindingRegistry(workplaceMount, workplace); const key = bindingKey(site, route);
  const record = registry.bindings.find((candidate) => bindingKey(candidate.site, candidate.route) === key) ?? fail("site-route-unavailable", `${key} has no local Site Route Binding`);
  if (record.binding.kind !== "external-link") fail("invalid-site-route-request", "Only an external-link Route can be detached without deleting a managed checkout");
  const mount = resolve(record.binding.mount);
  if (await exists(mount)) {
    const info = await lstat(mount);
    if (!info.isSymbolicLink()) fail("site-route-collision", `${mount} is not an external-link Route`);
    const linkedTarget = await realpath(mount).catch(async () => resolve(dirname(mount), await readlink(mount)));
    if (linkedTarget !== resolve(record.binding.realpath)) fail("site-route-collision", `${mount} does not resolve to its bound target`);
    await rm(mount, { recursive: false, force: false });
  }
  await removeSiteRouteBinding(workplaceMount, site, route, record.binding);
  return { kind: "SiteRouteDetachReceipt", version: 1, workplace, site, route, status: "detached", binding: record.binding };
}
