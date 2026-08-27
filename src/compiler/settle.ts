export type MatterDisposition = "drop" | "work" | "material" | "decision" | "artifact" | "desk" | "site";

export type SettleMatter = {
  id: string;
  summary: string;
  contentClass: "observation" | "result" | "transcript" | "reasoning" | "secret";
  disposition: MatterDisposition;
  owner?: string;
  root?: string;
  shelf?: string;
  humanAccepted?: boolean;
};

export type SettlePlan = {
  kind: "SettlePlan";
  meeting: string;
  during: "settling";
  after: "active" | "closed";
  dropped: string[];
  sourceBatches: Array<{
    root: string;
    items: Array<{ matter: string; entity: "work" | "material" | "place"; roles: string[]; owner: string; shelf: string }>;
  }>;
  preparedSiteEffects: Array<{ matter: string; owner: string; root: string }>;
  projections: ["register", "ledger", "views"];
  forbiddenEffects: ["accept", "publish", "host", "deliver", "create-authority"];
};

const ID = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const REF = /^workplace:\/\/[a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*)+$/;

function fail(message: string): never { throw new Error(message); }

export function planSettle(input: { meeting: string; disposition: "close" | "resume"; matters: SettleMatter[] }): SettlePlan {
  if (!REF.test(input.meeting)) fail("settle requires one portable Meeting Ref");
  if (!Array.isArray(input.matters)) fail("settle matters must be an array");
  const ids = new Set<string>();
  const dropped: string[] = [];
  const source = new Map<string, SettlePlan["sourceBatches"][number]["items"]>();
  const sites: SettlePlan["preparedSiteEffects"] = [];
  for (const matter of input.matters) {
    if (!ID.test(matter.id) || ids.has(matter.id)) fail(`Matter id is invalid or duplicated: ${matter.id}`);
    ids.add(matter.id);
    if (!matter.summary.trim() || matter.summary.length > 500) fail(`Matter ${matter.id} summary is invalid`);
    if (["transcript", "reasoning", "secret"].includes(matter.contentClass)) fail(`Matter ${matter.id} contains forbidden ${matter.contentClass}`);
    if (matter.disposition === "drop") { dropped.push(matter.id); continue; }
    if (!matter.owner || !REF.test(matter.owner) || !matter.root || !REF.test(matter.root)) fail(`Matter ${matter.id} requires owner and Root Refs`);
    if (matter.disposition === "site") { sites.push({ matter: matter.id, owner: matter.owner, root: matter.root }); continue; }
    if (!matter.shelf || !REF.test(matter.shelf)) fail(`Matter ${matter.id} requires one Shelf placement`);
    if (matter.disposition === "decision" && matter.humanAccepted !== true) fail(`Matter ${matter.id} cannot become a Decision without explicit human judgment`);
    const entity = matter.disposition === "work" ? "work" : matter.disposition === "desk" ? "place" : "material";
    const roles = matter.disposition === "work" ? ["initiative"] : matter.disposition === "material" ? ["meeting-contribution"] : matter.disposition === "decision" ? ["decision"] : matter.disposition === "artifact" ? ["artifact"] : ["desk"];
    const items = source.get(matter.root) ?? [];
    items.push({ matter: matter.id, entity, roles, owner: matter.owner, shelf: matter.shelf });
    source.set(matter.root, items);
  }
  return {
    kind: "SettlePlan",
    meeting: input.meeting,
    during: "settling",
    after: input.disposition === "close" ? "closed" : "active",
    dropped: dropped.sort(),
    sourceBatches: [...source.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([root, items]) => ({ root, items: items.sort((a, b) => a.matter.localeCompare(b.matter)) })),
    preparedSiteEffects: sites.sort((a, b) => a.matter.localeCompare(b.matter)),
    projections: ["register", "ledger", "views"],
    forbiddenEffects: ["accept", "publish", "host", "deliver", "create-authority"],
  };
}
