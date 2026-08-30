import { describe, expect, test } from "bun:test";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { applyNewWorkplace, loadStandardProfile, planNewWorkplace, type NewWorkplaceRequest } from "../src/compiler/new-workplace.ts";
import { enterWorkplace } from "../src/federation.ts";
import { applyWorkplaceSetup, planWorkplaceSetup, type WorkplaceSetupRequest } from "../src/setup.ts";

const repository = resolve(import.meta.dir, "..");
const profilePath = resolve(repository, "profiles/standard/profile.json");
const cliCommand = [Bun.argv[0]!, resolve(repository, "src/cli.ts")];

function cli(args: string[]): unknown {
  const result = Bun.spawnSync([...cliCommand, ...args], { cwd: repository, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
  return JSON.parse(new TextDecoder().decode(result.stdout));
}

function newRequest(target: string, id: string): NewWorkplaceRequest {
  return {
    kind: "NewWorkplaceRequest",
    version: 1,
    target,
    workplace: { id, name: `${id} fixture` },
    member: { id: "operator", name: "Fixture Operator", language: "en" },
    desk: { id: "operator", name: "Operator Desk", welcome: { tone: "Direct.", humor: "None.", durableChanges: "Update owned sources only." } },
    providers: [],
    git: { initialize: true, commits: true, author: { name: "Fixture", email: "fixture@example.test" } },
  };
}

async function createWorkplace(target: string, id: string) {
  const profile = await loadStandardProfile(profilePath);
  const plan = planNewWorkplace(newRequest(target, id), { profile, cliCommand });
  return applyNewWorkplace(plan, plan.revision);
}

async function entry(mount: string) {
  return JSON.parse(await readFile(join(mount, ".endroit/entry.json"), "utf8"));
}

function target(workplace: string, mode: "managed" | "external", path: string, entryBinding: unknown, source?: string, required = true): WorkplaceSetupRequest["targets"][number] {
  return {
    workplace,
    relation: workplace === "workplace://peer" ? "link" : "attachment",
    required,
    mount: { mode, path },
    ...(source ? { source } : {}),
    entry: entryBinding as WorkplaceSetupRequest["targets"][number]["entry"],
    providers: [],
  };
}

async function fixture() {
  const root = resolve(tmpdir(), `endroit-setup-test-${crypto.randomUUID()}`);
  await rm(root, { recursive: true, force: true });
  const anchor = await createWorkplace(join(root, "anchor"), "anchor");
  const peer = await createWorkplace(join(root, "peer-source"), "peer");
  await mkdir(join(root, "remotes"), { recursive: true });
  const peerRemote = join(root, "remotes/peer.git");
  const cloned = Bun.spawnSync(["git", "clone", "--bare", "--", peer.roots.shared, peerRemote], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (cloned.exitCode !== 0) throw new Error(new TextDecoder().decode(cloned.stderr));
  await writeFile(join(anchor.mount, "workplace/links.json"), `${JSON.stringify({ kind: "WorkplaceLinks", version: 1, workplace: "workplace://anchor", links: [{ target: "workplace://peer" }] }, null, 2)}\n`);
  return { root, anchor: anchor.mount, peer, peerRemote };
}

describe("portable Workplace setup", () => {
  test("clones a linked peer, adopts a sibling Attachment and is idempotent", async () => {
    const state = await fixture();
    try {
      const external = await createWorkplace(join(state.root, "external"), "external");
      const request: WorkplaceSetupRequest = {
        kind: "WorkplaceSetupRequest",
        version: 1,
        anchor: "workplace://anchor",
        targets: [
          target("workplace://peer", "managed", "checkouts/workplaces/peer", await entry(state.peer.mount), state.peerRemote),
          target("workplace://external", "external", external.mount, await entry(external.mount)),
        ],
      };
      const requestPath = join(state.root, "setup.json");
      await writeFile(requestPath, `${JSON.stringify(request, null, 2)}\n`);
      const preview = cli(["workplace", "setup", state.anchor, "--from", requestPath, "--preview", "--json"]) as Awaited<ReturnType<typeof planWorkplaceSetup>>;
      expect(preview.targets.map((item) => item.action)).toEqual(["clone", "adopt"]);
      const receipt = cli(["workplace", "setup", state.anchor, "--from", requestPath, "--apply", preview.revision, "--json"]) as Awaited<ReturnType<typeof applyWorkplaceSetup>>;
      expect(receipt.status).toBe("ready");
      expect(receipt.targets.map((item) => item.status)).toEqual(["adopted", "cloned"]);

      const peer = await enterWorkplace({ anchorMount: state.anchor, target: "workplace://peer" });
      const attached = await enterWorkplace({ anchorMount: state.anchor, target: "workplace://external" });
      expect(peer.realpath).toBe(await realpath(resolve(state.anchor, "checkouts/workplaces/peer")));
      expect(attached.realpath).toBe(await realpath(external.mount));
      expect(await readFile(peer.frontDoor, "utf8")).not.toContain("workplace://external");

      const replay = cli(["workplace", "setup", state.anchor, "--from", requestPath, "--preview", "--json"]) as Awaited<ReturnType<typeof planWorkplaceSetup>>;
      expect(replay.targets.every((item) => item.action === "verify")).toBe(true);
      const replayReceipt = cli(["workplace", "setup", state.anchor, "--from", requestPath, "--apply", replay.revision, "--json"]) as Awaited<ReturnType<typeof applyWorkplaceSetup>>;
      expect(replayReceipt.targets.every((item) => item.status === "unchanged")).toBe(true);
    } finally {
      await rm(state.root, { recursive: true, force: true });
    }
  });

  test("rolls back the Binding and created Mount when Anchor readiness fails", async () => {
    const state = await fixture();
    try {
      const request: WorkplaceSetupRequest = {
        kind: "WorkplaceSetupRequest",
        version: 1,
        anchor: "workplace://anchor",
        targets: [target("workplace://peer", "managed", "checkouts/workplaces/peer", await entry(state.peer.mount), state.peerRemote)],
      };
      const preview = await planWorkplaceSetup(request, { anchorMount: state.anchor, requestDirectory: state.root });
      await writeFile(join(state.anchor, "workplace/composition.json"), "not-json\n");
      let message = "";
      try { await applyWorkplaceSetup(preview, preview.revision); }
      catch (error) { message = error instanceof Error ? error.message : String(error); }
      expect(message).toContain("invalid JSON");
      expect(await Bun.file(join(state.anchor, "checkouts/workplaces/peer")).exists()).toBe(false);
      expect(await Bun.file(join(state.anchor, ".endroit/workplaces.json")).exists()).toBe(false);
    } finally {
      await rm(state.root, { recursive: true, force: true });
    }
  });

  test("keeps an unavailable optional Attachment out of local bindings", async () => {
    const state = await fixture();
    try {
      const missingEntry = { kind: "EntryBinding", workplace: "workplace://optional", member: "workplace://optional/member/operator", desk: "workplace://optional/desk/operator", rootBindings: { shared: "workplace" } };
      const request: WorkplaceSetupRequest = { kind: "WorkplaceSetupRequest", version: 1, anchor: "workplace://anchor", targets: [target("workplace://optional", "external", join(state.root, "optional"), missingEntry, undefined, false)] };
      const preview = await planWorkplaceSetup(request, { anchorMount: state.anchor, requestDirectory: state.root });
      const receipt = await applyWorkplaceSetup(preview, preview.revision);
      expect(receipt.status).toBe("partial");
      expect(receipt.targets[0]?.status).toBe("unavailable");
      expect(await Bun.file(join(state.anchor, ".endroit/workplaces.json")).exists()).toBe(false);

      const credentialed = { ...request, targets: [{ ...request.targets[0]!, source: "https://secret@example.test/private.git" }] };
      let message = "";
      try { await planWorkplaceSetup(credentialed, { anchorMount: state.anchor, requestDirectory: state.root }); }
      catch (error) { message = error instanceof Error ? error.message : String(error); }
      expect(message).toContain("must not embed credentials");
    } finally {
      await rm(state.root, { recursive: true, force: true });
    }
  });

  test("preserves a divergent existing Mount and rejects its identity", async () => {
    const state = await fixture();
    try {
      const wrongFamily: WorkplaceSetupRequest = {
        kind: "WorkplaceSetupRequest", version: 1, anchor: "workplace://anchor",
        targets: [target("workplace://peer", "managed", "checkouts/sites/peer", await entry(state.peer.mount), state.peerRemote)],
      };
      let family = "";
      try { await planWorkplaceSetup(wrongFamily, { anchorMount: state.anchor, requestDirectory: state.root }); }
      catch (error) { family = error instanceof Error ? error.message : String(error); }
      expect(family).toContain("must be checkouts/workplaces/peer");
      expect(await Bun.file(join(state.anchor, ".endroit/workplaces.json")).exists()).toBe(false);

      const existing = await createWorkplace(join(state.root, "existing"), "other");
      const expectedEntry = { kind: "EntryBinding", workplace: "workplace://expected", member: "workplace://expected/member/operator", desk: "workplace://expected/desk/operator", rootBindings: { shared: "workplace" } };
      const adoption: WorkplaceSetupRequest = { kind: "WorkplaceSetupRequest", version: 1, anchor: "workplace://anchor", targets: [target("workplace://expected", "external", existing.mount, expectedEntry)] };
      const preview = await planWorkplaceSetup(adoption, { anchorMount: state.anchor, requestDirectory: state.root });
      let identity = "";
      try { await applyWorkplaceSetup(preview, preview.revision); }
      catch (error) { identity = error instanceof Error ? error.message : String(error); }
      expect(identity).toContain("resolves to another Workplace");
      expect(await Bun.file(join(state.anchor, ".endroit/workplaces.json")).exists()).toBe(false);

      const collision = { ...adoption, targets: [{ ...adoption.targets[0]!, source: state.peerRemote }] };
      let existingBytes = "";
      try { await planWorkplaceSetup(collision, { anchorMount: state.anchor, requestDirectory: state.root }); }
      catch (error) { existingBytes = error instanceof Error ? error.message : String(error); }
      expect(existingBytes).toContain("setup never overwrites it");
    } finally {
      await rm(state.root, { recursive: true, force: true });
    }
  });
});
