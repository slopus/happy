import type { AdapterContext, MessagingInboundEvent } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import {
  createRecordingMessagingSurface,
  MessagingTeamChatEmulator,
} from "./messaging-team-chat-emulator.js";
import { createMessagingTeamChatSender, toTeamChatInbound } from "./team-chat-messaging.js";

const context: AdapterContext = {
  operationId: "operation-1",
  traceId: "trace-1",
  spaceId: "space-1",
  userId: "user-1",
  signal: new AbortController().signal,
};

describe("MessagingTeamChatEmulator", () => {
  it("rejects providers that cannot form valid thread IDs", () => {
    expect(() => new MessagingTeamChatEmulator({ provider: "" })).toThrow(/provider/);
    expect(() => new MessagingTeamChatEmulator({ provider: "bad:provider" })).toThrow(/provider/);
  });

  it("builds inbound fixtures with team-room enrichment fields", () => {
    const emulator = new MessagingTeamChatEmulator();
    const inbound = emulator.buildInbound({
      content: "hello room",
      kind: "mention",
      replyThreadId: "ts-1",
      participantNames: ["Ada", "Grace"],
    });
    expect(inbound.provider).toBe("teamchat-emulator");
    expect(inbound.workspaceId).toBe("T-emulator");
    expect(inbound.isDirect).toBe(false);
    expect(toTeamChatInbound(inbound)).toMatchObject({
      kind: "mention",
      workspaceId: "T-emulator",
      replyThreadId: "ts-1",
      participantNames: ["Ada", "Grace"],
      content: "hello room",
    });
  });

  it("exposes a MessagingPlatform with group capabilities", () => {
    const platform = new MessagingTeamChatEmulator().createPlatform();
    expect(platform).toMatchObject({
      provider: "teamchat-emulator",
      capabilities: { direct: true, groups: true, receipt: null },
    });
    expect(platform.directThreadId?.("U1")).toBe("teamchat-emulator:dm:U1");
  });

  it("works with createMessagingTeamChatSender via a recording surface", async () => {
    const emulator = new MessagingTeamChatEmulator();
    const recording = createRecordingMessagingSurface(emulator);
    const send = createMessagingTeamChatSender(recording as never);
    await send({
      conversationId: "teamchat-emulator:room-2",
      replyThreadId: null,
      content: "shipped",
    });
    expect(emulator.sent[0]).toMatchObject({
      threadId: "teamchat-emulator:room-2",
      body: "shipped",
    });
  });

  it("acts as a complete Slack-like messaging surface for product journeys", async () => {
    const emulator = new MessagingTeamChatEmulator({
      provider: "slack",
      capabilities: { groups: false },
    });
    const sink = vi.fn<(event: MessagingInboundEvent) => Promise<void>>(async () => undefined);
    emulator.onInbound(sink);

    const inbound = await emulator.emitInbound({
      isDirect: true,
      from: "U-colleague",
      fromLabel: "Teammate",
      content: "How is Fairhaven Robotics doing?",
    });
    await emulator.sendToThread({ threadId: inbound.threadId, body: "Checking now." }, context);

    expect(emulator.platforms()).toEqual([
      {
        provider: "slack",
        capabilities: { direct: true, groups: false, receipt: null },
      },
    ]);
    expect(sink).toHaveBeenCalledWith(inbound);
    expect(emulator.sent).toMatchObject([
      {
        threadId: inbound.threadId,
        body: "Checking now.",
        handle: "outbound-2",
      },
    ]);
    emulator.resetWitnesses();
    expect(emulator.handleWebhook("teams", new Request("https://example.test"))).toBeNull();
    await emulator.acknowledge(inbound.threadId, inbound.handle, context);
    expect(emulator.sent).toEqual([]);
  });
});
