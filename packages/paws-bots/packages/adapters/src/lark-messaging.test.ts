import { createCipheriv, createHash } from "node:crypto";
import { Readable } from "node:stream";
import type { HttpInstance } from "@larksuiteoapi/node-sdk";
import type {
  AdapterContext,
  MessagingInboundEvent,
  MessagingInboundMessage,
} from "@rakazo/adapter-kit";
import { ATTACHMENT_MAX_BYTES, ATTACHMENT_MAX_COUNT } from "@rakazo/contracts";
import { Message } from "chat";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChatSdkMessagingSurface } from "./chat-sdk-surface.js";
import { LazyLarkAdapter } from "./lark/lazy-adapter.js";
import { Domain, decodeThreadId, encodeThreadId } from "./lark/thread-id.js";
import { messagingPlatformsFromEnv } from "./messaging-platforms.js";

const { request } = vi.hoisted(() => ({ request: vi.fn() }));

// Exercise the real adapter and SDK; replace only outbound HTTP.
const httpInstance: HttpInstance = {
  request,
  get: request,
  delete: request,
  head: request,
  options: request,
  put: request,
  patch: request,
  post: (url: string, data: unknown) => request({ url, data, method: "POST" }),
};

const context: AdapterContext = {
  operationId: "op-test",
  traceId: "trace-test",
  spaceId: "space-test",
  userId: "user-test",
  signal: new AbortController().signal,
};
const token = "test-verification-token";
const encryptKey = "test-encryption-key";
// Image bytes the fake message-resource endpoint serves, by image key.
const images = new Map<string, Buffer>();
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from("png-body"),
]);
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x01, 0x02, 0x03]);

function createSurface(encrypted = false) {
  const platforms = messagingPlatformsFromEnv(
    {
      larkAppId: "cli-test",
      larkAppSecret: "test-app-secret",
      larkVerificationToken: token,
      ...(encrypted ? { larkEncryptKey: encryptKey } : {}),
    },
    { larkTransport: httpInstance },
  );
  const surface = new ChatSdkMessagingSurface(platforms);
  const events: MessagingInboundEvent[] = [];
  surface.onInbound(async (event) => {
    events.push(event);
  });
  return { surface, events, adapter: platforms[0]!.adapter };
}

function message(chatType = "p2p", sender = "ou-test") {
  return {
    schema: "2.0",
    header: { event_type: "im.message.receive_v1", event_id: "event-test", token },
    event: {
      sender: { sender_type: "user", sender_id: { open_id: sender } },
      message: {
        message_id: "om-test",
        chat_id: "oc-test",
        chat_type: chatType,
        message_type: "text",
        content: JSON.stringify({ text: "hello" }),
        create_time: "1700000000000",
      },
    },
  };
}

function messageWith(messageType: string, content: unknown) {
  const base = message();
  return {
    ...base,
    event: {
      ...base.event,
      message: {
        ...base.event.message,
        message_type: messageType,
        content: JSON.stringify(content),
      },
    },
  };
}

function webhook(body: unknown, headers: Record<string, string> = {}) {
  return new Request("https://rakazo.test/api/v1/messaging/webhook/lark", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function encryptedWebhook(payload: unknown, validSignature = true, pretty = false) {
  const iv = Buffer.alloc(16, 1);
  const key = createHash("sha256").update(encryptKey).digest();
  const cipher = createCipheriv("aes-256-cbc", key, iv);
  const encrypt = Buffer.concat([
    iv,
    cipher.update(JSON.stringify(payload)),
    cipher.final(),
  ]).toString("base64");
  const body = pretty ? JSON.stringify({ encrypt }, null, 2) : JSON.stringify({ encrypt });
  const timestamp = "1700000000";
  const nonce = "test-nonce";
  const signature = createHash("sha256")
    .update(timestamp + nonce + encryptKey + body)
    .digest("hex");
  return new Request("https://rakazo.test/api/v1/messaging/webhook/lark", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-lark-request-timestamp": timestamp,
      "x-lark-request-nonce": nonce,
      "x-lark-signature": validSignature ? signature : "invalid",
    },
    body,
  });
}

beforeEach(() => {
  images.clear();
  request.mockReset();
  request.mockImplementation(async ({ url }: { url: string }) => {
    const resource = /\/im\/v1\/messages\/om-test\/resources\/([^/?]+)$/.exec(url);
    if (resource) {
      const bytes = images.get(resource[1]!);
      if (!bytes) throw new Error(`Image not found: ${resource[1]}`);
      return {
        data: Readable.from([bytes]),
        headers: { "content-type": "application/octet-stream" },
      };
    }
    if (url.endsWith("/auth/v3/tenant_access_token/internal")) {
      return { code: 0, tenant_access_token: "test-access-token", expire: 7200 };
    }
    if (url.endsWith("/bot/v3/info")) {
      return { code: 0, bot: { open_id: "ou-bot", app_name: "Test bot" } };
    }
    if (url.endsWith("/contact/v3/users/ou-test")) {
      return { code: 0, data: { user: { name: "Test user" } } };
    }
    if (url.endsWith("/im/v1/messages/om-reply")) {
      return { code: 0 };
    }
    if (url.endsWith("/im/v1/messages")) {
      return { code: 0, data: { message_id: "om-reply" } };
    }
    if (url.endsWith("/im/v1/chats")) {
      return { code: 0, data: { chat_id: "oc-test" } };
    }
    throw new Error(`Unexpected HTTP request: ${url}`);
  });
});

describe("Lark messaging conformance", () => {
  it.each([undefined, "wrong-token"])("rejects a webhook with token %s", async (invalidToken) => {
    const { surface, events } = createSurface();
    const payload = message();
    const response = await surface.handleWebhook(
      "lark",
      webhook({ ...payload, header: { ...payload.header, token: invalidToken } }),
    );
    expect(response?.status).toBe(403);
    expect(events).toEqual([]);
  });

  it.each([false, true])(
    "answers authenticated URL verification (encrypted: %s)",
    async (encrypted) => {
      const { surface, events } = createSurface(encrypted);
      const payload = { type: "url_verification", token, challenge: "test-challenge" };
      const response = await surface.handleWebhook(
        "lark",
        encrypted ? encryptedWebhook(payload) : webhook(payload),
      );
      expect(response?.status).toBe(200);
      expect(await response?.json()).toEqual({ challenge: "test-challenge" });
      expect(events).toEqual([]);
    },
  );

  it.each([false, true])(
    "delivers direct messages and sends replies (encrypted: %s)",
    async (encrypted) => {
      const { surface, events } = createSurface(encrypted);
      const response = await surface.handleWebhook(
        "lark",
        encrypted ? encryptedWebhook(message()) : webhook(message()),
      );
      expect(response?.status).toBe(200);
      expect(events).toEqual([
        expect.objectContaining({
          type: "message",
          provider: "lark",
          isDirect: true,
          from: "ou-test",
          handle: "om-test",
          content: "hello",
        }),
      ]);
      const threadId = await surface.openDirectThread("lark", "ou-test", context);
      expect(
        await surface.sendToThread({ threadId, body: "## Plan\n\n**Bold** step" }, context),
      ).toEqual({
        handle: "om-reply",
      });
      expect(request).toHaveBeenCalledWith(
        expect.objectContaining({
          method: "POST",
          data: {
            receive_id: "oc-test",
            msg_type: "post",
            content: JSON.stringify({
              zh_cn: { content: [[{ tag: "md", text: "## Plan\n\n**Bold** step" }]] },
            }),
          },
        }),
      );
    },
  );

  it.each([true, false])(
    "verifies encrypted signatures against the raw body (raw signature: %s)",
    async (rawSignature) => {
      const { surface, events } = createSurface(true);
      const request = encryptedWebhook(message(), true, true);
      const body = await request.clone().text();
      expect(body).not.toBe(JSON.stringify(JSON.parse(body)));
      if (!rawSignature) {
        request.headers.set(
          "x-lark-signature",
          createHash("sha256")
            .update(
              request.headers.get("x-lark-request-timestamp")! +
                request.headers.get("x-lark-request-nonce")! +
                encryptKey +
                JSON.stringify(JSON.parse(body)),
            )
            .digest("hex"),
        );
      }
      const response = await surface.handleWebhook("lark", request);
      expect(response?.status).toBe(rawSignature ? 200 : 403);
      expect(events).toEqual(
        rawSignature
          ? [expect.objectContaining({ type: "message", provider: "lark", content: "hello" })]
          : [],
      );
    },
  );

  it("sends with a dedupe id Lark honors, so a repeated send of one message arrives once", async () => {
    const { surface } = createSurface();
    const threadId = await surface.openDirectThread("lark", "ou-test", context);
    const key = `msg:${"m".repeat(25)}:file:${"a".repeat(25)}`;
    await surface.sendToThread({ threadId, body: "hello", idempotencyKey: key }, context);
    await surface.sendToThread({ threadId, body: "hello", idempotencyKey: key }, context);

    const uuids = request.mock.calls
      .map(([config]) => (config as { data?: { uuid?: string } }).data?.uuid)
      .filter(Boolean);
    expect(uuids).toEqual([
      createHash("sha256").update(key).digest("hex").slice(0, 32),
      createHash("sha256").update(key).digest("hex").slice(0, 32),
    ]);
  });

  it("rejects an invalid encrypted signature", async () => {
    const { surface, events } = createSurface(true);
    expect((await surface.handleWebhook("lark", encryptedWebhook(message(), false)))?.status).toBe(
      403,
    );
    expect(events).toEqual([]);
  });

  it.each([
    ["group", "ou-test"],
    ["p2p", "ou-bot"],
  ])("ignores %s messages from %s", async (chatType, sender) => {
    const { surface, events } = createSurface();
    expect((await surface.handleWebhook("lark", webhook(message(chatType, sender))))?.status).toBe(
      200,
    );
    expect(events).toEqual([]);
  });

  it("returns a retryable failure when inbound persistence fails", async () => {
    const { surface } = createSurface();
    surface.onInbound(async () => {
      throw new Error("Persistence unavailable");
    });
    expect((await surface.handleWebhook("lark", webhook(message())))?.status).toBe(500);
  });
  it.each([false, true])(
    "rejects unauthenticated URL verification (encrypted: %s)",
    async (encrypted) => {
      const { surface } = createSurface(encrypted);
      const payload = { type: "url_verification", token: "wrong-token", challenge: "challenge" };
      expect(
        (
          await surface.handleWebhook(
            "lark",
            encrypted ? encryptedWebhook(payload) : webhook(payload),
          )
        )?.status,
      ).toBe(403);
    },
  );

  it("rejects malformed JSON and encrypted payloads", async () => {
    const { adapter } = createSurface();
    expect(
      (
        await adapter.handleWebhook(
          new Request("https://example.test", { method: "POST", body: "{" }),
        )
      ).status,
    ).toBe(400);
    expect((await adapter.handleWebhook(webhook({ encrypt: "invalid" }))).status).toBe(403);
  });

  it("preserves encoded chat and thread IDs byte for byte", () => {
    expect(encodeThreadId({ chatId: "oc-test" })).toBe("lark:b2MtdGVzdA");
    expect(encodeThreadId({ chatId: "oc-test", threadId: "omt-test" })).toBe(
      "lark:b2MtdGVzdA:b210LXRlc3Q",
    );
    expect(decodeThreadId("lark:b2MtdGVzdA:b210LXRlc3Q")).toEqual({
      chatId: "oc-test",
      threadId: "omt-test",
    });
    expect(() => decodeThreadId("slack:abc")).toThrow("Invalid thread ID prefix");
    expect(() => decodeThreadId("lark:")).toThrow("missing chatId");
  });

  it("edits Markdown as rich text and deletes messages through the SDK", async () => {
    const { surface, adapter } = createSurface();
    await surface.handleWebhook("lark", webhook(message()));
    const threadId = encodeThreadId({ chatId: "oc-test" });
    expect(
      await adapter.editMessage(threadId, "om-reply", { markdown: "**edited**" }),
    ).toMatchObject({ id: "om-reply", threadId });
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "PUT",
        url: expect.stringMatching(/\/im\/v1\/messages\/om-reply$/),
        data: {
          msg_type: "post",
          content: JSON.stringify({
            zh_cn: { content: [[{ tag: "md", text: "**edited**" }]] },
          }),
        },
      }),
    );
    await adapter.deleteMessage(threadId, "om-reply");
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ method: "DELETE" }));
  });

  it("posts plain strings as text through the SDK", async () => {
    const { adapter } = createSurface();
    const threadId = encodeThreadId({ chatId: "oc-test" });
    expect(await adapter.postMessage(threadId, "hello")).toMatchObject({
      id: "om-reply",
      threadId,
    });
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "POST",
        url: expect.stringMatching(/\/im\/v1\/messages$/),
        params: { receive_id_type: "chat_id" },
        data: {
          receive_id: "oc-test",
          msg_type: "text",
          content: JSON.stringify({ text: "hello" }),
        },
      }),
    );
  });

  it("rejects an empty postable before sending a message", async () => {
    const { adapter } = createSurface();
    await expect(
      adapter.postMessage(encodeThreadId({ chatId: "oc-test" }), { raw: "" }),
    ).rejects.toThrow(/empty or unsupported/);
    expect(request).not.toHaveBeenCalled();
  });

  it("fails outbound delivery on API errors", async () => {
    const { surface, adapter } = createSurface();
    await surface.handleWebhook("lark", webhook(message()));
    request.mockResolvedValueOnce({ code: 230001, msg: "Request rejected" });
    await expect(
      adapter.postMessage(encodeThreadId({ chatId: "oc-test" }), "reply"),
    ).rejects.toThrow("230001");
  });

  it("renders post content and links", async () => {
    const { surface, events } = createSurface();
    const payload = message();
    payload.event.message.message_type = "post";
    payload.event.message.content = JSON.stringify({
      post: {
        en_us: {
          title: "Title",
          content: [
            [
              { tag: "text", text: "See " },
              { tag: "a", text: "guide", href: "https://example.test/guide" },
            ],
          ],
        },
      },
    });
    await surface.handleWebhook("lark", webhook(payload));
    expect(events).toEqual([
      expect.objectContaining({ content: "Title\n\nSee guide (https://example.test/guide)" }),
    ]);
  });

  it.each([
    [
      "text and code",
      {
        content: [
          [{ tag: "text", text: "Before" }],
          [{ tag: "code_block", language: "GO", text: "func main() {\n    return\n}" }],
          [{ tag: "text", text: "After" }],
        ],
      },
      "Before\nfunc main() {\n    return\n}\nAfter",
    ],
    [
      "link and code",
      {
        content: [
          [{ tag: "a", text: "guide", href: "https://example.test/guide" }],
          [{ tag: "code_block", text: "if (ok) {\n    run();\n}" }],
        ],
      },
      "guide (https://example.test/guide)\nif (ok) {\n    run();\n}",
    ],
    [
      "Markdown inside code",
      { content: [[{ tag: "code_block", text: "[label](https://example.test)\n  literal" }]] },
      "[label](https://example.test)\n  literal",
    ],
    [
      "code only",
      {
        post: {
          en_us: {
            content: [
              [{ tag: "code_block", language: "GO", text: "func main() {\n    return\n}" }],
            ],
          },
        },
      },
      "func main() {\n    return\n}",
    ],
  ])("delivers post %s with code intact", async (_name, content, expected) => {
    const { surface, events } = createSurface();
    const payload = message();
    payload.event.message.message_type = "post";
    payload.event.message.content = JSON.stringify(content);
    expect((await surface.handleWebhook("lark", webhook(payload)))?.status).toBe(200);
    expect(events).toEqual([expect.objectContaining({ content: expected })]);
  });

  it("preserves other formatting when a post includes code", async () => {
    const { surface, events } = createSurface();
    const payload = message();
    payload.event.message.message_type = "post";
    payload.event.message.content = JSON.stringify({
      content: [
        [
          { tag: "text", text: "See **bold** " },
          { tag: "a", text: "guide", href: "https://example.test/guide" },
        ],
        [{ tag: "code_block", text: "  code" }],
      ],
    });
    await surface.handleWebhook("lark", webhook(payload));
    expect(events).toEqual([
      expect.objectContaining({ content: "See bold guide (https://example.test/guide)\n  code" }),
    ]);
  });

  it("retains links in list formatting alongside code", async () => {
    const { surface, events } = createSurface();
    const payload = message();
    payload.event.message.message_type = "post";
    payload.event.message.content = JSON.stringify({
      content: [
        [{ tag: "text", text: "- [guide](https://example.test/guide)" }],
        [{ tag: "code_block", text: "  code" }],
        [{ tag: "a", text: "reference", href: "https://example.test/reference" }],
      ],
    });
    await surface.handleWebhook("lark", webhook(payload));
    expect(events).toEqual([
      expect.objectContaining({
        content: expect.stringContaining("guide (https://example.test/guide)"),
      }),
    ]);
  });

  it("does not interpret indented ordinary code as a link", async () => {
    const { surface, events } = createSurface();
    const payload = message();
    payload.event.message.message_type = "post";
    payload.event.message.content = JSON.stringify({
      content: [
        [{ tag: "text", text: "    [literal](https://example.test/literal)" }],
        [{ tag: "code_block", text: "code" }],
        [{ tag: "a", text: "guide", href: "https://example.test/guide" }],
      ],
    });
    await surface.handleWebhook("lark", webhook(payload));
    expect(events).toEqual([
      expect.objectContaining({
        content: expect.stringContaining("[literal](https://example.test/literal)"),
      }),
    ]);
  });

  it("keeps title formatting when a post includes code and links", async () => {
    const { surface, events } = createSurface();
    const payload = message();
    payload.event.message.message_type = "post";
    payload.event.message.content = JSON.stringify({
      title: "Title",
      content: [
        [{ tag: "code_block", text: "code" }],
        [{ tag: "a", text: "guide", href: "https://example.test/guide" }],
      ],
    });
    await surface.handleWebhook("lark", webhook(payload));
    expect(events).toEqual([
      expect.objectContaining({ content: "Title\n\ncode\nguide (https://example.test/guide)" }),
    ]);
  });

  it("does not add ordinary Markdown indentation to a link", async () => {
    const { surface, events } = createSurface();
    const payload = message();
    payload.event.message.message_type = "post";
    payload.event.message.content = JSON.stringify({
      content: [
        [{ tag: "text", text: "  [guide](https://example.test/guide)" }],
        [{ tag: "code_block", text: "code" }],
      ],
    });
    await surface.handleWebhook("lark", webhook(payload));
    expect(events).toEqual([
      expect.objectContaining({ content: "guide (https://example.test/guide)\ncode" }),
    ]);
  });

  it("does not duplicate indentation parsed as ordinary Markdown code", async () => {
    const { surface, events } = createSurface();
    const payload = message();
    payload.event.message.message_type = "post";
    payload.event.message.content = JSON.stringify({
      content: [
        [{ tag: "text", text: "        code" }],
        [{ tag: "code_block", text: "literal" }],
        [{ tag: "a", text: "guide", href: "https://example.test/guide" }],
      ],
    });
    await surface.handleWebhook("lark", webhook(payload));
    expect(events).toEqual([
      expect.objectContaining({ content: "    code\nliteral\nguide (https://example.test/guide)" }),
    ]);
  });

  it("preserves heading separation with trailing title spaces", async () => {
    const { surface, events } = createSurface();
    const payload = message();
    payload.event.message.message_type = "post";
    payload.event.message.content = JSON.stringify({
      title: "Title  ",
      content: [
        [{ tag: "code_block", text: "code" }],
        [{ tag: "a", text: "guide", href: "https://example.test/guide" }],
      ],
    });
    await surface.handleWebhook("lark", webhook(payload));
    expect(events).toEqual([
      expect.objectContaining({ content: "Title\n\ncode\nguide (https://example.test/guide)" }),
    ]);
  });

  it("keeps code literal beside Markdown syntax and a link", async () => {
    const { surface, events } = createSurface();
    const payload = message();
    payload.event.message.message_type = "post";
    payload.event.message.content = JSON.stringify({
      content: [
        [
          { tag: "text", text: "`" },
          { tag: "code_block", text: "  x()\ny()" },
          { tag: "text", text: "`" },
        ],
        [{ tag: "a", text: "guide", href: "https://example.test/guide" }],
      ],
    });
    await surface.handleWebhook("lark", webhook(payload));
    expect(events).toEqual([
      expect.objectContaining({ content: expect.stringContaining("  x()\ny()") }),
    ]);
    expect(events).toEqual([
      expect.objectContaining({
        content: expect.stringContaining("guide (https://example.test/guide)"),
      }),
    ]);
  });

  it.each([false, true])(
    "resolves rich-text mention placeholders with code blocks: %s",
    async (withCode) => {
      const { surface, events } = createSurface();
      const payload = messageWith("post", {
        content: [
          [
            { tag: "at", user_id: "@_user_1", user_name: "" },
            { tag: "text", text: " and " },
            { tag: "at", user_id: "@_user_2" },
            { tag: "text", text: " and " },
            { tag: "at", user_id: "@_user_3", user_name: "Display name" },
          ],
          ...(withCode ? [[{ tag: "code_block", text: "@_user_1" }]] : []),
        ],
      });
      Object.assign(payload.event.message, {
        mentions: [
          { key: "@_user_1", name: "Alice", id: { open_id: "ou-alice" } },
          { key: "@_user_2", name: "Bob", id: { open_id: "ou-bob" } },
          { key: "@_user_3", name: "Other name", id: { open_id: "ou-other" } },
        ],
      });
      await surface.handleWebhook("lark", webhook(payload));
      expect(events).toEqual([
        expect.objectContaining({
          content: `@Alice and @Bob and @Display name${withCode ? "\n@_user_1" : ""}`,
        }),
      ]);
    },
  );

  it.each(["text", "post", "post with code"])(
    "resolves overlapping mention keys exactly once in %s",
    async (kind) => {
      const { surface, events } = createSurface();
      const keys = Array.from({ length: 10 }, (_, index) => `@_user_${index + 1}`);
      const text = `${keys.join(" ")} @_user_100`;
      const content =
        kind === "text"
          ? { text }
          : {
              content: [
                keys
                  .flatMap((user_id) => [
                    { tag: "at", user_id, user_name: "" },
                    { tag: "text", text: " " },
                  ])
                  .concat([{ tag: "at", user_id: "@_user_100", user_name: "" }]),
                ...(kind === "post with code" ? [[{ tag: "code_block", text }]] : []),
              ],
            };
      const payload = messageWith(kind === "text" ? "text" : "post", content);
      const names = [
        "Alice",
        "Price $& @_user_10",
        ...keys.slice(2).map((_, i) => `Person ${i + 3}`),
      ];
      Object.assign(payload.event.message, {
        mentions: keys.map((key, index) => ({
          key,
          name: names[index],
          id: { open_id: `ou-person-${index + 1}` },
        })),
      });
      await surface.handleWebhook("lark", webhook(payload));
      expect(events).toEqual([
        expect.objectContaining({
          content: `${names.map((name) => `@${name}`).join(" ")} @_user_100${kind === "post with code" ? `\n${text}` : ""}`,
        }),
      ]);
    },
  );

  it("treats mention keys literally and ignores empty keys", async () => {
    const { surface, events } = createSurface();
    const payload = messageWith("text", { text: "@_user.1 @_userX1 @_user.1suffix" });
    Object.assign(payload.event.message, {
      mentions: [
        { key: "", name: "Ignored", id: { open_id: "ou-empty" } },
        { key: "@_user.1", name: "Alice", id: { open_id: "ou-alice" } },
      ],
    });
    await surface.handleWebhook("lark", webhook(payload));
    expect(events).toEqual([
      expect.objectContaining({ content: "@Alice @_userX1 @_user.1suffix" }),
    ]);
  });

  it("preserves unresolved rich-text mention IDs and falls back without an ID", async () => {
    const { surface, events } = createSurface();
    await surface.handleWebhook(
      "lark",
      webhook(
        messageWith("post", {
          content: [
            [
              { tag: "at", user_id: "@_user_9", user_name: "" },
              { tag: "text", text: " and " },
              { tag: "at" },
            ],
          ],
        }),
      ),
    );
    expect(events).toEqual([expect.objectContaining({ content: "@_user_9 and @unknown" })]);
  });

  it("does not replace mention keys inside code blocks", async () => {
    const { surface, events } = createSurface();
    const payload = message();
    payload.event.message.message_type = "post";
    payload.event.message.content = JSON.stringify({
      content: [[{ tag: "text", text: "@_user_1" }], [{ tag: "code_block", text: "@_user_1" }]],
    });
    Object.assign(payload.event.message, {
      mentions: [{ key: "@_user_1", name: "Test", id: { open_id: "ou-test" } }],
    });
    await surface.handleWebhook("lark", webhook(payload));
    expect(events).toEqual([expect.objectContaining({ content: "@Test\n@_user_1" })]);
  });

  it("preserves multiple code blocks and their blank lines alongside links", async () => {
    const { surface, events } = createSurface();
    const payload = message();
    const first = "\nfirst\n\n";
    const second = "\n  second\n";
    payload.event.message.message_type = "post";
    payload.event.message.content = JSON.stringify({
      content: [
        [{ tag: "a", text: "guide", href: "https://example.test/guide" }],
        [{ tag: "code_block", text: first }],
        [{ tag: "code_block", text: second }],
        [{ tag: "text", text: "After" }],
      ],
    });
    await surface.handleWebhook("lark", webhook(payload));
    expect(events).toEqual([
      expect.objectContaining({
        content: `guide (https://example.test/guide)\n${first}\n${second}\nAfter`,
      }),
    ]);
  });

  it("replaces mention keys split between ordinary items but preserves them in code", async () => {
    const { surface, events } = createSurface();
    const payload = message();
    payload.event.message.message_type = "post";
    payload.event.message.content = JSON.stringify({
      content: [
        [
          { tag: "text", text: "@_user" },
          { tag: "text", text: "_1" },
        ],
        [{ tag: "code_block", text: "@_user_1\n  @_user_1" }],
      ],
    });
    Object.assign(payload.event.message, {
      mentions: [{ key: "@_user_1", name: "Test", id: { open_id: "ou-test" } }],
    });
    await surface.handleWebhook("lark", webhook(payload));
    expect(events).toEqual([expect.objectContaining({ content: "@Test\n@_user_1\n  @_user_1" })]);
  });

  it("preserves protected code parts through Message JSON serialization", async () => {
    const { surface, adapter } = createSurface();
    await surface.handleWebhook(
      "lark",
      webhook({ type: "url_verification", token, challenge: "test" }),
    );
    const payload = message();
    payload.event.message.message_type = "post";
    payload.event.message.content = JSON.stringify({
      content: [[{ tag: "text", text: "Before" }], [{ tag: "code_block", text: "  code\n" }]],
    });
    const parsed = adapter.parseMessage(payload.event);
    const restored = Message.fromJSON(JSON.parse(JSON.stringify(parsed)));
    expect(restored.text).toBe("Before\n  code\n");
    expect(restored.formatted.data).toMatchObject({
      rakazoLarkParts: [
        { text: "Before\n", literal: false },
        { text: "  code\n", literal: true },
      ],
    });
  });

  it("preserves an empty-label link alongside code", async () => {
    const { surface, events } = createSurface();
    const payload = message();
    payload.event.message.message_type = "post";
    payload.event.message.content = JSON.stringify({
      content: [
        [{ tag: "a", text: "", href: "https://example.test/guide" }],
        [{ tag: "code_block", text: "  code" }],
      ],
    });
    await surface.handleWebhook("lark", webhook(payload));
    expect(events).toEqual([
      expect.objectContaining({ content: "https://example.test/guide\n  code" }),
    ]);
  });

  it.each<[string, unknown, string]>([
    [
      "direct with title first",
      { title: "Title", content: [[{ tag: "text", text: "Hello" }]] },
      "# Title\nHello",
    ],
    ["direct without title", { content: [[{ tag: "text", text: "Hello" }]] }, "Hello"],
    [
      "direct with empty title",
      { title: "", content: [[{ tag: "text", text: "Hello" }]] },
      "Hello",
    ],
    ...["zh_cn", "en_us", "ja_jp"].flatMap<[string, unknown, string]>((locale) => {
      const post = { [locale]: { title: "Title", content: [[{ tag: "text", text: "Hello" }]] } };
      return [
        [locale, post, "# Title\nHello"],
        [`post.${locale}`, { post }, "# Title\nHello"],
      ];
    }),
    [
      "unsupported tags",
      {
        en_us: {
          title: "",
          content: [
            [
              { tag: "text", text: "Hello" },
              { tag: "img", image_key: "test-image", text: "ignored" },
              { tag: "unknown", text: "ignored" },
              { tag: "at", user_name: "Test bot" },
            ],
          ],
        },
      },
      "Hello@Test bot",
    ],
  ])("parses rich-text posts: %s", async (_name, content, expected) => {
    const { surface, adapter } = createSurface();
    await surface.handleWebhook(
      "lark",
      webhook({ type: "url_verification", token, challenge: "test" }),
    );
    const payload = message();
    payload.event.message.message_type = "post";
    payload.event.message.content = JSON.stringify(content);
    expect(adapter.parseMessage(payload.event).text).toBe(expected);
  });

  it("uses the selected API origin and keeps typing passive", async () => {
    const adapter = new LazyLarkAdapter({
      appId: "test-app",
      appSecret: "test-secret",
      verificationToken: token,
      encryptKey: "",
      domain: Domain.Lark,
      httpInstance,
    });
    await adapter.startTyping();
    expect(request).not.toHaveBeenCalled();
    await adapter.openDM!("ou-test");
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ url: "https://open.larksuite.com/open-apis/im/v1/chats" }),
    );
    expect(adapter.isDM(encodeThreadId({ chatId: "oc-test" }))).toBe(true);
  });
});

describe("Lark inbound images", () => {
  async function deliver(payload: unknown) {
    const { surface, events } = createSurface();
    const response = await surface.handleWebhook("lark", webhook(payload));
    expect(response?.status).toBe(200);
    return events as MessagingInboundMessage[];
  }

  it("delivers an image message as an attachment", async () => {
    images.set("img-1", png);
    const [event] = await deliver(messageWith("image", { image_key: "img-1" }));
    expect(event).toMatchObject({
      content: "",
      attachments: [{ name: "image-1.png", mimeType: "image/png", size: png.byteLength }],
    });
    expect(Buffer.from(await event!.attachments![0]!.fetch())).toEqual(png);
  });

  it.each([
    ["gif", "image/gif", Buffer.from("GIF89aimage-body")],
    ["webp", "image/webp", Buffer.from("RIFFxxxxWEBPimage-body")],
  ])("recognizes %s images", async (extension, mimeType, bytes) => {
    images.set("img-1", bytes);
    const [event] = await deliver(messageWith("image", { image_key: "img-1" }));
    expect(event?.attachments?.[0]).toMatchObject({ name: `image-1.${extension}`, mimeType });
  });

  it("preserves code blocks and mentions beside an image", async () => {
    images.set("img-1", png);
    const payload = messageWith("post", {
      content: [
        [
          { tag: "text", text: "@_user_1 " },
          { tag: "code_block", text: "const value = 1;" },
          { tag: "img", image_key: "img-1" },
        ],
      ],
    });
    Object.assign(payload.event.message, {
      mentions: [{ key: "@_user_1", name: "Test bot", id: { open_id: "bot-test" } }],
    });
    const [event] = await deliver(payload);
    expect(event?.content).toContain("@Test bot");
    expect(event?.content).toContain("const value = 1;");
    expect(event?.attachments).toHaveLength(1);
  });

  it("keeps the text of a rich-text post and attaches its images in order", async () => {
    images.set("img-1", png);
    images.set("img-2", jpeg);
    const [event] = await deliver(
      messageWith("post", {
        zh_cn: {
          content: [
            [{ tag: "text", text: "look" }],
            [{ tag: "img", image_key: "img-1" }],
            [{ tag: "img", image_key: "img-2" }],
            [{ tag: "img", image_key: "img-1" }],
          ],
        },
      }),
    );
    expect(event?.content).toBe("look");
    expect(event?.attachments?.map(({ name, mimeType }) => ({ name, mimeType }))).toEqual([
      { name: "image-1.png", mimeType: "image/png" },
      { name: "image-2.jpg", mimeType: "image/jpeg" },
    ]);
  });

  it("downloads no more images than a message may carry", async () => {
    const keys = Array.from({ length: ATTACHMENT_MAX_COUNT + 1 }, (_, index) => `img-${index}`);
    for (const key of keys) images.set(key, png);
    const [event] = await deliver(
      messageWith("post", {
        content: keys.map((key) => [{ tag: "img", image_key: key }]),
      }),
    );
    expect(event?.attachments).toHaveLength(ATTACHMENT_MAX_COUNT);
  });

  it.each([
    ["an unsupported format", () => images.set("img-1", Buffer.from("not an image"))],
    [
      "an oversized image",
      () => images.set("img-1", Buffer.concat([png, Buffer.alloc(ATTACHMENT_MAX_BYTES)])),
    ],
    ["a failed download", () => undefined],
  ])("still delivers the message when %s cannot be read", async (_label, arrange) => {
    arrange();
    const [event] = await deliver(messageWith("image", { image_key: "img-1" }));
    const [attachment] = event?.attachments ?? [];
    expect(event).toMatchObject({ provider: "lark", handle: "om-test" });
    // No MIME type and a failing fetch make the inbound handler mark it unavailable.
    expect(attachment).toMatchObject({ name: "image-1", mimeType: "" });
    await expect(attachment!.fetch()).rejects.toThrow();
  });

  it("never requests a resource for a key that is not a plain identifier", async () => {
    const [event] = await deliver(messageWith("image", { image_key: "../secrets" }));
    expect(event?.attachments).toBeUndefined();
    expect(request).not.toHaveBeenCalledWith(
      expect.objectContaining({ url: expect.stringContaining("/resources/") }),
    );
  });
});
