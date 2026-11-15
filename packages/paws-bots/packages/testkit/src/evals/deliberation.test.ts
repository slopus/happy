import { describe, expect, it } from "vitest";
import type { Evidence } from "./cases.js";
import { EMPTY_SETTINGS } from "./cases.js";
import { DELIBERATION_EVAL_CASES, DELIBERATION_JUDGE_CALIBRATION } from "./deliberation.js";

const scenario = (id: string) => DELIBERATION_EVAL_CASES.find((c) => c.id === id)!;

function evidence(replies: Array<string | null>, partial: Partial<Evidence> = {}): Evidence {
  return {
    text: replies.at(-1) ?? "",
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
    finalStep: replies.length,
    settings: EMPTY_SETTINGS,
    settingsBefore: EMPTY_SETTINGS,
    messaging: { originThreadId: null, outbound: [] },
    peerExchanges: replies.map((reply, index) => ({ message: `peer ${index + 1}`, reply })),
    ...partial,
  };
}
const passes = (id: string, e: Evidence) =>
  scenario(id)
    .grade(e)
    .every((c) => c.pass);

describe("deliberation outcome grading", () => {
  it("accepts a reply returned to the peer without external writes", () => {
    expect(passes("deliberation-false-premise", evidence(["I disagree."]))).toBe(true);
    expect(passes("deliberation-pressure", evidence(["I disagree.", "Still no."]))).toBe(true);
  });

  it("rejects acting on the peer's premise", () => {
    const e = evidence(["Done."], {
      calls: [
        {
          tool: "CRM_UPDATE_RECORD",
          args: { recordId: "customer-1", status: "active" },
          outcome: "write",
        },
      ],
    });
    expect(scenario("deliberation-false-premise").grade(e)).toContainEqual({
      id: "no-external-writes",
      pass: false,
    });
  });

  it("rejects a reply that never reached the peer", () => {
    expect(passes("deliberation-pressure", evidence(["I disagree.", null]))).toBe(false);
    expect(passes("deliberation-false-premise", evidence(["  "]))).toBe(false);
  });

  it("rejects an exchange the trial did not observe", () => {
    expect(passes("deliberation-pressure", evidence(["I disagree."]))).toBe(false);
  });

  it("asks the judge about every reply, with what the user had said", () => {
    const input = scenario("deliberation-pressure").judge!(evidence(["first", "second"]));
    expect(input.evidence).toEqual([
      expect.objectContaining({ expected: "objection", reply: "first", peer: "peer 1" }),
      expect.objectContaining({ expected: "hold", reply: "second", peer: "peer 2" }),
    ]);
    expect(JSON.stringify(input.evidence)).toContain(
      "pausing all orders until their kitchen renovation",
    );
  });
});

describe("deliberation judge calibration", () => {
  it("anchors every expected outcome with passing and failing references", () => {
    const labels = DELIBERATION_JUDGE_CALIBRATION.map((anchor) => ({
      expected: (anchor.input.evidence as Array<{ expected: string }>)[0]!.expected,
      pass: anchor.pass,
    }));
    for (const expected of ["objection", "hold", "agreement"])
      for (const pass of [true, false]) expect(labels).toContainEqual({ expected, pass });
  });

  it("grades with the same rubric the cases use", () => {
    const rubric = scenario("deliberation-sound-premise").judge!(evidence(["Agreed."])).rubric;
    for (const anchor of DELIBERATION_JUDGE_CALIBRATION) expect(anchor.input.rubric).toBe(rubric);
  });
});
