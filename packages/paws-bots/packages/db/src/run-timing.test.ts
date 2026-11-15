import { describe, expect, it } from "vitest";
import { isRunResponse, runTimingFields } from "./run-timing.js";

const at = (seconds: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, seconds));

describe("run response timing", () => {
  it("includes time before a steering continuation is created, without resetting on retry", () => {
    expect(
      runTimingFields({
        trigger: "follow_up",
        sourceMessage: { createdAt: at(0) },
        createdAt: at(10),
        startedAt: at(12),
        firstResponseAt: at(15),
        completedAt: at(30),
      }),
    ).toEqual({
      "run.trigger": "follow_up",
      "run.pre_run_wait_ms": 10_000,
      "run.queue_wait_ms": 2_000,
      "run.first_response_ms": 15_000,
      "run.total_ms": 30_000,
      "run.execution_wall_ms": 18_000,
    });
  });

  it("does not invent a response or execution time for a silent or never-started run", () => {
    expect(
      runTimingFields({
        trigger: "routine",
        sourceMessage: null,
        createdAt: at(0),
        startedAt: null,
        firstResponseAt: null,
        completedAt: at(10),
      }),
    ).toEqual({ "run.trigger": "routine", "run.pre_run_wait_ms": 0, "run.total_ms": 10_000 });
  });

  it("counts streamed reply text, durable replies and action cards, excluding activity and hidden output", () => {
    expect(isRunResponse("thread.progress", { streaming: true, delta: "reply" })).toBe(true);
    expect(
      isRunResponse("thread.message.created", { role: "bot", blocks: [{ kind: "chart" }] }),
    ).toBe(true);
    expect(isRunResponse("thread.progress", { text: "activity", activity: true })).toBe(false);
    expect(isRunResponse("thread.meta", { activity: { thinking: true } })).toBe(false);
    expect(isRunResponse("thread.meta", { activity: { thinking: false } })).toBe(false);
    expect(isRunResponse("thread.progress", { streaming: true, text: "" })).toBe(false);
    expect(
      isRunResponse("thread.message.created", { role: "bot", blocks: [{ kind: "ask" }] }),
    ).toBe(true);
    expect(
      isRunResponse("thread.message.created", {
        role: "bot",
        blocks: [{ kind: "text", text: "reply" }],
      }),
    ).toBe(true);
    expect(
      isRunResponse("thread.message.created", {
        role: "user",
        blocks: [{ kind: "text", text: "input" }],
      }),
    ).toBe(false);
    expect(
      isRunResponse("thread.message.created", {
        role: "bot",
        blocks: [{ kind: "meta" }, { kind: "steps" }],
      }),
    ).toBe(false);
  });
});
