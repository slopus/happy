import { describe, expect, it } from "vitest";
import { observationToolResult } from "./computer-tools.js";
import {
  advanceOverLimitActionCalls,
  advanceToolCallLoopGuard,
  isLoopGuardStopText,
  loopGuardStopText,
  MAX_CONSECUTIVE_OVER_LIMIT_ACTION_CALLS,
  overLimitStopText,
  toolCallStreakLength,
  toolResultFingerprint,
} from "./tool-loop.js";

const answer = (text: string) => toolResultFingerprint({ content: [{ type: "text", text }] });
const failure = (text = "missing script") => toolResultFingerprint(undefined, new Error(text));

/** The call that stops one command repeated with `seen(call)` as each call's answer, if any. */
function identicalStopsAt(seen: (call: number) => string | undefined) {
  let streak = { key: undefined as string | undefined, count: 0 };
  let previous: string | undefined;
  for (let call = 1; call <= 60; call += 1) {
    const result = advanceToolCallLoopGuard(streak, "shell", { command: "cat job.log" }, previous);
    streak = result.streak;
    if (result.stuck) return call;
    previous = seen(call);
  }
  return undefined;
}

describe("advanceToolCallLoopGuard", () => {
  it("allows a parallel Open Connector batch with distinct action inputs", () => {
    let streak = { key: undefined as string | undefined, count: 0 };

    for (let index = 0; index < 20; index += 1) {
      const result = advanceToolCallLoopGuard(streak, "mcp__open-connector__execute_action", {
        actionId: "records.get",
        input: { recordId: index + 1 },
      });
      streak = result.streak;
      expect(result.stuck).toBe(false);
    }
  });

  it("stops six consecutive identical calls that return the same tool error", () => {
    let streak = { key: undefined as string | undefined, count: 0 };
    let stuck = false;

    for (let index = 0; index < 6; index += 1) {
      const result = advanceToolCallLoopGuard(streak, "shell", { command: "npm test" }, failure());
      streak = result.streak;
      stuck = result.stuck;
    }

    expect(stuck).toBe(true);
    expect(streak.count).toBe(6);
  });

  it.each([
    [
      { command: "npm test", cwd: "/workspace" },
      { cwd: "/workspace", command: "npm test" },
    ],
    [
      { input: { command: "npm test", cwd: "/workspace" } },
      { input: { cwd: "/workspace", command: "npm test" } },
    ],
    [
      { actions: [{ kind: "click", ref: "target" }] },
      { actions: [{ ref: "target", kind: "click" }] },
    ],
  ])("stops repeated failures despite object field order: %j", (first, second) => {
    let streak = { key: undefined as string | undefined, count: 0 };
    let stoppedAt: number | undefined;
    for (let call = 1; call <= 40; call += 1) {
      const result = advanceToolCallLoopGuard(
        streak,
        "fixture_tool",
        call % 2 ? first : second,
        failure(),
      );
      streak = result.streak;
      if (result.stuck) {
        stoppedAt = call;
        break;
      }
    }
    expect(stoppedAt).toBe(6);
    expect(streak.count).toBe(6);
  });

  it("counts similar text arguments despite reordered fields", () => {
    let streak = { key: undefined as string | undefined, count: 0 };
    let stoppedAt: number | undefined;
    for (let call = 1; call <= 40; call += 1) {
      const command = `echo noop-${call}`;
      const args = call % 2 ? { command, cwd: "/workspace" } : { cwd: "/workspace", command };
      const result = advanceToolCallLoopGuard(streak, "shell", args, failure());
      streak = result.streak;
      if (result.stuck) {
        stoppedAt = call;
        break;
      }
    }
    expect(stoppedAt).toBe(25);
  });

  it("keeps polling new results when argument fields are reordered", () => {
    let streak = { key: undefined as string | undefined, count: 0 };
    for (let call = 1; call <= 60; call += 1) {
      const args =
        call % 2
          ? { command: "cat job.log", cwd: "/workspace" }
          : { cwd: "/workspace", command: "cat job.log" };
      const result = advanceToolCallLoopGuard(streak, "shell", args, answer(`Progress ${call}`));
      streak = result.streak;
      expect(result.stuck).toBe(false);
    }
  });

  it("counts reordered identical calls only once in a model response", () => {
    const first = advanceToolCallLoopGuard(
      { key: undefined, count: 0 },
      "shell",
      { command: "npm test", cwd: "/workspace" },
      failure(),
      1,
    );
    const repeated = advanceToolCallLoopGuard(
      first.streak,
      "shell",
      { cwd: "/workspace", command: "npm test" },
      failure(),
      1,
    );
    expect(repeated.streak).toBe(first.streak);
    expect(repeated.stuck).toBe(false);
  });

  it.each([
    [
      [{ ref: "alpha" }, { ref: "beta" }],
      [{ ref: "beta" }, { ref: "alpha" }],
    ],
    [{ field1: "value" }, { field2: "value" }],
  ])("keeps array order and object field names significant: %j", (first, second) => {
    let streak = { key: undefined as string | undefined, count: 0 };
    for (let call = 1; call <= 40; call += 1) {
      const result = advanceToolCallLoopGuard(
        streak,
        "fixture_tool",
        { input: call % 2 ? first : second },
        failure(),
      );
      streak = result.streak;
      expect(result.stuck).toBe(false);
    }
  });

  it("accepts omitted optional arguments represented by undefined", () => {
    const result = advanceToolCallLoopGuard({ key: undefined, count: 0 }, "ask_user", {
      question: "Continue?",
      options: undefined,
    });
    const repeated = advanceToolCallLoopGuard(result.streak, "ask_user", { question: "Continue?" });
    expect(repeated.streak.count).toBe(2);
    expect(repeated.stuck).toBe(false);
  });

  it("stops calls that differ only by a number in a text argument", () => {
    let streak = { key: undefined as string | undefined, count: 0 };
    let calls = 0;
    let stuck = false;

    while (!stuck && calls < 50) {
      calls += 1;
      const result = advanceToolCallLoopGuard(streak, "shell", { command: `echo noop-${calls}` });
      streak = result.streak;
      stuck = result.stuck;
    }

    expect(calls).toBe(25);
    expect(toolCallStreakLength(streak)).toBe(25);
  });

  it("reports the run that stopped it, identical or near-identical, in the stop text", () => {
    const stopText = (command: (call: number) => string) => {
      let streak = { key: undefined as string | undefined, count: 0 };
      for (let call = 1; call < 50; call += 1) {
        const result = advanceToolCallLoopGuard(
          streak,
          "shell",
          { command: command(call) },
          failure(),
        );
        streak = result.streak;
        if (result.stuck) return loopGuardStopText("shell", streak);
      }
      throw new Error("never stopped");
    };

    expect(stopText(() => "npm test")).toContain(" with the same input 6 times in a row");
    expect(stopText((call) => `echo noop-${call}`)).toContain(
      " with nearly the same input 25 times",
    );
    expect(isLoopGuardStopText(stopText(() => "npm test"))).toBe(true);
    expect(isLoopGuardStopText("An ordinary reply")).toBe(false);
    expect(isLoopGuardStopText(stopText((call) => `echo noop-${call}`))).toBe(true);
  });

  it("keeps the identical stop count when a longer similar streak precedes it", () => {
    let streak = { key: undefined as string | undefined, count: 0 };
    for (let call = 1; call <= 10; call += 1) {
      streak = advanceToolCallLoopGuard(streak, "shell", { command: `echo noop-${call}` }).streak;
    }
    for (let call = 0; call < 6; call += 1) {
      streak = advanceToolCallLoopGuard(
        streak,
        "shell",
        { command: "echo noop-11" },
        failure(),
      ).streak;
    }
    expect(loopGuardStopText("shell", streak)).toContain(" with the same input 6 times in a row");
  });

  it.each([
    ["shell", (n: number) => ({ command: `sed -n '${n * 100},${n * 100 + 99}p' big.log` })],
    ["browser_act", (n: number) => ({ actions: [{ kind: "click", ref: `e${n + 2}` }] })],
    ["browser_navigate", (n: number) => ({ url: `https://fixture.test/list?page=${n}` })],
  ])("lets a 12-step %s sequence that differs only by numbers finish", (name, input) => {
    let streak = { key: undefined as string | undefined, count: 0 };
    for (let step = 1; step <= 12; step += 1) {
      const result = advanceToolCallLoopGuard(streak, name, input(step));
      streak = result.streak;
      expect(result.stuck).toBe(false);
    }
  });

  it("lets a similar run broken by another call start over", () => {
    let streak = { key: undefined as string | undefined, count: 0 };
    for (let index = 0; index < 20; index += 1) {
      const command = index % 5 === 4 ? "pwd" : `echo noop-${index}`;
      const result = advanceToolCallLoopGuard(streak, "shell", { command });
      streak = result.streak;
      expect(result.stuck).toBe(false);
    }
  });

  it.each([
    ["the same failure", () => failure(), 6],
    ["the same answer", () => answer("Still loading"), 25],
    ["an unknown answer", () => undefined, 25],
    ["a new answer each time", (call: number) => answer(`Downloaded ${call * 10}%`), undefined],
    // Only the first switch is new; after that both are known.
    ["alternating failures", (call: number) => failure(call % 2 ? "a" : "b"), 7],
    ["alternating answers", (call: number) => answer(call % 2 ? "a" : "b"), 26],
    // The first failure, from call 5, starts the run the sixth failing call stops.
    ["a failure after four answers", (call: number) => (call <= 4 ? answer("ok") : failure()), 10],
    // Call 20's new answer starts the run over from it, so its 25th repeat stops.
    ["an answer that changes at call 20", (call: number) => answer(call < 20 ? "a" : "b"), 44],
    // A wait with transient errors: the first error starts the run over from call 4.
    ["one error in a wait", (call: number) => (call === 4 ? failure() : answer("pending")), 28],
    [
      "an error every third answer in a wait",
      (call: number) => (call % 3 === 1 && call > 1 ? failure() : answer("pending")),
      28,
    ],
    // A failing exit code can be a wait too (`sleep 30; test -f done`).
    [
      "a failing shell exit code",
      () => toolResultFingerprint({ stdout: "", stderr: "1 test failed", code: 1 }),
      25,
    ],
  ])("stops an identical repeat that got %s at the expected call", (_, seen, stopsAt) => {
    expect(identicalStopsAt(seen)).toBe(stopsAt);
  });

  it.each([
    ["identical", () => "npm test", 6],
    ["digits-only", (call: number) => `cat page-${call}.txt`, 25],
  ])("counts %s calls once per model response", (_, command, limit) => {
    const stopsAt = (response: (call: number) => number) => {
      let streak = { key: undefined as string | undefined, count: 0 };
      for (let call = 1; call <= limit; call += 1) {
        const result = advanceToolCallLoopGuard(
          streak,
          "shell",
          { command: command(call) },
          failure(),
          response(call),
        );
        streak = result.streak;
        if (result.stuck) return call;
      }
      return undefined;
    };

    expect(stopsAt(() => 1)).toBeUndefined();
    expect(stopsAt((call) => call)).toBe(limit);
  });

  it("fingerprints what the model saw, not timing details", () => {
    expect(toolResultFingerprint({ content: [{ type: "text", text: "ok" }], details: 1 })).toBe(
      toolResultFingerprint({ content: [{ type: "text", text: "ok" }], details: 2 }),
    );
    expect(failure("boom")).not.toBe(failure("bang"));
    expect(toolResultFingerprint({ error: "boom" })).toMatch(/^failed:/);
    expect(answer("boom")).not.toMatch(/^failed:/);
  });

  it("fingerprints screen results by frame, not capture time", () => {
    const screen = (frameId: string, capturedAt: string, unchangedVisualCount: number) =>
      observationToolResult(
        {
          frameId,
          capturedAt,
          image: new Uint8Array([1]),
          mimeType: "image/png",
          width: 1280,
          height: 800,
        },
        "computer acted",
        frameId,
        { unchangedVisualCount },
      );
    const first = screen("frame-a", "2026-01-01T00:00:00.000Z", 1);
    expect(toolResultFingerprint(first)).toBe(
      toolResultFingerprint(screen("frame-a", "2026-01-01T00:00:05.000Z", 2)),
    );
    expect(toolResultFingerprint(first)).not.toBe(
      toolResultFingerprint(screen("frame-b", "2026-01-01T00:00:05.000Z", 2)),
    );
  });
});

describe("advanceOverLimitActionCalls", () => {
  const over = { actions: Array.from({ length: 25 }, () => ({ kind: "click", x: 1, y: 1 })) };
  const ok = { actions: over.actions.slice(0, 24) };

  it("counts over-limit batches in a row across both action tools, even when they differ", () => {
    let count = 0;
    count = advanceOverLimitActionCalls(count, "computer_act", over);
    count = advanceOverLimitActionCalls(count, "browser_act", {
      actions: [...over.actions, ...over.actions],
    });
    count = advanceOverLimitActionCalls(count, "computer_act", over);
    expect(count).toBe(3);
    expect(count).toBeLessThan(MAX_CONSECUTIVE_OVER_LIMIT_ACTION_CALLS);
    expect(advanceOverLimitActionCalls(count, "computer_act", over)).toBe(
      MAX_CONSECUTIVE_OVER_LIMIT_ACTION_CALLS,
    );
  });

  it("counts expanded computer actions while leaving browser batches unexpanded", () => {
    const actions = Array.from({ length: 13 }, () => ({
      kind: "click",
      x: 1,
      y: 1,
      double: true,
    }));
    expect(advanceOverLimitActionCalls(3, "computer_act", { actions })).toBe(
      MAX_CONSECUTIVE_OVER_LIMIT_ACTION_CALLS,
    );
    expect(advanceOverLimitActionCalls(3, "computer_act", { actions: actions.slice(0, 12) })).toBe(
      0,
    );
    expect(advanceOverLimitActionCalls(3, "browser_act", { actions })).toBe(0);
  });

  it("ignores other tools and resets on a batch within the limit", () => {
    expect(advanceOverLimitActionCalls(2, "computer_observe", {})).toBe(2);
    expect(advanceOverLimitActionCalls(2, "computer_act", ok)).toBe(0);
    expect(advanceOverLimitActionCalls(2, "browser_act", undefined)).toBe(0);
  });
});

describe("overLimitStopText", () => {
  it("names the over-limit batches and is recognised as a loop-guard stop", () => {
    const text = overLimitStopText("Computer act", 4);
    expect(text).toContain("with too many actions 4 times in a row");
    expect(text).not.toContain("same input");
    expect(isLoopGuardStopText(text)).toBe(true);
  });
});
