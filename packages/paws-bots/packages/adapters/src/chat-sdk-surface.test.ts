import { createHmac } from "node:crypto";
import { createSlackAdapter } from "@chat-adapter/slack";
import { createMockAdapter, createTestMessage } from "@chat-adapter/tests";
import type { AdapterContext, MessagingInboundEvent } from "@rakazo/adapter-kit";
import type { Adapter, ChatInstance } from "chat";
import { describe, expect, it, vi } from "vitest";
import type { MessagingPlatform } from "./chat-sdk-surface.js";
import {
  ChatSdkMessagingSurface,
  MESSAGING_WEBHOOK_MAX_BODY_BYTES,
  providerOfThreadId,
} from "./chat-sdk-surface.js";
import { enrichSlackTeamRoom } from "./messaging-platforms.js";
import { toTeamChatInbound } from "./team-chat-messaging.js";

const context: AdapterContext = {
  operationId: "op-1",
  traceId: "trace-1",
  spaceId: "ws-1",
  userId: "user-1",
  signal: new AbortController().signal,
};

/**
 * A mock Chat SDK adapter whose webhook drives the real Chat instance. Like
 * the real Sendblue/Telegram/WhatsApp adapters, handleWebhook fires
 * processMessage without awaiting it and registers the work via waitUntil.
 * Mock thread ids are DMs when the channel segment starts with "D".
 */
function createPlatform(
  overrides: Partial<MessagingPlatform> = {},
  adapterOverrides: Partial<Adapter> = {},
) {
  let chat: ChatInstance | undefined;
  const adapterName = overrides.adapterName ?? overrides.provider ?? "mock";
  const adapter: Adapter = createMockAdapter(adapterName, {
    initialize: vi.fn(async (instance: ChatInstance) => {
      chat = instance;
    }),
    handleWebhook: vi.fn(
      async (request: Request, options?: { waitUntil?: (task: Promise<unknown>) => void }) => {
        const payload = (await request.json()) as {
          threadId: string;
          id: string;
          text: string;
          isMe?: boolean;
          isMention?: boolean;
          rawType?: string;
          files?: Array<{ name: string; url: string; authenticated?: boolean }>;
        };
        // Fire-and-forget: matches Chat SDK adapters that return 200 before
        // processMessage settles, relying on waitUntil for background work.
        chat!.processMessage(
          adapter,
          payload.threadId,
          createTestMessage(payload.id, payload.text, {
            threadId: payload.threadId,
            raw: {
              roster: ["+15551111111", "+15552222222"],
              ...(payload.rawType ? { type: payload.rawType } : {}),
            },
            author: {
              userId: "U123",
              userName: "testuser",
              fullName: "Test User",
              isBot: false,
              isMe: payload.isMe ?? false,
            },
            attachments: (payload.files ?? []).map((file) => ({
              type: "image" as const,
              name: file.name,
              url: file.url,
              mimeType: "image/png",
              size: 3,
              ...(file.authenticated ? { fetchData: async () => Buffer.from([1, 2, 3]) } : {}),
            })),
            isMention: payload.isMention,
          }),
          options,
        );
        return new Response("ok");
      },
    ),
    // Force thread.post through postMessage, the surface's send path.
    postChannelMessage: undefined,
    ...adapterOverrides,
  });
  const platform: MessagingPlatform = {
    provider: "mock",
    capabilities: { direct: true, groups: true, receipt: "typing" },
    adapter,
    ...overrides,
  };
  return { adapter, platform, getChat: () => chat! };
}

function createSurface(
  overrides: Partial<MessagingPlatform> = {},
  adapterOverrides: Partial<Adapter> = {},
) {
  const { adapter, platform, getChat } = createPlatform(overrides, adapterOverrides);
  const surface = new ChatSdkMessagingSurface([platform]);
  const events: MessagingInboundEvent[] = [];
  surface.onInbound(async (event) => {
    events.push(event);
  });
  return { adapter, platform, surface, events, getChat };
}

function webhookRequest(payload: unknown): Request {
  return new Request("https://rakazo.test/api/v1/messaging/webhook/mock", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

describe("ChatSdkMessagingSurface inbound", () => {
  it.each([
    ["UBOT", "mention"],
    ["UOTHER", "ambient"],
  ] as const)(
    "classifies a plain Slack message mentioning %s as %s",
    async (mentionedUser, kind) => {
      const signingSecret = "test-slack-signing-secret";
      const apiRequests: string[] = [];
      const adapter = createSlackAdapter({
        botToken: "xoxb-fake",
        botUserId: "UBOT",
        signingSecret,
        // Stub HTTP transport so the real webhook/parser cannot reach Slack.
        webClientOptions: {
          adapter: async (config) => {
            apiRequests.push(config.url ?? "");
            return {
              data: { ok: true, user: { name: "test-user", real_name: "Test User" } },
              status: 200,
              statusText: "OK",
              headers: {},
              config,
              request: { path: "/api/users.info" },
            };
          },
        },
      });
      const surface = new ChatSdkMessagingSurface([
        {
          provider: "slack",
          capabilities: { direct: true, groups: true, receipt: "reaction" },
          adapter,
          enrichTeamRoom: enrichSlackTeamRoom,
        },
      ]);
      const events: MessagingInboundEvent[] = [];
      surface.onInbound(async (event) => {
        events.push(event);
      });
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
          text: `<@${mentionedUser}> ship it?`,
          ts: "1700000000.000001",
        },
      });
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature = createHmac("sha256", signingSecret)
        .update(`v0:${timestamp}:${body}`)
        .digest("hex");

      try {
        const response = await surface.handleWebhook(
          "slack",
          new Request("https://rakazo.test/api/v1/messaging/webhook/slack", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-slack-request-timestamp": timestamp,
              "x-slack-signature": `v0=${signature}`,
            },
            body,
          }),
        );

        expect(response?.status).toBe(200);
        expect(events).toEqual([
          expect.objectContaining({ type: "message", provider: "slack", isDirect: false, kind }),
        ]);
        expect(apiRequests).toEqual([
          "https://slack.com/api/users.info",
          "https://slack.com/api/users.info",
        ]);
      } finally {
        await surface.shutdown();
      }
    },
  );

  it("normalizes a DM into a provider-neutral inbound message", async () => {
    const { surface, events } = createSurface();
    const response = await surface.handleWebhook(
      "mock",
      webhookRequest({ threadId: "mock:Duser:1", id: "m-1", text: "hello" }),
    );

    expect(response?.status).toBe(200);
    expect(events).toEqual([
      {
        type: "message",
        provider: "mock",
        handle: "m-1",
        threadId: "mock:Duser:1",
        isDirect: true,
        from: "U123",
        fromLabel: "Test User",
        channelName: null,
        participants: [],
        content: "hello",
        mediaUrl: null,
      },
    ]);
  });

  it("hands authenticated files over as fetchable attachments", async () => {
    const { surface, events } = createSurface();
    await surface.handleWebhook(
      "mock",
      webhookRequest({
        threadId: "mock:Duser:1",
        id: "m-1",
        text: "",
        files: [
          { name: "screen.png", url: "https://files.example.test/private", authenticated: true },
          { name: "public.png", url: "https://cdn.example.test/public.png" },
        ],
      }),
    );

    const event = events[0];
    if (event?.type !== "message") throw new Error("expected a message");
    expect(event.mediaUrl).toBe("https://files.example.test/private");
    expect(event.attachments).toEqual([
      { name: "screen.png", mimeType: "image/png", size: 3, fetch: expect.any(Function) },
    ]);
    await expect(event.attachments?.[0]?.fetch()).resolves.toEqual(new Uint8Array([1, 2, 3]));
  });

  it("hydrates incomplete Slack app-mention file stubs from the exact history message", async () => {
    const hydrated = createTestMessage("m-1", "history text must not replace the mention", {
      threadId: "slack:C1:1",
      raw: { type: "message" },
      author: {
        userId: "U123",
        userName: "testuser",
        fullName: "Test User",
        isBot: false,
        isMe: false,
      },
      attachments: [
        {
          type: "file",
          name: "transcript.txt",
          mimeType: "text/plain",
          size: 12,
          fetchData: async () => Buffer.from("meeting text"),
        },
      ],
      isMention: true,
    });
    const fetchMessage = vi.fn(async () => hydrated);
    const { surface, events } = createSurface({ provider: "slack" }, { fetchMessage });

    const response = await surface.handleWebhook(
      "slack",
      webhookRequest({
        threadId: "slack:C1:1",
        id: "m-1",
        text: "@bot inspect this",
        isMention: true,
        rawType: "app_mention",
        files: [{ name: "transcript.txt", url: "https://files.slack.com/incomplete" }],
      }),
    );

    expect(response?.status).toBe(200);
    expect(fetchMessage).toHaveBeenCalledOnce();
    expect(fetchMessage).toHaveBeenCalledWith("slack:C1:1", "m-1");
    const event = events[0];
    if (event?.type !== "message") throw new Error("expected a message");
    expect(event).toMatchObject({
      content: "@bot inspect this",
      handle: "m-1",
      mentionsBot: true,
      provider: "slack",
      threadId: "slack:C1:1",
    });
    expect(event.attachments).toEqual([
      { name: "transcript.txt", mimeType: "text/plain", size: 12, fetch: expect.any(Function) },
    ]);
    await expect(event.attachments?.[0]?.fetch()).resolves.toEqual(
      new Uint8Array(Buffer.from("meeting text")),
    );
  });

  it.each([
    ["text-only", undefined],
    [
      "already fetchable",
      [{ name: "transcript.txt", url: "https://files.slack.com/complete", authenticated: true }],
    ],
  ])("does not hydrate %s Slack app mentions", async (_label, files) => {
    const fetchMessage = vi.fn();
    const { surface, events } = createSurface({ provider: "slack" }, { fetchMessage });

    const response = await surface.handleWebhook(
      "slack",
      webhookRequest({
        threadId: "slack:C1:1",
        id: "m-no-hydrate",
        text: "@bot hello",
        isMention: true,
        rawType: "app_mention",
        files,
      }),
    );

    expect(response?.status).toBe(200);
    expect(fetchMessage).not.toHaveBeenCalled();
    expect(events).toHaveLength(1);
  });

  it.each([
    ["missing history message", vi.fn(async () => null)],
    [
      "history without fetchable files",
      vi.fn(async () => createTestMessage("m-missing", "history")),
    ],
    [
      "history lookup failure",
      vi.fn(async () => {
        throw new Error("missing_scope");
      }),
    ],
    ["adapter without fetchMessage", undefined],
  ])("delivers incomplete Slack mentions after %s", async (_label, fetchMessage) => {
    const { surface, events } = createSurface({ provider: "slack" }, { fetchMessage });

    const response = await surface.handleWebhook(
      "slack",
      webhookRequest({
        threadId: "slack:C1:1",
        id: "m-missing",
        text: "@bot inspect this",
        isMention: true,
        rawType: "app_mention",
        files: [{ name: "transcript.txt", url: "https://files.slack.com/incomplete" }],
      }),
    );

    expect(response?.status).toBe(200);
    if (fetchMessage) expect(fetchMessage).toHaveBeenCalledWith("slack:C1:1", "m-missing");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      content: "@bot inspect this",
      handle: "m-missing",
      mentionsBot: true,
      mediaUrl: "https://files.slack.com/incomplete",
    });
  });

  it("does not turn inbound conversion failures into retryable sink failures", async () => {
    const { surface, events } = createSurface({
      enrichTeamRoom: () => {
        throw new Error("conversion failed");
      },
    });
    const response = await surface.handleWebhook(
      "mock",
      webhookRequest({
        threadId: "mock:C1:1",
        id: "m-conversion",
        text: "hello",
      }),
    );
    expect(response?.status).toBe(200);
    expect(events).toEqual([]);
  });

  it.each([false, true])(
    "keeps URL-only files beside fetchable files (first: %s)",
    async (first) => {
      const { surface, events } = createSurface();
      const files = [
        { name: "private.png", url: "https://files.example.test/private", authenticated: true },
        { name: "public.png", url: "https://cdn.example.test/public.png" },
      ];
      await surface.handleWebhook(
        "mock",
        webhookRequest({
          threadId: "mock:C1:1",
          id: "m-files",
          text: "see files",
          files: first ? files.toReversed() : files,
        }),
      );
      const event = events[0];
      if (event?.type !== "message") throw new Error("expected a message");
      expect(toTeamChatInbound(event)).toMatchObject({
        content: "see files\nhttps://cdn.example.test/public.png",
        attachments: [{ name: "private.png", fetch: expect.any(Function) }],
      });
    },
  );

  it("keeps link targets the SDK's plain text drops", async () => {
    const { surface, events } = createSurface();
    await surface.handleWebhook(
      "mock",
      webhookRequest({
        threadId: "mock:Duser:1",
        id: "m-1",
        text: "see [example.test/projects/…](https://example.test/projects/abc) and [https://example.test/](https://example.test/) or [example.test/x](https://example.test/x) or [example.test/](https://example.test/) or [example.test](https://example.test/)",
      }),
    );

    expect(events[0]).toMatchObject({
      content:
        "see example.test/projects/… (https://example.test/projects/abc) and https://example.test/ or example.test/x or example.test/ or example.test",
    });
  });

  it.each([
    "# Heading\n\n*literal asterisks* and `backticks`",
    "# Heading\n\n*literal asterisks* and `backticks` [https://example.test/](https://example.test/)",
  ])("keeps the adapter's original text when no link target is added: %s", async (text) => {
    const { surface, events } = createSurface();
    await surface.handleWebhook(
      "mock",
      webhookRequest({ threadId: "mock:Duser:1", id: "m-1", text }),
    );

    expect(events[0]).toMatchObject({ content: text });
  });

  it("flags group messages the SDK detects as bot mentions", async () => {
    const { surface, events } = createSurface();
    await surface.handleWebhook(
      "mock",
      webhookRequest({ threadId: "mock:C1:1", id: "m-1", text: "@mock-bot ship it?" }),
    );
    await surface.handleWebhook(
      "mock",
      webhookRequest({ threadId: "mock:C1:1", id: "m-2", text: "ship it?" }),
    );

    expect(events.map((event) => event.type === "message" && event.mentionsBot)).toEqual([
      true,
      undefined,
    ]);
  });

  it("never surfaces the bot's own messages", async () => {
    const { surface, events } = createSurface();
    const response = await surface.handleWebhook(
      "mock",
      webhookRequest({ threadId: "mock:Duser:1", id: "m-1", text: "echo", isMe: true }),
    );

    expect(response?.status).toBe(200);
    expect(events).toHaveLength(0);
  });

  it("delivers non-DM events with the platform's roster hooks when groups are supported", async () => {
    const { surface, events } = createSurface({
      participants: (raw) => (raw as { roster: string[] }).roster,
      channelName: () => "The Group",
      transport: () => "SMS",
      rosterAt: () => new Date("2026-11-04T10:01:00.000Z"),
    });
    await surface.handleWebhook(
      "mock",
      webhookRequest({ threadId: "mock:C1:9", id: "m-2", text: "group hello" }),
    );

    expect(events).toEqual([
      expect.objectContaining({
        type: "message",
        isDirect: false,
        participants: ["+15551111111", "+15552222222"],
        channelName: "The Group",
        transport: "SMS",
        content: "group hello",
        rosterAt: new Date("2026-11-04T10:01:00.000Z"),
      }),
    ]);
  });

  it("drops non-DM events for platforms without group support", async () => {
    const { surface, events } = createSurface({
      capabilities: { direct: true, groups: false, receipt: null },
    });
    const response = await surface.handleWebhook(
      "mock",
      webhookRequest({ threadId: "mock:C1:9", id: "m-3", text: "group hello" }),
    );

    expect(response?.status).toBe(200);
    expect(events).toHaveLength(0);
  });

  it("still delivers a follow-up after the thread is subscribed", async () => {
    // Chat SDK routes post-subscribe messages only to onSubscribedMessage;
    // without that handler the catch-all never sees them.
    const { surface, events, getChat } = createSurface({
      participants: (raw) => (raw as { roster: string[] }).roster,
    });
    const threadId = "mock:C1:9";
    await surface.handleWebhook("mock", webhookRequest({ threadId, id: "m-sub-1", text: "first" }));
    expect(events).toHaveLength(1);

    await getChat().getState().subscribe(threadId);

    await surface.handleWebhook(
      "mock",
      webhookRequest({ threadId, id: "m-sub-2", text: "second" }),
    );
    expect(events.map((event) => event.handle)).toEqual(["m-sub-1", "m-sub-2"]);
  });

  it("delivers overlapping messages on one conversation instead of dropping them", async () => {
    const { platform } = createPlatform();
    const surface = new ChatSdkMessagingSurface([platform]);
    const delivered: string[] = [];
    surface.onInbound(async (event) => {
      delivered.push(event.handle);
      // The real sink writes to the database and enqueues a run, so the
      // second webhook lands while the first is still in flight.
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    const [first, second] = await Promise.all([
      surface.handleWebhook(
        "mock",
        webhookRequest({ threadId: "mock:Duser:1", id: "m-4", text: "one" }),
      ),
      surface.handleWebhook(
        "mock",
        webhookRequest({ threadId: "mock:Duser:1", id: "m-5", text: "two" }),
      ),
    ]);

    expect([first?.status, second?.status]).toEqual([200, 200]);
    // A dropped message would ACK 200 with no vendor retry, losing it for good.
    expect(delivered.sort()).toEqual(["m-4", "m-5"]);
  });
});

describe("ChatSdkMessagingSurface webhook waitUntil drain", () => {
  it("does not return 2xx until the inbound sink finishes", async () => {
    const { adapter, platform } = createPlatform();
    const surface = new ChatSdkMessagingSurface([platform]);
    let sinkDone = false;
    let sawSinkPendingAtResponse = false;
    surface.onInbound(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      sinkDone = true;
    });

    const responsePromise = surface.handleWebhook(
      "mock",
      webhookRequest({ threadId: "mock:Duser:1", id: "m-slow", text: "hello" }),
    );
    // The response must wait for the waitUntil sink to finish.
    const response = await responsePromise;
    sawSinkPendingAtResponse = !sinkDone;
    expect(sawSinkPendingAtResponse).toBe(false);
    expect(sinkDone).toBe(true);
    expect(response?.status).toBe(200);
    expect(adapter.handleWebhook).toHaveBeenCalled();
  });

  it("returns 5xx when the inbound sink throws so the vendor can retry", async () => {
    const { platform } = createPlatform();
    const surface = new ChatSdkMessagingSurface([platform]);
    surface.onInbound(async () => {
      throw new Error("provision failed");
    });

    const response = await surface.handleWebhook(
      "mock",
      webhookRequest({ threadId: "mock:Duser:1", id: "m-fail", text: "hello" }),
    );

    expect(response?.status).toBe(500);
  });

  it("processes the vendor's retry of a message the sink failed on, exactly once", async () => {
    const { platform } = createPlatform();
    const surface = new ChatSdkMessagingSurface([platform]);
    const processed: string[] = [];
    let failNext = true;
    surface.onInbound(async (event) => {
      if (failNext) {
        failNext = false;
        throw new Error("provision failed");
      }
      if (event.type === "message") processed.push(event.handle);
    });
    const delivery = { threadId: "mock:Duser:1", id: "m-retry", text: "hello" };

    // Chat marks the message seen before the sink runs; without clearing
    // that mark the retry would ACK 200 and the message would be lost.
    expect((await surface.handleWebhook("mock", webhookRequest(delivery)))?.status).toBe(500);
    expect((await surface.handleWebhook("mock", webhookRequest(delivery)))?.status).toBe(200);
    expect((await surface.handleWebhook("mock", webhookRequest(delivery)))?.status).toBe(200);

    expect(processed).toEqual(["m-retry"]);
  });
});

describe("ChatSdkMessagingSurface webhook plumbing", () => {
  it("returns null for a provider it does not host", () => {
    const { surface } = createSurface();
    expect(surface.handleWebhook("nope", webhookRequest({}))).toBeNull();
  });

  it("rejects oversized bodies before they reach the adapter", async () => {
    const { surface, adapter } = createSurface();
    const response = await surface.handleWebhook(
      "mock",
      new Request("https://rakazo.test/api/v1/messaging/webhook/mock", {
        method: "POST",
        body: "x".repeat(MESSAGING_WEBHOOK_MAX_BODY_BYTES + 1),
      }),
    );

    expect(response?.status).toBe(413);
    expect(adapter.handleWebhook).not.toHaveBeenCalled();
  });

  it("peeks status payloads only after the adapter accepted the request", async () => {
    const peekStatuses = () => [
      { type: "status", provider: "mock", handle: "h-1", status: "SENT" } as const,
    ];

    const accepted = createSurface(
      { peekStatuses },
      { handleWebhook: vi.fn(async () => new Response("ok")) },
    );
    await accepted.surface.handleWebhook("mock", webhookRequest({ is_outbound: true }));
    expect(accepted.events).toEqual([
      { type: "status", provider: "mock", handle: "h-1", status: "SENT" },
    ]);

    // A forged webhook the adapter rejects must not flip outbox rows.
    const rejected = createSurface(
      { peekStatuses },
      { handleWebhook: vi.fn(async () => new Response("no", { status: 401 })) },
    );
    const response = await rejected.surface.handleWebhook(
      "mock",
      webhookRequest({ is_outbound: true }),
    );
    expect(response?.status).toBe(401);
    expect(rejected.events).toHaveLength(0);
  });
});

describe("ChatSdkMessagingSurface outbound", () => {
  it("posts Telegram replies as Markdown", async () => {
    const { surface, adapter } = createSurface({ provider: "telegram" });
    const body = "# Heading\n\n**bold** and [link](https://example.test)";

    await surface.sendToThread({ threadId: "telegram:123", body }, context);

    expect(adapter.postMessage).toHaveBeenCalledExactlyOnceWith("telegram:123", {
      markdown: body,
    });
  });

  it.each(["whatsapp", "lark"])("posts %s replies as Markdown", async (provider) => {
    const { surface, adapter } = createSurface({ provider });
    const body = "**bold** and [link](https://example.test)";
    const threadId = `${provider}:C1:9`;

    await surface.sendToThread({ threadId, body }, context);

    expect(adapter.postMessage).toHaveBeenCalledExactlyOnceWith(threadId, { markdown: body });
  });

  it("posts Photon iMessage replies as Markdown under the adapter's own thread ids", async () => {
    const { surface, adapter } = createSurface({ provider: "photon", adapterName: "imessage" });
    const body = "**bold** and [link](https://example.test)";

    await surface.sendToThread({ threadId: "photon:any;-;+15550001111", body }, context);

    expect(adapter.postMessage).toHaveBeenCalledExactlyOnceWith("imessage:any;-;+15550001111", {
      markdown: body,
    });
  });

  it.each(["slack", "sendblue"])("keeps %s replies as strings", async (provider) => {
    const { surface, adapter } = createSurface({ provider });
    const body = "**bold** and [link](https://example.test)";
    const threadId = `${provider}:C1:9`;

    await surface.sendToThread({ threadId, body }, context);

    expect(adapter.postMessage).toHaveBeenCalledExactlyOnceWith(threadId, body);
  });

  it("posts a Telegram image attachment as a photo", async () => {
    const { surface, adapter } = createSurface({ provider: "telegram" });
    const data = new Uint8Array([1, 2, 3]);

    await surface.sendToThread(
      {
        threadId: "telegram:123",
        body: "",
        attachment: { name: "chart.png", mimeType: "image/png", data },
      },
      context,
    );

    expect(adapter.postMessage).toHaveBeenCalledExactlyOnceWith("telegram:123", {
      markdown: "",
      attachments: [
        { type: "image", data: Buffer.from(data), name: "chart.png", mimeType: "image/png" },
      ],
    });
  });

  it.each([
    ["a PDF", "report.pdf", "application/pdf", 3],
    ["an SVG", "logo.svg", "image/svg+xml", 3],
    ["an image over the photo limit", "scan.png", "image/png", 10_000_001],
  ])("uploads %s to Telegram as a document", async (_label, name, mimeType, size) => {
    const { surface, adapter } = createSurface({ provider: "telegram" });
    const data = new Uint8Array(size);

    await surface.sendToThread(
      { threadId: "telegram:123", body: "", attachment: { name, mimeType, data } },
      context,
    );

    // Compare the bytes by size: deep-equality on a 10 MB buffer is slow.
    expect(adapter.postMessage).toHaveBeenCalledExactlyOnceWith("telegram:123", {
      markdown: "",
      files: [{ data: expect.any(Buffer), filename: name, mimeType }],
    });
    const [, message] = (adapter.postMessage as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(message.files[0].data.byteLength).toBe(size);
  });

  it("fails a file over Telegram's upload limit without retrying it", async () => {
    const { surface, adapter } = createSurface({ provider: "telegram" });
    const attachment = {
      name: "video.mp4",
      mimeType: "video/mp4",
      data: new Uint8Array(50_000_001),
    };

    await expect(
      surface.sendToThread({ threadId: "telegram:123", body: "", attachment }, context),
    ).rejects.toMatchObject({ name: "MessagingSendError", permanent: true });
    expect(adapter.postMessage).not.toHaveBeenCalled();
  });

  it("posts to a thread through the platform adapter and returns the handle", async () => {
    const { surface, adapter } = createSurface();
    const result = await surface.sendToThread({ threadId: "mock:C1:9", body: "hi" }, context);

    expect(result).toEqual({ handle: "msg-1" });
    expect(adapter.postMessage).toHaveBeenCalledTimes(1);
    expect((adapter.postMessage as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toBe("mock:C1:9");
  });

  it.each([
    ["a transient failure", new Error("socket hang up"), false, null],
    [
      "a rate limit",
      Object.assign(new Error("rate limited"), { name: "AdapterRateLimitError", retryAfter: 30 }),
      false,
      30_000,
    ],
    ["a permanent failure", new Error("channel_not_found"), true, null],
  ] as const)("classifies %s for the outbox", async (_label, error, permanent, retryAfterMs) => {
    const { surface } = createSurface(
      { isPermanentSendError: (candidate) => candidate === error && permanent },
      { postMessage: vi.fn(async () => Promise.reject(error)) },
    );

    await expect(
      surface.sendToThread({ threadId: "mock:C1:9", body: "hi" }, context),
    ).rejects.toMatchObject({
      name: "MessagingSendError",
      message: error.message,
      cause: error,
      permanent,
      retryAfterMs,
    });
  });

  it("prefers the platform's deterministic direct thread id", async () => {
    const { surface, adapter } = createSurface({
      directThreadId: (address) => `mock:D${address}:pinned`,
    });
    await expect(surface.openDirectThread("mock", "+15551234567", context)).resolves.toBe(
      "mock:D+15551234567:pinned",
    );
    expect(adapter.openDM).not.toHaveBeenCalled();
  });

  it("falls back to the adapter's openDM", async () => {
    const { surface, adapter } = createSurface();
    await expect(surface.openDirectThread("mock", "+15551234567", context)).resolves.toBe(
      "mock:D+15551234567:",
    );
    expect(adapter.openDM).toHaveBeenCalledWith("+15551234567");
  });

  it("classifies a failed openDM like a failed send", async () => {
    const error = new Error("invalid_auth");
    const { surface } = createSurface(
      { isPermanentSendError: (candidate) => candidate === error },
      { openDM: vi.fn(async () => Promise.reject(error)) },
    );
    await expect(surface.openDirectThread("mock", "U1", context)).rejects.toMatchObject({
      name: "MessagingSendError",
      permanent: true,
    });
  });

  it("throws when the platform cannot open direct conversations", async () => {
    const { surface } = createSurface({}, { openDM: undefined });
    await expect(surface.openDirectThread("mock", "+15551234567", context)).rejects.toThrow(
      /cannot open direct/,
    );
  });

  it("throws for an unknown provider", async () => {
    const { surface } = createSurface();
    await expect(surface.openDirectThread("nope", "+15551234567", context)).rejects.toThrow(
      /Unknown messaging provider/,
    );
  });
});

describe("ChatSdkMessagingSurface thread history", () => {
  it.each(["mock", "mock-work"])(
    "returns history with provider %s, oldest first, without the bot's own",
    async (provider) => {
      const message = (id: string, isMe = false) =>
        createTestMessage(id, `text ${id}`, {
          threadId: "mock:C1:100",
          author: { userId: "U1", userName: "ada", fullName: "Ada", isBot: false, isMe },
        });
      const fetchMessages = vi.fn(async () => ({
        messages: [message("100"), message("101", true), message("102"), message("103")],
      }));
      const { surface } = createSurface({ provider, adapterName: "mock" }, { fetchMessages });

      const history = await surface.fetchThreadHistory(
        `${provider}:C1:100`,
        { before: "103", limit: 50 },
        context,
      );

      expect(fetchMessages).toHaveBeenCalledWith("mock:C1:100", {
        limit: 51,
        direction: "backward",
      });
      expect(history.map((event) => [event.provider, event.threadId])).toEqual([
        [provider, `${provider}:C1:100`],
        [provider, `${provider}:C1:100`],
      ]);
      expect(history.map((event) => [event.handle, event.content, event.isDirect])).toEqual([
        ["100", "text 100", false],
        ["102", "text 102", false],
      ]);
    },
  );

  it("returns nothing when the asking message is outside the fetched page", async () => {
    const fetchMessages = vi.fn(async () => ({
      messages: [createTestMessage("100", "text 100", { threadId: "mock:C1:100" })],
    }));
    const { surface } = createSurface({}, { fetchMessages });

    await expect(
      surface.fetchThreadHistory("mock:C1:100", { before: "103", limit: 50 }, context),
    ).resolves.toEqual([]);
  });
});

describe("ChatSdkMessagingSurface acknowledge", () => {
  it.each(["mock", "mock-work"])("reacts with eyes on provider %s", async (provider) => {
    const { surface, adapter } = createSurface({
      provider,
      adapterName: "mock",
      capabilities: { direct: true, groups: true, receipt: "reaction" },
    });
    await surface.acknowledge(`${provider}:Duser:1`, "1700000000.000100", context);
    expect(adapter.addReaction).toHaveBeenCalledWith("mock:Duser:1", "1700000000.000100", "eyes");
    expect(adapter.startTyping).not.toHaveBeenCalled();
  });

  it("starts typing on typing platforms", async () => {
    const { surface, adapter } = createSurface();
    await surface.acknowledge("mock:Duser:1", "m-1", context);
    expect(adapter.startTyping).toHaveBeenCalledWith("mock:Duser:1");
    expect(adapter.addReaction).not.toHaveBeenCalled();
  });

  it("no-ops when the platform has no receipt", async () => {
    const { surface, adapter } = createSurface({
      capabilities: { direct: true, groups: true, receipt: null },
    });
    await surface.acknowledge("mock:Duser:1", "m-1", context);
    expect(adapter.startTyping).not.toHaveBeenCalled();
    expect(adapter.addReaction).not.toHaveBeenCalled();
  });

  it("no-ops for a thread on an unknown provider", async () => {
    const { surface, adapter } = createSurface();
    await surface.acknowledge("nope:Duser:1", "m-1", context);
    expect(adapter.startTyping).not.toHaveBeenCalled();
    expect(adapter.addReaction).not.toHaveBeenCalled();
  });
});

describe("ChatSdkMessagingSurface shape", () => {
  it("requires at least one platform and reports the mounted ones", () => {
    expect(() => new ChatSdkMessagingSurface([])).toThrow(/>=1 platform/);
    const { surface } = createSurface();
    expect(surface.platforms()).toEqual([
      { provider: "mock", capabilities: { direct: true, groups: true, receipt: "typing" } },
    ]);
    expect(surface.describe().capabilities).toEqual({ providers: ["mock"] });
    expect(providerOfThreadId("mock:C1:9")).toBe("mock");
    expect(providerOfThreadId("slack~installation-a:C1:9")).toBe("slack");
    expect(providerOfThreadId("telegram-work:42")).toBe("telegram-work");
  });

  it("retries initialize after a failure and stops polling on shutdown", async () => {
    let attempts = 0;
    const stopPolling = vi.fn(async () => undefined);
    const { surface, adapter } = createSurface({}, {
      initialize: vi.fn(async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("telegram unavailable");
      }),
      stopPolling,
    } as Partial<Adapter>);

    await expect(surface.initialize()).rejects.toThrow(/telegram unavailable/);
    // Partial multi-adapter init can leave Telegram polling; clear it on failure.
    expect(stopPolling).toHaveBeenCalledTimes(1);
    await expect(surface.initialize()).resolves.toBeUndefined();
    expect(adapter.initialize).toHaveBeenCalledTimes(2);

    await surface.shutdown();
    expect(stopPolling).toHaveBeenCalledTimes(2);
  });
});
