import { describe, expect, test } from "bun:test";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { foldOutcome, parseScenario, qualifyScenario, type Scenario, type Trajectory } from "../src/qualification/index.ts";
import { compileStaticWorkplace, loadCompileInput } from "../src/compiler/index.ts";

const sha = (character: string) => character.repeat(40);

const scenario: Scenario = {
  kind: "OutcomeScenario",
  id: "flappy-manual-v0",
  initialRevision: "sha256:world-v0",
  initialFacts: ["intent-framed"],
  allowedRoots: ["root:site/flappy-bird"],
  expectedReads: [
    { ref: "workplace:demo/flappy", revision: "sha256:workplace", order: 1 },
    { ref: "place:demo/product", revision: "sha256:room", order: 2 },
  ],
  expectedPath: [
    { order: 1, kind: "read", target: "workplace:demo/flappy" },
    { order: 2, kind: "enter", target: "place:demo/product" },
    { order: 3, kind: "method", target: "method:research/study" },
    { order: 4, kind: "effect", target: "root:site/flappy-bird" },
  ],
  outcomeContributions: [
    { id: "frame", at: "method:research/study", requires: ["intent-framed"], produces: ["twist-qualified"], preserves: ["site-sovereignty"], forbids: ["workplace-product-bytes"], evidence: ["study"] },
    { id: "build", at: "root:site/flappy-bird", requires: ["twist-qualified"], produces: ["playable-game"], preserves: ["site-sovereignty"], forbids: ["workplace-product-bytes"], evidence: ["verification"] },
  ],
  forbiddenBehavior: ["runtime-call", "invented-authority", "workplace-write"],
  expectedEffects: [{ id: "site-build", root: "root:site/flappy-bird", produces: ["twist-qualified", "playable-game"], evidence: ["evidence:study", "evidence:verification"] }],
  expectedLineage: [{ from: "work:flappy", to: "commit:site", relation: "implemented-by" }],
  commitScope: { work: "work:flappy", planRevision: "sha256:plan", operation: "site.build", responsibility: "playable-flappy", authority: "human-invoked", object: "work:flappy" },
  terminal: { status: "awaiting-human-validation", clean: true, commitCount: 1 },
};

const expectedEffect = scenario.expectedEffects[0]!;
const expectedLineage = scenario.expectedLineage[0]!;

const passing: Trajectory = {
  kind: "ObservedTrajectory",
  scenario: scenario.id,
  initialRevision: scenario.initialRevision,
  reads: scenario.expectedReads,
  path: scenario.expectedPath,
  behavior: [],
  effects: [{ id: expectedEffect.id, root: expectedEffect.root, produces: expectedEffect.produces, evidence: expectedEffect.evidence, commitOid: sha("a"), scope: scenario.commitScope }],
  evidence: [
    { ref: "evidence:study", kind: "study", effect: "site-build", commitOid: sha("a") },
    { ref: "evidence:verification", kind: "verification", effect: "site-build", commitOid: sha("a") },
  ],
  lineage: [{ from: expectedLineage.from, to: expectedLineage.to, relation: expectedLineage.relation, oid: sha("a") }],
  verification: { status: "pass", evidence: ["evidence:verification"] },
  terminal: { status: "awaiting-human-validation", clean: true, commits: [sha("a")], preserves: ["site-sovereignty"] },
};

describe("static Workplace Outcome qualification", () => {
  test("the hidden Flappy contract folds independently of Agent surfaces", async () => {
    const fixture = await Bun.file(new URL("../examples/flappy/qualification/scenario.json", import.meta.url)).json() as Scenario;
    expect(foldOutcome(fixture).produces).toEqual(["question-bounded", "twist-qualified", "playable-game"]);
    expect(await Bun.file(new URL("../examples/flappy/world/qualification/scenario.json", import.meta.url)).exists()).toBe(false);
  });

  test("keeps the profile-routing oracle hidden and targets WELCOME", async () => {
    const fixture = parseScenario(await Bun.file(new URL("../examples/flappy/qualification/profile-update-scenario.json", import.meta.url)).json());
    expect(fixture.expectedPath.at(-1)?.target).toBe("workplace://demo/flappy-studio/material/welcome-alexis");
    expect(fixture.forbiddenBehavior).toContain("provider-memory-write");
    expect(foldOutcome(fixture).preserves).toContain("provider-memory-unchanged");
    expect(await Bun.file(new URL("../examples/flappy/world/qualification/profile-update-scenario.json", import.meta.url)).exists()).toBe(false);
  });

  test("pins expected reads to the compiled frozen source Revisions", async () => {
    const repository = resolve(import.meta.dir, "..");
    const root = resolve(tmpdir(), `endroit-qualification-test-${crypto.randomUUID()}`);
    await rm(root, { recursive: true, force: true });
    try {
      const input = await loadCompileInput({
        profilePath: resolve(repository, "profiles/standard/profile.json"),
        workplacePath: resolve(repository, "examples/flappy/world/workplace/workplace.json"),
      });
      const compiled = await compileStaticWorkplace(input, { outDir: root });
      const map = JSON.parse(await readFile(resolve(compiled.root, "workplace/.workplace/workplace-map.json"), "utf8")) as { sourceRevision: string; entries: Array<{ ref: string; revision: string }> };
      const frozen = JSON.parse(await readFile(resolve(repository, "examples/flappy/qualification/scenario.json"), "utf8")) as Scenario;
      expect(frozen.initialRevision).toBe(map.sourceRevision);
      expect(frozen.expectedReads[0]?.revision).toBe(map.sourceRevision);
      for (const read of frozen.expectedReads.slice(1)) {
        expect(read.revision).toBe(map.entries.find((entry) => entry.ref === read.ref)?.revision);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("folds ordered contributions before execution", () => {
    expect(foldOutcome(scenario)).toEqual({
      contributions: ["frame", "build"],
      requires: ["intent-framed", "twist-qualified"],
      produces: ["twist-qualified", "playable-game"],
      preserves: ["site-sovereignty"],
      forbids: ["workplace-product-bytes"],
      evidence: ["study", "verification"],
    });
  });

  test("passes an exact clean trajectory", () => {
    expect(qualifyScenario(scenario, passing).status).toBe("pass");
  });

  test("keeps a functional result RED when the observable path diverges", () => {
    const divergent = structuredClone(passing);
    divergent.path = divergent.path.filter((step) => step.kind !== "method");
    expect(divergent.effects[0]!.produces).toContain("playable-game");
    const result = qualifyScenario(scenario, divergent);
    expect(result.status).toBe("fail");
    expect(result.checks.find((check) => check.id === "expected-path")?.status).toBe("fail");
  });

  test("rejects an Outcome contribution whose prerequisite is absent", () => {
    const invalid = structuredClone(scenario);
    invalid.initialFacts = [];
    expect(() => foldOutcome(invalid)).toThrow("requires unavailable facts");
  });

  test("rejects unknown Scenario fields at the JSON boundary", () => {
    expect(() => parseScenario({ ...scenario, answer: "leaked" })).toThrow("invalid fields");
  });
});
