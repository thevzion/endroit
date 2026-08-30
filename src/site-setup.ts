import { lstat, mkdir, readFile, readdir, realpath, rename, rm } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { hash, stable } from "./compiler/index.ts";

const REF = /^workplace:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
const ID = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const RESERVED = new Set(["sites", "workplaces"]);

export type SiteRouteRevision =
  | { kind: "branch"; name: string }
  | { kind: "commit"; sha: string };

export type SiteRouteSetupRequest = {
  kind: "SiteRouteSetupRequest";
  version: 1;
  workplace: string;
  sites: Array<{
    id: string;
    productRemote: { kind: "ProductRemote"; locator: string };
    routes: Array<{ id: string; revision: SiteRouteRevision }>;
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
    routes: Array<{ id: string; revision: SiteRouteRevision; path: string; action: "clone" | "verify" }>;
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
    routes: Array<{ id: string; path: string; commit: string; status: "cloned" | "unchanged" }>;
  }>;
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

function exact(value: Record<string, unknown>, keys: string[], subject: string): void {
  const unknown = Object.keys(value).filter((key) => !keys.includes(key));
  const missing = keys.filter((key) => !(key in value));
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
      exact(route, ["id", "revision"], routeSubject);
      return { id: id(route.id, `${routeSubject}.id`), revision: revision(route.revision, `${routeSubject}.revision`) };
    });
    if (new Set(routes.map((route) => route.id)).size !== routes.length) fail("invalid-site-route-request", `${subject}.routes repeats an id`);
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
    for (const route of site.routes) {
      const routePath = join(sitePath, route.id);
      await physicalDirectory(routePath, resolve(canonicalMount, relative(mount, routePath)), routePath);
    }
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
      return { ...route, path, action: "verify" as "clone" | "verify" };
    }),
  }));
  for (const site of sites) for (const route of site.routes) if (!await exists(route.path)) route.action = "clone";
  const preview = { kind: "SiteRouteSetupPlan" as const, version: 1 as const, workplace: request.workplace, workplaceMount, sites };
  return { ...preview, revision: hash(stable(preview)) };
}

function git(cwd: string, args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) fail("site-route-unavailable", `git ${args[0]} failed: ${new TextDecoder().decode(result.stderr).trim()}`);
  return new TextDecoder().decode(result.stdout).trim();
}

async function observeRoute(path: string, locator: string, revision: SiteRouteRevision): Promise<string> {
  const gitDirectory = join(path, ".git");
  const gitInfo = await lstat(gitDirectory).catch(() => fail("site-route-collision", `${gitDirectory} must be a physical Git directory`));
  if (gitInfo.isSymbolicLink() || !gitInfo.isDirectory() || await realpath(gitDirectory) !== resolve(await realpath(path), ".git")) fail("site-route-collision", `${gitDirectory} must be a physical Git directory`);
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
  return commit;
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

async function cloneRoute(path: string, locator: string, revision: SiteRouteRevision, createdRoutes: string[]): Promise<string> {
  const temporary = `${path}.endroit-site-setup-${process.pid}-${crypto.randomUUID()}`;
  try {
    if (revision.kind === "branch") git(dirname(path), ["clone", "--no-tags", "--single-branch", "--branch", revision.name, "--", locator, temporary]);
    else {
      git(dirname(path), ["clone", "--no-checkout", "--no-tags", "--", locator, temporary]);
      git(temporary, ["checkout", "--detach", revision.sha]);
    }
    if (await exists(path)) fail("site-route-collision", `${path} appeared during clone`);
    await rename(temporary, path);
    createdRoutes.push(path);
    return await observeRoute(path, locator, revision);
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

export async function applySiteRouteSetup(plan: SiteRouteSetupPlan, expectedRevision: string, options: { targetFamily?: string } = {}): Promise<SiteRouteSetupReceipt> {
  const { revision: _revision, ...preview } = plan;
  const currentRevision = hash(stable(preview));
  if (plan.revision !== currentRevision || expectedRevision !== currentRevision) fail("site-route-digest-mismatch", `Preview digest mismatch: expected current ${currentRevision}`);
  const finalFamily = resolve(plan.workplaceMount, "checkouts/sites");
  const family = resolve(options.targetFamily ?? finalFamily);
  const staging = family !== finalFamily;
  if (await workplaceIdentity(plan.workplaceMount) !== plan.workplace) fail("invalid-site-route-request", `Plan Workplace ${plan.workplace} does not match ${plan.workplaceMount}`);
  if (staging && plan.sites.some((site) => site.routes.some((route) => route.action !== "clone"))) fail("site-route-collision", "Staging accepts clone actions only");
  for (const site of plan.sites) for (const route of site.routes) {
    if (route.path !== resolve(finalFamily, site.id, route.id)) fail("site-route-collision", `${route.path} is not its closed Site/Route address`);
  }
  await assertFamily(plan.workplaceMount, family, plan.sites);
  const observed = new Map<string, string>();
  for (const site of plan.sites) for (const route of site.routes) {
    const target = resolve(family, site.id, route.id);
    const present = await exists(target);
    if (staging || route.action === "clone") {
      if (present) fail("site-route-collision", `${target} already exists`);
    } else {
      if (!present) fail("site-route-unavailable", `${target} disappeared after Preview`);
      observed.set(`${site.id}/${route.id}`, await observeRoute(target, site.productRemote.locator, route.revision));
    }
  }
  const createdRoutes: string[] = [];
  const createdDirectories: string[] = [];
  const receiptSites: SiteRouteSetupReceipt["sites"] = [];
  try {
    for (const site of plan.sites) {
      const routes: SiteRouteSetupReceipt["sites"][number]["routes"] = [];
      for (const route of site.routes) {
        const target = resolve(family, site.id, route.id);
        let commit = observed.get(`${site.id}/${route.id}`);
        if (route.action === "clone") {
          await ensureDirectories(plan.workplaceMount, dirname(target), createdDirectories);
          await assertFamily(plan.workplaceMount, family, []);
          commit = await cloneRoute(target, site.productRemote.locator, route.revision, createdRoutes);
        }
        if (!commit) fail("site-route-unavailable", `${target} was not materialized`);
        routes.push({ id: route.id, path: target, commit, status: route.action === "clone" ? "cloned" : "unchanged" });
      }
      receiptSites.push({ id: site.id, routes });
    }
  } catch (error) {
    for (const path of createdRoutes.reverse()) await rm(path, { recursive: true, force: true });
    for (const path of createdDirectories.reverse()) {
      if (await readdir(path, { withFileTypes: true }).then((entries) => entries.length === 0).catch(() => false)) await rm(path, { recursive: true, force: true });
    }
    throw error;
  }
  return { kind: "SiteRouteSetupReceipt", version: 1, plan: plan.revision, workplace: plan.workplace, status: "ready", family, createdDirectories, sites: receiptSites };
}
