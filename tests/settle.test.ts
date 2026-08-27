import { describe, expect, test } from "bun:test";
import { planSettle, type SettleMatter } from "../src/compiler/index.ts";

describe("settle cascade", () => {
  const base = {
    owner: "workplace://demo/member/alexis",
    root: "workplace://demo/root/shared",
    shelf: "workplace://demo/room/product/shelf/material",
    contentClass: "result" as const,
  };

  test("separates Root batches, placements and prepared Site effects", () => {
    const matters: SettleMatter[] = [
      { id: "noise", summary: "No durable consequence.", contentClass: "observation", disposition: "drop" },
      { ...base, id: "work", summary: "Continue the bounded implementation.", disposition: "work" },
      { ...base, id: "evidence", summary: "Reusable observed evidence.", disposition: "material" },
      { ...base, id: "choice", summary: "Human accepted the chosen boundary.", disposition: "decision", humanAccepted: true },
      { ...base, id: "contract", summary: "Inspectible output contract.", disposition: "artifact" },
      { ...base, id: "preference", summary: "Personal durable interaction preference.", disposition: "desk", root: "workplace://demo/root/private" },
      { ...base, id: "site", summary: "A separately authorized Site edit may follow.", disposition: "site", root: "workplace://demo/root/site" },
    ];
    const plan = planSettle({ meeting: "workplace://demo/meeting/current", disposition: "close", matters });
    expect(plan.after).toBe("closed");
    expect(plan.dropped).toEqual(["noise"]);
    expect(plan.sourceBatches).toHaveLength(2);
    expect(plan.sourceBatches.flatMap((batch) => batch.items).find((item) => item.matter === "choice")?.roles).toEqual(["decision"]);
    expect(plan.sourceBatches.flatMap((batch) => batch.items).find((item) => item.matter === "contract")?.entity).toBe("material");
    expect(plan.preparedSiteEffects).toEqual([{ matter: "site", owner: base.owner, root: "workplace://demo/root/site" }]);
    expect(plan.forbiddenEffects).toContain("deliver");
    expect(JSON.stringify(plan)).not.toContain("transcript");
  });

  test("rejects unaccepted Decisions and unsafe retention classes", () => {
    expect(() => planSettle({ meeting: "workplace://demo/meeting/current", disposition: "resume", matters: [{ ...base, id: "choice", summary: "Candidate only.", disposition: "decision" }] })).toThrow("explicit human judgment");
    for (const contentClass of ["transcript", "reasoning", "secret"] as const) {
      expect(() => planSettle({ meeting: "workplace://demo/meeting/current", disposition: "resume", matters: [{ ...base, id: contentClass, summary: "Unsafe.", contentClass, disposition: "material" }] })).toThrow(`forbidden ${contentClass}`);
    }
  });
});
