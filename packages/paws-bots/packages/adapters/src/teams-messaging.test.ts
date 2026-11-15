import { TeamsAdapter } from "@chat-adapter/teams";
import type { MessagingInboundEvent } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { ChatSdkMessagingSurface } from "./chat-sdk-surface.js";
import { messagingEnvFromProcess, messagingPlatformsFromEnv } from "./messaging-platforms.js";

const credentials = {
  teamsAppId: "00000000-0000-4000-8000-000000000001",
  teamsAppPassword: "fake-client-secret",
  teamsAppTenantId: "00000000-0000-4000-8000-000000000002",
};

describe("Teams messaging", () => {
  it("normalizes credentials and requires the complete single-tenant configuration", () => {
    expect(
      messagingEnvFromProcess({
        TEAMS_APP_ID: " app ",
        TEAMS_APP_PASSWORD: " secret ",
        TEAMS_APP_TENANT_ID: " tenant ",
      }),
    ).toMatchObject({ teamsAppId: "app", teamsAppPassword: "secret", teamsAppTenantId: "tenant" });
    for (const key of Object.keys(credentials)) {
      expect(messagingPlatformsFromEnv({ ...credentials, [key]: undefined })).toEqual([]);
    }
    expect(messagingPlatformsFromEnv(credentials)[0]).toMatchObject({
      provider: "teams",
      capabilities: { direct: true, groups: false, receipt: "typing" },
    });
  });

  it("rejects unsigned webhook messages without delivering them", async () => {
    const surface = new ChatSdkMessagingSurface(messagingPlatformsFromEnv(credentials));
    const inbound = vi.fn();
    surface.onInbound(inbound);
    try {
      const response = await surface.handleWebhook(
        "teams",
        new Request("https://example.test/api/v1/messaging/webhook/teams", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            type: "message",
            id: "message-1",
            text: "link-code",
            channelId: "msteams",
            serviceUrl: "https://smba.trafficmanager.net/teams/",
            from: { id: "sender-1" },
            recipient: { id: `28:${credentials.teamsAppId}` },
            conversation: { id: "a:conversation-1", conversationType: "personal" },
          }),
        }),
      );
      expect(response?.status).toBe(401);
      expect(inbound).not.toHaveBeenCalled();
    } finally {
      await surface.shutdown();
    }
  });

  it("delivers personal messages and safely ignores channels and group chats", async () => {
    const initialize = vi.spyOn(TeamsAdapter.prototype, "initialize");
    const platforms = messagingPlatformsFromEnv(credentials);
    const surface = new ChatSdkMessagingSurface(platforms);
    const events: MessagingInboundEvent[] = [];
    surface.onInbound(async (event) => {
      events.push(event);
    });
    try {
      await surface.initialize();
      const chat = initialize.mock.calls[0]![0];
      const adapter = platforms[0]!.adapter;
      // The SDK calls processMessage after webhook authentication; exercise that
      // handoff with real Teams parsing, separately from the unsigned webhook test.
      for (const conversationType of ["personal", "groupChat", "channel"]) {
        const message = adapter.parseMessage({
          type: "message",
          id: `message-${conversationType}`,
          text: "hello",
          channelId: "msteams",
          serviceUrl: "https://smba.trafficmanager.net/teams/",
          from: { id: "29:sender", name: "Test Sender" },
          recipient: { id: `28:${credentials.teamsAppId}` },
          conversation: { id: `a:${conversationType}`, conversationType },
        });
        await chat.processMessage(adapter, message.threadId, message);
      }
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        provider: "teams",
        isDirect: true,
        from: "29:sender",
        content: "hello",
      });
    } finally {
      initialize.mockRestore();
      await surface.shutdown();
    }
  });

  it("uses durable thread ids that preserve the service URL and conversation type", () => {
    const adapter = new TeamsAdapter({
      appId: credentials.teamsAppId,
      appPassword: credentials.teamsAppPassword,
      appTenantId: credentials.teamsAppTenantId,
      appType: "SingleTenant",
    });
    const direct = {
      conversationId: "a:conversation-1",
      serviceUrl: "https://smba.trafficmanager.net/teams/",
      conversationType: "personal" as const,
    };
    const id = adapter.encodeThreadId(direct);
    expect(adapter.decodeThreadId(id)).toMatchObject({
      conversationId: direct.conversationId,
      serviceUrl: direct.serviceUrl,
    });
    expect(adapter.isDM(id)).toBe(true);
    expect(adapter.isDM(adapter.encodeThreadId({ ...direct, conversationType: "groupChat" }))).toBe(
      false,
    );
  });
});
