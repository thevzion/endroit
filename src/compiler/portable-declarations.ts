import { dirname, relative, resolve } from "node:path";
import { parseContinuityDescriptor } from "../checkpoint-store.ts";
import { normalizeWorkplaceRecoveryRequest } from "../recovery.ts";
import { parseSiteRouteSetupRequest } from "../site-setup.ts";
import { parseWorkplaceSetupRequest } from "../setup.ts";

// These are owned operational inputs, not compiler outputs or semantic sources.
// Keep checkpoint selections outside sourceRevision to avoid self-reference.
export function portableDeclarationKind(path: string): string | undefined {
  return /^\.workplace\/(?:bootstrap\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\/)?(setup|recovery|continuity|sites)\.json$/.exec(path)?.[1];
}

function fail(message: string): never { throw new Error(message); }
function rejectAbsolutePaths(value: unknown): void {
  if (typeof value === "string" && /^(?:\/|[A-Za-z]:|\\\\)/.test(value)) fail("Portable declarations cannot contain absolute or drive-relative machine paths");
  if (value && typeof value === "object") for (const item of Object.values(value)) rejectAbsolutePaths(item);
}
function remote(locator: string): void {
  if (/[\u0000-\u0020?#]/.test(locator)) fail("Portable Product Remote cannot contain controls, query or fragment");
  if (/^[^/\\:@]+@[^/:]+:.+/.test(locator)) return;
  let url: URL;
  try { url = new URL(locator); } catch { fail("Portable Product Remote must be an explicit network locator"); }
  if (!["https:", "ssh:"].includes(url.protocol) || url.password || url.search || url.hash || /[\u0000-\u0020]/.test(locator) || url.protocol !== "ssh:" && url.username) fail("Portable Product Remote must be credential-free HTTPS or SSH without query or fragment");
}

export type PortableDependency = { path: string; identity: string; field: "anchor" | "workplace" };
export function validatePortableDeclaration(root: string, path: string, bytes: string, workplace: string): PortableDependency[] {
  const kind = portableDeclarationKind(path) ?? fail(`Unknown portable declaration: ${path}`);
  const value: unknown = JSON.parse(bytes);
  rejectAbsolutePaths(value);
  const directory = resolve(root, dirname(path));
  const bootstrap = /^\.workplace\/bootstrap\/([^/]+)\//.exec(path)?.[1];
  const anchor = bootstrap ? `workplace://${bootstrap}` : workplace;
  const identity = (actual: string): void => { if (actual !== anchor) fail(`${path} must belong to ${anchor}`); };
  const dependencies: PortableDependency[] = [];
  const dependency = (absolute: string, expected: string, owner: string, field: PortableDependency["field"]): void => {
    const local = relative(root, absolute).split("\\").join("/");
    if (portableDeclarationKind(local) !== expected) fail(`${path} must reference a declared portable ${expected} file`);
    if (expected === "continuity" && !local.startsWith(".workplace/bootstrap/")) fail("Recovery continuity inputs use Bootstrap descriptors relative to their .endroit installation, not top-level descriptors");
    dependencies.push({ path: local, identity: owner, field });
  };
  if (kind === "setup") {
    const request = parseWorkplaceSetupRequest(value, directory);
    identity(request.anchor);
    for (const target of request.targets) {
      const id = target.workplace.split("/").at(-1);
      if (target.mount.mode !== "managed" || target.mount.path !== `checkouts/workplaces/${id}`) fail("Portable Setup targets need their exact managed Workplace address");
      if (target.source) remote(target.source);
      if (Object.keys(target.entry.rootBindings).length !== 1 || target.entry.rootBindings.shared !== "workplace") fail("Portable EntryBinding declares only the shared Workplace Root; other Roots are local");
      if (target.providers.length) fail("Concrete ProviderBindings belong in local Setup inputs, not portable declarations");
    }
  } else if (kind === "recovery") {
    const request = normalizeWorkplaceRecoveryRequest(value, directory);
    identity(request.anchor);
    dependency(request.setup, "setup", request.anchor, "anchor");
    for (const site of request.sites) dependency(site.request, "sites", site.workplace, "workplace");
    for (const entry of request.continuity ?? []) dependency(entry.descriptor, "continuity", entry.workplace, "workplace");
    for (const checkpoint of request.checkpoints) {
      const local = relative(resolve(dirname(root), ".endroit/checkpoints"), checkpoint.checkpoint);
      if (!local || local.startsWith("..")) fail("Portable checkpoint selections must address the ignored local checkpoint store");
    }
  } else if (kind === "continuity") {
    const descriptor = parseContinuityDescriptor(value, directory);
    identity(descriptor.anchor);
    identity(descriptor.workplace);
    if (descriptor.binding) fail("ContinuityBindings belong only in local ignored state");
    const mount = dirname(root);
    const base = bootstrap ? resolve(mount, ".endroit") : directory;
    const boundedLocal = (input: string): void => {
      const local = relative(resolve(mount, ".endroit"), resolve(base, input));
      if (!local || local.startsWith("..") || /[\\:]/.test(input)) fail("Portable continuity capture/store must stay below the target Mount's ignored .endroit");
    };
    boundedLocal(descriptor.capture);
    boundedLocal(descriptor.store);
    if (/[\\:]/.test(descriptor.restoreTarget) || resolve(base, descriptor.restoreTarget) !== resolve(mount, "checkouts/sites")) fail("Portable continuity restoreTarget must be the target Mount's checkouts/sites family");
  } else {
    const request = parseSiteRouteSetupRequest(value, directory);
    identity(request.workplace);
    for (const site of request.sites) {
      remote(site.productRemote.locator);
      if (site.routes.some((route) => route.physical?.kind === "external-link")) fail("External Route targets belong in local Site inputs");
    }
  }
  return dependencies;
}
