import { createHmac } from "node:crypto";
import type * as SlackAdapterModule from "@chat-adapter/slack";
import type { AdapterContext, MessagingInboundMessage } from "@rakazo/adapter-kit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChatSdkMessagingSurface } from "./chat-sdk-surface.js";
import { messagingPlatformsFromEnv } from "./messaging-platforms.js";

type SlackRequest = { method: string; params: Record<string, string> };

type SlackResponse = { status: number; headers: Record<string, string>; data: unknown };

const slack = vi.hoisted(() => ({
  requests: [] as SlackRequest[],
  reactionResult: { ok: true } as Record<string, unknown>,
  postMessageResponse: null as SlackResponse | null,
}));

const slackResults: Record<string, () => Record<string, unknown>> = {
  "auth.test": () => ({ ok: true, user_id: "UBOT", bot_id: "BBOT" }),
  "users.info": () => ({ ok: true, user: { name: "test-user", real_name: "Test User" } }),
  "reactions.add": () => slack.reactionResult,
  "chat.postMessage": () => ({ ok: true, ts: "1700000000.000002", channel: "CTEST" }),
};

function slackResponse(method: string): SlackResponse {
  if (method === "chat.postMessage" && slack.postMessageResponse) return slack.postMessageResponse;
  return {
    status: 200,
    headers: {},
    data: slackResults[method]?.() ?? { ok: false, error: "unknown_method" },
  };
}

vi.mock("@chat-adapter/slack", async (importOriginal) => {
  const actual = await importOriginal<typeof SlackAdapterModule>();
  return {
    ...actual,
    createSlackAdapter: (config: Parameters<typeof actual.createSlackAdapter>[0]) =>
      actual.createSlackAdapter({
        ...config,
        // Keep the production client options (retries, rate limits, timeout).
        webClientOptions: {
          ...config?.webClientOptions,
          adapter: async (request) => {
            const method = (request.url ?? "").replace("https://slack.com/api/", "");
            slack.requests.push({
              method,
              params: Object.fromEntries(new URLSearchParams(String(request.data ?? ""))),
            });
            return {
              ...slackResponse(method),
              statusText: "",
              config: request,
              request: { path: `/api/${method}` },
            };
          },
        },
      }),
  };
});

const context: AdapterContext = {
  operationId: "op-test",
  traceId: "trace-test",
  spaceId: "space-test",
  userId: "user-test",
  signal: new AbortController().signal,
};
const signingSecret = "test-slack-signing-secret";

function createSlackSurface() {
  return new ChatSdkMessagingSurface(
    messagingPlatformsFromEnv({ slackBotToken: "xoxb-fake", slackSigningSecret: signingSecret }),
  );
}

function mentionWebhook(retryNum?: number, text = "<@UBOT> ship it?"): Request {
  const body = JSON.stringify({
    type: "event_callback",
    team_id: "TTEST",
    event_id: "EvTEST",
    authorizations: [{ user_id: "UBOT", is_bot: true }],
    event: {
      type: "message",
      channel_type: "channel",
      channel: "CTEST",
      user: "USENDER",
      text,
      ts: "1700000000.000001",
    },
  });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac("sha256", signingSecret)
    .update(`v0:${timestamp}:${body}`)
    .digest("hex");
  return new Request("https://rakazo.test/api/v1/messaging/webhook/slack", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": `v0=${signature}`,
      ...(retryNum
        ? { "x-slack-retry-num": String(retryNum), "x-slack-retry-reason": "http_error" }
        : {}),
    },
    body,
  });
}

async function receiveChannelMention() {
  const surface = createSlackSurface();
  const events: MessagingInboundMessage[] = [];
  surface.onInbound(async (event) => {
    if (event.type === "message") events.push(event);
  });
  const response = await surface.handleWebhook("slack", mentionWebhook());
  expect(response?.status).toBe(200);
  expect(events).toHaveLength(1);
  return { surface, event: events[0]! };
}

function reactionRequests() {
  return slack.requests.filter((request) => request.method === "reactions.add");
}

describe("Slack receipt", () => {
  beforeEach(() => {
    slack.requests.length = 0;
    slack.reactionResult = { ok: true };
  });

  it("reacts with eyes on the mention", async () => {
    const { surface, event } = await receiveChannelMention();
    try {
      await surface.acknowledge(event.threadId, event.handle, context);

      expect(event.threadId).toBe("slack:CTEST:1700000000.000001");
      expect(reactionRequests().map((request) => request.params)).toEqual([
        { token: "xoxb-fake", channel: "CTEST", timestamp: "1700000000.000001", name: "eyes" },
      ]);
    } finally {
      await surface.shutdown();
    }
  });

  it("treats a reaction Slack already has as delivered", async () => {
    const { surface, event } = await receiveChannelMention();
    slack.reactionResult = { ok: false, error: "already_reacted" };
    try {
      await expect(
        surface.acknowledge(event.threadId, event.handle, context),
      ).resolves.toBeUndefined();
      expect(reactionRequests()).toHaveLength(1);
    } finally {
      await surface.shutdown();
    }
  });

  it("surfaces any other Slack error", async () => {
    const { surface, event } = await receiveChannelMention();
    slack.reactionResult = { ok: false, error: "missing_scope" };
    try {
      await expect(surface.acknowledge(event.threadId, event.handle, context)).rejects.toThrow(
        "An API error occurred: missing_scope",
      );
    } finally {
      await surface.shutdown();
    }
  });
});

describe("Slack inbound retries", () => {
  beforeEach(() => {
    slack.requests.length = 0;
  });

  it("processes Slack's retry of an event the sink failed on, exactly once", async () => {
    const surface = createSlackSurface();
    const processed: string[] = [];
    let failNext = true;
    surface.onInbound(async (event) => {
      if (failNext) {
        failNext = false;
        throw new Error("provision failed");
      }
      if (event.type === "message") processed.push(event.handle);
    });
    try {
      // Slack marks the event delivered and Chat marks the message seen
      // before the sink runs; both must be cleared or the retry is dropped.
      expect((await surface.handleWebhook("slack", mentionWebhook()))?.status).toBe(500);
      expect((await surface.handleWebhook("slack", mentionWebhook(1)))?.status).toBe(200);
      expect((await surface.handleWebhook("slack", mentionWebhook(2)))?.status).toBe(200);

      expect(processed).toEqual(["1700000000.000001"]);
    } finally {
      await surface.shutdown();
    }
  });
});

describe("Slack inbound formatting", () => {
  it.each([
    ["unmatched emphasis", "*_".repeat(8_000)],
    ["deeply nested quotes", ">".repeat(7_000)],
  ])("delivers a message full of %s promptly and in full", async (_name, hostile) => {
    const surface = createSlackSurface();
    const events: MessagingInboundMessage[] = [];
    surface.onInbound(async (event) => {
      if (event.type === "message") events.push(event);
    });
    const started = performance.now();
    const response = await surface.handleWebhook("slack", mentionWebhook(undefined, hostile));
    expect(performance.now() - started).toBeLessThan(1_500);
    expect(response?.status).toBe(200);
    expect(events[0]?.content).toBe(hostile);
  });

  it("still renders link targets in an ordinary message", async () => {
    const surface = createSlackSurface();
    const events: MessagingInboundMessage[] = [];
    surface.onInbound(async (event) => {
      if (event.type === "message") events.push(event);
    });
    const text = "<@UBOT> *read* <https://example.test/spec|the spec> first";
    await surface.handleWebhook("slack", mentionWebhook(undefined, text));
    expect(events[0]?.content).toBe("@Test User read the spec (https://example.test/spec) first");
  });
});

describe("Slack sends", () => {
  beforeEach(() => {
    slack.requests.length = 0;
    slack.postMessageResponse = null;
  });

  function postRequests() {
    return slack.requests.filter((request) => request.method === "chat.postMessage");
  }

  it.each([
    [
      "a rate limit, with Slack's retry-after",
      { status: 429, headers: { "retry-after": "30" }, data: { ok: false, error: "ratelimited" } },
      { permanent: false, retryAfterMs: 30_000 },
    ],
    [
      "a server error",
      { status: 503, headers: {}, data: "" },
      { permanent: false, retryAfterMs: null },
    ],
    [
      "a channel the bot cannot reach",
      { status: 200, headers: {}, data: { ok: false, error: "channel_not_found" } },
      { permanent: true, retryAfterMs: null },
    ],
    [
      "a revoked token",
      { status: 200, headers: {}, data: { ok: false, error: "invalid_auth" } },
      { permanent: true, retryAfterMs: null },
    ],
  ] as const)(
    "fails fast on %s and leaves retries to the outbox",
    async (_label, response, classified) => {
      const surface = createSlackSurface();
      slack.postMessageResponse = response;
      try {
        await expect(
          surface.sendToThread({ threadId: "slack:CTEST:", body: "hi" }, context),
        ).rejects.toMatchObject({ name: "MessagingSendError", ...classified });
        expect(postRequests()).toHaveLength(1);
      } finally {
        await surface.shutdown();
      }
    },
  );

  it("returns the posted message handle", async () => {
    const surface = createSlackSurface();
    try {
      await expect(
        surface.sendToThread({ threadId: "slack:CTEST:", body: "hi" }, context),
      ).resolves.toEqual({ handle: "1700000000.000002" });
      expect(postRequests()).toHaveLength(1);
    } finally {
      await surface.shutdown();
    }
  });
});
