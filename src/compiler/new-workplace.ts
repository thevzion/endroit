import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import {
  checkWorkplaceMount,
  compileWorkplaceMount,
  hash,
  stable,
} from "./index.ts";
import type { CheckResult } from "./index.ts";
import type { LoadedProfilePackage, ProviderBinding, ProviderSurfaceTarget } from "./model.ts";
import { installGitGuards, planGitGuards, type GitGuardManifest } from "./git-witness.ts";
import { instantiateCoordinationPolicy, loadProfilePackage, renderProfileTemplate } from "./profile-package.ts";

export type NewProvider = "codex" | "claude";

export type NewWorkplaceRequest = {
  kind: "NewWorkplaceRequest";
  version: 1;
  target: string;
  workplace: { id: string; name: string };
  member: { id: string; name: string; language: string };
  desk: {
    id: string;
    name: string;
    welcome: { tone: string; humor: string; durableChanges: string };
  };
  providers: NewProvider[];
  git: {
    initialize: true;
    commits: true;
    author: { name: string; email: string };
  };
};

export type PlannedNewFile = {
  path: string;
  responsibility: "owned-source" | "local-binding" | "projection";
  digest: string | null;
};

export type NewWorkplacePlan = {
  kind: "human/new-workplace-preview";
  version: 1;
  revision: string;
  request: NewWorkplaceRequest;
  profile: { ref: string; revision: string };
  files: PlannedNewFile[];
  commits: Array<{ root: "shared"; responsibility: "sources" | "projections"; message: string }>;
  gitGuards: GitGuardManifest;
  exclusions: ["Room", "Work", "Site", "remote", "hosting", "delivery"];
  contents: Record<string, string>;
};

export type NewWorkplaceResult = {
  kind: "NewWorkplaceResult";
  revision: string;
  mount: string;
  roots: { shared: string };
  desk: string;
  commits: { sharedSources: string; sharedProjections: string };
  check: CheckResult;
};

const REQUEST_KEYS = new Set(["kind", "version", "target", "workplace", "member", "desk", "providers", "git"]);
const WORKPLACE_KEYS = new Set(["id", "name"]);
const MEMBER_KEYS = new Set(["id", "name", "language"]);
const DESK_KEYS = new Set(["id", "name", "welcome"]);
const WELCOME_KEYS = new Set(["tone", "humor", "durableChanges"]);
const GIT_KEYS = new Set(["initialize", "commits", "author"]);
const AUTHOR_KEYS = new Set(["name", "email"]);
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const LANGUAGE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

function fail(message: string): never {
  throw new Error(message);
}

function canonicalText(value: string): string {
  return value.replace(/\r\n?/g, "\n");
}

function object(value: unknown, subject: string): Record<string, unknown> {
  if (value === null || Array.isArray(value) || typeof value !== "object") fail(`${subject} must be an object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(`${subject} has an invalid prototype`);
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, keys: Set<string>, subject: string): void {
  const unknown = Object.keys(value).filter((key) => !keys.has(key));
  if (unknown.length > 0) fail(`${subject} has unknown fields: ${unknown.sort().join(", ")}`);
}

function text(value: unknown, subject: string, max = 200): string {
  if (typeof value !== "string") fail(`${subject} must be a string`);
  const result = value.trim();
  if (!result || result.length > max || CONTROL.test(result)) fail(`${subject} must be 1..${max} printable characters`);
  return result;
}

function slug(value: unknown, subject: string): string {
  const result = text(value, subject, 63);
  if (!SLUG.test(result)) fail(`${subject} must be a lower-ASCII slug`);
  return result;
}

export function slugify(value: string): string {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 63).replace(/-$/, "") || "workplace";
}

export function validateNewWorkplaceRequest(value: unknown): NewWorkplaceRequest {
  const request = object(value, "NewWorkplaceRequest");
  exact(request, REQUEST_KEYS, "NewWorkplaceRequest");
  if (request.kind !== "NewWorkplaceRequest" || request.version !== 1) fail("Unsupported NewWorkplaceRequest");

  const workplace = object(request.workplace, "workplace");
  const member = object(request.member, "member");
  const desk = object(request.desk, "desk");
  const welcome = object(desk.welcome, "desk.welcome");
  const git = object(request.git, "git");
  const author = object(git.author, "git.author");
  exact(workplace, WORKPLACE_KEYS, "workplace");
  exact(member, MEMBER_KEYS, "member");
  exact(desk, DESK_KEYS, "desk");
  exact(welcome, WELCOME_KEYS, "desk.welcome");
  exact(git, GIT_KEYS, "git");
  exact(author, AUTHOR_KEYS, "git.author");

  const target = resolve(text(request.target, "target", 4096));
  if (target === dirname(target)) fail("target cannot be the filesystem root");
  const language = text(member.language, "member.language", 35);
  if (!LANGUAGE.test(language)) fail("member.language must be a BCP 47 language tag");
  if (!Array.isArray(request.providers)) fail("providers must be an array");
  const providers = request.providers.map((provider, index) => {
    if (provider !== "codex" && provider !== "claude") fail(`providers[${index}] is unsupported`);
    return provider;
  });
  if (new Set(providers).size !== providers.length) fail("providers must not contain duplicates");
  if (desk.id !== member.id) fail("desk.id must equal member.id; v1 has one Desk per Member x Workplace");
  if (git.initialize !== true || git.commits !== true) fail("git.initialize and git.commits must be true in version 1");
  const email = text(author.email, "git.author.email", 254);
  if (!EMAIL.test(email)) fail("git.author.email is invalid");

  return {
    kind: "NewWorkplaceRequest",
    version: 1,
    target,
    workplace: { id: slug(workplace.id, "workplace.id"), name: text(workplace.name, "workplace.name", 100) },
    member: { id: slug(member.id, "member.id"), name: text(member.name, "member.name", 100), language },
    desk: {
      id: slug(desk.id, "desk.id"),
      name: text(desk.name, "desk.name", 100),
      welcome: {
        tone: text(welcome.tone, "desk.welcome.tone", 240),
        humor: text(welcome.humor, "desk.welcome.humor", 240),
        durableChanges: text(welcome.durableChanges, "desk.welcome.durableChanges", 500),
      },
    },
    providers,
    git: { initialize: true, commits: true, author: { name: text(author.name, "git.author.name", 100), email } },
  };
}

function yaml(value: string): string {
  return JSON.stringify(value);
}

function source(metadata: {
  ref: string;
  entity: string;
  roles: string[];
  slot: string;
  owner: string;
  scope: string;
  label: string;
  summary: string;
  when: string[];
  relations?: Record<string, string[]>;
  language?: string;
  responsibilities?: string[];
  authorityLimits?: string[];
  durableChanges?: string[];
}, body: string): string {
  const lines = [
    `ref: ${yaml(metadata.ref)}`,
    `entity: ${yaml(metadata.entity)}`,
    `roles: ${JSON.stringify(metadata.roles)}`,
    `slot: ${yaml(metadata.slot)}`,
    `owner: ${yaml(metadata.owner)}`,
    `scope: ${yaml(metadata.scope)}`,
    `label: ${yaml(metadata.label)}`,
    ...(metadata.language ? [`language: ${yaml(metadata.language)}`] : []),
    `summary: ${yaml(metadata.summary)}`,
    `when: ${JSON.stringify(metadata.when)}`,
    ...(metadata.responsibilities ? [`responsibilities: ${JSON.stringify(metadata.responsibilities)}`] : []),
    ...(metadata.authorityLimits ? [`authorityLimits: ${JSON.stringify(metadata.authorityLimits)}`] : []),
    ...(metadata.durableChanges ? [`durableChanges: ${JSON.stringify(metadata.durableChanges)}`] : []),
    ...(metadata.relations && Object.keys(metadata.relations).length > 0
      ? ["relations:", ...Object.entries(metadata.relations).map(([id, refs]) => `  ${id}: ${JSON.stringify(refs)}`)]
      : ["relations: {}"]),
  ];
  return `---\n${lines.join("\n")}\n---\n\n${body.trim()}\n`;
}

function providerBinding(provider: NewProvider, command: string[], target: string, profilePackage: LoadedProfilePackage): ProviderBinding {
  const targets: ProviderSurfaceTarget[] = provider === "codex" ? [
    { provider, kind: "front-door", path: "AGENTS.md", discovery: "automatic", loadGuarantee: "qualified" },
    { provider, kind: "agent", path: "agents/manager.md", discovery: "model-selected", loadGuarantee: "qualified" },
    { provider, kind: "agent", path: "agents/worker.md", discovery: "model-selected", loadGuarantee: "qualified" },
    ...Object.values(profilePackage.affordances).filter((affordance) => affordance.contract.providerTargets.includes("skill")).map(({ contract }): ProviderSurfaceTarget => ({ provider, kind: "skill", path: `.agents/skills/${contract.id}/SKILL.md`, discovery: "model-selected", loadGuarantee: "qualified" })),
  ] : [
    { provider, kind: "front-door", path: "CLAUDE.md", discovery: "automatic", loadGuarantee: "qualified" },
    { provider, kind: "agent", path: "agents/manager.md", discovery: "model-selected", loadGuarantee: "unproven" },
    { provider, kind: "agent", path: "agents/worker.md", discovery: "model-selected", loadGuarantee: "unproven" },
  ];
  return {
    kind: "ProviderBinding",
    provider,
    targets,
    tools: [
      { trait: "source.read-local", tool: "shell", provider, availability: "available" },
      { trait: "workplace.compile", tool: "endroit", provider, availability: "available", command: [...command, "ready", target] },
    ],
  };
}

export function planNewWorkplace(value: unknown, options: { profile: LoadedProfilePackage; cliCommand: string[] }): NewWorkplacePlan {
  const request = validateNewWorkplaceRequest(value);
  if (options.profile.manifest.id !== "endroit-standard") fail("endroit new version 1 requires the Standard Profile");
  if (options.cliCommand.length === 0 || options.cliCommand.some((part) => !part)) fail("cliCommand must identify the Endroit executable");
  const base = `workplace://${request.workplace.id}`;
  const member = `${base}/member/${request.member.id}`;
  const desk = `${base}/desk/${request.member.id}`;
  const material = (id: string) => `${base}/material/${id}`;
  const contents: Record<string, string> = {};
  const put = (path: string, content: string) => { contents[path] = canonicalText(content); };

  const providerTargets = request.providers.flatMap((provider) => providerBinding(provider, options.cliCommand, request.target, options.profile).targets);
  put(".gitignore", ["/.endroit/", "/.agents/", "/FRONTDOOR.md", "/AGENTS.md", "/CLAUDE.md", "/MEMORY.md", "/rooms/", "/work/", "/sites/", "/desks/", "/scopes/", "/methods/", "/agents/", ".DS_Store", "**/.DS_Store", ""].join("\n"));
  put("workplace/.gitattributes", [
    ".gitattributes text eol=lf",
    ".gitignore text eol=lf",
    "**/.workplaceignore text eol=lf",
    "*.json text eol=lf",
    "*.md text eol=lf",
    "",
  ].join("\n"));
  put("workplace/profile.json", stable({ kind: "ProfileSelection", version: 1, ref: options.profile.manifest.ref, digest: options.profile.digest }));
  put("workplace/composition.json", stable({ kind: "Composition", ref: `${base}/composition`, equipment: options.profile.compositionTemplate.equipment }));
  put("workplace/coordination.json", stable(instantiateCoordinationPolicy(options.profile, base)));
  put("workplace/workplace.json", stable({
    kind: "WorkplaceBuildContract",
    version: 2,
    workplace: base,
    profile: { ref: options.profile.manifest.ref, path: "profile.json", revision: options.profile.digest },
    composition: { ref: `${base}/composition`, path: "composition.json" },
    roots: ["shared", "site"],
    policy: {
      disclosureSelectors: options.profile.profile.disclosures.selectors.map((selector) => selector.id),
      localBuildIntent: "bounded-work-and-site",
      delivery: "explicit-human-only",
    },
    distributionTargets: [
      { provider: "neutral", kind: "front-door", path: "WORKPLACE.md", discovery: "manual", loadGuarantee: "qualified" },
      ...providerTargets,
    ],
  }));
  put("workplace/.workplaceignore", ".git/\nnode_modules/\ndist/\n.endroit/\n.DS_Store\n**/.DS_Store\n");
  const variables = {
    WORKPLACE_ID: request.workplace.id, WORKPLACE_NAME: request.workplace.name,
    MEMBER_ID: request.member.id, MEMBER_NAME: request.member.name, LANGUAGE: request.member.language,
    DESK_ID: request.desk.id, DESK_NAME: request.desk.name, TONE: request.desk.welcome.tone,
    HUMOR: request.desk.welcome.humor, DURABLE_CHANGES: request.desk.welcome.durableChanges,
  };
  const body = (id: string) => renderProfileTemplate(options.profile.defaults[id] ?? fail(`Profile Package default ${id} is unavailable`), variables);
  put("workplace/sources/CONSTITUTION.md", source({ ref: material("constitution"), entity: "material", roles: ["constitution"], slot: "governance", owner: member, scope: base, label: `${request.workplace.name} Constitution`, summary: "Human direction, judgment, acceptance and delivery consent remain explicit.", when: ["Before any durable or external effect."] }, body("constitution")));
  put("workplace/sources/DOCTRINE.md", source({ ref: material("doctrine"), entity: "material", roles: ["doctrine"], slot: "governance", owner: member, scope: base, label: `${request.workplace.name} Doctrine`, summary: "Compile globally, disclose locally, load on intent and execute with proof.", when: ["Choosing a path from intent to outcome."] }, body("doctrine")));
  put("workplace/sources/CHANGE.md", source({ ref: material("change-policy"), entity: "material", roles: ["change-policy"], slot: "governance", owner: member, scope: base, label: `${request.workplace.name} Change Policy`, summary: "Durable changes follow one declared Operation in their owning Root with proof.", when: ["Before changing Workplace or Site state."] }, body("change")));
  put(`workplace/sources/members/${request.member.id}/MEMBER.md`, source({ ref: member, entity: "member", roles: ["owner"], slot: "members", owner: member, scope: base, label: request.member.name, language: request.member.language, summary: `Human owner of ${request.workplace.name}.`, when: ["Human ownership, judgment or consent matters."], responsibilities: ["Own direction, judgment, acceptance and delivery consent."], authorityLimits: ["Agents may prepare bounded local changes but never accept, host or deliver."], durableChanges: [request.desk.welcome.durableChanges], relations: { owns: [desk] } }, body("member")));
  const deskRoot = `workplace/sources/members/${request.member.id}/desk`;
  put(`${deskRoot}/DESK.md`, source({ ref: desk, entity: "place", roles: ["desk"], slot: "desks", owner: member, scope: base, label: request.desk.name, summary: `Situated Desk identity and index for ${request.member.name}.`, when: ["A bound entry resolves its Desk."], relations: { "owned-by": [member] } }, body("desk")));
  const welcomeBody = body("welcome");
  if (new TextEncoder().encode(welcomeBody).byteLength > 4096) fail("WELCOME body exceeds 4 KiB");
  put(`${deskRoot}/WELCOME.md`, source({ ref: material(`welcome-${request.member.id}`), entity: "material", roles: ["welcome"], slot: "desk-material", owner: member, scope: desk, label: `${request.member.name} welcome`, summary: `Resident disclosure selected by ${request.desk.name}.`, when: ["Every conversation bound to this Desk."], relations: { "owned-by": [member], "for-desk": [desk] } }, welcomeBody));
  put(`${deskRoot}/MEMORY.md`, source({ ref: material(`memory-${request.member.id}`), entity: "material", roles: ["memory-policy"], slot: "desk-material", owner: member, scope: desk, label: `${request.member.name} memory policy`, summary: "Desk sources own durable situated continuity; provider memory is disposable cache.", when: ["A conversation considers retaining situated continuity."], relations: { "owned-by": [member], "for-desk": [desk] } }, body("memory")));
  put(".endroit/entry.json", stable({ kind: "EntryBinding", workplace: base, member, desk, rootBindings: { shared: "workplace" } }));
  for (const provider of request.providers) put(`.endroit/providers/${provider}.json`, stable(providerBinding(provider, options.cliCommand, request.target, options.profile)));

  const projectionPaths = [
    "FRONTDOOR.md", "methods/open-room.md", "agents/manager.md", "agents/worker.md", ".endroit/front-door-ir.json", ".endroit/coordination-ir.json", ".endroit/disclosure-contract.json", ".endroit/context-contracts.json", ".endroit/control-clauses.json", ".endroit/projection-manifest.json",
    "workplace/WORKPLACE.md", "workplace/LEXICON.md", "workplace/.workplace/definition.json", "workplace/.workplace/lexicon.json", "workplace/.workplace/profile.json", "workplace/.workplace/composition.json", "workplace/.workplace/coordination.json", "workplace/.workplace/views/PROFILE.md", "workplace/.workplace/views/COMPOSITION.md", "workplace/.workplace/workplace-map.json", "workplace/.workplace/instruction-coverage.json", "workplace/.workplace/projection-manifest.json",
    ...(request.providers.includes("codex") ? ["AGENTS.md", ...["enter", "maintain"].map((id) => `.agents/skills/${id}/SKILL.md`)] : []),
    ...(request.providers.includes("claude") ? ["CLAUDE.md"] : []),
  ].sort();
  const gitGuards = planGitGuards(options.cliCommand);
  const files: PlannedNewFile[] = [
    ...Object.entries(contents).map(([path, content]): PlannedNewFile => ({ path, responsibility: path.startsWith(".endroit/") || path === ".gitignore" ? "local-binding" : "owned-source", digest: hash(content) })),
    ...projectionPaths.map((path): PlannedNewFile => ({ path, responsibility: "projection", digest: null })),
    ...gitGuards.hooks.map((hook): PlannedNewFile => ({ path: `${hook.rootPath}/.git/hooks/${hook.name}`, responsibility: "local-binding", digest: hook.digest })),
    { path: ".endroit/git-guards.json", responsibility: "local-binding" as const, digest: hash(stable(gitGuards)) },
  ].sort((a, b) => a.path.localeCompare(b.path));
  const commits: NewWorkplacePlan["commits"] = [
    { root: "shared", responsibility: "sources", message: `adopt(workplace:${request.workplace.id}): create owned sources` },
    { root: "shared", responsibility: "projections", message: `compile(workplace:${request.workplace.id}): project portable control plane` },
  ];
  const preview = {
    kind: "human/new-workplace-preview" as const,
    version: 1 as const,
    request,
    profile: { ref: options.profile.manifest.ref, revision: options.profile.digest },
    gitGuards,
    files,
    commits,
    exclusions: ["Room", "Work", "Site", "remote", "hosting", "delivery"] as NewWorkplacePlan["exclusions"],
  };
  return { ...preview, revision: hash(stable(preview)), contents };
}

export function renderNewWorkplacePreview(plan: NewWorkplacePlan): string {
  const roots = [`- Mount: ${plan.request.target}`, "- Workplace Git Root: workplace/", `- Desk subtree: workplace/sources/members/${plan.request.member.id}/desk/`];
  const providers = plan.request.providers.length > 0 ? plan.request.providers.join(", ") : "none (neutral Front Door only)";
  return [
    ...roots,
    `- Files: ${plan.files.length} planned (${plan.files.filter((file) => file.responsibility === "projection").length} compiler projections)`,
    ...plan.files.map((file) => `  - [${file.responsibility}] ${file.path}${file.digest ? ` · ${file.digest}` : " · compiler-derived"}`),
    `- Adapters: ${providers}`,
    `- Git identity: ${plan.request.git.author.name} <${plan.request.git.author.email}>`,
    "- Commits:",
    ...plan.commits.map((commit) => `  - ${commit.root}: ${commit.message}`),
    `- Not created: ${plan.exclusions.join(", ")}`,
    `- Preview digest: ${plan.revision}`,
  ].join("\n");
}

function runGit(root: string, args: string[], author?: { name: string; email: string }): string {
  const command = ["git", ...(author ? ["-c", `user.name=${author.name}`, "-c", `user.email=${author.email}`] : []), ...args];
  const result = Bun.spawnSync(command, { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) fail(`git ${args[0]} failed in ${root}: ${new TextDecoder().decode(result.stderr).trim()}`);
  return new TextDecoder().decode(result.stdout).trim();
}

function commit(root: string, message: string, authority: "human-invoked" | "projection", author: { name: string; email: string }, build?: string): string {
  runGit(root, ["add", "."]);
  const body = `${message}\n\nAuthority: ${authority}${build ? `\nBuild: ${build}` : ""}`;
  runGit(root, ["commit", "-m", body], author);
  return runGit(root, ["rev-parse", "HEAD"]);
}

async function unavailable(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return false;
  } catch (error) {
    if (error instanceof Error && error.message.includes("ENOENT")) return true;
    throw error;
  }
}

export async function assertNewWorkplaceTargetAvailable(target: string): Promise<void> {
  const path = resolve(target);
  if (!await unavailable(path)) fail(`Target already exists or is a symlink: ${path}`);
}

export async function applyNewWorkplace(plan: NewWorkplacePlan, expectedRevision: string): Promise<NewWorkplaceResult> {
  if (expectedRevision !== plan.revision) fail(`Preview digest mismatch: expected current ${plan.revision}`);
  const target = plan.request.target;
  await assertNewWorkplaceTargetAvailable(target);
  const temp = join(dirname(target), `.${basename(target)}.endroit-new-${process.pid}-${crypto.randomUUID()}`);
  let moved = false;
  await mkdir(dirname(target), { recursive: true });
  try {
    await mkdir(temp, { recursive: false });
    for (const [path, content] of Object.entries(plan.contents).sort(([a], [b]) => a.localeCompare(b))) {
      const destination = join(temp, path);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, content, { flag: "wx" });
    }
    const shared = join(temp, "workplace");
    runGit(shared, ["init", "-b", "develop"]);
    const sharedSources = commit(shared, plan.commits[0]!.message, "human-invoked", plan.request.git.author);
    await compileWorkplaceMount({ mount: temp });
    const sharedProjections = commit(shared, plan.commits[1]!.message, "projection", plan.request.git.author, sharedSources);
    await installGitGuards(temp, plan.gitGuards);
    const check = await checkWorkplaceMount({ mount: temp });
    if (check.compileStatus !== "valid" || check.operationStatus !== "ready" || check.entryStatus !== "bound") fail(`Created Workplace did not reach ready: ${check.compileStatus}/${check.entryStatus}/${check.operationStatus}`);
    for (const root of [shared]) {
      if (runGit(root, ["status", "--porcelain"])) fail(`Git Root is dirty after creation: ${root}`);
      if (runGit(root, ["remote"])) fail(`Git Root unexpectedly has a remote: ${root}`);
    }
    await rename(temp, target);
    moved = true;
    const finalCheck = await checkWorkplaceMount({ mount: target });
    if (finalCheck.compileStatus !== "valid" || finalCheck.operationStatus !== "ready") fail("Final Workplace check failed after atomic move");
    return {
      kind: "NewWorkplaceResult",
      revision: plan.revision,
      mount: target,
      roots: { shared: join(target, "workplace") },
      desk: join(target, `workplace/sources/members/${plan.request.member.id}/desk`),
      commits: { sharedSources, sharedProjections },
      check: finalCheck,
    };
  } catch (error) {
    await rm(temp, { recursive: true, force: true });
    if (moved) await rm(target, { recursive: true, force: true });
    throw error;
  }
}

export async function loadStandardProfile(path: string): Promise<LoadedProfilePackage> {
  return loadProfilePackage(path);
}
