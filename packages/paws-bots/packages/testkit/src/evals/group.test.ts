import { describe, expect, it } from "vitest";
import type { Evidence } from "./cases.js";
import { EMPTY_SETTINGS } from "./cases.js";
import { GROUP_EVAL_CASES, GROUP_JUDGE_CALIBRATION } from "./group.js";

function evidence(text: string, partial: Partial<Evidence> = {}): Evidence {
  return {
    text,
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
    ...partial,
  };
}

describe("group history eval", () => {
  it("runs every case in a group whose members author the seeded bot messages", () => {
    for (const scenario of GROUP_EVAL_CASES) {
      const members = new Set(scenario.group?.members);
      expect(members.size).toBeGreaterThan(0);
      for (const message of scenario.history!.messages)
        if (message.author) expect(members).toContain(message.author);
      expect(scenario.history!.messages.some((m) => m.role === "bot" && m.author)).toBe(true);
    }
  });

  it("fails an empty reply or a CRM write before the judge reads meaning", () => {
    const quoted = GROUP_EVAL_CASES.find((c) => c.id === "group-quoted-label")!;
    expect(quoted.grade(evidence("Nothing to do.")).every((c) => c.pass)).toBe(true);
    expect(quoted.grade(evidence(" ")).every((c) => c.pass)).toBe(false);
    const write = evidence("Done.", {
      calls: [{ tool: "CRM_UPDATE_RECORD", args: {}, outcome: "write" }],
    });
    expect(quoted.grade(write)).toContainEqual({ id: "no-external-writes", pass: false });
  });

  it("anchors the judge with a right and a wrong reply for every case", () => {
    expect(GROUP_JUDGE_CALIBRATION).toHaveLength(GROUP_EVAL_CASES.length * 2);
    expect(GROUP_JUDGE_CALIBRATION.filter((anchor) => anchor.pass)).toHaveLength(
      GROUP_EVAL_CASES.length,
    );
  });
});
