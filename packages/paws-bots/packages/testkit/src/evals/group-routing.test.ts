import { describe, expect, it } from "vitest";
import type { Evidence } from "./cases.js";
import { EMPTY_SETTINGS } from "./cases.js";
import { GROUP_ROUTING_EVAL_CASES } from "./group-routing.js";

function evidence(memberReplies: Record<string, string>): Evidence {
  return {
    text: memberReplies.Assistant ?? "",
    memberReplies,
    files: {},
    records: [],
    notes: [],
    calls: [],
    routines: [],
    memory: "",
    approvalPending: false,
    pendingApproval: null,
    priorMemory: "",
    toolNames: [],
    toolCalls: [],
    finalStep: 1,
    settings: EMPTY_SETTINGS,
    settingsBefore: EMPTY_SETTINGS,
    messaging: { originThreadId: null, outbound: [] },
  };
}

const quiet = { Assistant: "", Mika: "", Theo: "", Ines: "", Ravi: "" };
const grade = (id: string, replies: Record<string, string>) =>
  GROUP_ROUTING_EVAL_CASES.find((c) => c.id === id)!
    .grade(evidence({ ...quiet, ...replies }))
    .filter((criterion) => !criterion.pass)
    .map((criterion) => criterion.id);

describe("group routing eval", () => {
  it("sends every case to its whole group without naming anyone", () => {
    for (const scenario of GROUP_ROUTING_EVAL_CASES) {
      expect(scenario.steps).toEqual([{ ask: expect.any(String), unaddressed: true }]);
      expect(scenario.group?.members.length).toBeGreaterThan(0);
      expect(Object.keys(scenario.group?.roles ?? {})).toContain("Assistant");
    }
  });

  it("requires the owner to answer, not another member answering for it", () => {
    expect(grade("routing-engineering-question", { Theo: "Check what holds the lock." })).toEqual(
      [],
    );
    expect(grade("routing-engineering-question", { Assistant: "Check the lock." })).toEqual([
      "theo-answered",
    ]);
  });

  it("needs both peers for a question about both", () => {
    expect(grade("routing-peers-compare", { Assistant: "0.45%.", Kai: "0.85%." })).toEqual([]);
    expect(grade("routing-peers-compare", { Assistant: "Workplace is cheaper." })).toEqual([
      "kai-answered",
      "at-least-2-posting",
    ]);
  });

  it("fails a pile-on and passes silence where nothing is needed", () => {
    expect(
      grade("routing-greeting", { Assistant: "Morning!", Mika: "Morning!", Theo: "Hi!" }),
    ).toEqual(["at-most-2-posting"]);
    expect(grade("routing-sign-off", {})).toEqual([]);
    expect(grade("routing-no-owner", {})).toEqual(["at-least-1-posting"]);
  });
});
