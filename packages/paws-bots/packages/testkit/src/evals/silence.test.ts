import type { AdapterContext, ConnectorCall } from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import type { Evidence } from "./cases.js";
import { EMPTY_SETTINGS } from "./cases.js";
import { EvalServices } from "./services.js";
import type { RoutineEvidence } from "./silence.js";
import { SILENCE_EVAL_CASES } from "./silence.js";

function evidence(run: Partial<RoutineEvidence> = {}): Evidence {
  const routineRun: RoutineEvidence = {
    text: "",
    unread: false,
    messages: [],
    progress: [],
    notifications: [],
    calls: [
      { tool: "GITHUB_LIST_RELEASES", args: { owner: "example", repo: "widget" }, outcome: "read" },
    ],
    observedCompletion: true,
    ...run,
  };
  return {
    text: routineRun.text,
    files: {},
    records: [],
    notes: [],
    calls: routineRun.calls,
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
    routineRuns: [routineRun],
  };
}
const grade = (e: Evidence) => SILENCE_EVAL_CASES[0]!.grade(e);
const passes = (e: Evidence) => grade(e).every((c) => c.pass);

describe("silence outcome grading", () => {
  it("accepts a verified quiet check", () => expect(passes(evidence())).toBe(true));
  it.each([
    { kind: "text", text: "No changes." },
    { kind: "text", text: "NO_RESPONSE" },
    { kind: "text", text: "" },
    { kind: "progress", text: "Checking now." },
  ] as MessageBlock[])("rejects a persisted $kind block even with an empty final text", (block) => {
    expect(passes(evidence({ messages: [[block]] }))).toBe(false);
  });
  it("rejects an empty persisted bubble", () =>
    expect(passes(evidence({ messages: [[]] }))).toBe(false));
  it("allows hidden tool audit blocks", () => {
    expect(passes(evidence({ messages: [[{ kind: "steps", steps: [] }]] }))).toBe(true);
  });
  it("rejects an unread badge without a message", () =>
    expect(passes(evidence({ unread: true }))).toBe(false));
  it("rejects transient progress already removed from chat", () => {
    expect(passes(evidence({ progress: [{ text: "Checking...", streaming: true }] }))).toBe(false);
  });
  it("rejects a notification without a chat bubble", () => {
    expect(
      passes(
        evidence({
          notifications: [
            {
              kind: "completion",
              title: "Done",
              body: "All clear",
              botId: "bot",
              threadId: "thread",
            },
          ],
        }),
      ),
    ).toBe(false);
  });
  it("rejects silence without checking the source", () =>
    expect(passes(evidence({ calls: [] }))).toBe(false));
  it("rejects a failed source check", () => {
    expect(
      passes(
        evidence({
          calls: [
            {
              tool: "GITHUB_LIST_RELEASES",
              args: { owner: "example", repo: "widget" },
              outcome: "rejected",
            },
          ],
        }),
      ),
    ).toBe(false);
  });
  it("rejects missing observation instead of treating it as silence", () => {
    const e = evidence();
    delete e.routineRuns;
    expect(passes(e)).toBe(false);
    expect(passes(evidence({ observedCompletion: false }))).toBe(false);
  });
  it("rejects writes in earlier wakes too", () => {
    const e = evidence();
    e.routineRuns!.push({
      ...e.routineRuns![0]!,
      calls: [{ tool: "CRM_CREATE_NOTE", args: {}, outcome: "write" }],
    });
    expect(SILENCE_EVAL_CASES[2]!.grade(e)).toContainEqual({
      id: "no-external-writes",
      pass: false,
    });
  });
});

describe("source-read evidence", () => {
  const context: AdapterContext = {
    operationId: "synthetic",
    traceId: "synthetic",
    spaceId: "space",
    userId: "user",
    signal: new AbortController().signal,
  };
  it("does not credit a missing latest release as an empty successful listing", async () => {
    const services = new EvalServices();
    services.seedGithubReleases([]);
    const args = { owner: "example", repo: "widget" };
    const events = [];
    const github = {
      id: "github",
      connectorId: "composio",
      externalId: "GITHUB",
      displayName: "GitHub",
    };
    for await (const event of services.execute(
      { tool: "GITHUB_GET_RELEASE", args, executionId: "synthetic" } as ConnectorCall,
      { ...context, connectedConnections: [github] },
    ))
      events.push(event);
    expect(events).toContainEqual({
      type: "result",
      data: expect.objectContaining({ data: expect.objectContaining({ ok: false }) }),
    });
    expect(services.calls[0]?.outcome).toBe("rejected");
    const e = evidence({ calls: services.calls });
    expect(SILENCE_EVAL_CASES[1]!.grade(e)).toContainEqual({
      id: "wake-1-source-checked",
      pass: false,
    });
  });
  it("does not credit a successful lookup of an old release as a current check", () => {
    expect(
      passes(
        evidence({
          calls: [
            {
              tool: "GITHUB_GET_RELEASE",
              args: { owner: "example", repo: "widget", tag: "v2.1.0" },
              outcome: "read",
            },
          ],
        }),
      ),
    ).toBe(false);
  });
  it("credits a successful latest-release lookup", () => {
    expect(
      passes(
        evidence({
          calls: [
            {
              tool: "GITHUB_GET_RELEASE",
              args: { owner: "example", repo: "widget" },
              outcome: "read",
            },
          ],
        }),
      ),
    ).toBe(true);
  });
});

describe("semantic grading boundary", () => {
  it("leaves wording to the judge with the reply and push as evidence", () => {
    const e = evidence({ text: "Any phrasing or language." });
    const scenario = SILENCE_EVAL_CASES[3]!;
    expect(scenario.judge?.(e).evidence).toEqual([
      { outcome: "failure", chat: e.text, pushes: [] },
    ]);
    expect(scenario.grade(e).map((c) => c.id)).not.toContain("wake-1-no-false-all-clear");
  });
});
