import { describe, expect, test } from "bun:test";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { checkWorkplaceMount, readyWorkplace } from "../src/compiler/index.ts";
import {
  deriveWorkplaceRegistry,
  enterWorkplace,
  resolveOwner,
  resolveOwnerOperations,
  resolveWorkplaceMount,
} from "../src/federation.ts";

const repository = resolve(import.meta.dir, "..");
const fixtures = resolve(repository, "examples/federation");
const profilePath = resolve(repository, "profiles/standard/profile.json");

async function temporary(): Promise<string> {
  const root = resolve("/tmp", `endroit-federation-test-${crypto.randomUUID()}`);
  await rm(root, { recursive: true, force: true });
  return root;
}

async function materialize(): Promise<{ root: string; anchor: string; peer: string; restricted: string }> {
  const root = await temporary();
  for (const id of ["anchor", "peer", "restricted"]) {
    await cp(resolve(fixtures, id), resolve(root, id), { recursive: true });
    const world = resolve(root, id, "world");
    await mkdir(resolve(world, ".endroit/providers"), { recursive: true });
    await cp(resolve(world, "bindings/entry.json"), resolve(world, ".endroit/entry.json"), { recursive: false });
    await cp(resolve(world, "bindings/provider.codex.json"), resolve(world, ".endroit/providers/codex.json"), { recursive: false });
  }
  const anchor = resolve(root, "anchor/world");
  const peer = resolve(root, "peer/world");
  const restricted = resolve(root, "restricted/world");
  await cp(resolve(anchor, "bindings/workplaces.json"), resolve(anchor, ".endroit/workplaces.json"), { recursive: false });
  for (const world of [peer, restricted, anchor]) {
    const result = await readyWorkplace({ start: world, provider: "codex", profilePath });
    expect(result.check.operationStatus).toBe("ready");
  }
  return { root, anchor, peer, restricted };
}

async function filesBelow(root: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...await filesBelow(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

async function errorCode(effect: Promise<unknown>): Promise<string | undefined> {
  try {
    await effect;
    return undefined;
  } catch (error) {
    return error && typeof error === "object" && "code" in error ? String(error.code) : undefined;
  }
}

describe("owner-scoped Workplace federation", () => {
  test("derives minimal adjacency and enters separate target Front Doors", async () => {
    const state = await materialize();
    try {
      const registry = await deriveWorkplaceRegistry(state.anchor);
      expect(registry).toEqual(JSON.parse(await readFile(resolve(fixtures, "expected/registry.json"), "utf8")));

      const anchorDoor = await readFile(resolve(state.anchor, "FRONTDOOR.md"), "utf8");
      expect(anchorDoor).toContain("## Adjacent Workplaces");
      expect(anchorDoor).toContain("`workplace://fixture/peer` - link - available - not-entered");
      expect(anchorDoor).toContain("`workplace://fixture/restricted` - attachment - available - not-entered");
      expect(anchorDoor).not.toContain(state.root);
      expect(anchorDoor).not.toContain("member/peer-member");
      expect(await readFile(resolve(state.anchor, "AGENTS.md"), "utf8")).toContain("## Adjacent Workplaces");
      expect(await readFile(resolve(state.anchor, "workplace/WORKPLACE.md"), "utf8")).toBe(await readFile(resolve(fixtures, "anchor/world/workplace/WORKPLACE.md"), "utf8"));
      expect(await readFile(resolve(state.anchor, "workplace/WORKPLACE.md"), "utf8")).not.toContain("workplace://fixture/restricted");

      const peer = await enterWorkplace({ anchorMount: state.anchor, target: "workplace://fixture/peer", provider: "codex", profilePath });
      const restricted = await enterWorkplace({ anchorMount: state.anchor, target: "workplace://fixture/restricted", provider: "codex", profilePath });
      expect(peer.member).toBe("workplace://fixture/peer/member/peer-member");
      expect(peer.desk).toBe("workplace://fixture/peer/desk/peer-member");
      expect(restricted.member).toBe("workplace://fixture/restricted/member/restricted-member");
      expect(peer.frontDoor).not.toBe(restricted.frontDoor);
      expect(await readFile(peer.frontDoor, "utf8")).not.toContain("workplace://fixture/restricted");
      expect(await readFile(restricted.frontDoor, "utf8")).not.toContain("workplace://fixture/peer");
    } finally {
      await rm(state.root, { recursive: true, force: true });
    }
  });

  test("fails closed on invalid, missing, unsafe and mismatched Bindings", async () => {
    const state = await materialize();
    try {
      const localPath = resolve(state.anchor, ".endroit/workplaces.json");
      const original = JSON.parse(await readFile(localPath, "utf8")) as { bindings: Array<Record<string, unknown>> };

      await mkdir(resolve(state.root, "decoy/peer"), { recursive: true });
      await writeFile(localPath, JSON.stringify({ ...original, bindings: original.bindings.filter((binding) => binding.workplace !== "workplace://fixture/peer") }, null, 2));
      expect((await deriveWorkplaceRegistry(state.anchor)).entries[0]?.availability).toBe("unavailable");
      expect((await checkWorkplaceMount({ mount: state.anchor, provider: "codex", profilePath })).operationStatus).toBe("compile-required");
      expect(await errorCode(resolveWorkplaceMount(state.anchor, "workplace://fixture/peer"))).toBe("unavailable");

      await writeFile(localPath, JSON.stringify({ ...original, bindings: original.bindings.map((binding) => binding.workplace === "workplace://fixture/peer" ? { ...binding, mode: "managed", mount: "../peer/world" } : binding) }, null, 2));
      expect(await errorCode(resolveWorkplaceMount(state.anchor, "workplace://fixture/peer"))).toBe("unsafe-mount");

      await writeFile(localPath, JSON.stringify(original, null, 2));
      const contractPath = resolve(state.peer, "workplace/workplace.json");
      const contract = JSON.parse(await readFile(contractPath, "utf8")) as Record<string, unknown>;
      await writeFile(contractPath, JSON.stringify({ ...contract, workplace: "workplace://fixture/not-peer" }, null, 2));
      expect(await errorCode(resolveWorkplaceMount(state.anchor, "workplace://fixture/peer"))).toBe("identity-mismatch");

      const linksPath = resolve(state.anchor, "workplace/links.json");
      const links = JSON.parse(await readFile(linksPath, "utf8")) as Record<string, unknown>;
      await writeFile(linksPath, JSON.stringify({ ...links, unknown: true }, null, 2));
      expect(await errorCode(deriveWorkplaceRegistry(state.anchor))).toBe("invalid-federation-source");
    } finally {
      await rm(state.root, { recursive: true, force: true });
    }
  });

  test("resolves owner-scoped operations and keeps public fixtures synthetic", async () => {
    expect(resolveOwner({ explicit: "workplace://fixture/peer", candidates: ["workplace://fixture/restricted"], anchor: "workplace://fixture/anchor", anchorAdmissible: true })).toEqual({ status: "resolved", workplace: "workplace://fixture/peer" });
    expect(resolveOwner({ existingOwner: "workplace://fixture/restricted", candidates: [], anchor: "workplace://fixture/anchor", anchorAdmissible: true })).toEqual({ status: "resolved", workplace: "workplace://fixture/restricted" });
    expect(resolveOwner({ candidates: ["workplace://fixture/peer", "workplace://fixture/restricted"], anchor: "workplace://fixture/anchor", anchorAdmissible: false })).toEqual({ status: "pending", candidates: ["workplace://fixture/peer", "workplace://fixture/restricted"] });
    expect(resolveOwnerOperations([
      { explicit: "workplace://fixture/peer", candidates: [], anchor: "workplace://fixture/anchor", anchorAdmissible: true },
      { explicit: "workplace://fixture/restricted", candidates: [], anchor: "workplace://fixture/anchor", anchorAdmissible: true },
    ])).toEqual([
      { status: "resolved", workplace: "workplace://fixture/peer" },
      { status: "resolved", workplace: "workplace://fixture/restricted" },
    ]);

    const bytes = (await Promise.all((await filesBelow(fixtures)).map((path) => readFile(path, "utf8")))).join("\n").toLowerCase();
    for (const forbidden of ["private-company-sentinel", "private-user-sentinel", "/users/"]) expect(bytes).not.toContain(forbidden);
  });
});
