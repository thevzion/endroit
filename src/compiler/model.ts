export const KERNEL_PRIMITIVES = [
  "Root",
  "Ref",
  "Revision",
  "Node",
  "Relation",
  "Role",
  "Slot",
  "Source",
  "Projection",
  "Constraint",
] as const;

export type Revision = `sha256:${string}`;
export type SemanticRef = string;
export type Cardinality = "0..1" | "1" | "0..*" | "1..*";

export type ObservedRef = {
  ref: SemanticRef;
  revision: Revision;
};

export type SourceDefinition = {
  format: "markdown";
  leaf?: string;
};

export type RoleTarget =
  | { kind: "entity-family"; ids: string[] }
  | { kind: "slot"; ids?: string[] }
  | { kind: "relation"; ids?: string[] }
  | { kind: "projection"; ids?: string[] };

export type RoleDefinition = {
  id: string;
  mode: "authored" | "resolved";
  target: RoleTarget;
  requiresRoles?: string[];
  conflictsWith?: string[];
  roots?: string[];
  source?: SourceDefinition;
  locator?: string;
  lifecycle?: string;
  slots?: string[];
  requiredRelations?: string[];
  sourceResponsibilities?: string[];
  projectionResponsibilities?: string[];
  entry?: "none" | "link" | "scope";
  purpose?: string;
  useWhen?: string[];
  avoidWhen?: string[];
  ownership?: { kind: "root" | "owner" };
  retention?: { kind: "active" | "temporary" | "lifecycle" };
};

export type EntityDefinition = {
  id: string;
  title: string;
  purpose: string;
  useWhen: string[];
  avoidWhen?: string[];
  roles: string[];
};

export type RootDefinition = {
  id: string;
  ownership: "workplace" | "member" | "external";
  visibility: "shared" | "private";
  physical: "embedded" | "bound";
};

export type SlotDefinition = {
  id: string;
  owner: string;
  role: string;
  accepts: {
    entities?: string[];
    roles?: string[];
    projections?: string[];
  };
  cardinality: Cardinality;
  locator: string;
  visibility: "listed" | "linked" | "unlisted";
  order?: number;
  lifecycle?: string;
  affordances?: string[];
};

export type RelationDefinition = {
  id: string;
  from: string[];
  to: string[];
  cardinality: { from: Cardinality; to: Cardinality };
  external: "forbidden" | "allowed";
  purpose: string;
};

export type ViewDefinition = {
  id: string;
  fromEntities?: string[];
  fromRoles?: string[];
  projection: string;
};

export type DisclosurePosition = "hall" | "place" | "meeting" | "work" | "site";
export type DisclosureVisibility = "must-show" | "may-show" | "must-hide";

export type DisclosureSelector = {
  id: string;
  positions: DisclosurePosition[];
  visibility: DisclosureVisibility;
  roles: string[];
  relations: string[];
  reason: string;
};

export type ControlPlacement = "Resident" | "RequiredRead" | "MayRead" | "Guard";

export type ControlClause = {
  id: string;
  positions: DisclosurePosition[];
  trigger: string;
  placement: ControlPlacement;
  criticality: "critical" | "advisory";
  reasonForDisclosure: string;
  consequenceIfMissed: string;
  requiredEvidence: string[];
  enforcement: "staged" | "history" | "qualification";
};

export type Profile = {
  $schema: string;
  id: string;
  version: string;
  ref: SemanticRef;
  roots: Record<string, Omit<RootDefinition, "id">>;
  entities: Record<string, Omit<EntityDefinition, "id">>;
  roles: Record<string, Omit<RoleDefinition, "id">>;
  slots: Record<string, Omit<SlotDefinition, "id">>;
  relations: Record<string, Omit<RelationDefinition, "id">>;
  views: Record<string, Omit<ViewDefinition, "id">>;
  lifecycles: Record<string, string[]>;
  disclosures: {
    discovery: string;
    identity: string;
    roots: string;
    lifecycle: string;
    sites: string;
    projections: string;
    degraded: string;
    selectors: DisclosureSelector[];
    limits: { maxSourceBytes: number; maxSources: number; maxDepth: number; maxResidentBytes: number };
  };
};

export type SourceEnvelope = {
  ref: SemanticRef;
  entity: string;
  roles?: string[];
  slot?: string;
  owner: SemanticRef;
  scope: SemanticRef;
  label?: string;
  language?: string;
  summary: string;
  when: string[];
  responsibilities?: string[];
  authorityLimits?: string[];
  durableChanges?: string[];
  outcomes?: string[];
  verification?: string[];
  intent?: string;
  primaryWork?: SemanticRef;
  relatedWorks?: SemanticRef[];
  occupants?: Array<{
    id: string;
    role: "main" | "manager" | "worker" | "specialized";
    agent?: SemanticRef;
    contribution?: SemanticRef;
  }>;
  controls?: string[];
  dispatches?: Array<{
    id: string;
    occupant: string;
    meetingRef: SemanticRef;
    position: string;
    work: SemanticRef;
    objective: string;
    authoritativeSources: SemanticRef[];
    mutableScope: string[];
    exclusions: string[];
    authority: "delegated";
    mandate: SemanticRef;
    expectedOutcome: string;
    terminalCondition: string;
    activeControls: string[];
    status: "pending" | "active" | "complete" | "blocked";
  }>;
  nextBoundary?: string;
  disposition?: "resume" | "close";
  sharedShelves?: SemanticRef[];
  appliesTo?: SemanticRef[];
  status?: string;
  supersedes?: SemanticRef[];
  contradicts?: SemanticRef[];
  relations: Record<string, SemanticRef[]>;
  derivedFrom?: ObservedRef[];
  lifecycle?: string;
  currency?: "current" | "superseded" | "archived";
  freshness?: "fresh" | "stale" | "unknown";
  claimMaturity?: "observation" | "hypothesis" | "proposal" | "accepted";
};

export type SourceRecord = {
  relativePath: string;
  root?: string;
  mountPath?: string;
  envelope: SourceEnvelope;
  body: string;
  bytes: string;
  revision: Revision;
};

export type OperationRequirement = {
  id: string;
  trait: string;
  effect: "read" | "write" | "external";
  authority: "none" | "bounded" | "human-only";
  proof: string[];
};

export type OutcomeContribution = {
  id: string;
  requires: string[];
  produces: string[];
  preserves: string[];
  forbids: string[];
  evidence: string[];
};

export type StageDefinition = {
  id: string;
  appliesTo: string[];
  operations: string[];
  outcome: OutcomeContribution;
  optional?: boolean;
};

export type MethodDefinition = {
  id: string;
  title: string;
  instructions: string;
  intent: string[];
  useWhen: string[];
  avoidWhen?: string[];
  acceptsWorkForms: string[];
  requiredPlaceRoles: string[];
  requiredEntityRoles?: string[];
  requires: string[];
  operations: OperationRequirement[];
  effects: string[];
  authority: "none" | "bounded" | "human-only";
  proof: string[];
  staticFallback: "complete" | "read-only" | "pending";
  coordination?: "read-only" | "single-scope" | "integration";
  requiredControls?: string[];
  context?: {
    requiredReads: string[];
    conditionalReads: string[];
    forbiddenScopes: string[];
    searchRoot: string;
    stopCondition: string;
  };
  stages: StageDefinition[];
};

export type AffordanceContract = {
  kind: "AffordanceContract";
  version: 1;
  id: string;
  positions: DisclosurePosition[];
  applicability: "onboarding-required" | "bound" | "active-meeting";
  authority: "none" | "bounded" | "human-consent";
  providerTargets: Array<"skill" | "command">;
  instructions: string;
};

export type WorkplaceProfilePackageManifest = {
  $schema: string;
  kind: "WorkplaceProfilePackage";
  version: 1;
  id: string;
  ref: SemanticRef;
  release: string;
  sourceContracts: string;
  components: Record<"grammar" | "lexicon" | "responsibilities" | "composition" | "coordination" | "disclosure" | "projections" | "new", string>;
  affordances: Array<{ id: string; path: string }>;
  defaults: Record<"constitution" | "doctrine" | "change" | "member" | "desk" | "welcome" | "memory", string>;
};

export type SourceContractId = "room" | "meeting" | "work" | "site";

export type LoadedSourceContract = {
  id: SourceContractId;
  sourcePath: string;
  projectionPath: string;
  variables: string[];
  consumers: string[];
  maxBytes: number;
  template: string;
  templateRevision: Revision;
  revision: Revision;
};

export type LoadedProfilePackage = {
  path: string;
  manifest: WorkplaceProfilePackageManifest;
  digest: Revision;
  profile: Profile;
  controls: ControlClause[];
  lexicon: Record<string, { label: string; definition: string; aliases: string[] }>;
  responsibilities: Array<{ id: string; role: string; owner: "shared" | "private"; required: true | "bound"; default: string }>;
  compositionTemplate: { equipment: SemanticRef[] };
  coordinationTemplate: Pick<CoordinationPolicy, "roles" | "resolution" | "dispatchEnvelope" | "fallbacks">;
  projections: { portable: string[]; local: string[] };
  newResolver: { questions: string[]; variables: string[]; exclusions: string[] };
  sourceContracts: Record<SourceContractId, LoadedSourceContract>;
  affordances: Record<string, { contract: AffordanceContract; instructions: string; revision: Revision }>;
  defaults: Record<string, string>;
};

export type Equipment = {
  kind: "Equipment";
  ref: SemanticRef;
  id: string;
  compatibleProfiles: string[];
  methods: MethodDefinition[];
};

export type Composition = {
  kind: "Composition";
  ref: SemanticRef;
  equipment: SemanticRef[];
};

export type ProviderSurfaceTarget = {
  provider: string;
  kind: "front-door" | "skill" | "command" | "view" | "startup" | "agent";
  path: string;
  discovery: "automatic" | "model-selected" | "human-explicit" | "manual";
  loadGuarantee: "qualified" | "unproven";
};

export type WorkplaceBuildContract = {
  kind: "WorkplaceBuildContract";
  version: 2;
  workplace: SemanticRef;
  profile: { ref: SemanticRef; path?: string; revision?: Revision };
  composition: { ref: SemanticRef; path?: string; revision?: Revision };
  roots: string[];
  policy: {
    disclosureSelectors: string[];
    localBuildIntent: "bounded-work-and-site";
    delivery: "explicit-human-only";
  };
  distributionTargets: ProviderSurfaceTarget[];
};

export type EntryBinding = {
  kind: "EntryBinding";
  workplace: SemanticRef;
  member: SemanticRef;
  desk: SemanticRef;
  rootBindings: Record<string, string>;
};

export type ConcreteToolBinding = {
  trait: string;
  tool: string;
  provider?: string;
  availability: "available" | "missing" | "degraded";
  command?: string[];
};

export type ProviderBinding = {
  kind: "ProviderBinding";
  provider: string;
  targets: ProviderSurfaceTarget[];
  tools: ConcreteToolBinding[];
};

export type CoordinationRole = "main" | "manager" | "worker";

export type CoordinationPolicy = {
  kind: "CoordinationPolicy";
  version: 1;
  ref: SemanticRef;
  roles: Record<CoordinationRole, { owns: string[]; never: string[] }>;
  resolution: Array<{
    id: string;
    when: {
      rootCount: "one" | "multiple";
      effectCount: "zero" | "one" | "multiple";
      integration: boolean;
      contextClass: "bounded" | "substantial";
    };
    sequence: CoordinationRole[];
  }>;
  dispatchEnvelope: string[];
  fallbacks: {
    ambiguous: "ask-once-zero-write";
    missingAuthority: "blocked";
    noSubagents: "degraded" | "blocked";
    inlineWorker: "forbidden" | "single-scope-explicit";
  };
};

export type CoordinationIR = {
  kind: "CoordinationIR";
  version: 1;
  workplace: SemanticRef;
  policy: { ref: SemanticRef; revision: Revision };
  roles: CoordinationPolicy["roles"];
  resolution: CoordinationPolicy["resolution"];
  dispatchEnvelope: string[];
  provider: {
    status: "neutral" | "available" | "degraded";
    targets: Array<{ provider: string; role: "manager" | "worker"; loadGuarantee: "qualified" | "unproven" }>;
    fallback: CoordinationPolicy["fallbacks"];
  };
};

export type Diagnostic = {
  severity: "error" | "warning";
  code: string;
  subject: string;
  message: string;
};
