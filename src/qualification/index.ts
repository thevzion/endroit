export type OutcomeContribution = {
  id: string;
  at: string;
  requires: string[];
  produces: string[];
  preserves: string[];
  forbids: string[];
  evidence: string[];
};

export type PathStep = {
  order: number;
  kind: "read" | "resolve" | "enter" | "method" | "transition" | "effect";
  target: string;
};

export type Scenario = {
  kind: "OutcomeScenario";
  id: string;
  initialRevision: string;
  initialFacts: string[];
  allowedRoots: string[];
  expectedReads: Array<{ ref: string; revision: string; order: number }>;
  expectedPath: PathStep[];
  outcomeContributions: OutcomeContribution[];
  forbiddenBehavior: string[];
  expectedEffects: Array<{
    id: string;
    root: string;
    produces: string[];
    evidence: string[];
  }>;
  expectedLineage: Array<{ from: string; to: string; relation: string }>;
  commitScope: {
    work: string;
    planRevision: string;
    operation: string;
    responsibility: string;
    authority: string;
    object: string;
  };
  terminal: { status: string; clean: true; commitCount: number };
};

export type Trajectory = {
  kind: "ObservedTrajectory";
  scenario: string;
  initialRevision: string;
  reads: Scenario["expectedReads"];
  path: PathStep[];
  behavior: string[];
  effects: Array<{
    id: string;
    root: string;
    produces: string[];
    evidence: string[];
    commitOid: string;
    scope: Scenario["commitScope"];
  }>;
  evidence: Array<{
    ref: string;
    kind: string;
    effect: string;
    commitOid: string;
  }>;
  lineage: Array<{
    from: string;
    to: string;
    relation: string;
    oid: string;
  }>;
  verification: { status: "pass" | "fail"; evidence: string[] };
  terminal: {
    status: string;
    clean: boolean;
    commits: string[];
    preserves: string[];
  };
};

export type ExpectedOutcome = {
  contributions: string[];
  requires: string[];
  produces: string[];
  preserves: string[];
  forbids: string[];
  evidence: string[];
};

export type ExactCheck = {
  id: string;
  status: "pass" | "fail";
  detail: string;
};

export type QualificationResult = {
  status: "pass" | "fail";
  scenario: string;
  expectedOutcome: ExpectedOutcome;
  checks: ExactCheck[];
  lineage: {
    requiredCoverage: number;
    effectCommitCoverage: number;
    evidenceCoverage: number;
    orphanEffects: number;
    unresolvedEvidence: number;
    resumeComplete: boolean;
  };
};

const unique = (values: string[]) => [...new Set(values)];
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const oid = (value: string) => /^[0-9a-f]{40,64}$/.test(value);
const ratio = (covered: number, total: number) => total === 0 ? 1 : covered / total;

export function foldOutcome(scenario: Scenario): ExpectedOutcome {
  const facts = new Set(scenario.initialFacts);
  const contributions: string[] = [];
  const requires: string[] = [];
  const produces: string[] = [];
  const preserves: string[] = [];
  const forbids: string[] = [];
  const evidence: string[] = [];
  const positions = new Map(scenario.expectedPath.map((step) => [step.target, step.order]));
  const selected = scenario.outcomeContributions
    .filter((item) => positions.has(item.at))
    .sort((a, b) => positions.get(a.at)! - positions.get(b.at)!);

  if (selected.length !== scenario.outcomeContributions.length) {
    throw new Error("Every Outcome contribution must belong to the expected Path");
  }

  for (const item of selected) {
    const missing = item.requires.filter((required) => !facts.has(required));
    if (missing.length > 0) {
      throw new Error(`${item.id} requires unavailable facts: ${missing.join(", ")}`);
    }
    contributions.push(item.id);
    requires.push(...item.requires);
    produces.push(...item.produces);
    preserves.push(...item.preserves);
    forbids.push(...item.forbids);
    evidence.push(...item.evidence);
    item.produces.forEach((value) => facts.add(value));
  }

  const conflict = unique(produces).filter((value) => new Set(forbids).has(value));
  if (conflict.length > 0) {
    throw new Error(`Outcome both produces and forbids: ${conflict.join(", ")}`);
  }

  return {
    contributions: unique(contributions),
    requires: unique(requires),
    produces: unique(produces),
    preserves: unique(preserves),
    forbids: unique(forbids),
    evidence: unique(evidence),
  };
}

export function qualifyScenario(scenario: Scenario, trajectory: Trajectory): QualificationResult {
  if (trajectory.scenario !== scenario.id) {
    throw new Error(`Trajectory targets ${trajectory.scenario}, expected ${scenario.id}`);
  }

  const expectedOutcome = foldOutcome(scenario);
  const checks: ExactCheck[] = [];
  const check = (id: string, pass: boolean, detail: string) => {
    checks.push({ id, status: pass ? "pass" : "fail", detail });
  };

  check("initial-revision", trajectory.initialRevision === scenario.initialRevision,
    "Observed world must match the frozen Scenario revision");
  check("expected-reads", same(trajectory.reads, scenario.expectedReads),
    "Read Ref, Revision and order must match exactly");
  check("expected-path", same(trajectory.path, scenario.expectedPath),
    "Observable path must match exactly even when the product works");

  const forbidden = trajectory.behavior.filter((value) => scenario.forbiddenBehavior.includes(value));
  check("forbidden-behavior", forbidden.length === 0,
    forbidden.length === 0 ? "No forbidden behavior observed" : `Observed: ${forbidden.join(", ")}`);

  const badRoots = trajectory.effects.filter((effect) => !scenario.allowedRoots.includes(effect.root));
  check("allowed-roots", badRoots.length === 0,
    badRoots.length === 0 ? "All effects stay in declared Roots" : `Outside: ${badRoots.map((e) => e.root).join(", ")}`);

  const observedEffects = trajectory.effects.map(({ id, root, produces, evidence }) => ({ id, root, produces, evidence }));
  check("effects", same(observedEffects, scenario.expectedEffects),
    "Effects, products and evidence declarations must match exactly");

  const badScopes = trajectory.effects.filter((effect) => !same(effect.scope, scenario.commitScope));
  check("commit-scope", badScopes.length === 0,
    badScopes.length === 0 ? "Every effect uses the expected indivisible responsibility scope" : "One or more effect scopes diverge");

  const observedProduces = unique(trajectory.effects.flatMap((effect) => effect.produces));
  const observedEvidenceKinds = unique(trajectory.evidence.map((item) => item.kind));
  const observedOutcome = {
    produces: observedProduces,
    preserves: unique(trajectory.terminal.preserves),
    evidence: observedEvidenceKinds,
  };
  const outcomePass = same(observedOutcome.produces, expectedOutcome.produces)
    && same(observedOutcome.preserves, expectedOutcome.preserves)
    && same(observedOutcome.evidence, expectedOutcome.evidence)
    && expectedOutcome.forbids.every((value) => !observedProduces.includes(value));
  check("outcome", outcomePass, "Observed effects/evidence must realize the folded expected Outcome");

  const normalizedLineage = trajectory.lineage.map(({ from, to, relation }) => ({ from, to, relation }));
  const matchedLineage = scenario.expectedLineage.filter((edge) => normalizedLineage.some((actual) => same(actual, edge))).length;
  const lineageOidsValid = trajectory.lineage.every((edge) => oid(edge.oid));
  check("lineage", matchedLineage === scenario.expectedLineage.length && lineageOidsValid,
    "Every required semantic edge needs an explicit Git OID");

  const committedEffects = trajectory.effects.filter((effect) => oid(effect.commitOid) && trajectory.terminal.commits.includes(effect.commitOid));
  const orphanEffects = trajectory.effects.filter((effect) => !trajectory.evidence.some((item) => item.effect === effect.id && item.commitOid === effect.commitOid)).length;
  const unresolvedEvidence = trajectory.evidence.filter((item) => !trajectory.effects.some((effect) => effect.id === item.effect && effect.commitOid === item.commitOid)).length;
  const evidenceMatched = expectedOutcome.evidence.filter((kind) => trajectory.evidence.some((item) => item.kind === kind)).length;
  check("evidence", orphanEffects === 0 && unresolvedEvidence === 0 && evidenceMatched === expectedOutcome.evidence.length,
    "Evidence must close every Effect and every expected evidence kind");

  check("verification", trajectory.verification.status === "pass" && trajectory.verification.evidence.length > 0,
    "External verification must pass with explicit evidence");

  const terminalPass = trajectory.terminal.status === scenario.terminal.status
    && trajectory.terminal.clean === scenario.terminal.clean
    && trajectory.terminal.commits.length === scenario.terminal.commitCount
    && trajectory.terminal.commits.every(oid);
  check("terminal", terminalPass, "Terminal status, clean Git and exact commit count must match");

  const resumeComplete = terminalPass && trajectory.verification.status === "pass";
  return {
    status: checks.every((item) => item.status === "pass") ? "pass" : "fail",
    scenario: scenario.id,
    expectedOutcome,
    checks,
    lineage: {
      requiredCoverage: ratio(matchedLineage, scenario.expectedLineage.length),
      effectCommitCoverage: ratio(committedEffects.length, trajectory.effects.length),
      evidenceCoverage: ratio(evidenceMatched, expectedOutcome.evidence.length),
      orphanEffects,
      unresolvedEvidence,
      resumeComplete,
    },
  };
}

export async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await Bun.file(path).text()) as T;
}

const record = (value: unknown, subject: string): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${subject} must be an object`);
  }
  return value as Record<string, unknown>;
};

const closed = (value: unknown, keys: string[], subject: string) => {
  const item = record(value, subject);
  const actual = Object.keys(item).sort();
  const expected = [...keys].sort();
  if (!same(actual, expected)) throw new Error(`${subject} has invalid fields: ${actual.join(", ")}`);
  return item;
};

const array = (value: unknown, subject: string): unknown[] => {
  if (!Array.isArray(value)) throw new Error(`${subject} must be an array`);
  return value;
};

const strings = (value: unknown, subject: string) => {
  const values = array(value, subject);
  if (!values.every((item) => typeof item === "string")) throw new Error(`${subject} must contain strings`);
};

const scalar = (value: unknown, type: "string" | "number" | "boolean", subject: string) => {
  if (typeof value !== type) throw new Error(`${subject} must be a ${type}`);
};

function validateSteps(value: unknown, subject: string) {
  for (const [index, step] of array(value, subject).entries()) {
    const item = closed(step, ["order", "kind", "target"], `${subject}[${index}]`);
    scalar(item.order, "number", `${subject}[${index}].order`);
    scalar(item.kind, "string", `${subject}[${index}].kind`);
    scalar(item.target, "string", `${subject}[${index}].target`);
  }
}

function validateReads(value: unknown, subject: string) {
  for (const [index, read] of array(value, subject).entries()) {
    const item = closed(read, ["ref", "revision", "order"], `${subject}[${index}]`);
    scalar(item.ref, "string", `${subject}[${index}].ref`);
    scalar(item.revision, "string", `${subject}[${index}].revision`);
    scalar(item.order, "number", `${subject}[${index}].order`);
  }
}

export function parseScenario(value: unknown): Scenario {
  const item = closed(value, [
    "kind", "id", "initialRevision", "initialFacts", "allowedRoots", "expectedReads",
    "expectedPath", "outcomeContributions", "forbiddenBehavior", "expectedEffects",
    "expectedLineage", "commitScope", "terminal",
  ], "Scenario");
  if (item.kind !== "OutcomeScenario") throw new Error("Scenario.kind must be OutcomeScenario");
  scalar(item.id, "string", "Scenario.id");
  scalar(item.initialRevision, "string", "Scenario.initialRevision");
  strings(item.initialFacts, "Scenario.initialFacts");
  strings(item.allowedRoots, "Scenario.allowedRoots");
  strings(item.forbiddenBehavior, "Scenario.forbiddenBehavior");
  validateReads(item.expectedReads, "Scenario.expectedReads");
  validateSteps(item.expectedPath, "Scenario.expectedPath");
  for (const [index, contribution] of array(item.outcomeContributions, "Scenario.outcomeContributions").entries()) {
    const entry = closed(contribution, ["id", "at", "requires", "produces", "preserves", "forbids", "evidence"], `Scenario.outcomeContributions[${index}]`);
    scalar(entry.id, "string", `Scenario.outcomeContributions[${index}].id`);
    scalar(entry.at, "string", `Scenario.outcomeContributions[${index}].at`);
    for (const key of ["requires", "produces", "preserves", "forbids", "evidence"]) strings(entry[key], `Scenario.outcomeContributions[${index}].${key}`);
  }
  array(item.expectedEffects, "Scenario.expectedEffects");
  array(item.expectedLineage, "Scenario.expectedLineage");
  closed(item.commitScope, ["work", "planRevision", "operation", "responsibility", "authority", "object"], "Scenario.commitScope");
  closed(item.terminal, ["status", "clean", "commitCount"], "Scenario.terminal");
  return item as unknown as Scenario;
}

export function parseTrajectory(value: unknown): Trajectory {
  const item = closed(value, [
    "kind", "scenario", "initialRevision", "reads", "path", "behavior", "effects",
    "evidence", "lineage", "verification", "terminal",
  ], "Trajectory");
  if (item.kind !== "ObservedTrajectory") throw new Error("Trajectory.kind must be ObservedTrajectory");
  scalar(item.scenario, "string", "Trajectory.scenario");
  scalar(item.initialRevision, "string", "Trajectory.initialRevision");
  strings(item.behavior, "Trajectory.behavior");
  validateReads(item.reads, "Trajectory.reads");
  validateSteps(item.path, "Trajectory.path");
  array(item.effects, "Trajectory.effects");
  array(item.evidence, "Trajectory.evidence");
  array(item.lineage, "Trajectory.lineage");
  closed(item.verification, ["status", "evidence"], "Trajectory.verification");
  closed(item.terminal, ["status", "clean", "commits", "preserves"], "Trajectory.terminal");
  return item as unknown as Trajectory;
}

export async function readScenario(path: string): Promise<Scenario> {
  return parseScenario(JSON.parse(await Bun.file(path).text()));
}

export async function readTrajectory(path: string): Promise<Trajectory> {
  return parseTrajectory(JSON.parse(await Bun.file(path).text()));
}
