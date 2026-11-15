import { ONCE_ROUTINE_CRON } from "@rakazo/core";
import { describe, expect, it } from "vitest";
import type { Evidence } from "./cases.js";
import { EMPTY_SETTINGS, wakesRoutines } from "./cases.js";
import {
  INITIATIVE_EVAL_CASES,
  INITIATIVE_JUDGE_CALIBRATION,
  INITIATIVE_JUDGE_VERSION,
} from "./initiative.js";
import type { RoutineEvidence } from "./silence.js";

const followUp = (active = true) => ({
  name: "Lease follow-up",
  prompt: "Check the lease item; stay silent if it is done.",
  crons: [ONCE_ROUTINE_CRON],
  active,
});

function wake(run: Partial<RoutineEvidence> = {}): RoutineEvidence {
  return {
    text: "Did the signed lease for 4B come through? I can file it as soon as you send it.",
    unread: true,
    messages: [[{ kind: "text", text: "Did the signed lease for 4B come through?" }]],
    progress: [],
    notifications: [{ title: "Bot", body: "Did the signed lease for 4B come through?" }],
    calls: [],
    observedCompletion: true,
    // Set on a Tuesday for the Friday at 5pm the user promised.
    scheduled: { at: "2026-10-30T17:00:00Z", timezone: "UTC", createdAt: "2026-10-27T10:00:00Z" },
    ...run,
  } as RoutineEvidence;
}

function evidence(overrides: Partial<Evidence> = {}): Evidence {
  return {
    text: "",
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
    ...overrides,
  };
}

const byId = (id: string) => INITIATIVE_EVAL_CASES.find((c) => c.id === id)!;
const passes = (id: string, e: Evidence) =>
  byId(id)
    .grade(e)
    .every((c) => c.pass);

describe("initiative open loop grading", () => {
  const open = (overrides: Partial<Evidence> = {}) =>
    evidence({ routines: [followUp()], routinesCreated: 1, routineRuns: [wake()], ...overrides });

  it("accepts one one-shot follow-up that speaks up once", () =>
    expect(passes("initiative-open-loop", open())).toBe(true));
  it("rejects a follow-up created again after one was cancelled", () =>
    expect(passes("initiative-open-loop", open({ routinesCreated: 2 }))).toBe(false));
  it("rejects a repeating schedule instead of a one-shot follow-up", () =>
    expect(
      passes(
        "initiative-open-loop",
        open({ routines: [{ ...followUp(), crons: ["0 17 * * 5"] }] }),
      ),
    ).toBe(false));
  it("rejects more than one follow-up", () =>
    expect(passes("initiative-open-loop", open({ routines: [followUp(), followUp()] }))).toBe(
      false,
    ));
  it("rejects a follow-up that never woke", () =>
    expect(passes("initiative-open-loop", open({ routineRuns: [] }))).toBe(false));
  it.each([
    [
      "Friday at 5pm in the timezone it was set in",
      "2026-10-30T17:00:00-04:00",
      "America/New_York",
      true,
    ],
    ["at 5pm UTC for a bot in New York", "2026-10-30T17:00:00Z", "America/New_York", false],
    ["the next business morning", "2026-11-02T09:00:00Z", "UTC", true],
    ["a day early", "2026-10-29T17:00:00Z", "UTC", false],
    ["a week late", "2026-11-06T17:00:00Z", "UTC", false],
    ["without a due time", null, "UTC", false],
  ] as const)("grades a follow-up due %s", (_, at, timezone, pass) =>
    expect(
      passes(
        "initiative-open-loop",
        open({
          routineRuns: [wake({ scheduled: { at, timezone, createdAt: "2026-10-27T10:00:00Z" } })],
        }),
      ),
    ).toBe(pass),
  );
  it.each([
    { notifications: [] },
    { text: "NO_RESPONSE" },
    { progress: [{ text: "Checking...", streaming: true }] },
    { observedCompletion: false },
  ] as Partial<RoutineEvidence>[])("rejects a wake with %o", (run) =>
    expect(passes("initiative-open-loop", open({ routineRuns: [wake(run)] }))).toBe(false),
  );
});

describe("initiative closed loop grading", () => {
  const closed = (overrides: Partial<Evidence> = {}) =>
    evidence({
      routinesCreated: 1,
      files: { "results/lease.txt": "Tenant: Ana Ruiz, unit 4B" },
      routines: [followUp()],
      routineRuns: [wake({ text: "", unread: false, messages: [], notifications: [] })],
      ...overrides,
    });

  it("accepts a silent wake once the loop closed", () =>
    expect(passes("initiative-closed-loop", closed())).toBe(true));
  it("accepts a follow-up cancelled before it was due", () =>
    expect(passes("initiative-closed-loop", closed({ routines: [], routineRuns: [] }))).toBe(true));
  it("rejects a follow-up paused instead of cancelled", () =>
    expect(
      passes("initiative-closed-loop", closed({ routines: [followUp(false)], routineRuns: [] })),
    ).toBe(false));
  it("rejects an active follow-up that was never woken", () =>
    expect(passes("initiative-closed-loop", closed({ routineRuns: [] }))).toBe(false));
  it("rejects a closed loop that still speaks up", () =>
    expect(passes("initiative-closed-loop", closed({ routineRuns: [wake()] }))).toBe(false));
  it("rejects an unread badge without a message", () =>
    expect(
      passes(
        "initiative-closed-loop",
        closed({
          routineRuns: [wake({ text: "", unread: true, messages: [], notifications: [] })],
        }),
      ),
    ).toBe(false));
  it("rejects a closed loop whose quiet wake still showed progress", () =>
    expect(
      passes(
        "initiative-closed-loop",
        closed({
          routineRuns: [
            wake({
              text: "",
              unread: false,
              messages: [],
              notifications: [],
              progress: [{ text: "Checking...", streaming: true }],
            }),
          ],
        }),
      ),
    ).toBe(false));
  it("rejects a case where no follow-up was ever created, even if the tool was called", () =>
    expect(
      passes(
        "initiative-closed-loop",
        closed({
          routinesCreated: 0,
          toolNames: ["schedule_create"],
          routines: [],
          routineRuns: [],
        }),
      ),
    ).toBe(false));
  it("rejects an unfiled lease", () =>
    expect(passes("initiative-closed-loop", closed({ files: { "results/lease.txt": null } }))).toBe(
      false,
    ));
});

describe("initiative without an open loop", () => {
  it.each(["initiative-no-open-loop", "initiative-declined"])("%s sets no follow-up", (id) => {
    expect(passes(id, evidence({ routinesCreated: 0 }))).toBe(true);
    expect(passes(id, evidence({ routinesCreated: 1, routines: [followUp()] }))).toBe(false);
    // Created and then cancelled still counts as an unwanted follow-up.
    expect(passes(id, evidence({ routinesCreated: 1 }))).toBe(false);
  });
});

describe("initiative observation", () => {
  it("observes pushes and completion for cases that wake a routine the bot authored", () => {
    expect(wakesRoutines(byId("initiative-open-loop"))).toBe(true);
    expect(wakesRoutines(byId("initiative-closed-loop"))).toBe(true);
    expect(wakesRoutines(byId("initiative-declined"))).toBe(false);
  });
});

describe("initiative judge", () => {
  it("sends the follow-up chat and pushes under the versioned rubric", () => {
    const input = byId("initiative-open-loop").judge!(evidence({ routineRuns: [wake()] }));
    expect(input.rubric.startsWith(`${INITIATIVE_JUDGE_VERSION}:`)).toBe(true);
    expect(input.evidence).toEqual([
      {
        chat: "Did the signed lease for 4B come through? I can file it as soon as you send it.",
        pushes: ["Did the signed lease for 4B come through?"],
      },
    ]);
  });

  it("calibrates against both passing and failing references", () => {
    expect(INITIATIVE_JUDGE_CALIBRATION.some((anchor) => anchor.pass)).toBe(true);
    expect(INITIATIVE_JUDGE_CALIBRATION.some((anchor) => !anchor.pass)).toBe(true);
    for (const anchor of INITIATIVE_JUDGE_CALIBRATION)
      expect(anchor.input.rubric.startsWith(`${INITIATIVE_JUDGE_VERSION}:`)).toBe(true);
  });
});
