import { createHmac } from "node:crypto";
import type { MessagingInboundEvent } from "@rakazo/adapter-kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatSdkMessagingSurface } from "./chat-sdk-surface.js";
import { messagingPlatformsFromEnv } from "./messaging-platforms.js";

// Fake credentials and a stubbed fetch: the real Photon adapter verifies and
// routes webhooks offline; nothing here reaches Spectrum Cloud.
const webhookSecret = "whsec_test";

function createSurface() {
  const platforms = messagingPlatformsFromEnv(
    {
      photonProjectId: "project-test",
      photonProjectSecret: "secret-test",
      photonWebhookSecret: webhookSecret,
    },
    { pollInboundMessages: true },
  );
  const surface = new ChatSdkMessagingSurface(platforms);
  const events: MessagingInboundEvent[] = [];
  surface.onInbound(async (event) => {
    events.push(event);
  });
  return { surface, events };
}

function delivery(direction = "inbound", chatGuid = "any;-;+15550001111") {
  return {
    event: "messages",
    space: { id: chatGuid },
    message: {
      id: "msg-test",
      direction,
      sender: { id: "+15550001111" },
      content: { type: "text", text: "hello bot" },
      timestamp: new Date().toISOString(),
    },
  };
}

function webhook(payload: unknown, secret = webhookSecret) {
  const body = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex")}`;
  return new Request("https://example.test/api/v1/messaging/webhook/photon", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-spectrum-event": "messages",
      "x-spectrum-timestamp": timestamp,
      "x-spectrum-signature": signature,
    },
    body,
  });
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      // Spectrum Cloud's REST envelope; a shared-line token keeps the gRPC
      // client unconnected until something streams or sends.
      const url = String(input instanceof Request ? input.url : input);
      const data = url.endsWith("/imessage/tokens")
        ? { type: "shared", token: "token-test", expiresIn: 3600 }
        : {};
      return Response.json({ succeed: true, data });
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Photon messaging conformance", () => {
  it("delivers a signed direct message under the photon provider", async () => {
    const { surface, events } = createSurface();
    const response = await surface.handleWebhook("photon", webhook(delivery()));
    expect(response?.status).toBe(200);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      provider: "photon",
      threadId: "photon:any;-;+15550001111",
      isDirect: true,
      handle: "msg-test",
      from: "+15550001111",
      content: "hello bot",
    });
    await surface.shutdown();
  });

  it("ignores echoes of the line's own outbound messages", async () => {
    const { surface, events } = createSurface();
    const response = await surface.handleWebhook("photon", webhook(delivery("outbound")));
    expect(response?.status).toBe(200);
    expect(events).toEqual([]);
    await surface.shutdown();
  });

  it("rejects a webhook signed with another secret", async () => {
    const { surface, events } = createSurface();
    const response = await surface.handleWebhook("photon", webhook(delivery(), "whsec_forged"));
    expect(response?.status).toBe(401);
    expect(events).toEqual([]);
    await surface.shutdown();
  });
});
