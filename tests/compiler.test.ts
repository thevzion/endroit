import { describe, expect, test } from "bun:test";
import { cp, lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  KERNEL_PRIMITIVES,
  checkStaticWorkplace,
  checkWorkplaceMount,
  compileWorkplaceMount,
  compileStaticWorkplace,
  discoverMount,
  loadCompileInput,
  parseCoordinationPolicy,
  parseSourceEnvelope,
  readyWorkplace,
  validateCoordinationPolicy,
  validateProfile,
} from "../src/compiler/index.ts";
import type { Profile } from "../src/compiler/model.ts";
import { previewAdoption } from "../src/compiler/adoption.ts";
import { loadProfilePackage } from "../src/compiler/profile-package.ts";

const repository = resolve(import.meta.dir, "..");
const profilePath = resolve(repository, "profiles/standard/profile.json");
const alternativePath = resolve(repository, "examples/field-lab/profile.json");
const world = resolve(repository, "examples/flappy/world");
const config = resolve(world, "workplace/workplace.json");
const entry = resolve(world, "bindings/entry.json");
const provider = resolve(world, "bindings/provider.codex.json");

async function json<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function temporary(): Promise<string> {
  const path = resolve(tmpdir(), `endroit-static-test-${crypto.randomUUID()}`);
  await rm(path, { recursive: true, force: true });
  return path;
}

describe("static Workplace compiler", () => {
  test("keeps the generic kernel and Profile vocabularies separate", async () => {
    expect(KERNEL_PRIMITIVES).toEqual([
      "Root", "Ref", "Revision", "Node", "Relation", "Role", "Slot",
      "Source", "Projection", "Constraint",
    ]);
    const standard = (await loadProfilePackage(profilePath)).profile;
    const alternative = await json<Profile>(alternativePath);
    validateProfile(standard);
    validateProfile(alternative);
    expect(Object.keys(standard.entities).sort()).toEqual(["agent", "material", "meeting", "member", "place", "work"]);
    expect(Object.keys(alternative.entities).sort()).toEqual(["experiment", "instrument", "researcher", "specimen", "zone"]);
  });

  test("validates the closed owned CoordinationPolicy", async () => {
    const workplace = "workplace://demo/smallest";
    const policy = await json<Record<string, unknown>>(resolve(repository, "examples/smallest/world/workplace/coordination.json"));
    expect(validateCoordinationPolicy(policy, workplace).ref).toBe(`${workplace}/coordination`);
    expect(() => validateCoordinationPolicy({ ...policy, unknown: true }, workplace)).toThrow("unknown fields");
    const bytes = await readFile(resolve(repository, "examples/smallest/world/workplace/coordination.json"), "utf8");
    expect(() => parseCoordinationPolicy(bytes.replace('"version": 1,', '"version": 1,\n  "version": 1,'), workplace)).toThrow("Map keys must be unique");
    const invalid = structuredClone(policy) as { resolution: Array<{ sequence: string[] }> };
    invalid.resolution[1]!.sequence = ["main", "manager", "main"];
    expect(() => validateCoordinationPolicy(invalid, workplace)).toThrow("invalid sequence");
  });

  test("compiles smallest, rich and Flappy through the same generic path", async () => {
    const root = await temporary();
    try {
      for (const fixture of ["smallest", "rich", "flappy"]) {
        const workplacePath = resolve(repository, `examples/${fixture}/world/workplace/workplace.json`);
        const input = await loadCompileInput({ profilePath, workplacePath });
        const result = await compileStaticWorkplace(input, { outDir: resolve(root, fixture) });
        expect((await checkStaticWorkplace({ root: result.root })).compileStatus).toBe("valid");
      }
      const fieldLab = await loadCompileInput({
        profilePath: alternativePath,
        workplacePath: resolve(repository, "examples/field-lab/world/workplace/workplace.json"),
      });
      const alternative = await compileStaticWorkplace(fieldLab, { outDir: resolve(root, "field-lab") });
      expect((await checkStaticWorkplace({ root: alternative.root })).compileStatus).toBe("valid");
      expect(await readFile(resolve(alternative.root, "scopes/zone/north/FRONTDOOR.md"), "utf8")).toContain("Inspect trial");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("does not absorb an ancestor Site Git history into embedded example Roots", async () => {
    const result = await checkWorkplaceMount({ mount: resolve(repository, "examples/smallest/world") });
    expect(result.compileStatus).toBe("valid");
    expect(result.operationStatus).toBe("pending");
  });

  test("compiles neutral and bound static entries progressively", async () => {
    const root = await temporary();
    try {
      const neutralInput = await loadCompileInput({ profilePath, workplacePath: config, providerPath: provider });
      const neutral = await compileStaticWorkplace(neutralInput, { outDir: resolve(root, "neutral") });
      expect(neutral.status).toBe("onboarding-required");
      expect((await checkStaticWorkplace({ root: neutral.root })).operationStatus).toBe("pending");
      expect(await readFile(resolve(neutral.root, "AGENTS.md"), "utf8")).toContain("room/product");
      expect(await readFile(resolve(neutral.root, "AGENTS.md"), "utf8")).toContain("Resident operating contract");
      expect(await readFile(resolve(neutral.root, "AGENTS.md"), "utf8")).toContain("Product bytes and Git");
      expect(await readFile(resolve(neutral.root, "AGENTS.md"), "utf8")).toContain("Qualify the twist before building");
      expect(await readFile(resolve(neutral.root, "AGENTS.md"), "utf8")).not.toContain("This ordinary file is a compiled adapter");
      expect(await readFile(resolve(neutral.root, "AGENTS.md"), "utf8")).not.toContain("site/flappy-bird");
      expect(await readFile(resolve(neutral.root, "AGENTS.md"), "utf8")).toContain("Provider coordination status: **available**");
      expect(await readFile(resolve(neutral.root, "AGENTS.md"), "utf8")).not.toContain("Manager coordination contract");
      expect(neutral.files).toContain("agents/manager.md");
      expect(neutral.files).toContain("agents/worker.md");
      expect(neutral.files).not.toContain("MAIN.md");
      expect(await readFile(resolve(neutral.root, "agents/manager.md"), "utf8")).toContain("own the Git index");
      expect(await readFile(resolve(neutral.root, "agents/worker.md"), "utf8")).toContain("Never: commit; dispatch; human contact; scope expansion");
      expect(await readFile(resolve(neutral.root, "rooms/product/AGENTS.md"), "utf8")).not.toContain("Manager contract");
      expect(await readFile(resolve(neutral.root, "work/flappy-bird/AGENTS.md"), "utf8")).toContain("Manager contract");
      expect(await readFile(resolve(neutral.root, "sites/flappy-bird/AGENTS.md"), "utf8")).toContain("Worker contract");
      expect(await readFile(resolve(neutral.root, "rooms/product/AGENTS.md"), "utf8")).toContain("methods/study.md");
      expect(await readFile(resolve(neutral.root, "rooms/product/AGENTS.md"), "utf8")).toContain("meeting/flappy-qualification");
      expect(await readFile(resolve(neutral.root, "rooms/product/meetings/flappy-qualification/FRONTDOOR.md"), "utf8")).toContain("Closing this Meeting never completes its Work");
      expect(await readFile(resolve(neutral.root, "rooms/product/methods/study.md"), "utf8")).toContain("It is not a resident Skill");
      const openWork = await readFile(resolve(neutral.root, "rooms/product/methods/open-work.md"), "utf8");
      expect(openWork).toContain("workplace/.workplace/source-contracts/WORK.md");
      expect(openWork).toContain("workplace/.workplace/source-contracts/SITE.md");
      expect(openWork).toContain("open-work(work:<work-id>): declare bounded Work and Site route");
      expect(openWork).toContain("open-work(site:<site-id>): implement <observed-effect>");
      expect(openWork).toContain("record verified Outcome candidate");
      expect(openWork).toContain("A delegated Worker returns changed paths and proof without committing");
      expect(neutral.files.filter((path) => path.startsWith(".agents/skills/")).sort()).toEqual([
        ".agents/skills/onboard/SKILL.md",
      ]);
      expect(await readFile(resolve(neutral.root, ".agents/skills/onboard/SKILL.md"), "utf8")).toContain("adoption as an internal");
      expect(neutral.files.some((path) => path.endsWith("package.json"))).toBe(false);
      expect(neutral.files).not.toContain("methods/open-room.md");

      const boundInput = await loadCompileInput({ profilePath, workplacePath: config, entryPath: entry, providerPath: provider });
      const bound = await compileStaticWorkplace(boundInput, { outDir: resolve(root, "bound") });
      expect((await checkStaticWorkplace({ root: bound.root })).operationStatus).toBe("ready");
      expect(await readFile(resolve(bound.root, ".endroit/projection-manifest.json"), "utf8")).toContain('"entryStatus": "bound"');
      const boundAgents = await readFile(resolve(bound.root, "AGENTS.md"), "utf8");
      expect(boundAgents).toContain("Reception · bound Member Card");
      expect(boundAgents).toContain("Welcome from the bound Desk");
      expect(boundAgents).toContain("provider memory");
      expect(boundAgents).not.toBe(await readFile(resolve(neutral.root, "AGENTS.md"), "utf8"));
      for (const path of neutral.files.filter((candidate) => candidate.startsWith("workplace/"))) {
        expect(await readFile(resolve(bound.root, path), "utf8")).toBe(await readFile(resolve(neutral.root, path), "utf8"));
      }
      expect(await readFile(resolve(bound.root, "workplace/.workplace/workplace-map.json"), "utf8")).not.toContain("checkouts/desks");
      expect((await lstat(resolve(bound.root, "AGENTS.md"))).isSymbolicLink()).toBe(false);
      expect((await lstat(resolve(bound.root, "FRONTDOOR.md"))).isSymbolicLink()).toBe(false);
      expect(bound.files).not.toContain("CLAUDE.md");
      expect(bound.files.filter((path) => path.startsWith(".agents/skills/")).sort()).toEqual([
        ".agents/skills/enter/SKILL.md",
        ".agents/skills/maintain/SKILL.md",
        ".agents/skills/settle/SKILL.md",
      ]);
      expect(await readFile(resolve(bound.root, ".agents/skills/settle/SKILL.md"), "utf8")).toContain("Prepare Site effects separately");
      const openRoom = await readFile(resolve(bound.root, "methods/open-room.md"), "utf8");
      expect(openRoom).toContain("workplace/.workplace/source-contracts/ROOM.md");
      expect(openRoom).toContain("workplace/.workplace/source-contracts/MEETING.md");
      expect(await readFile(resolve(bound.root, "workplace/.workplace/source-contracts/ROOM.md"), "utf8")).toContain("ref: {{ROOM_REF}}");
      const definition = await readFile(resolve(bound.root, "workplace/.workplace/definition.json"), "utf8");
      expect(definition).toContain('"sourceContracts"');
      expect(definition).toContain('"templateRevision": "sha256:');
      const portableManifest = await readFile(resolve(bound.root, "workplace/.workplace/projection-manifest.json"), "utf8");
      expect(portableManifest).toContain('"path": "workplace/.workplace/source-contracts/ROOM.md"');
      expect(portableManifest).toContain('"consumers": [\n        "open-room"');
      expect(portableManifest).toContain('"revision": "sha256:');
      await rm(resolve(bound.root, ".endroit"), { recursive: true, force: true });
      const withoutLocalState = await checkStaticWorkplace({ root: bound.root });
      expect(withoutLocalState.compileStatus).toBe("valid");
      expect(withoutLocalState.entryStatus).toBe("onboarding-required");
      expect(await readFile(resolve(bound.root, "rooms/product/AGENTS.md"), "utf8")).toContain("Study");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("emits only explicitly bound provider surfaces", async () => {
    const root = await temporary();
    try {
      const neutralInput = await loadCompileInput({ profilePath, workplacePath: config });
      const neutral = await compileStaticWorkplace(neutralInput, { outDir: resolve(root, "neutral") });
      expect(neutral.files).toContain("FRONTDOOR.md");
      expect(neutral.files).not.toContain("AGENTS.md");
      expect(neutral.files).not.toContain("CLAUDE.md");
      expect(neutral.files.some((path) => path.startsWith(".agents/skills/"))).toBe(false);
      expect(neutral.files).toContain("agents/manager.md");
      expect(await readFile(resolve(neutral.root, ".endroit/coordination-ir.json"), "utf8")).toContain('"status": "neutral"');

      let blocked = "";
      try {
        await loadCompileInput({ profilePath, workplacePath: config, entryPath: entry, providerPath: resolve(world, "bindings/provider.claude.json") });
      } catch (error) { blocked = error instanceof Error ? error.message : String(error); }
      expect(blocked).toContain("qualified Manager and Worker");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("is byte-reproducible and detects a stale projection", async () => {
    const root = await temporary();
    try {
      const input = await loadCompileInput({ profilePath, workplacePath: config, entryPath: entry, providerPath: provider });
      const first = await compileStaticWorkplace(input, { outDir: resolve(root, "first") });
      const second = await compileStaticWorkplace(input, { outDir: resolve(root, "second") });
      expect(first.files).toEqual(second.files);
      for (const path of first.files) {
        expect(await readFile(resolve(first.root, path), "utf8")).toBe(await readFile(resolve(second.root, path), "utf8"));
      }
      await writeFile(resolve(first.root, "rooms/product/AGENTS.md"), "stale\n");
      const checked = await checkStaticWorkplace({ root: first.root });
      expect(checked.compileStatus).toBe("stale");
      expect(checked.operationStatus).toBe("degraded");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects directory-plausible placement that violates its Slot", async () => {
    const input = await loadCompileInput({ profilePath, workplacePath: config });
    const material = input.sources.find((source) => source.envelope.entity === "material");
    if (!material) throw new Error("fixture has no Material");
    material.envelope.slot = "room-work";
    const root = await temporary();
    try {
      let message = "";
      try {
        await compileStaticWorkplace(input, { outDir: root });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toContain("is not accepted by Slot room-work");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("fails closed when integration lacks structural coordination proof", async () => {
    const input = await loadCompileInput({ profilePath, workplacePath: config });
    const meeting = input.sources.find((source) => source.envelope.ref === "workplace://demo/flappy-studio/meeting/flappy-qualification");
    if (!meeting) throw new Error("fixture has no Meeting");
    meeting.envelope.occupants = meeting.envelope.occupants?.filter((occupant) => occupant.role !== "manager");
    const root = await temporary();
    try {
      let message = "";
      try { await compileStaticWorkplace(input, { outDir: root }); }
      catch (error) { message = error instanceof Error ? error.message : String(error); }
      expect(message).toContain("Manager and Worker proof");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("rejects hostile YAML features and unknown source fields", () => {
    const prefix = `ref: workplace://demo/member/alexis
entity: member
roles: [owner]
owner: workplace://demo/member/alexis
scope: workplace://demo
summary: Human owner
when: [Ownership matters]
relations: {}
`;
    const hostile = [
      `${prefix}summary: duplicate\n`,
      `${prefix}label: &name Alexis\nlanguage: *name\n`,
      `${prefix}label: !private Alexis\n`,
      `%YAML 1.2\n${prefix}`,
      `${prefix}unknown: value\n`,
      `${prefix}__proto__: polluted\n`,
    ];
    for (const metadata of hostile) {
      expect(() => parseSourceEnvelope(`---\n${metadata}---\n\n# Member\n`)).toThrow();
    }
    expect(() => parseSourceEnvelope(`---\n${prefix}---\n---\n# second document\n`)).toThrow("multiple YAML documents");
  });

  test("gives semantic text one LF revision while preserving its canonical bytes", () => {
    const lf = `---\nref: workplace://demo/member/operator\nentity: member\nowner: workplace://demo/member/operator\nscope: workplace://demo\nsummary: Human owner\nwhen: [Ownership matters]\nrelations: {}\n---\n# Member\n`;
    const crlf = lf.replaceAll("\n", "\r\n");
    expect(parseSourceEnvelope(crlf).revision).toBe(parseSourceEnvelope(lf).revision);
    expect(parseSourceEnvelope(crlf).bytes).toBe(lf);
  });

  test("rejects a WELCOME body above the resident context budget", async () => {
    const input = await loadCompileInput({ profilePath, workplacePath: config, entryPath: entry, providerPath: provider });
    const welcome = input.sources.find((source) => (source.envelope.roles ?? []).includes("welcome"));
    if (!welcome) throw new Error("fixture has no WELCOME");
    welcome.body = `# Welcome\n\n${"x".repeat(4097)}`;
    const root = await temporary();
    try {
      let message = "";
      try {
        await compileStaticWorkplace(input, { outDir: root });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toContain("WELCOME body exceeds 4 KiB");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("fails closed when resident policy is missing or over budget", async () => {
    const root = await temporary();
    try {
      const missing = await loadCompileInput({ profilePath, workplacePath: config, providerPath: provider });
      const missingDoctrine = missing.sources.find((source) => (source.envelope.roles ?? []).includes("doctrine"));
      if (!missingDoctrine) throw new Error("fixture has no Doctrine");
      missingDoctrine.body = "# Doctrine\n\nDeferred detail only.";
      let message = "";
      try {
        await compileStaticWorkplace(missing, { outDir: resolve(root, "missing") });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toContain("must contain one non-empty ## Resident section");

      const oversized = await loadCompileInput({ profilePath, workplacePath: config, providerPath: provider });
      const oversizedDoctrine = oversized.sources.find((source) => (source.envelope.roles ?? []).includes("doctrine"));
      if (!oversizedDoctrine) throw new Error("fixture has no Doctrine");
      oversizedDoctrine.body = `# Doctrine\n\n## Resident\n\n${"x".repeat(oversized.profile.disclosures.limits.maxResidentBytes + 1)}`;
      message = "";
      try {
        await compileStaticWorkplace(oversized, { outDir: resolve(root, "oversized") });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toContain("resident operating contract exceeds Profile limit");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("renders the rich Member directory and read-only Keyring", async () => {
    const root = await temporary();
    try {
      const input = await loadCompileInput({
        profilePath,
        workplacePath: resolve(repository, "examples/rich/world/workplace/workplace.json"),
        entryPath: resolve(repository, "examples/rich/world/bindings/entry.json"),
        providerPath: resolve(repository, "examples/rich/world/bindings/provider.codex.json"),
      });
      const compiled = await compileStaticWorkplace(input, { outDir: root });
      const agents = await readFile(resolve(compiled.root, "AGENTS.md"), "utf8");
      expect(agents).toContain("[Mira]");
      expect(agents).toContain("Key to [Sam Desk]");
      expect(agents).toContain("no filesystem access, mutation, Mandate or Authority");
      expect(agents).not.toContain("Treat all durable changes as proposals for Sam");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a removed Key changes only its dependent local neighborhood", async () => {
    const root = await temporary();
    try {
      const options = {
        profilePath,
        workplacePath: resolve(repository, "examples/rich/world/workplace/workplace.json"),
        entryPath: resolve(repository, "examples/rich/world/bindings/entry.json"),
        providerPath: resolve(repository, "examples/rich/world/bindings/provider.codex.json"),
      };
      const beforeInput = await loadCompileInput(options);
      const before = await compileStaticWorkplace(beforeInput, { outDir: resolve(root, "before") });
      const afterInput = await loadCompileInput(options);
      const index = afterInput.sources.findIndex((source) => source.envelope.ref === "workplace://demo/rich-studio/desk/sam");
      const desk = afterInput.sources[index];
      if (!desk) throw new Error("fixture has no Sam Desk");
      afterInput.sources[index] = {
        ...parseSourceEnvelope(desk.bytes.replace("  admits: [workplace://demo/rich-studio/member/alexis]\n", ""), desk.relativePath),
        root: desk.root,
        mountPath: desk.mountPath,
      };
      const after = await compileStaticWorkplace(afterInput, { outDir: resolve(root, "after") });
      expect(await readFile(resolve(before.root, "AGENTS.md"), "utf8")).not.toBe(await readFile(resolve(after.root, "AGENTS.md"), "utf8"));
      expect(await readFile(resolve(before.root, "desks/sam/AGENTS.md"), "utf8")).not.toBe(await readFile(resolve(after.root, "desks/sam/AGENTS.md"), "utf8"));
      expect(await readFile(resolve(before.root, "rooms/lab/AGENTS.md"), "utf8")).toBe(await readFile(resolve(after.root, "rooms/lab/AGENTS.md"), "utf8"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("ready rebuilds only stale local projections and leaves the Site untouched", async () => {
    const root = await temporary();
    await cp(world, root, { recursive: true });
    try {
      const workplacePath = resolve(root, "workplace/workplace.json");
      const workplace = await json<Record<string, unknown>>(workplacePath);
      (workplace.profile as Record<string, unknown>).path = profilePath;
      await writeFile(workplacePath, `${JSON.stringify(workplace, null, 2)}\n`);
      await mkdir(resolve(root, ".endroit"), { recursive: true });
      await writeFile(resolve(root, ".endroit/entry.json"), await readFile(resolve(root, "bindings/entry.json"), "utf8"));
      await mkdir(resolve(root, ".endroit/providers"), { recursive: true });
      await writeFile(resolve(root, ".endroit/providers/codex.json"), await readFile(resolve(root, "bindings/provider.codex.json"), "utf8"));
      const withoutPresence = await checkWorkplaceMount({ mount: root });
      expect(withoutPresence.operationStatus).toBe("degraded");
      expect(withoutPresence.diagnostics.some((item) => item.code === "coordination-presence-missing")).toBe(true);
      await mkdir(resolve(root, ".endroit/meetings/fixture"), { recursive: true });
      await writeFile(resolve(root, ".endroit/meetings/fixture/presence.json"), `${JSON.stringify({ kind: "MeetingPresence", version: 1, id: "fixture", workplace: "workplace://demo/flappy-studio", sessionDigest: "fixture-digest", lifecycle: "active", intent: "Qualify Flappy", meetingRef: "workplace://demo/flappy-studio/meeting/flappy-qualification", createdAt: "2026-08-25T12:00:00.000Z", updatedAt: "2026-08-25T12:00:00.000Z" }, null, 2)}\n`);
      const siteReadme = resolve(root, "checkouts/sites/flappy-bird/README.md");
      const siteFiles = [siteReadme, resolve(root, "checkouts/sites/flappy-bird/SPEC.md"), resolve(root, "checkouts/sites/flappy-bird/CONTRIBUTING.md")];
      const beforeSite = await Promise.all(siteFiles.map((path) => readFile(path, "utf8")));

      const first = await readyWorkplace({ start: resolve(root, "workplace/sources/rooms/product") });
      expect(first.changed).toBe(true);
      expect(first.check.operationStatus).toBe("ready");
      const second = await readyWorkplace({ start: root });
      expect(second.changed).toBe(false);

      const welcome = resolve(root, "checkouts/desks/alexis/WELCOME.md");
      await writeFile(welcome, `${await readFile(welcome, "utf8")}\nRemember concise jokes.\n`);
      expect((await checkWorkplaceMount({ mount: root })).operationStatus).toBe("compile-required");
      const rebuilt = await readyWorkplace({ start: root });
      expect(rebuilt.changed).toBe(true);
      expect(await readFile(resolve(root, "AGENTS.md"), "utf8")).toContain("Remember concise jokes.");
      expect(await Promise.all(siteFiles.map((path) => readFile(path, "utf8")))).toEqual(beforeSite);
      expect(await Bun.file(resolve(root, "site")).exists()).toBe(false);

      await rm(resolve(root, ".endroit"), { recursive: true, force: true });
      const withoutLocalState = await checkWorkplaceMount({ mount: root });
      expect(withoutLocalState.entryStatus).toBe("onboarding-required");
      expect(await readFile(resolve(root, "AGENTS.md"), "utf8")).toContain("Remember concise jokes.");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("discovers the Mount from the shared Root and sovereign Site", async () => {
    const root = await temporary();
    await cp(world, root, { recursive: true });
    try {
      expect(await discoverMount(resolve(root, "workplace/sources/rooms/product"))).toBe(root);
      expect(await discoverMount(resolve(root, "checkouts/sites/flappy-bird"))).toBe(root);
      await rm(resolve(root, "workplace/.workplace"), { recursive: true, force: true });
      await rm(resolve(root, "workplace/WORKPLACE.md"), { recursive: false, force: true });
      const workplacePath = resolve(root, "workplace/workplace.json");
      const workplace = await json<Record<string, unknown>>(workplacePath);
      (workplace.profile as Record<string, unknown>).path = profilePath;
      await writeFile(workplacePath, `${JSON.stringify(workplace, null, 2)}\n`);
      const ready = await readyWorkplace({ start: resolve(root, "checkouts/sites/flappy-bird") });
      expect(ready.mount).toBe(root);
      expect(ready.check.entryStatus).toBe("onboarding-required");
      expect(await Bun.file(resolve(root, "FRONTDOOR.md")).exists()).toBe(true);
      expect(await Bun.file(resolve(root, "AGENTS.md")).exists()).toBe(false);
      expect(await Bun.file(resolve(root, "site")).exists()).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("tracks .workplaceignore and fails when it hides a required source", async () => {
    const root = await temporary();
    await cp(world, root, { recursive: true });
    try {
      const workplacePath = resolve(root, "workplace/workplace.json");
      const workplace = await json<Record<string, unknown>>(workplacePath);
      (workplace.profile as Record<string, unknown>).path = profilePath;
      await writeFile(workplacePath, `${JSON.stringify(workplace, null, 2)}\n`);
      await mkdir(resolve(root, "workplace/sources/ignored"), { recursive: true });
      const hidden = `---\nref: workplace://demo/flappy-studio/material/hidden\nentity: material\nroles: [evidence]\nslot: room-material\nowner: workplace://demo/flappy-studio/member/alexis\nscope: workplace://demo/flappy-studio/room/product\nsummary: Hidden evidence\nwhen: [Never implicitly.]\nrelations:\n  contained-by: [workplace://demo/flappy-studio/room/product]\n---\n\n# Hidden evidence\n`;
      await writeFile(resolve(root, "workplace/sources/ignored/hidden.md"), hidden);
      await writeFile(resolve(root, "workplace/.workplaceignore"), "sources/ignored/\n");
      await rm(resolve(root, "workplace/.workplace"), { recursive: true, force: true });
      await rm(resolve(root, "workplace/WORKPLACE.md"), { recursive: false, force: true });
      await compileWorkplaceMount({ mount: root });
      await writeFile(resolve(root, "workplace/.workplaceignore"), "sources/ignored/\n# changed\n");
      expect((await checkWorkplaceMount({ mount: root })).operationStatus).toBe("compile-required");

      const roomPath = resolve(root, "workplace/sources/rooms/product/ROOM.md");
      const room = await readFile(roomPath, "utf8");
      await writeFile(roomPath, room.replace("  supported-by:\n", "  supported-by:\n    - workplace://demo/flappy-studio/material/hidden\n"));
      let message = "";
      try {
        await loadCompileInput({ workplacePath });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toContain("points outside the Instance");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("refuses a non-owned adapter collision", async () => {
    const root = await temporary();
    await cp(world, root, { recursive: true });
    try {
      const workplacePath = resolve(root, "workplace/workplace.json");
      const workplace = await json<Record<string, unknown>>(workplacePath);
      (workplace.profile as Record<string, unknown>).path = profilePath;
      await writeFile(workplacePath, `${JSON.stringify(workplace, null, 2)}\n`);
      await mkdir(resolve(root, ".endroit/providers"), { recursive: true });
      await writeFile(resolve(root, ".endroit/providers/codex.json"), await readFile(resolve(root, "bindings/provider.codex.json"), "utf8"));
      await writeFile(resolve(root, "AGENTS.md"), "# Human-owned instructions\n");
      let message = "";
      try {
        await compileWorkplaceMount({ mount: root, entryPath: "bindings/entry.json", provider: "codex" });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toContain("non-owned projection collision");
      expect(await readFile(resolve(root, "AGENTS.md"), "utf8")).toBe("# Human-owned instructions\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("previews brownfield adoption without mutating or absorbing the Site", async () => {
    const source = resolve(repository, "examples/brownfield/source");
    const before = await readFile(resolve(source, "README.md"), "utf8");
    const root = await temporary();
    try {
      const first = await previewAdoption({ source, outDir: resolve(root, "first") });
      const second = await previewAdoption({ source, outDir: resolve(root, "second") });
      expect(first.revision).toBe(second.revision);
      expect(await readFile(resolve(first.outDir, "WORKPLACE-PREVIEW.md"), "utf8")).toContain("Preview without Apply is a valid Outcome");
      expect(await readFile(resolve(first.outDir, "preview-manifest.json"), "utf8")).toContain("bind-sovereign-site; do-not-copy-or-absorb");
      expect(await readFile(resolve(source, "README.md"), "utf8")).toBe(before);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
