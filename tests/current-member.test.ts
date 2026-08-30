import { describe, expect, test } from "bun:test";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { CurrentMemberError, rememberCurrentMember, resolveCurrentMember } from "../src/current-member.ts";

async function fixture() {
  const root = resolve("/tmp", `endroit-current-member-${crypto.randomUUID()}`);
  const mount = join(root, "anchor");
  await mkdir(mount, { recursive: true });
  return { root, mount };
}

describe("local Current Member binding", () => {
  test("stays pending until explicit input is remembered, then resolves locally", async () => {
    const state = await fixture();
    try {
      const base = { anchorMount: state.mount, anchor: "workplace://anchor", workplace: "workplace://peer" };
      expect(await resolveCurrentMember(base)).toEqual({ status: "pending-member", source: "none", workplace: "workplace://peer" });
      const explicit = await resolveCurrentMember({ ...base, member: "workplace://peer/member/operator", desk: "workplace://peer/desk/operator" });
      expect(explicit).toEqual({ status: "resolved", source: "request", workplace: "workplace://peer", member: "workplace://peer/member/operator", desk: "workplace://peer/desk/operator" });
      if (explicit.status !== "resolved") throw new Error("explicit Current Member did not resolve");
      const remembered = await rememberCurrentMember({ ...base, member: explicit.member, desk: explicit.desk });
      expect(remembered.changed).toBe(true);
      expect(await resolveCurrentMember(base)).toEqual({ ...explicit, source: "local" });
      expect((await rememberCurrentMember({ ...base, member: explicit.member, desk: explicit.desk })).changed).toBe(false);
      expect(await readFile(join(state.mount, ".endroit/current-member.json"), "utf8")).not.toContain(state.root);
    } finally { await rm(state.root, { recursive: true, force: true }); }
  });

  test("rejects inference-shaped, malformed and escaping local state", async () => {
    const state = await fixture();
    try {
      const base = { anchorMount: state.mount, anchor: "workplace://anchor", workplace: "workplace://peer" };
      try { await resolveCurrentMember({ ...base, member: "workplace://peer/member/operator" }); throw new Error("expected partial Current Member rejection"); }
      catch (error) { expect(error instanceof CurrentMemberError).toBe(true); }
      await mkdir(join(state.mount, ".endroit"), { recursive: true });
      await writeFile(join(state.mount, ".endroit/current-member.json"), JSON.stringify({ kind: "CurrentMemberBindings", version: 1, anchor: "workplace://anchor", members: [], inferredFromGit: true }));
      try { await resolveCurrentMember(base); throw new Error("expected inference-shaped binding rejection"); }
      catch (error) { expect(error instanceof CurrentMemberError).toBe(true); }
      await rm(join(state.mount, ".endroit"), { recursive: true, force: true });
      const outside = join(state.root, "outside");
      await mkdir(outside, { recursive: true });
      await symlink(outside, join(state.mount, ".endroit"));
      try { await rememberCurrentMember({ ...base, member: "workplace://peer/member/operator", desk: "workplace://peer/desk/operator" }); throw new Error("expected symlink rejection"); }
      catch (error) { expect(error instanceof CurrentMemberError && error.code === "current-member-collision").toBe(true); }
      expect(await Bun.file(join(outside, "current-member.json")).exists()).toBe(false);
    } finally { await rm(state.root, { recursive: true, force: true }); }
  });
});
