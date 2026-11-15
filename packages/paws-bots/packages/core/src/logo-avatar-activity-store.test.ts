import { describe, expect, it } from "vitest";
import type { LogoAvatarEvent } from "./logo-avatar-activity.js";
import { createLogoAvatarActivityStore } from "./logo-avatar-activity-store.js";

const event = (
  seq: number,
  type: string,
  payload: Record<string, unknown> = {},
  runId = "run-a",
  threadId = "thread-a",
  botId = "bot-a",
): LogoAvatarEvent => ({ seq, type, payload, runId, threadId, botId });
const snapshot = (cursor: number) => ({
  threadId: "thread-a",
  cursor,
  botId: "bot-a",
  run: { id: "run-a", botId: "bot-a", status: "running" as const, trigger: "user" as const },
});

describe("live logo avatar activity store", () => {
  it("preserves a known tool when a second feed hydrates the same cursor", () => {
    const s = createLogoAvatarActivityStore();
    s.hydrate("chat", snapshot(0));
    s.apply("chat", event(1, "agent.tool.called", { name: "read_file", executionId: "read" }));
    s.hydrate("call", snapshot(1));
    expect(s.getActivity("bot-a")).toBe("reading");
    s.resetSource("chat");
    expect(s.getActivity("bot-a")).toBe("reading");
    s.apply("call", event(2, "agent.tool.completed", { executionId: "read" }));
    expect(s.getActivity("bot-a")).toBe("working");
    s.resetSource("call");
    s.hydrate("reconnect", snapshot(2));
    s.apply("reconnect", event(1, "agent.tool.called", { name: "read_file", executionId: "read" }));
    expect(s.getActivity("bot-a")).toBe("working");
  });
  it("tracks concurrent runs and restores another live tool after completion", () => {
    const s = createLogoAvatarActivityStore();
    s.apply("chat", event(1, "run.started", { trigger: "user" }));
    s.apply("chat", event(2, "agent.tool.called", { name: "read_file", executionId: "read" }));
    s.apply("chat", event(3, "run.started", { trigger: "user" }, "run-b"));
    s.apply(
      "chat",
      event(4, "agent.tool.called", { name: "computer_act", executionId: "screen" }, "run-b"),
    );
    expect(s.getActivity("bot-a")).toBe("computer");
    s.apply("chat", event(5, "run.completed", {}, "run-b"));
    expect(s.getActivity("bot-a")).toBe("reading");
    s.apply("chat", event(6, "agent.tool.completed", { executionId: "read" }));
    expect(s.getActivity("bot-a")).toBe("working");
    s.apply("chat", event(7, "run.cancelled"));
    expect(s.getActivity("bot-a")).toBe("idle");
  });
  it("deduplicates overlapping feeds and never resurrects a completed stale tool", () => {
    const s = createLogoAvatarActivityStore();
    s.apply("chat", event(1, "run.started", { trigger: "user" }));
    s.apply("chat", event(2, "agent.tool.called", { name: "read_file", executionId: "read" }));
    s.apply("call", event(2, "agent.tool.called", { name: "read_file", executionId: "read" }));
    s.apply("call", event(3, "agent.tool.completed", { executionId: "read" }));
    s.resetSource("call");
    expect(s.getActivity("bot-a")).toBe("working");
    s.apply("chat", event(2, "agent.tool.called", { name: "read_file", executionId: "read" }));
    expect(s.getActivity("bot-a")).toBe("working");
  });
  it("reconciles reconnect snapshots without replaying old tool activity", () => {
    const s = createLogoAvatarActivityStore();
    s.hydrate("chat", snapshot(10));
    s.apply("chat", event(9, "agent.tool.called", { name: "read_file", executionId: "old" }));
    expect(s.getActivity("bot-a")).toBe("working");
    s.apply("chat", event(11, "agent.tool.called", { name: "read_file", executionId: "new" }));
    expect(s.getActivity("bot-a")).toBe("reading");
    s.reconcile(snapshot(11));
    expect(s.getActivity("bot-a")).toBe("reading");
    s.reconcile(snapshot(12));
    expect(s.getActivity("bot-a")).toBe("working");
    s.resetSource("chat");
    expect(s.getActivity("bot-a", "running")).toBe("working");
  });
  it("scopes cursors per thread and cleanup per connection", () => {
    const s = createLogoAvatarActivityStore();
    s.apply("chat-a", event(100, "run.started", { trigger: "user" }));
    s.apply("chat-b", event(1, "run.started", { trigger: "user" }, "run-b", "thread-b", "bot-b"));
    s.apply(
      "chat-b",
      event(
        2,
        "agent.tool.called",
        { name: "web_fetch", executionId: "read" },
        "run-b",
        "thread-b",
        "bot-b",
      ),
    );
    s.resetSource("chat-a");
    expect(s.getActivity("bot-b")).toBe("reading");
    s.clear();
    expect(s.getActivity("bot-b", "idle")).toBe("idle");
  });
  it("uses genuine streamed text and clears composing at a durable reply", () => {
    const s = createLogoAvatarActivityStore();
    s.hydrate("chat", snapshot(0));
    s.apply(
      "chat",
      event(1, "thread.progress", { streaming: true, activity: true, text: "Reading" }),
    );
    expect(s.getActivity("bot-a")).toBe("working");
    s.apply("chat", event(2, "thread.progress", { streaming: true, delta: "Reply" }));
    expect(s.getActivity("bot-a")).toBe("writing");
    s.apply("chat", event(3, "thread.message.created", { role: "bot" }));
    expect(s.getActivity("bot-a")).toBe("working");
  });
  it("keeps background, unknown tools and missing provenance conservative", () => {
    const s = createLogoAvatarActivityStore();
    s.apply("chat", event(1, "agent.tool.called", { name: "read_file", executionId: "read" }));
    expect(s.getActivity("bot-a", "running")).toBe("working");
    s.apply("chat", event(2, "run.started", { trigger: "tickets" }));
    s.apply("chat", event(3, "agent.tool.called", { name: "computer_act", executionId: "screen" }));
    expect(s.getActivity("bot-a", "running")).toBe("idle");
    s.apply("chat", event(4, "run.started", { trigger: "user" }, "visible"));
    s.apply(
      "chat",
      event(
        5,
        "agent.tool.called",
        { name: "some_provider_tool", executionId: "unknown" },
        "visible",
      ),
    );
    expect(s.getActivity("bot-a")).toBe("working");
  });
  it("publishes only semantic activity changes and handles wait/failure safely", () => {
    const s = createLogoAvatarActivityStore();
    let notifications = 0;
    s.subscribe(() => notifications++);
    s.hydrate("chat", snapshot(0));
    const first = notifications;
    s.apply("chat", event(1, "thread.progress", { streaming: true, delta: "a" }));
    s.apply("chat", event(2, "thread.progress", { streaming: true, delta: "ab" }));
    expect(notifications).toBe(first + 1);
    s.apply("chat", event(3, "run.waiting_input"));
    expect(s.getActivity("bot-a")).toBe("waiting");
    s.apply("chat", event(4, "run.failed"));
    expect(s.getActivity("bot-a")).toBe("error");
    s.apply("chat", event(5, "run.started", { trigger: "user" }, "new"));
    expect(s.getActivity("bot-a")).toBe("working");
  });
});

it("retains genuine thinking across duplicate owners, resets on fresh snapshots and prioritises concurrent real actions", () => {
  const s = createLogoAvatarActivityStore();
  s.hydrate("chat", snapshot(0));
  s.apply("chat", event(1, "thread.meta", { activity: { thinking: true } }));
  expect(s.getActivity("bot-a")).toBe("thinking");
  s.hydrate("call", snapshot(1)); // Preserve exact same-cursor detail, including thinking.
  s.apply("call", event(1, "thread.meta", { activity: { thinking: true } }));
  expect(s.getActivity("bot-a")).toBe("thinking");
  s.apply("call", event(2, "run.started", { trigger: "user" }, "run-b"));
  expect(s.getActivity("bot-a")).toBe("thinking"); // Genuine signal beats generic running.
  s.apply("call", event(3, "thread.progress", { streaming: true, delta: "Reply" }, "run-b"));
  expect(s.getActivity("bot-a")).toBe("writing");
  s.apply("call", event(4, "run.completed", {}, "run-b"));
  expect(s.getActivity("bot-a")).toBe("thinking");
  s.resetSource("chat");
  expect(s.getActivity("bot-a")).toBe("thinking");
  s.reconcile(snapshot(5));
  expect(s.getActivity("bot-a")).toBe("working");
  s.apply("call", event(4, "thread.meta", { activity: { thinking: true } }));
  expect(s.getActivity("bot-a")).toBe("working");
  s.apply("call", event(6, "thread.meta", { activity: { thinking: true } }));
  expect(s.getActivity("bot-a")).toBe("thinking");
  s.resetSource("call");
  s.hydrate("reconnect", snapshot(6));
  expect(s.getActivity("bot-a")).toBe("working");
  s.clear();
  expect(s.getActivity("bot-a")).toBe("idle");
});

it("lets an idle observed chat retain generic work reported elsewhere", () => {
  const s = createLogoAvatarActivityStore();
  s.hydrate("idle-dm", { threadId: "dm", botId: "bot-a", cursor: 0, run: null });
  expect(s.getActivity("bot-a", "running")).toBe("working");
  expect(s.getActivity("bot-a", "waiting_input")).toBe("waiting");
  expect(s.getActivity("bot-a", "failed")).toBe("error");
  expect(s.getActivity("bot-a", "idle")).toBe("idle");
  s.hydrate("group", snapshot(0));
  s.apply("group", event(1, "agent.tool.called", { name: "read_file", executionId: "read" }));
  expect(s.getActivity("bot-a", "running")).toBe("reading");
  s.apply("group", event(2, "run.completed"));
  expect(s.getActivity("bot-a", "running")).toBe("working");
  expect(s.getActivity("bot-a", "idle")).toBe("idle");
});

it("publishes a background-only fallback change without exposing its activity", () => {
  const s = createLogoAvatarActivityStore();
  s.apply("chat", event(1, "run.started", { trigger: "tickets" }));
  expect(s.getActivity("bot-a", "running")).toBe("idle");
  let notifications = 0;
  s.subscribe(() => notifications++);
  s.hydrate("chat", { ...snapshot(2), run: null });
  expect(s.getActivity("bot-a", "running")).toBe("working");
  expect(notifications).toBe(1);
});
