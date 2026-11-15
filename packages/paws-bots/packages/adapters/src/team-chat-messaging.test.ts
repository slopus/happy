import type { MessagingInboundMessage, MessagingSurface } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import {
  createMessagingTeamChatHistory,
  createMessagingTeamChatSender,
  resolveMessagingThreadId,
  toTeamChatInbound,
} from "./team-chat-messaging.js";

function baseEvent(overrides: Partial<MessagingInboundMessage> = {}): MessagingInboundMessage {
  return {
    type: "message",
    provider: "slack",
    handle: "Ev1",
    threadId: "slack:C1",
    isDirect: false,
    from: "U1",
    fromLabel: "Ada",
    channelName: "launch",
    participants: ["U1", "U2"],
    content: "Ship Friday?",
    mediaUrl: null,
    ...overrides,
  };
}

describe("toTeamChatInbound", () => {
  it("returns null when content and media are empty", () => {
    expect(toTeamChatInbound(baseEvent({ content: "  ", mediaUrl: null }))).toBeNull();
  });

  it("keeps a file-only message and passes its attachments through", () => {
    const attachment = { name: "a.png", mimeType: "image/png", fetch: vi.fn() };
    const mapped = toTeamChatInbound(baseEvent({ content: "", attachments: [attachment] }));
    expect(mapped).toMatchObject({ content: "", attachments: [attachment] });
  });

  it("leaves out the media url when the file arrives as an attachment", () => {
    const attachment = { name: "a.png", mimeType: "image/png", fetch: vi.fn() };
    const mapped = toTeamChatInbound(
      baseEvent({
        content: "see this",
        mediaUrl: "https://files.example/private/a.png",
        attachments: [attachment],
      }),
    );
    expect(mapped?.content).toBe("see this");
  });

  it("appends mediaUrl to content", () => {
    const mapped = toTeamChatInbound(
      baseEvent({ content: "see this", mediaUrl: "https://cdn.example/a.png" }),
    );
    expect(mapped?.content).toBe("see this\nhttps://cdn.example/a.png");
  });

  it("marks directs as direct", () => {
    expect(toTeamChatInbound(baseEvent({ isDirect: true }))?.kind).toBe("direct");
  });

  it("uses conversationKey and workspaceId when provided", () => {
    const mapped = toTeamChatInbound(
      baseEvent({
        workspaceId: "T1",
        conversationKey: "channel:C1",
        kind: "mention",
        replyThreadId: "100.1",
        senderIsBot: true,
        participantNames: ["Ada", "Grace"],
      }),
    );
    expect(mapped).toMatchObject({
      eventId: "Ev1",
      workspaceId: "T1",
      kind: "mention",
      conversationKey: "channel:C1",
      conversationId: "slack:C1",
      replyThreadId: "100.1",
      senderIsBot: true,
      participantNames: ["Ada", "Grace"],
    });
  });

  it("falls back workspaceId to provider and conversationKey to threadId", () => {
    const mapped = toTeamChatInbound(baseEvent());
    expect(mapped?.workspaceId).toBe("slack");
    expect(mapped?.conversationKey).toBe("slack:C1");
    expect(mapped?.kind).toBe("ambient");
  });

  it("treats @mentions as mention when kind is omitted", () => {
    expect(toTeamChatInbound(baseEvent({ content: "hey @rakazo look" }))?.kind).toBe("mention");
  });
});

describe("resolveMessagingThreadId", () => {
  it("keeps conversationId when there is no reply thread", () => {
    expect(resolveMessagingThreadId("slack:C1", null)).toBe("slack:C1");
  });

  it("appends replyThreadId onto provider:channel ids", () => {
    expect(resolveMessagingThreadId("slack:C1", "100.1")).toBe("slack:C1:100.1");
  });

  it("replaces a stale thread segment when replyThreadId differs", () => {
    expect(resolveMessagingThreadId("slack:C1:999.9", "100.1")).toBe("slack:C1:100.1");
  });

  it("leaves conversationId alone when it already ends with replyThreadId", () => {
    expect(resolveMessagingThreadId("slack:C1:100.1", "100.1")).toBe("slack:C1:100.1");
  });
});

describe("createMessagingTeamChatSender", () => {
  it("posts through messaging.sendToThread using the reply thread id", async () => {
    const sendToThread = vi.fn(async () => ({ handle: "msg-1" }));
    const messaging = { sendToThread } as unknown as MessagingSurface;
    const send = createMessagingTeamChatSender(messaging);
    await expect(
      send({
        conversationId: "slack:C1",
        replyThreadId: "100.1",
        content: "Done",
      }),
    ).resolves.toEqual({ handle: "msg-1" });
    expect(sendToThread).toHaveBeenCalledWith(
      { threadId: "slack:C1:100.1", body: "Done" },
      expect.objectContaining({
        operationId: expect.stringMatching(/^team-chat-send:/),
        spaceId: "",
        userId: "",
      }),
    );
  });

  it("forwards idempotencyKey into the messaging send and operation id", async () => {
    const sendToThread = vi.fn(async () => ({ handle: "msg-2" }));
    const messaging = { sendToThread } as unknown as MessagingSurface;
    const send = createMessagingTeamChatSender(messaging);
    await expect(
      send({
        conversationId: "slack:C1",
        replyThreadId: null,
        content: "Retry safe",
        idempotencyKey: "external-message:m-1",
      }),
    ).resolves.toEqual({ handle: "msg-2" });
    expect(sendToThread).toHaveBeenCalledWith(
      {
        threadId: "slack:C1",
        body: "Retry safe",
        idempotencyKey: "external-message:m-1",
      },
      expect.objectContaining({
        operationId: "team-chat-send:external-message:m-1",
      }),
    );
  });
});

describe("createMessagingTeamChatHistory", () => {
  it("is absent when the surface cannot read history", () => {
    expect(createMessagingTeamChatHistory({} as MessagingSurface)).toBeUndefined();
  });

  it("reads the reply thread and places each message in the asking room as ambient context", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const fetchThreadHistory = vi.fn(async () => [
      baseEvent({ handle: "100.1", content: "look at this", threadId: "slack:C1:100.1" }),
      baseEvent({ handle: "100.2", content: " " }),
    ]);
    const read = createMessagingTeamChatHistory({
      fetchThreadHistory,
    } as unknown as MessagingSurface);

    const history = await read!({
      eventId: "100.9",
      workspaceId: "T1",
      kind: "mention",
      conversationKey: "C1",
      conversationId: "slack:C1:100.1",
      conversationName: "launch",
      replyThreadId: "100.1",
      senderId: "U2",
      senderName: "Grace",
      content: "@Chief is this a LOD issue?",
    });

    expect(fetchThreadHistory).toHaveBeenCalledWith(
      "slack:C1:100.1",
      { before: "100.9", limit: 50 },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(timeout).toHaveBeenCalledWith(1_000);
    timeout.mockRestore();
    expect(history).toEqual([
      expect.objectContaining({
        eventId: "100.1",
        kind: "ambient",
        workspaceId: "T1",
        conversationKey: "C1",
        conversationId: "slack:C1:100.1",
        replyThreadId: "100.1",
        content: "look at this",
      }),
    ]);
  });
});
