import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import type { SemanticRef, SourceEnvelope } from "./model.ts";

export type MeetingLifecycle = "ephemeral" | "active" | "settling" | "closed";

export type MeetingCandidate = {
  ref: SemanticRef;
  room: SemanticRef;
  lifecycle: Exclude<MeetingLifecycle, "ephemeral">;
  primaryWork?: SemanticRef;
  relatedWorks: SemanticRef[];
};

export type MeetingPresence = {
  kind: "MeetingPresence";
  version: 1;
  id: string;
  workplace: SemanticRef;
  sessionDigest: string;
  lifecycle: "ephemeral" | "active";
  intent: string;
  position?: SemanticRef;
  meetingRef?: SemanticRef;
  createdAt: string;
  updatedAt: string;
};

export type MeetingResolution =
  | { status: "joined" | "resumed"; meeting: MeetingCandidate; presence: MeetingPresence }
  | { status: "ephemeral"; presence: MeetingPresence; meetingId: string }
  | { status: "ambiguous"; candidates: SemanticRef[]; question: string };

function digest(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

function slug(value: string): string {
  const normalized = value.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
  return normalized || "meeting";
}

export function createMeetingId(intent: string, now: Date, entropy: string): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "z").toLowerCase();
  return `${stamp}-${slug(intent)}-${digest(entropy).slice(0, 8)}`;
}

function presence(input: {
  workplace: SemanticRef;
  sessionKey?: string;
  intent: string;
  position?: SemanticRef;
  meetingRef?: SemanticRef;
  now: Date;
  entropy: string;
}): MeetingPresence {
  const sessionDigest = digest(input.sessionKey ?? input.entropy);
  const time = input.now.toISOString();
  return {
    kind: "MeetingPresence",
    version: 1,
    id: sessionDigest.slice(0, 16),
    workplace: input.workplace,
    sessionDigest,
    lifecycle: input.meetingRef ? "active" : "ephemeral",
    intent: input.intent,
    ...(input.position ? { position: input.position } : {}),
    ...(input.meetingRef ? { meetingRef: input.meetingRef } : {}),
    createdAt: time,
    updatedAt: time,
  };
}

export function resolveMeeting(input: {
  workplace: SemanticRef;
  meetings: MeetingCandidate[];
  intent: string;
  explicitMeeting?: SemanticRef;
  room?: SemanticRef;
  work?: SemanticRef;
  sessionKey?: string;
  now?: Date;
  entropy?: string;
}): MeetingResolution {
  const now = input.now ?? new Date();
  const entropy = input.entropy ?? crypto.randomUUID();
  if (input.explicitMeeting) {
    const meeting = input.meetings.find((item) => item.ref === input.explicitMeeting);
    if (!meeting || meeting.lifecycle !== "active") throw new Error(`Explicit Meeting is not active: ${input.explicitMeeting}`);
    return { status: "joined", meeting, presence: presence({ workplace: input.workplace, sessionKey: input.sessionKey, intent: input.intent, ...(input.room ? { position: input.room } : {}), meetingRef: meeting.ref, now, entropy }) };
  }
  const compatible = input.meetings.filter((meeting) => meeting.lifecycle === "active"
    && (!input.room || meeting.room === input.room)
    && (!input.work || meeting.primaryWork === input.work || meeting.relatedWorks.includes(input.work)));
  if (compatible.length === 1) {
    const meeting = compatible[0]!;
    return { status: "resumed", meeting, presence: presence({ workplace: input.workplace, sessionKey: input.sessionKey, intent: input.intent, ...(input.room ? { position: input.room } : {}), meetingRef: meeting.ref, now, entropy }) };
  }
  if (compatible.length > 1) return {
    status: "ambiguous",
    candidates: compatible.map((item) => item.ref).sort(),
    question: `Which Meeting should this Session join: ${compatible.map((item) => item.ref).sort().join(", ")}?`,
  };
  return {
    status: "ephemeral",
    meetingId: createMeetingId(input.intent, now, entropy),
    presence: presence({ workplace: input.workplace, sessionKey: input.sessionKey, intent: input.intent, ...(input.room ? { position: input.room } : {}), now, entropy }),
  };
}

export async function writeMeetingPresence(mount: string, value: MeetingPresence): Promise<string> {
  const directory = join(mount, ".endroit/meetings", value.id);
  await mkdir(directory, { recursive: true });
  const path = join(directory, "presence.json");
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
  return path;
}

export function materializeMeeting(input: {
  workplace: SemanticRef;
  meetingId: string;
  owner: SemanticRef;
  room: SemanticRef;
  intent: string;
  primaryWork?: SemanticRef;
  relatedWorks?: SemanticRef[];
  nextBoundary: string;
  mainId?: string;
}): { ref: SemanticRef; relativePath: string; bytes: string; envelope: SourceEnvelope } {
  const ref = `${input.workplace}/meeting/${input.meetingId}`;
  const roomId = input.room.split("/").at(-1)!;
  const envelope: SourceEnvelope = {
    ref,
    entity: "meeting",
    roles: ["meeting"],
    slot: "room-meeting",
    owner: input.owner,
    scope: input.room,
    summary: input.intent,
    when: ["Resuming this collaboration event or validating its durable effects."],
    intent: input.intent,
    ...(input.primaryWork ? { primaryWork: input.primaryWork } : {}),
    relatedWorks: input.relatedWorks ?? [],
    occupants: [{ id: input.mainId ?? "main", role: "main" }],
    controls: [],
    dispatches: [],
    nextBoundary: input.nextBoundary,
    lifecycle: "active",
    relations: {
      "contained-by": [input.room],
      advances: [...new Set([input.primaryWork, ...(input.relatedWorks ?? [])].filter((value): value is string => Boolean(value)))],
    },
  };
  const frontmatter = stringifyYaml(envelope, { lineWidth: 0, sortMapEntries: true }).trimEnd();
  const bytes = `---\n${frontmatter}\n---\n\n# Meeting\n\n## Intent\n\n${input.intent}\n\n## State\n\nActive. Next boundary: ${input.nextBoundary}\n`;
  return { ref, relativePath: `rooms/${roomId}/meetings/${input.meetingId}/MEETING.md`, bytes, envelope };
}
