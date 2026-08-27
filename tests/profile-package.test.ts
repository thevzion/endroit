import { describe, expect, test } from "bun:test";
import { cp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadProfilePackage } from "../src/compiler/profile-package.ts";
import { renderSourceContract, stable } from "../src/compiler/index.ts";

const repository = resolve(import.meta.dir, "..");
const standard = resolve(repository, "profiles/standard");

async function fixture(): Promise<string> {
  const root = resolve("/tmp", `endroit-profile-package-${crypto.randomUUID()}`);
  await cp(standard, root, { recursive: true });
  return root;
}

describe("Workplace Profile Package", () => {
  test("loads deterministically from explicit refs and covers the Standard", async () => {
    const first = await loadProfilePackage(resolve(standard, "profile.json"));
    const second = await loadProfilePackage(standard);
    expect(first.digest).toBe(second.digest);
    expect(Object.keys(first.profile.entities).sort()).toEqual(["agent", "material", "meeting", "member", "place", "work"]);
    expect(Object.keys(first.affordances).sort()).toEqual(["enter", "maintain", "onboard", "settle"]);
    expect(first.controls.map((item) => item.placement).sort()).toEqual(["Guard", "Guard", "RequiredRead", "Resident"]);
    expect(Object.keys(first.sourceContracts)).toEqual(["room", "meeting", "work", "site"]);
    expect(first.responsibilities.every((item) => Boolean(first.defaults[item.id]))).toBe(true);
  });

  test("renders each declared Source Contract through the production parser", async () => {
    const profile = await loadProfilePackage(standard);
    const refs = {
      OWNER_REF: "workplace://demo/member/alexis",
      WORKPLACE_REF: "workplace://demo",
      ROOM_REF: "workplace://demo/room/product",
      MEETING_REF: "workplace://demo/meeting/kickoff",
      WORK_REF: "workplace://demo/work/product",
      SITE_REF: "workplace://demo/site/product",
    };
    const rendered = {
      room: renderSourceContract(profile, "room", { ROOM_REF: refs.ROOM_REF, OWNER_REF: refs.OWNER_REF, WORKPLACE_REF: refs.WORKPLACE_REF, MEETING_REF: refs.MEETING_REF, ROOM_LABEL: "Product", ROOM_SUMMARY: "Own the product subject.", ROOM_WHEN: "The intent concerns the product." }),
      meeting: renderSourceContract(profile, "meeting", { MEETING_REF: refs.MEETING_REF, OWNER_REF: refs.OWNER_REF, ROOM_REF: refs.ROOM_REF, MEETING_LABEL: "Kickoff", MEETING_SUMMARY: "Coordinate the first durable effect.", MEETING_WHEN: "The product intent is active.", MEETING_INTENT: "Resolve the bounded product outcome.", NEXT_BOUNDARY: "Open Work or remain active." }),
      work: renderSourceContract(profile, "work", { WORK_REF: refs.WORK_REF, OWNER_REF: refs.OWNER_REF, ROOM_REF: refs.ROOM_REF, SITE_REF: refs.SITE_REF, WORK_SUMMARY: "Produce the bounded product.", WORK_WHEN: "The product Outcome is requested.", WORK_OUTCOME: "The product exists in its declared Site.", WORK_VERIFICATION: "Site checks pass." }),
      site: renderSourceContract(profile, "site", { SITE_REF: refs.SITE_REF, OWNER_REF: refs.OWNER_REF, WORKPLACE_REF: refs.WORKPLACE_REF, WORK_REF: refs.WORK_REF, SITE_SUMMARY: "Sovereign product destination.", SITE_WHEN: "The Work needs product bytes." }),
    };
    expect(rendered.room.envelope.roles).toEqual(["room"]);
    expect(rendered.meeting.envelope.lifecycle).toBe("active");
    expect(rendered.work.envelope.relations.targets).toEqual([refs.SITE_REF]);
    expect(rendered.site.envelope.relations.implements).toEqual([refs.WORK_REF]);
    const room = { ROOM_REF: refs.ROOM_REF, OWNER_REF: refs.OWNER_REF, WORKPLACE_REF: refs.WORKPLACE_REF, MEETING_REF: refs.MEETING_REF, ROOM_LABEL: "Product", ROOM_SUMMARY: "Summary", ROOM_WHEN: "When" };
    expect(() => renderSourceContract(profile, "room", { ...room, EXTRA: "no" })).toThrow("unknown variables");
    const { ROOM_WHEN: _roomWhen, ...incompleteRoom } = room;
    expect(() => renderSourceContract(profile, "room", incompleteRoom)).toThrow("missing variables");
    expect(() => renderSourceContract(profile, "room", { ...room, ROOM_SUMMARY: "x".repeat(20_000) })).toThrow("byte budget");
  });

  test("rejects hostile JSON, missing refs, ambiguous aliases and budgets", async () => {
    for (const mutate of [
      async (root: string) => {
        const path = resolve(root, "profile.json");
        await writeFile(path, (await readFile(path, "utf8")).replace('"version": 1,', '"version": 1,\n  "version": 1,'));
      },
      async (root: string) => {
        const value = JSON.parse(await readFile(resolve(root, "profile.json"), "utf8")) as { components: { grammar: string } };
        value.components.grammar = "missing.json";
        await writeFile(resolve(root, "profile.json"), stable(value));
      },
      async (root: string) => {
        const path = resolve(root, "lexicon.json");
        const value = JSON.parse(await readFile(path, "utf8")) as { terms: Record<string, { aliases: string[] }> };
        value.terms.agent!.aliases = ["shared-alias"];
        value.terms.member!.aliases = ["shared-alias"];
        await writeFile(path, stable(value));
      },
      async (root: string) => writeFile(resolve(root, "defaults/desk/WELCOME.md"), "x".repeat(4097)),
      async (root: string) => {
        const path = resolve(root, "source-contracts.json");
        const value = JSON.parse(await readFile(path, "utf8")) as { contracts: Array<{ id: string; variables: string[] }> };
        value.contracts.find((item) => item.id === "room")!.variables.push("UNDECLARED");
        await writeFile(path, stable(value));
      },
      async (root: string) => {
        const path = resolve(root, "source-contracts.json");
        const value = JSON.parse(await readFile(path, "utf8")) as { contracts: Array<{ id: string }> };
        value.contracts = value.contracts.filter((item) => item.id !== "site");
        await writeFile(path, stable(value));
      },
      async (root: string) => {
        const path = resolve(root, "source-contracts.json");
        const value = JSON.parse(await readFile(path, "utf8")) as { contracts: Array<{ id: string; path: string }> };
        value.contracts.find((item) => item.id === "room")!.path = "../ROOM.md";
        await writeFile(path, stable(value));
      },
    ]) {
      const root = await fixture();
      try {
        await mutate(root);
        let message = "";
        try { await loadProfilePackage(root); }
        catch (error) { message = error instanceof Error ? error.message : String(error); }
        expect(message).not.toBe("");
      } finally { await rm(root, { recursive: true, force: true }); }
    }
  });
});
