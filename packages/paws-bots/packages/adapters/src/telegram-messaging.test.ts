import { createTelegramAdapter } from "@chat-adapter/telegram";
import type { AdapterContext, MessagingInboundEvent } from "@rakazo/adapter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatSdkMessagingSurface } from "./chat-sdk-surface.js";
import type { MessagingEnvironmentValues } from "./messaging-platforms.js";
import { messagingPlatformsFromEnv, splitOutboundBody } from "./messaging-platforms.js";

const context: AdapterContext = {
  operationId: "op-test",
  traceId: "trace-test",
  spaceId: "space-test",
  userId: "user-test",
  signal: new AbortController().signal,
};

function createSurface(sendErrors: string[] = []) {
  const sends: { text: string; parse_mode?: string }[] = [];
  // Exercise the pinned adapter's rendering and fallback, replacing only HTTP.
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init: RequestInit) => {
      const method = new URL(input).pathname.split("/").at(-1);
      if (method === "getMe") {
        return Response.json({ ok: true, result: { id: 999, is_bot: true, username: "testbot" } });
      }
      if (method === "sendRichMessage") {
        // Regular Telegram Bot API deployments may not support rich messages.
        return Response.json(
          { ok: false, error_code: 404, description: "Not Found" },
          { status: 404 },
        );
      }
      if (method !== "sendMessage") throw new Error(`Unexpected Telegram method: ${method}`);
      const payload = JSON.parse(String(init.body)) as (typeof sends)[number];
      sends.push(payload);
      const description = sendErrors.shift();
      if (description) {
        const status = description.includes("can't parse") ? 400 : 500;
        return Response.json({ ok: false, error_code: status, description }, { status });
      }
      return Response.json({
        ok: true,
        result: {
          message_id: 42,
          date: 1_700_000_000,
          chat: { id: 123, type: "private" },
          from: { id: 999, is_bot: true, first_name: "Test Bot" },
          text: payload.text,
        },
      });
    }),
  );
  const adapter = createTelegramAdapter({
    botToken: "test-token",
    secretToken: "test-webhook-secret",
    mode: "webhook",
  });
  const surface = new ChatSdkMessagingSurface([
    { provider: "telegram", capabilities: { direct: true, groups: false, receipt: null }, adapter },
  ]);
  return { surface, sends, threadId: adapter.encodeThreadId({ chatId: "123" }) };
}

afterEach(() => vi.unstubAllGlobals());

describe("Telegram messaging Markdown", () => {
  it.each([
    ["a".repeat(9000), "a".repeat(9000)],
    [`${"a".repeat(4095)}😀${"b".repeat(4096)}`, `${"a".repeat(4095)}😀${"b".repeat(4096)}`],
    ["!".repeat(4096), "!".repeat(4096)],
    [`**${"!".repeat(4090)}**`, "!".repeat(4090)],
    [`\`\`\`text\n${"\\".repeat(4090)}\n\`\`\``, "\\".repeat(4090)],
  ])("sends every split part without adapter truncation", async (body, expected) => {
    const { surface, sends, threadId } = createSurface();
    const parts = splitOutboundBody("telegram", body);
    for (const part of parts) {
      await surface.sendToThread({ threadId, body: part }, context);
    }

    expect(sends).toHaveLength(parts.length);
    expect(sends.every(({ text }) => text.length <= 4096 && !/[\uD800-\uDFFF]/u.test(text))).toBe(
      true,
    );
    expect(sends.every(({ text }) => !text.includes("…"))).toBe(true);
    // Remove the fixtures' MarkdownV2 wrappers before unescaping literal content.
    const visibleText = sends
      .map(({ text }) =>
        text
          .replace(/^```[^\n]*\n([\s\S]*)\n```$/, "$1")
          .replace(/^\*([^*]*)\*$/s, "$1")
          .replace(/\\([\\!*`])/g, "$1"),
      )
      .join("");
    expect(visibleText).toBe(expected);
  });

  it("keeps every link address when a long reply is split", () => {
    const urls = Array.from({ length: 80 }, (_, i) => `https://example.com/articles/${i}`);
    const body = `Sources:\n${urls
      .map((url, i) => `${i + 1}. [Article ${i}](${url}) - a short summary of the article text`)
      .join("\n")}`;
    expect(body.length).toBeGreaterThan(4096);
    const sent = splitOutboundBody("telegram", body).join("\n").replace(/\\(.)/g, "$1");
    for (const url of urls) expect(sent).toContain(url);
  });

  it("keeps link-shaped text in code as written when a long reply is split", () => {
    const filler = Array.from({ length: 120 }, (_, i) => `Line ${i} of the reply.`).join("\n");
    const body = `Write links as \`[label](url)\`.\n${filler}`;
    expect(body.length).toBeGreaterThan(2000);
    const long = `${body}\n${"x".repeat(4200)}`;
    const sent = splitOutboundBody("telegram", long).join("\n").replace(/\\(.)/g, "$1");
    expect(sent).toContain("[label](url)");
    expect(sent).not.toContain("label (url)");
  });

  it("keeps the address of a link whose label has brackets when a long reply is split", () => {
    const long = `See [the [beta] docs](https://example.com/beta)\n${"x".repeat(4200)}`;
    const sent = splitOutboundBody("telegram", long).join("\n").replace(/\\(.)/g, "$1");
    expect(sent).toContain("https://example.com/beta");
  });

  it("does not repeat an address already shown when a long reply is split", () => {
    const long = `**Contact** bob@example.com or https://example.com/\n${"x".repeat(4200)}`;
    const sent = splitOutboundBody("telegram", long).join("\n").replace(/\\(.)/g, "$1");
    expect(sent).toContain("bob@example.com");
    expect(sent).not.toContain("mailto:");
    expect(sent).not.toContain("(https://example.com/)");
  });

  it("keeps the address of a link in a reply that fits in one message", () => {
    const body = "Read [the docs](https://example.com/docs/start) first.";
    expect(splitOutboundBody("telegram", body).join("")).toContain(
      "https://example.com/docs/start",
    );
  });

  it("keeps every split part in the plain-text fallback after Markdown rejection", async () => {
    const { surface, sends, threadId } = createSurface([
      "Bad Request: can't parse entities",
      "",
      "Bad Request: can't parse entities",
    ]);
    const body = "!".repeat(4096);
    for (const part of splitOutboundBody("telegram", body)) {
      await surface.sendToThread({ threadId, body: part }, context);
    }

    const fallback = sends.filter((send) => !send.parse_mode);
    expect(fallback).toHaveLength(2);
    expect(fallback.map(({ text }) => text).join("")).toBe(body);
    expect(sends.every(({ text }) => text.length <= 4096)).toBe(true);
  });

  it("renders headings, bold, links and escaped punctuation as MarkdownV2", async () => {
    const { surface, sends, threadId } = createSurface();
    const result = await surface.sendToThread(
      {
        threadId,
        body: "# Heading\n\n**bold** and [link](https://example.test)\n\nHello_world! (test).",
      },
      context,
    );

    expect(result.handle).toBeTruthy();
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({
      parse_mode: "MarkdownV2",
      text: "*Heading*\n\n*bold* and [link](https://example.test)\n\nHello\\_world\\! \\(test\\)\\.",
    });
  });

  it("retries a Markdown parse rejection as plain text and returns its handle", async () => {
    const { surface, sends, threadId } = createSurface([
      "Bad Request: can't parse entities: Can't find end of Bold entity",
    ]);

    const result = await surface.sendToThread({ threadId, body: "**bold**!" }, context);

    expect(result.handle).toBeTruthy();
    expect(sends).toHaveLength(2);
    expect(sends[0]).toMatchObject({ parse_mode: "MarkdownV2", text: "*bold*\\!" });
    expect(sends[1]).toMatchObject({ text: "bold!" });
    expect(sends[1]).not.toHaveProperty("parse_mode");
  });

  it("propagates unrelated send failures without a duplicate plain-text attempt", async () => {
    const { surface, sends, threadId } = createSurface(["Internal Server Error"]);

    await expect(surface.sendToThread({ threadId, body: "**bold**" }, context)).rejects.toThrow(
      "Internal Server Error",
    );
    expect(sends).toHaveLength(1);
  });

  it("propagates a failed plain-text fallback for upstream delivery recovery", async () => {
    const { surface, sends, threadId } = createSurface([
      "Bad Request: can't parse entities",
      "Internal Server Error",
    ]);

    await expect(surface.sendToThread({ threadId, body: "**bold**" }, context)).rejects.toThrow(
      "Internal Server Error",
    );
    expect(sends).toHaveLength(2);
    expect(sends[1]).not.toHaveProperty("parse_mode");
  });
});

describe("Telegram bots side by side", () => {
  const telegramUpdate = (text: string) => ({
    update_id: 1,
    message: {
      message_id: 7,
      date: 1_700_000_000,
      chat: { id: 123, type: "private", first_name: "Ada" },
      from: { id: 123, is_bot: false, first_name: "Ada" },
      text,
    },
  });

  function createTwoBotSurface() {
    const sends: { token: string; chatId: unknown }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string, init: RequestInit) => {
        const url = new URL(input);
        const [, botPath, method] = url.pathname.split("/");
        const token = botPath!.replace(/^bot/, "");
        if (method === "getMe") {
          return Response.json({ ok: true, result: { id: 9, is_bot: true, username: token } });
        }
        if (method === "sendRichMessage") {
          return Response.json(
            { ok: false, error_code: 404, description: "Not Found" },
            {
              status: 404,
            },
          );
        }
        if (method !== "sendMessage") throw new Error(`Unexpected Telegram method: ${method}`);
        const payload = JSON.parse(String(init.body)) as { chat_id: unknown; text: string };
        sends.push({ token, chatId: payload.chat_id });
        return Response.json({
          ok: true,
          result: {
            message_id: 42,
            date: 1_700_000_000,
            chat: { id: 123, type: "private" },
            from: { id: 9, is_bot: true, first_name: token },
            text: payload.text,
          },
        });
      }),
    );
    const telegram = (botToken: string, secretToken: string) =>
      createTelegramAdapter({ botToken, secretToken, mode: "webhook" });
    const capabilities = { direct: true, groups: false, receipt: null };
    const surface = new ChatSdkMessagingSurface([
      { provider: "telegram", capabilities, adapter: telegram("home-token", "home-secret") },
      {
        provider: "telegram-work",
        adapterName: "telegram",
        capabilities,
        adapter: telegram("work-token", "work-secret"),
      },
    ]);
    const inbound: MessagingInboundEvent[] = [];
    surface.onInbound(async (event) => {
      inbound.push(event);
    });
    return { surface, sends, inbound };
  }

  const webhook = (secret: string, text: string) =>
    new Request("https://rakazo.test/api/v1/messaging/webhook/x", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": secret,
      },
      body: JSON.stringify(telegramUpdate(text)),
    });

  it("keeps the same Telegram user's chats with each bot apart, inbound and outbound", async () => {
    const { surface, sends, inbound } = createTwoBotSurface();

    expect(
      (await surface.handleWebhook("telegram", webhook("home-secret", "hi home")))?.status,
    ).toBe(200);
    expect(
      (await surface.handleWebhook("telegram-work", webhook("work-secret", "hi work")))?.status,
    ).toBe(200);
    expect(inbound).toMatchObject([
      { provider: "telegram", threadId: "telegram:123", from: "123", content: "hi home" },
      { provider: "telegram-work", threadId: "telegram-work:123", from: "123", content: "hi work" },
    ]);

    await surface.sendToThread({ threadId: "telegram-work:123", body: "from work" }, context);
    await surface.sendToThread({ threadId: "telegram:123", body: "from home" }, context);
    expect(sends).toEqual([
      { token: "work-token", chatId: "123" },
      { token: "home-token", chatId: "123" },
    ]);
    expect(await surface.openDirectThread("telegram-work", "123", context)).toBe(
      "telegram-work:123",
    );
  });

  it("rejects an update signed with another bot's webhook secret", async () => {
    const { surface, inbound } = createTwoBotSurface();

    const response = await surface.handleWebhook("telegram-work", webhook("home-secret", "x"));

    expect(response?.status).toBe(401);
    expect(inbound).toEqual([]);
  });
});

describe("Telegram groups", () => {
  function createGroupSurface() {
    const sends: { token: string; payload: Record<string, unknown> }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string, init: RequestInit) => {
        const url = new URL(input);
        const [, botPath, method] = url.pathname.split("/");
        const token = botPath!.replace(/^bot/, "");
        if (method === "getMe") {
          const work = token.includes("work");
          return Response.json({
            ok: true,
            result: {
              id: work ? 998 : 999,
              is_bot: true,
              username: work ? "workbot" : "testbot",
            },
          });
        }
        if (method === "sendRichMessage") {
          return Response.json(
            { ok: false, error_code: 404, description: "Not Found" },
            { status: 404 },
          );
        }
        if (method !== "sendMessage") throw new Error(`Unexpected Telegram method: ${method}`);
        const payload = JSON.parse(String(init.body)) as Record<string, unknown>;
        sends.push({ token, payload });
        return Response.json({
          ok: true,
          result: {
            message_id: 42,
            date: 1_700_000_000,
            chat: { id: payload.chat_id, type: "supergroup" },
            from: { id: 999, is_bot: true, first_name: "Test Bot" },
            text: payload.text,
          },
        });
      }),
    );
    // Mount the production platform entries, not hand-built ones, so the
    // capability and hook wiring itself is under test.
    const surface = new ChatSdkMessagingSurface(
      messagingPlatformsFromEnv({
        telegramBotToken: "home-token",
        telegramWebhookSecret: "home-secret",
        telegramBots: [{ name: "work", botToken: "work-token", webhookSecret: "work-secret" }],
      }),
    );
    const inbound: MessagingInboundEvent[] = [];
    surface.onInbound(async (event) => {
      inbound.push(event);
    });
    return { surface, sends, inbound };
  }

  const webhook = (secret: string, update: unknown) =>
    new Request("https://rakazo.test/api/v1/messaging/webhook/x", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": secret,
      },
      body: JSON.stringify(update),
    });

  const familyChat = { id: -1001234, type: "supergroup" as const, title: "Family" };
  const sender = { id: 777, is_bot: false, first_name: "Grace" };

  function groupMessage(messageOverrides: Record<string, unknown> = {}, updateId = 101) {
    return {
      update_id: updateId,
      message: {
        message_id: 11,
        date: 1_700_000_000,
        chat: familyChat,
        from: sender,
        text: "hello group",
        ...messageOverrides,
      },
    };
  }

  it("delivers a group message with the chat title and the mention flag", async () => {
    const { surface, inbound } = createGroupSurface();

    expect(
      (
        await surface.handleWebhook(
          "telegram",
          webhook(
            "home-secret",
            groupMessage({
              message_id: 11,
              text: "@testbot hello",
              entities: [{ type: "mention", offset: 0, length: 8 }],
            }),
          ),
        )
      )?.status,
    ).toBe(200);
    expect(
      (
        await surface.handleWebhook(
          "telegram",
          webhook("home-secret", groupMessage({ message_id: 12 }, 102)),
        )
      )?.status,
    ).toBe(200);

    expect(inbound).toHaveLength(2);
    expect(inbound[0]).toMatchObject({
      type: "message",
      provider: "telegram",
      handle: "-1001234:11",
      threadId: "telegram:-1001234",
      isDirect: false,
      from: "777",
      fromLabel: "Grace",
      channelName: "Family",
      participants: [],
      content: "@testbot hello",
      mentionsBot: true,
    });
    expect(inbound[1]).toMatchObject({
      threadId: "telegram:-1001234",
      content: "hello group",
    });
    expect(inbound[1]?.type === "message" && inbound[1].mentionsBot).toBeUndefined();
  });

  it("keeps a plain reply on the group's own thread", async () => {
    const { surface, inbound } = createGroupSurface();

    expect(
      (
        await surface.handleWebhook(
          "telegram",
          webhook(
            "home-secret",
            groupMessage({
              message_id: 13,
              message_thread_id: 9,
              text: "yes please",
              reply_to_message: {
                message_id: 9,
                date: 1_700_000_000,
                chat: familyChat,
                from: { id: 999, is_bot: true, first_name: "Test Bot" },
                text: "earlier bot reply",
              },
            }),
          ),
        )
      )?.status,
    ).toBe(200);

    expect(inbound).toEqual([
      expect.objectContaining({
        threadId: "telegram:-1001234",
        content: "yes please",
      }),
    ]);
  });

  it("keeps a forum topic as its own conversation", async () => {
    const { surface, inbound } = createGroupSurface();

    await surface.handleWebhook(
      "telegram",
      webhook(
        "home-secret",
        groupMessage({ message_id: 14, is_topic_message: true, message_thread_id: 12 }),
      ),
    );

    expect(inbound).toEqual([
      expect.objectContaining({ threadId: "telegram:-1001234:12", channelName: "Family" }),
    ]);
  });

  it("ignores broadcast channel posts", async () => {
    const { surface, inbound } = createGroupSurface();

    const response = await surface.handleWebhook(
      "telegram",
      webhook("home-secret", {
        update_id: 104,
        channel_post: {
          message_id: 21,
          date: 1_700_000_000,
          chat: { id: -1005499, type: "channel", title: "Announcements" },
          text: "big news",
        },
      }),
    );

    expect(response?.status).toBe(200);
    expect(inbound).toEqual([]);
  });

  it("keeps each bot's group threads apart and posts replies to the right chat", async () => {
    const { surface, sends, inbound } = createGroupSurface();

    await surface.handleWebhook(
      "telegram-work",
      webhook("work-secret", groupMessage({ message_id: 15, text: "hi work bot" })),
    );
    expect(inbound).toMatchObject([
      {
        provider: "telegram-work",
        threadId: "telegram-work:-1001234",
        channelName: "Family",
      },
    ]);

    await surface.sendToThread({ threadId: "telegram-work:-1001234", body: "from work" }, context);
    await surface.sendToThread({ threadId: "telegram:-1001234", body: "from home" }, context);
    expect(sends.map(({ token, payload }) => [token, payload.chat_id])).toEqual([
      ["work-token", "-1001234"],
      ["home-token", "-1001234"],
    ]);
  });

  it("posts a forum topic reply into its topic", async () => {
    const { surface, sends } = createGroupSurface();

    await surface.sendToThread({ threadId: "telegram:-1001234:12", body: "topic reply" }, context);

    expect(sends[0]?.payload).toMatchObject({ chat_id: "-1001234", message_thread_id: 12 });
  });

  it("reports a member who left or was removed as a departure, not a message", async () => {
    const { surface, inbound } = createGroupSurface();

    expect(
      (
        await surface.handleWebhook(
          "telegram",
          webhook(
            "home-secret",
            groupMessage({
              message_id: 16,
              text: undefined,
              left_chat_member: { id: 888, is_bot: false, first_name: "Heather" },
            }),
          ),
        )
      )?.status,
    ).toBe(200);

    expect(inbound).toEqual([
      expect.objectContaining({
        type: "message",
        threadId: "telegram:-1001234",
        isDirect: false,
        from: "777",
        content: "",
        departures: { addresses: ["888"], botLeft: false },
      }),
    ]);
  });

  it("flags the bot's own removal as the channel's end", async () => {
    const { surface, inbound } = createGroupSurface();

    expect(
      (
        await surface.handleWebhook(
          "telegram",
          webhook(
            "home-secret",
            groupMessage({
              message_id: 17,
              text: undefined,
              from: { id: 600, is_bot: false, first_name: "Ada" },
              // The home bot's getMe id is 999.
              left_chat_member: { id: 999, is_bot: true, username: "testbot" },
            }),
          ),
        )
      )?.status,
    ).toBe(200);

    expect(inbound).toEqual([
      expect.objectContaining({ departures: { addresses: [], botLeft: true } }),
    ]);
  });
});

describe("Telegram messaging files", () => {
  function createFileSurface() {
    const uploads: { method: string; field: string; filename: string; caption: unknown }[] = [];
    // Exercise the pinned adapter's upload requests, replacing only HTTP.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string, init: RequestInit) => {
        const method = new URL(input).pathname.split("/").at(-1)!;
        if (method === "getMe") {
          return Response.json({
            ok: true,
            result: { id: 999, is_bot: true, username: "testbot" },
          });
        }
        if (method !== "sendPhoto" && method !== "sendDocument") {
          throw new Error(`Unexpected Telegram method: ${method}`);
        }
        const form = init.body as FormData;
        const field = method === "sendPhoto" ? "photo" : "document";
        const file = form.get(field) as File;
        uploads.push({ method, field, filename: file.name, caption: form.get("caption") });
        return Response.json({
          ok: true,
          result: {
            message_id: 43,
            date: 1_700_000_000,
            chat: { id: 123, type: "private" },
            from: { id: 999, is_bot: true, first_name: "Test Bot" },
          },
        });
      }),
    );
    const adapter = createTelegramAdapter({
      botToken: "test-token",
      secretToken: "test-webhook-secret",
      mode: "webhook",
    });
    const surface = new ChatSdkMessagingSurface([
      {
        provider: "telegram",
        capabilities: { direct: true, groups: false, receipt: null, files: true },
        adapter,
      },
    ]);
    return { surface, uploads, threadId: adapter.encodeThreadId({ chatId: "123" }) };
  }

  it("sends an image as a photo and other files as documents", async () => {
    const { surface, uploads, threadId } = createFileSurface();
    const data = new Uint8Array([1, 2, 3]);

    const photo = await surface.sendToThread(
      { threadId, body: "", attachment: { name: "chart.png", mimeType: "image/png", data } },
      context,
    );
    await surface.sendToThread(
      { threadId, body: "", attachment: { name: "report.pdf", mimeType: "application/pdf", data } },
      context,
    );

    expect(photo.handle).toBeTruthy();
    expect(uploads).toEqual([
      { method: "sendPhoto", field: "photo", filename: "chart.png", caption: null },
      { method: "sendDocument", field: "document", filename: "report.pdf", caption: null },
    ]);
  });
});

describe("Telegram redelivery", () => {
  it.each([
    [
      "telegram",
      999,
      5,
      { telegramBotToken: "test-token", telegramWebhookSecret: "test-webhook-secret" },
    ],
    [
      "telegram-work",
      1001,
      6,
      {
        telegramBots: [
          { name: "work", botToken: "test-token", webhookSecret: "test-webhook-secret" },
        ],
      },
    ],
  ] as [string, number, number, MessagingEnvironmentValues][])(
    "processes Telegram's retry of an update the sink failed on, exactly once (%s)",
    async (provider, botId, updateId, env) => {
      // The pinned adapter claims each update id; only getMe goes over HTTP.
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          Response.json({ ok: true, result: { id: botId, is_bot: true, username: "testbot" } }),
        ),
      );
      const surface = new ChatSdkMessagingSurface(messagingPlatformsFromEnv(env));
      const inbound: string[] = [];
      surface.onInbound(async (event) => {
        if (event.type !== "message") return;
        inbound.push(event.content);
        if (inbound.length === 1) throw new Error("database unavailable");
      });
      const update = () =>
        new Request("https://rakazo.test/api/v1/messaging/webhook/telegram", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-telegram-bot-api-secret-token": "test-webhook-secret",
          },
          body: JSON.stringify({
            update_id: updateId,
            message: {
              message_id: 7,
              date: 1_700_000_000,
              chat: { id: 123, type: "private", first_name: "Ada" },
              from: { id: 123, is_bot: false, first_name: "Ada" },
              text: "remind me at 5",
            },
          }),
        });

      const statuses = [];
      for (let attempt = 0; attempt < 3; attempt += 1) {
        statuses.push((await surface.handleWebhook(provider, update()))?.status);
      }

      expect(statuses).toEqual([500, 200, 200]);
      expect(inbound).toEqual(["remind me at 5", "remind me at 5"]);
    },
  );
});
