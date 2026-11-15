import type { ProductEvent } from "@rakazo/contracts";
import { afterEach, expect, it } from "vitest";
import {
  newLogoAvatarActivitySource,
  openLogoAvatarActivityFeed,
  syncWebLogoAvatarIdentity,
  webLogoAvatarActivity,
} from "./logo-avatar-activity.js";

const snapshot = {
  threadId: "thread-a",
  cursor: 10,
  botId: "bot-a",
  run: { id: "run-a", botId: "bot-a", status: "running" as const, trigger: "user" as const },
};
const tool = {
  id: "event-a",
  spaceId: "space-a",
  threadId: "thread-a",
  seq: 11,
  botId: "bot-a",
  runId: "run-a",
  type: "agent.tool.called",
  payload: { name: "read_file", executionId: "read" },
  createdAt: "2026-10-01T00:00:00Z",
} as ProductEvent;
afterEach(() => webLogoAvatarActivity.clear());

it("hydrates honest generic work and clears exact activity when a feed ends", async () => {
  const abort = new AbortController();
  const feed = await openLogoAvatarActivityFeed("chat", snapshot, 10, abort.signal, async () =>
    (async function* () {
      yield tool;
    })(),
  );
  expect(webLogoAvatarActivity.getActivity("bot-a")).toBe("working");
  for await (const event of feed) {
    webLogoAvatarActivity.apply("chat", event);
    expect(webLogoAvatarActivity.getActivity("bot-a")).toBe("reading");
  }
  expect(webLogoAvatarActivity.getActivity("bot-a", "running")).toBe("working");
});
it("drops stale activity on abort and on failed reconnect", async () => {
  const abort = new AbortController();
  await openLogoAvatarActivityFeed("chat", snapshot, 10, abort.signal, async () =>
    (async function* () {
      yield tool;
    })(),
  );
  webLogoAvatarActivity.apply("chat", tool);
  expect(webLogoAvatarActivity.getActivity("bot-a")).toBe("reading");
  abort.abort();
  expect(webLogoAvatarActivity.getActivity("bot-a", "running")).toBe("working");
  await expect(
    openLogoAvatarActivityFeed("chat", snapshot, 10, new AbortController().signal, async () => {
      throw new Error("offline");
    }),
  ).rejects.toThrow("offline");
  expect(webLogoAvatarActivity.getActivity("bot-a", "running")).toBe("working");
});

it("clears settled identity changes and rejects old managed feed callbacks", () => {
  syncWebLogoAvatarIdentity("first-user");
  const old = newLogoAvatarActivitySource();
  webLogoAvatarActivity.hydrate(old, snapshot);
  webLogoAvatarActivity.apply(old, tool);
  expect(webLogoAvatarActivity.getActivity("bot-a")).toBe("reading");
  syncWebLogoAvatarIdentity("first-user");
  expect(webLogoAvatarActivity.getActivity("bot-a")).toBe("reading");
  syncWebLogoAvatarIdentity("second-user");
  webLogoAvatarActivity.apply(old, { ...tool, seq: 12 });
  webLogoAvatarActivity.hydrate(old, snapshot);
  expect(webLogoAvatarActivity.getActivity("bot-a", "idle")).toBe("idle");
  const next = newLogoAvatarActivitySource();
  webLogoAvatarActivity.hydrate(next, snapshot);
  webLogoAvatarActivity.apply(next, tool);
  expect(webLogoAvatarActivity.getActivity("bot-a")).toBe("reading");
  syncWebLogoAvatarIdentity(null);
  expect(webLogoAvatarActivity.getActivity("bot-a", "idle")).toBe("idle");
});
