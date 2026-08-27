import { describe, expect, test } from "bun:test";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  compileStaticWorkplace,
  createMeetingId,
  loadCompileInput,
  materializeMeeting,
  resolveMeeting,
  writeMeetingPresence,
  type MeetingCandidate,
} from "../src/compiler/index.ts";

const repository = resolve(import.meta.dir, "..");
const profilePath = resolve(repository, "profiles/standard/profile.json");

async function temporary(label: string): Promise<string> {
  const path = resolve("/tmp", `${label}-${crypto.randomUUID()}`);
  await rm(path, { recursive: true, force: true });
  return path;
}

describe("Meeting kernel", () => {
  const workplace = "workplace://demo/smallest";
  const room = `${workplace}/room/product`;
  const work = `${workplace}/work/demo`;
  const now = new Date("2026-08-25T12:00:00.000Z");

  test("resolves explicit, unique, ephemeral and ambiguous Meetings without provider identity leakage", async () => {
    const active: MeetingCandidate = { ref: `${workplace}/meeting/active`, room, lifecycle: "active", primaryWork: work, relatedWorks: [] };
    const other: MeetingCandidate = { ref: `${workplace}/meeting/other`, room, lifecycle: "active", relatedWorks: [work] };
    const joined = resolveMeeting({ workplace, meetings: [active], explicitMeeting: active.ref, room, work, intent: "Continue demo", sessionKey: "provider-secret-session", now, entropy: "a" });
    expect(joined.status).toBe("joined");
    if (joined.status !== "joined") throw new Error("expected joined");
    expect(joined.presence.sessionDigest).not.toContain("provider-secret-session");

    expect(resolveMeeting({ workplace, meetings: [active], room, work, intent: "Continue demo", now, entropy: "b" }).status).toBe("resumed");
    const ephemeral = resolveMeeting({ workplace, meetings: [], room, intent: "New demo", now, entropy: "c" });
    expect(ephemeral.status).toBe("ephemeral");
    if (ephemeral.status !== "ephemeral") throw new Error("expected ephemeral");
    expect(ephemeral.meetingId).toBe(createMeetingId("New demo", now, "c"));

    const ambiguous = resolveMeeting({ workplace, meetings: [active, other], room, work, intent: "Continue demo", now, entropy: "d" });
    expect(ambiguous.status).toBe("ambiguous");
    if (ambiguous.status !== "ambiguous") throw new Error("expected ambiguity");
    expect(ambiguous.candidates).toEqual([active.ref, other.ref]);
    expect(() => resolveMeeting({ workplace, meetings: [{ ...active, lifecycle: "closed" }], explicitMeeting: active.ref, intent: "Continue", now, entropy: "e" })).toThrow("not active");

    const mount = await temporary("endroit-meeting-presence");
    try {
      const path = await writeMeetingPresence(mount, joined.presence);
      const bytes = await readFile(path, "utf8");
      expect(bytes).not.toContain("provider-secret-session");
      expect(bytes).toContain('"lifecycle": "active"');
    } finally {
      await rm(mount, { recursive: true, force: true });
    }
  });

  test("materializes a strict Room-owned Meeting and compiles its progressive Front Door", async () => {
    const root = await temporary("endroit-meeting-compile");
    const world = resolve(root, "world");
    const out = resolve(root, "compiled");
    try {
      await cp(resolve(repository, "examples/smallest/world"), world, { recursive: true });
      const meeting = materializeMeeting({
        workplace,
        meetingId: "20260825t120000z-demo-1234abcd",
        owner: `${workplace}/member/alexis`,
        room,
        intent: "Advance the demo without completing Work",
        primaryWork: work,
        nextBoundary: "Verify the bounded result.",
      });
      const path = resolve(world, "workplace/sources", meeting.relativePath);
      await mkdir(resolve(path, ".."), { recursive: true });
      await writeFile(path, meeting.bytes);
      const roomPath = resolve(world, "workplace/sources/rooms/product/ROOM.md");
      const roomBytes = await readFile(roomPath, "utf8");
      await writeFile(roomPath, roomBytes.replace(`    - ${work}\n`, `    - ${work}\n    - ${meeting.ref}\n`));

      const input = await loadCompileInput({ profilePath, workplacePath: resolve(world, "workplace/workplace.json") });
      const compiled = await compileStaticWorkplace(input, { outDir: out });
      const door = await readFile(resolve(compiled.root, "rooms/product/meetings/20260825t120000z-demo-1234abcd/FRONTDOOR.md"), "utf8");
      expect(door).toContain("Meeting contract");
      expect(door).toContain("Verify the bounded result");
      expect(door).toContain("Closing this Meeting never completes its Work");
      expect(await readFile(resolve(compiled.root, "FRONTDOOR.md"), "utf8")).toContain(meeting.ref);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
