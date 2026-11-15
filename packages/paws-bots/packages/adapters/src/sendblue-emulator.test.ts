import type { AdapterContext, MessagingInboundEvent } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import { ChatSdkMessagingSurface } from "./chat-sdk-surface.js";
import { createEmulatedSendbluePlatform, SendBlueEmulator } from "./sendblue-emulator.js";

const context: AdapterContext = {
  operationId: "op-1",
  traceId: "trace-1",
  spaceId: "ws-1",
  userId: "user-1",
  signal: new AbortController().signal,
};

/** The production sendblue pipeline (Chat SDK + official SDK) over the emulator. */
function createHarness() {
  const emulator = new SendBlueEmulator();
  const surface = new ChatSdkMessagingSurface([createEmulatedSendbluePlatform(emulator)]);
  const events: MessagingInboundEvent[] = [];
  surface.onInbound(async (event) => {
    events.push(event);
  });
  return { emulator, surface, events };
}

describe("emulated sendblue platform inbound", () => {
  it("normalizes a DM webhook into a direct inbound message", async () => {
    const { emulator, surface, events } = createHarness();
    const response = await surface.handleWebhook(
      "sendblue",
      emulator.buildInboundRequest({
        fromNumber: "+15551234567",
        content: "hi there",
        handle: "handle-dm-1",
      }),
    );

    expect(response?.status).toBe(200);
    // handleWebhook drains waitUntil, so the sink has finished by ACK.
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: "message",
      provider: "sendblue",
      transport: "iMessage",
      handle: "handle-dm-1",
      threadId: expect.stringMatching(/^sendblue:/),
      isDirect: true,
      from: "+15551234567",
      fromLabel: null,
      channelName: null,
      participants: [],
      content: "hi there",
      mediaUrl: null,
    });
    // The DM thread id matches what outbound resolution would open.
    const dmThreadId = await surface.openDirectThread("sendblue", "+15551234567", context);
    expect((events[0] as { threadId: string }).threadId).toBe(dmThreadId);
  });

  it("normalizes a group webhook with roster and display name", async () => {
    const { emulator, surface, events } = createHarness();
    const response = await surface.handleWebhook(
      "sendblue",
      emulator.buildInboundRequest({
        fromNumber: "+15551111111",
        content: "hello group",
        groupId: "grp-1",
        groupName: "Family",
        participants: ["+15551111111", "+15552222222", emulator.phoneNumber],
      }),
    );

    expect(response?.status).toBe(200);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual(
      expect.objectContaining({
        type: "message",
        provider: "sendblue",
        threadId: expect.stringMatching(/^sendblue:/),
        isDirect: false,
        from: "+15551111111",
        channelName: "Family",
        // The deployment's own line number never appears in the roster.
        participants: ["+15551111111", "+15552222222"],
        content: "hello group",
      }),
    );
  });
});

describe("emulated sendblue platform outbound", () => {
  it("sends a DM through openDirectThread + sendToThread", async () => {
    const { emulator, surface } = createHarness();
    const threadId = await surface.openDirectThread("sendblue", "+15557654321", context);
    const sent = await surface.sendToThread({ threadId, body: "hello you" }, context);

    expect(sent.handle).toMatch(/^emulated-handle-/);
    expect(emulator.sent).toEqual([
      { kind: "dm", to: "+15557654321", body: "hello you", handle: sent.handle },
    ]);
  });

  it("posts to a group via the thread id captured from an inbound group event", async () => {
    const { emulator, surface, events } = createHarness();
    await surface.handleWebhook(
      "sendblue",
      emulator.buildInboundRequest({
        fromNumber: "+15551111111",
        content: "hello group",
        groupId: "grp-1",
        participants: ["+15551111111", emulator.phoneNumber],
      }),
    );
    expect(events).toHaveLength(1);
    const threadId = (events[0] as { threadId: string }).threadId;

    const sent = await surface.sendToThread({ threadId, body: "hi all" }, context);

    expect(emulator.sent).toEqual([
      { kind: "group", groupId: "grp-1", body: "hi all", handle: sent.handle },
    ]);
  });

  it("rejects the send when the vendor API fails", async () => {
    const { emulator, surface } = createHarness();
    const threadId = await surface.openDirectThread("sendblue", "+15557654321", context);
    emulator.failNextSends(1);

    await expect(surface.sendToThread({ threadId, body: "will fail" }, context)).rejects.toThrow();
    expect(emulator.sent).toHaveLength(0);
    // The SDK must not retry on its own (no idempotency key): the outbox does.
    await surface.sendToThread({ threadId, body: "next" }, context);
    expect(emulator.sent.map((message) => message.body)).toEqual(["next"]);
  });
});

describe("emulated sendblue platform delivery status", () => {
  it("surfaces a signed status webhook to the sink", async () => {
    const { emulator, surface, events } = createHarness();
    const response = await surface.handleWebhook(
      "sendblue",
      emulator.buildStatusRequest({ handle: "handle-9", status: "DELIVERED" }),
    );

    expect(response?.status).toBe(200);
    expect(events).toEqual([
      { type: "status", provider: "sendblue", handle: "handle-9", status: "DELIVERED" },
    ]);
  });

  it("rejects a wrong signing secret with 401 and no sink event", async () => {
    const { emulator, surface, events } = createHarness();
    const good = emulator.buildStatusRequest({ handle: "handle-9", status: "DELIVERED" });
    const forged = new Request(good.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "sb-signing-secret": "not-the-secret",
      },
      body: await good.text(),
    });

    const response = await surface.handleWebhook("sendblue", forged);

    expect(response?.status).toBe(401);
    expect(events).toHaveLength(0);
  });
});

describe("emulated sendblue platform receipt", () => {
  it("acknowledges a DM with a typing indicator", async () => {
    const { emulator, surface } = createHarness();
    const threadId = await surface.openDirectThread("sendblue", "+15557654321", context);
    await surface.acknowledge(threadId, "inbound-1", context);

    expect(emulator.typingIndicators).toEqual(["+15557654321"]);
  });
});
