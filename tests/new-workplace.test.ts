import { describe, expect, test } from "bun:test";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { checkStaticWorkplace, checkWorkplaceMount, readyWorkplace } from "../src/compiler/index.ts";
import {
  applyNewWorkplace,
  loadStandardProfile,
  planNewWorkplace,
  type NewWorkplaceRequest,
} from "../src/compiler/new-workplace.ts";
import { renderWordmark, runNewWizard } from "../src/new-wizard.ts";

const repository = resolve(import.meta.dir, "..");
const profilePath = resolve(repository, "profiles/standard/profile.json");
const cliCommand = [Bun.argv[0]!, resolve(repository, "src/cli.ts")];

function request(target: string, providers: Array<"codex" | "claude"> = ["codex"]): NewWorkplaceRequest {
  return {
    kind: "NewWorkplaceRequest",
    version: 1,
    target,
    workplace: { id: "fresh-studio", name: "Fresh Studio" },
    member: { id: "alexis", name: "Alexis", language: "fr" },
    desk: {
      id: "alexis",
      name: "Alexis Desk",
      welcome: {
        tone: "Direct, warm and concise.",
        humor: "Light when it helps; never forced.",
        durableChanges: "Update this Desk WELCOME.md, never provider memory.",
      },
    },
    providers,
    git: { initialize: true, commits: true, author: { name: "Alexis Fixture", email: "alexis@example.test" } },
  };
}

function git(root: string, args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
  return new TextDecoder().decode(result.stdout).trim();
}

function filesystemRoot(path: string): string {
  let root = resolve(path);
  while (dirname(root) !== root) root = dirname(root);
  return root;
}

describe("endroit new", () => {
  test("plans identical bytes and invalidates a changed Request", async () => {
    const profile = await loadStandardProfile(profilePath);
    const previewTarget = resolve(tmpdir(), "endroit-new-preview");
    const first = planNewWorkplace(request(previewTarget), { profile, cliCommand });
    const second = planNewWorkplace(request(previewTarget), { profile, cliCommand });
    expect(first.revision).toBe(second.revision);
    expect(first.files).toEqual(second.files);
    expect(first.files.some((file) => file.path === "AGENTS.md")).toBe(true);
    expect(first.files.some((file) => file.path === "CLAUDE.md")).toBe(false);
    expect(first.gitGuards.hooks).toHaveLength(2);
    expect(first.gitGuards.hooks.some((hook) => hook.rootPath.includes("sites"))).toBe(false);
    const neutralOnly = planNewWorkplace(request(resolve(tmpdir(), "endroit-new-neutral"), []), { profile, cliCommand });
    expect(neutralOnly.files.some((file) => file.path === "FRONTDOOR.md")).toBe(true);
    expect(neutralOnly.files.some((file) => file.path === "AGENTS.md" || file.path === "CLAUDE.md")).toBe(false);
    const changed = request(previewTarget);
    changed.desk.welcome.humor = "Dry humor.";
    expect(planNewWorkplace(changed, { profile, cliCommand }).revision).not.toBe(first.revision);
    expect(() => planNewWorkplace({ ...request(previewTarget), unknown: true }, { profile, cliCommand })).toThrow("unknown fields");
    expect(() => planNewWorkplace(request(previewTarget, ["codex", "codex"]), { profile, cliCommand })).toThrow("duplicates");
    expect(() => planNewWorkplace(request(filesystemRoot(tmpdir())), { profile, cliCommand })).toThrow("filesystem root");
    const crlf = { ...profile, defaults: Object.fromEntries(Object.entries(profile.defaults).map(([id, value]) => [id, value.replaceAll("\n", "\r\n")])) };
    expect(Object.values(planNewWorkplace(request(previewTarget), { profile: crlf, cliCommand }).contents).every((content) => !content.includes("\r"))).toBe(true);
  });

  test("creates a bound Workplace with one Git Root and one situated Desk subtree", async () => {
    const target = resolve(tmpdir(), `endroit-new-test-${crypto.randomUUID()}`);
    await rm(target, { recursive: true, force: true });
    try {
      const profile = await loadStandardProfile(profilePath);
      const plan = planNewWorkplace(request(target, ["codex", "claude"]), { profile, cliCommand });
      const result = await applyNewWorkplace(plan, plan.revision);
      expect(result.check.operationStatus).toBe("ready");
      expect(result.check.entryStatus).toBe("bound");
      expect(git(result.roots.shared, ["branch", "--show-current"])).toBe("develop");
      expect(git(result.roots.shared, ["rev-list", "--count", "HEAD"])).toBe("2");
      expect(git(result.roots.shared, ["remote"])).toBe("");
      expect(git(result.roots.shared, ["status", "--porcelain"])).toBe("");
      expect(await readFile(resolve(result.roots.shared, ".gitattributes"), "utf8")).toContain("*.md text eol=lf");
      expect(git(result.roots.shared, ["check-attr", "eol", "--", "WORKPLACE.md"])).toContain("eol: lf");
      expect(git(result.roots.shared, ["log", "-2", "--format=%B"])).toContain("Authority: human-invoked");
      expect(git(result.roots.shared, ["log", "-1", "--format=%B"])).toContain("Authority: projection");

      const agents = await readFile(resolve(target, "AGENTS.md"), "utf8");
      expect(agents).toContain("Reception · bound Member Card");
      expect(agents).toContain("Language: fr");
      expect(agents).toContain("Direct, warm and concise.");
      expect(agents).toContain("Desk Memory Policy");
      expect(agents).toContain("methods/open-room.md");
      expect(agents).toContain("Provider coordination status: **available**");
      expect(agents).not.toContain("Manager coordination contract");
      expect(agents).toContain("Resident operating contract");
      expect(agents).toContain("A Workplace cannot weaken a Standard invariant");
      expect(agents).toContain("Installed is not visible");
      expect(agents).not.toContain("Load the complete owned policy only when the current Intent requires it");
      expect(agents).not.toContain("This ordinary file is a compiled adapter");
      expect(agents).not.toContain("<!-- disclosure:");
      expect(await readFile(resolve(target, "FRONTDOOR.md"), "utf8")).toContain("<!-- disclosure:");
      const constitution = await readFile(resolve(target, "workplace/sources/CONSTITUTION.md"), "utf8");
      expect(constitution).toContain("The human Member owns Intent");
      expect(constitution).not.toContain("Alexis owns direction");
      expect(await readFile(resolve(target, "workplace/sources/DOCTRINE.md"), "utf8")).toContain("one question and zero writes");
      expect(result.desk).toBe(resolve(target, "workplace/sources/members/alexis/desk"));
      expect(await readFile(resolve(result.desk, "MEMORY.md"), "utf8")).toContain("Secrets belong in a secret store");
      expect(await Bun.file(resolve(target, "checkouts/desks")).exists()).toBe(false);
      const openRoom = await readFile(resolve(target, "methods/open-room.md"), "utf8");
      const enter = await readFile(resolve(target, ".agents/skills/enter/SKILL.md"), "utf8");
      expect(enter).toContain("directly through the resident Member Card to its WELCOME source");
      expect(enter).toContain("`open-room` are not applicable");
      expect(openRoom).toContain("local to the Hall");
      expect(openRoom).toContain("visibility alone is insufficient");
      expect(openRoom).toContain("## Avoid when");
      expect(openRoom).toContain("Intent concerns the bound Member, Desk preferences or WELCOME");
      expect(openRoom).toContain("workplace/sources/rooms/<room-id>/ROOM.md");
      expect(openRoom).toContain("open-room(place:<room-id>): declare owned Room");
      expect(openRoom).toContain("Meeting: <resolved-meeting-ref>");
      expect(openRoom).toContain("meetings/<meeting-id>/MEETING.md");
      expect(openRoom).toContain("Literal angle-bracket tokens are invalid");
      expect(openRoom).toContain("Authority: delegated");
      expect(openRoom).toContain("Build: <exact-room-and-meeting-source-oid>");
      expect(openRoom).toContain(cliCommand[0]!);
      expect(openRoom).toContain("Only there may `open-work` become visible");
      const change = await readFile(resolve(target, "workplace/sources/CHANGE.md"), "utf8");
      expect(change).toContain("<affordance>(<kind>:<slug>): <observed effect>");
      expect(change).toContain("Mandate: <fully-qualified-mandate-ref>");
      expect(change).toContain("Plan-Revision: <root-ref>@<oid>");
      expect(change).toContain("every later durable commit names a resolved active Meeting");
      expect(change).toContain("No-op, stale, blocked or foreign");
      expect(await Bun.file(resolve(target, "CLAUDE.md")).exists()).toBe(true);
      expect(await Bun.file(resolve(target, "workplace/sources/rooms")).exists()).toBe(false);
      expect(await Bun.file(resolve(target, "workplace/sources/sites")).exists()).toBe(false);
      expect(await Bun.file(resolve(target, "workplace/sources/work")).exists()).toBe(false);
      expect(await Bun.file(resolve(target, "workplace/coordination.json")).exists()).toBe(true);
      expect(await readFile(resolve(target, "workplace/profile.json"), "utf8")).toContain('"kind": "ProfileSelection"');
      expect(await readFile(resolve(target, "workplace/.workplace/definition.json"), "utf8")).toContain('"kind": "WorkplaceDefinition"');
      expect(await readFile(resolve(target, "workplace/LEXICON.md"), "utf8")).toContain("# Lexicon");
      expect(await Bun.file(resolve(target, ".agents/skills/enter/SKILL.md")).exists()).toBe(true);
      expect(await Bun.file(resolve(target, ".agents/skills/maintain/SKILL.md")).exists()).toBe(true);
      expect(await Bun.file(resolve(target, ".agents/skills/onboard/SKILL.md")).exists()).toBe(false);
      expect(await Bun.file(resolve(target, ".agents/skills/settle/SKILL.md")).exists()).toBe(false);
      expect(await readFile(resolve(target, "agents/manager.md"), "utf8")).toContain("Git index");
      expect(await readFile(resolve(target, "agents/worker.md"), "utf8")).toContain("Never: commit");
      expect(await readFile(resolve(target, "workplace/.workplace/coordination.json"), "utf8")).toBe(await readFile(resolve(target, "workplace/coordination.json"), "utf8"));
      expect((await readyWorkplace({ start: target })).changed).toBe(false);

      await rm(resolve(target, ".endroit"), { recursive: true, force: true });
      const withoutLocal = await checkStaticWorkplace({ mount: target });
      expect(withoutLocal.compileStatus).toBe("valid");
      expect(withoutLocal.entryStatus).toBe("onboarding-required");
      expect(await readFile(resolve(target, "FRONTDOOR.md"), "utf8")).toContain("Open a Room");
    } finally {
      await rm(target, { recursive: true, force: true });
    }
  });

  test("refuses wrong consent, existing targets and symlinks without effects", async () => {
    const parent = resolve(tmpdir(), `endroit-new-guard-${crypto.randomUUID()}`);
    const existing = resolve(parent, "existing");
    const linked = resolve(parent, "linked");
    const absent = resolve(parent, "absent");
    await rm(parent, { recursive: true, force: true });
    await mkdir(existing, { recursive: true });
    await writeFile(resolve(existing, "keep.txt"), "keep\n");
    await (symlink as unknown as (target: string, path: string, type: "dir" | "junction") => Promise<void>)(existing, linked, process.platform === "win32" ? "junction" : "dir");
    try {
      const profile = await loadStandardProfile(profilePath);
      const absentPlan = planNewWorkplace(request(absent), { profile, cliCommand });
      let wrong = "";
      try { await applyNewWorkplace(absentPlan, "sha256:wrong"); } catch (error) { wrong = error instanceof Error ? error.message : String(error); }
      expect(wrong).toContain("digest mismatch");
      expect(await Bun.file(absent).exists()).toBe(false);
      for (const target of [existing, linked]) {
        const plan = planNewWorkplace(request(target), { profile, cliCommand });
        let message = "";
        try { await applyNewWorkplace(plan, plan.revision); } catch (error) { message = error instanceof Error ? error.message : String(error); }
        expect(message).toContain("exists or is a symlink");
      }
      expect(await readFile(resolve(existing, "keep.txt"), "utf8")).toBe("keep\n");
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  test("keeps the Mount readable and names the exact unavailable recompilation command", async () => {
    const target = resolve(tmpdir(), `endroit-new-degraded-${crypto.randomUUID()}`);
    const executable = resolve(tmpdir(), `endroit-new-executable-${crypto.randomUUID()}`);
    await rm(target, { recursive: true, force: true });
    await writeFile(executable, "fixture\n");
    try {
      const profile = await loadStandardProfile(profilePath);
      const plan = planNewWorkplace(request(target), { profile, cliCommand: [executable] });
      await applyNewWorkplace(plan, plan.revision);
      await rm(executable, { force: true, recursive: false });
      const checked = await checkWorkplaceMount({ mount: target });
      expect(checked.compileStatus).toBe("valid");
      expect(checked.operationStatus).toBe("degraded");
      expect(checked.requiredAction).toContain(`${JSON.stringify(executable)} "ready"`);
      expect(await readFile(resolve(target, "FRONTDOOR.md"), "utf8")).toContain("Open a Room");
    } finally {
      await rm(target, { recursive: true, force: true });
      await rm(executable, { force: true, recursive: false });
    }
  });

  test("invalidates local projections when a ProviderBinding changes", async () => {
    const target = resolve(tmpdir(), `endroit-new-binding-${crypto.randomUUID()}`);
    await rm(target, { recursive: true, force: true });
    try {
      const profile = await loadStandardProfile(profilePath);
      const plan = planNewWorkplace(request(target), { profile, cliCommand });
      await applyNewWorkplace(plan, plan.revision);
      const bindingPath = resolve(target, ".endroit/providers/codex.json");
      const binding = JSON.parse(await readFile(bindingPath, "utf8")) as { tools: Array<{ availability: string }> };
      binding.tools[0]!.availability = "degraded";
      await writeFile(bindingPath, `${JSON.stringify(binding, null, 2)}\n`);
      const checked = await checkWorkplaceMount({ mount: target });
      expect(checked.compileStatus).toBe("stale");
      expect(checked.operationStatus).toBe("compile-required");
      expect(checked.diagnostics.some((item) => item.code === "binding-revision-stale")).toBe(true);
    } finally {
      await rm(target, { recursive: true, force: true });
    }
  });

  test("marks the build stale when the owned CoordinationPolicy changes", async () => {
    const target = resolve(tmpdir(), `endroit-new-coordination-${crypto.randomUUID()}`);
    await rm(target, { recursive: true, force: true });
    try {
      const profile = await loadStandardProfile(profilePath);
      const plan = planNewWorkplace(request(target), { profile, cliCommand });
      await applyNewWorkplace(plan, plan.revision);
      const path = resolve(target, "workplace/coordination.json");
      const policy = JSON.parse(await readFile(path, "utf8")) as { roles: { main: { owns: string[] } } };
      policy.roles.main.owns.push("explicit escalation");
      await writeFile(path, `${JSON.stringify(policy, null, 2)}\n`);
      const checked = await checkWorkplaceMount({ mount: target });
      expect(checked.compileStatus).toBe("stale");
      expect(checked.operationStatus).toBe("compile-required");
      expect(checked.diagnostics.some((item) => item.code === "source-revision-stale")).toBe(true);
    } finally {
      await rm(target, { recursive: true, force: true });
    }
  });

  test("keeps projections readable and requests the exact pinned Profile Package", async () => {
    const target = resolve(tmpdir(), `endroit-new-profile-${crypto.randomUUID()}`);
    await rm(target, { recursive: true, force: true });
    try {
      const profile = await loadStandardProfile(profilePath);
      const plan = planNewWorkplace(request(target), { profile, cliCommand });
      await applyNewWorkplace(plan, plan.revision);
      const path = resolve(target, "workplace/profile.json");
      const selection = JSON.parse(await readFile(path, "utf8")) as { digest: string };
      selection.digest = "sha256:wrong";
      await writeFile(path, `${JSON.stringify(selection, null, 2)}\n`);
      const checked = await checkWorkplaceMount({ mount: target });
      expect(checked.compileStatus).toBe("unavailable");
      expect(checked.operationStatus).toBe("compile-required");
      expect(checked.diagnostics.some((item) => item.code === "profile-package-unavailable")).toBe(true);
      expect(await readFile(resolve(target, "FRONTDOOR.md"), "utf8")).toContain("Static Workplace Front Door");
      expect((await readyWorkplace({ start: target })).changed).toBe(false);
    } finally { await rm(target, { recursive: true, force: true }); }
  });

  test("uses the compact wordmark only on a suitable TTY", () => {
    expect(renderWordmark({ tty: false })).toBe("");
    expect(renderWordmark({ tty: true, columns: 80, unicode: true })).toContain("┌─┐  ENDROIT");
    expect(renderWordmark({ tty: true, columns: 30, unicode: true })).toBe("ENDROIT — intent → path → outcome");
    expect(renderWordmark({ tty: true, columns: 80, unicode: false })).toBe("ENDROIT — intent → path → outcome");
  });

  test("fails non-interactive creation with the exact Request action and stable JSON", () => {
    const result = Bun.spawnSync([Bun.argv[0]!, resolve(repository, "src/cli.ts"), "new", resolve(tmpdir(), "endroit-new-noninteractive"), "--json"], { cwd: repository, stdout: "pipe", stderr: "pipe" });
    const stdout = new TextDecoder().decode(result.stdout);
    const stderr = new TextDecoder().decode(result.stderr);
    expect(result.exitCode).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).toContain('"error"');
    expect(stderr).toContain("provide --request <file> with --preview or --apply <sha256>");
    expect(stderr).not.toContain("ENDROIT —");
  });

  test("cancels a simulated interactive stream with code-path zero writes", async () => {
    const target = resolve(tmpdir(), `endroit-new-cancel-${crypto.randomUUID()}`);
    await rm(target, { recursive: true, force: true });
    const input = new PassThrough() as PassThrough & { isTTY: boolean; setRawMode(value: boolean): void; emit(event: string, value: string, key: object): void; listenerCount(event: string): number };
    const output = new PassThrough() as PassThrough & { isTTY: boolean; columns: number };
    input.isTTY = true;
    input.setRawMode = () => {};
    output.isTTY = true;
    output.columns = 80;
    const profile = await loadStandardProfile(profilePath);
    const pending = runNewWizard({ target, profile, cliCommand, input, output, gitAuthor: { name: "Fixture", email: "fixture@example.test" } });
    while (input.listenerCount("keypress") === 0) await new Promise((done) => setTimeout(done, 1));
    input.emit("keypress", "\u001b", { name: "escape", sequence: "\u001b" });
    expect(await pending).toBe(undefined);
    expect(await Bun.file(target).exists()).toBe(false);
  });

  test("drives the interactive Clack stream through Preview before declining Apply", async () => {
    const target = resolve(tmpdir(), `endroit-new-interactive-${crypto.randomUUID()}`);
    await rm(target, { recursive: true, force: true });
    const input = new PassThrough() as PassThrough & { isTTY: boolean; setRawMode(value: boolean): void; emit(event: string, value: string, key: object): void; listenerCount(event: string): number };
    const output = new PassThrough() as PassThrough & { isTTY: boolean; columns: number };
    input.isTTY = true;
    input.setRawMode = () => {};
    output.isTTY = true;
    output.columns = 80;
    const profile = await loadStandardProfile(profilePath);
    const pending = runNewWizard({ target, profile, cliCommand, input, output, gitAuthor: { name: "Fixture", email: "fixture@example.test" } });
    const pause = () => new Promise((done) => setTimeout(done, 5));
    const key = (value: string, name = value) => input.emit("keypress", value, { name, sequence: value });
    const answer = async (value = "") => {
      while (input.listenerCount("keypress") === 0) await pause();
      for (const character of value) key(character, character === " " ? "space" : character);
      key("\r", "return");
      await pause();
    };
    await answer("Stream Studio");
    await answer();
    await answer("Alexis");
    await answer();
    await answer();
    await answer();
    await answer();
    await answer();
    await answer();
    await answer();
    await answer();
    expect(await pending).toBe(undefined);
    expect(await Bun.file(target).exists()).toBe(false);
  });
});
