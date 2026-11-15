import type { ProductEvent } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import {
  initialLogoAvatarSignals,
  logoAvatarActivity,
  reduceLogoAvatarSignals,
} from "./logo-avatar-activity.js";

function event(
  seq: number,
  type: ProductEvent["type"],
  payload: ProductEvent["payload"] = {},
  runId = "run-1",
): ProductEvent {
  return {
    id: `event-${seq}`,
    spaceId: "space-1",
    threadId: "thread-1",
    botId: "bot-1",
    runId,
    seq,
    type,
    payload,
    createdAt: "2026-10-27T12:00:00.000Z",
  };
}
const started = () =>
  reduceLogoAvatarSignals(
    initialLogoAvatarSignals("bot-1"),
    event(1, "run.started", { trigger: "user" }),
  );

describe("logo avatar activity from public events", () => {
  it("follows confirmed reading, reply streaming, computer use and completion", () => {
    let state = started();
    expect(logoAvatarActivity(state)).toBe("working");
    state = reduceLogoAvatarSignals(
      state,
      event(2, "agent.tool.called", { name: "read_file", executionId: "read-1" }),
    );
    expect(logoAvatarActivity(state)).toBe("reading");
    state = reduceLogoAvatarSignals(
      state,
      event(3, "agent.tool.completed", {
        name: "read_file",
        executionId: "read-1",
        outcome: "succeeded",
      }),
    );
    expect(logoAvatarActivity(state)).toBe("working");
    state = reduceLogoAvatarSignals(
      state,
      event(4, "thread.progress", { delta: "The summary is", streaming: true }),
    );
    expect(logoAvatarActivity(state)).toBe("writing");
    state = reduceLogoAvatarSignals(
      state,
      event(5, "agent.tool.called", { name: "computer_act", executionId: "computer-1" }),
    );
    expect(logoAvatarActivity(state)).toBe("computer");
    state = reduceLogoAvatarSignals(state, event(6, "run.completed"));
    expect(logoAvatarActivity(state)).toBe("idle");
  });

  it.each(["read_file", "web_fetch", "read_history", "skill_read"])(
    "recognises the exact read operation %s",
    (name) => {
      expect(
        logoAvatarActivity(
          reduceLogoAvatarSignals(
            started(),
            event(2, "agent.tool.called", { name, executionId: "tool-1" }),
          ),
        ),
      ).toBe("reading");
    },
  );

  it("recognises a file write without calling it streamed reply text", () => {
    const state = reduceLogoAvatarSignals(
      started(),
      event(2, "agent.tool.called", { name: "write_file", executionId: "write-1" }),
    );
    expect(logoAvatarActivity(state)).toBe("writing");
    expect(state.composing).toBe(false);
  });

  it("does not invent thinking, reading or computer use from narration or a running computer", () => {
    let state = reduceLogoAvatarSignals(
      started(),
      event(2, "thread.progress", {
        text: "Thinking about reading on the computer",
        activity: true,
      }),
    );
    expect(logoAvatarActivity(state)).toBe("working");
    state = reduceLogoAvatarSignals(state, event(3, "computer.status", { state: "running" }));
    expect(logoAvatarActivity(state)).toBe("working");
    state = reduceLogoAvatarSignals(
      state,
      event(4, "agent.tool.called", { name: "connector_read_something", executionId: "unknown" }),
    );
    expect(logoAvatarActivity(state)).toBe("working");
  });

  it("tracks concurrent tool executions and does not clear the newer one on an old completion", () => {
    let state = reduceLogoAvatarSignals(
      started(),
      event(2, "agent.tool.called", { name: "read_file", executionId: "read" }),
    );
    state = reduceLogoAvatarSignals(
      state,
      event(3, "agent.tool.called", { name: "browser_snapshot", executionId: "screen" }),
    );
    state = reduceLogoAvatarSignals(
      state,
      event(4, "agent.tool.completed", { executionId: "read", outcome: "succeeded" }),
    );
    expect(logoAvatarActivity(state)).toBe("computer");
    state = reduceLogoAvatarSignals(
      state,
      event(5, "agent.tool.completed", { executionId: "screen", outcome: "error" }),
    );
    expect(logoAvatarActivity(state)).toBe("working");
  });

  it.each([
    "run.waiting_input",
    "computer.takeover.requested",
    "computer.takeover.granted",
  ] as const)("stops active work on %s", (type) => {
    const reading = reduceLogoAvatarSignals(
      started(),
      event(2, "agent.tool.called", { name: "read_file", executionId: "read" }),
    );
    const waiting = reduceLogoAvatarSignals(reading, event(3, type));
    expect(logoAvatarActivity(waiting)).toBe("waiting");
    expect(waiting.tools).toEqual([]);
    expect(
      logoAvatarActivity(reduceLogoAvatarSignals(waiting, event(4, "computer.takeover.released"))),
    ).toBe("working");
  });

  it("clears a cancelled run immediately and only shows error on a failed run", () => {
    const writing = reduceLogoAvatarSignals(
      started(),
      event(2, "thread.progress", { delta: "Reply", streaming: true }),
    );
    expect(logoAvatarActivity(reduceLogoAvatarSignals(writing, event(3, "run.cancelled")))).toBe(
      "idle",
    );
    expect(logoAvatarActivity(reduceLogoAvatarSignals(writing, event(3, "run.failed")))).toBe(
      "error",
    );
  });

  it("ignores stale events, another bot and completion from a prior run", () => {
    const state = started();
    expect(reduceLogoAvatarSignals(state, event(0, "run.failed"))).toBe(state);
    expect(
      reduceLogoAvatarSignals(state, { ...event(2, "run.failed"), botId: "another-bot" }),
    ).toBe(state);
    expect(
      logoAvatarActivity(reduceLogoAvatarSignals(state, event(3, "run.failed", {}, "older-run"))),
    ).toBe("working");
  });

  it("keeps hidden background ticket work out of avatar activity", () => {
    let state = reduceLogoAvatarSignals(
      initialLogoAvatarSignals("bot-1"),
      event(1, "run.started", { trigger: "tickets" }),
    );
    state = reduceLogoAvatarSignals(
      state,
      event(2, "agent.tool.called", { name: "read_file", executionId: "hidden-read" }),
    );
    expect(logoAvatarActivity(state)).toBe("idle");
  });
});

describe("genuine coarse thinking activity", () => {
  it("requires an explicit scoped lifecycle marker and yields to streamed output/tools", () => {
    let state = reduceLogoAvatarSignals(
      started(),
      event(2, "thread.meta", { activity: { thinking: true } }),
    );
    expect(logoAvatarActivity(state)).toBe("thinking");
    state = reduceLogoAvatarSignals(
      state,
      event(3, "thread.meta", { activity: { thinking: false } }),
    );
    expect(logoAvatarActivity(state)).toBe("working");
    state = reduceLogoAvatarSignals(
      state,
      event(4, "thread.meta", { activity: { thinking: true } }),
    );
    state = reduceLogoAvatarSignals(
      state,
      event(5, "thread.progress", { streaming: true, delta: "Reply" }),
    );
    expect(logoAvatarActivity(state)).toBe("writing");
    expect(state.thinking).toBe(false);
    state = reduceLogoAvatarSignals(
      state,
      event(6, "agent.tool.called", { name: "read_file", executionId: "read" }),
    );
    state = reduceLogoAvatarSignals(
      state,
      event(7, "thread.meta", { activity: { thinking: true } }),
    );
    expect(logoAvatarActivity(state)).toBe("reading");
    expect(state.thinking).toBe(false);
    state = reduceLogoAvatarSignals(
      state,
      event(8, "agent.tool.completed", { executionId: "read" }),
    );
    expect(logoAvatarActivity(state)).toBe("working");
    state = reduceLogoAvatarSignals(
      state,
      event(9, "thread.meta", { activity: { thinking: true } }, "other-run"),
    );
    expect(logoAvatarActivity(state)).toBe("working");
  });
  it.each([
    "run.completed",
    "run.cancelled",
    "run.failed",
    "run.waiting_input",
    "computer.takeover.requested",
    "computer.takeover.granted",
    "computer.takeover.released",
  ] as const)("clears thinking at %s and cannot revive a terminal/waiting run", (boundary) => {
    let state = reduceLogoAvatarSignals(
      started(),
      event(2, "thread.meta", { activity: { thinking: true } }),
    );
    state = reduceLogoAvatarSignals(state, event(3, boundary));
    expect(state.thinking).toBe(false);
    if (boundary !== "computer.takeover.released") {
      state = reduceLogoAvatarSignals(
        state,
        event(4, "thread.meta", { activity: { thinking: true } }),
      );
      expect(state.thinking).toBe(false);
    }
  });
  it("does not guess from malformed markers, background work or snapshot status", () => {
    const state = started();
    for (const payload of [{}, { activity: { thinking: "true" } }, { text: "Thinking" }]) {
      expect(
        logoAvatarActivity(reduceLogoAvatarSignals(state, event(2, "thread.meta", payload))),
      ).toBe("working");
    }
    const background = reduceLogoAvatarSignals(
      initialLogoAvatarSignals("bot-1"),
      event(1, "run.started", { trigger: "tickets" }),
    );
    expect(
      logoAvatarActivity(
        reduceLogoAvatarSignals(
          background,
          event(2, "thread.meta", { activity: { thinking: true } }),
        ),
      ),
    ).toBe("idle");
  });
});
