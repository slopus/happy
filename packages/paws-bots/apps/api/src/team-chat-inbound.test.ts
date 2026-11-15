import type { MessagingInboundMessage, TeamChatInboundMessage } from "@rakazo/adapter-kit";
import { SpaceDeletionInProgressError } from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as Inbound from "./messaging-inbound.js";
import type { MessagingInboundDeps } from "./messaging-inbound.js";
import type { TeamChatBridge } from "./team-chat-bridge.js";
import { createTeamChatInboundHandler } from "./team-chat-inbound.js";

const routing = vi.hoisted(() => ({ canWake: true, wake: vi.fn() }));

vi.mock("./messaging-inbound.js", async (importOriginal) => ({
  ...(await importOriginal<typeof Inbound>()),
  teamChatSenderCanWakeMessageRoutines: async () => routing.canWake,
  wakeMessageRoutines: routing.wake,
}));

function event(fields: Partial<MessagingInboundMessage> = {}): MessagingInboundMessage {
  return {
    type: "message",
    provider: "slack",
    handle: "100.1",
    threadId: "slack:C-1:100.1",
    isDirect: false,
    from: "U-1",
    fromLabel: "Ada",
    channelName: "launch",
    participants: [],
    content: "@Chief run the release routine",
    mediaUrl: null,
    workspaceId: "T-1",
    conversationKey: "channel:C-1",
    kind: "mention",
    ...fields,
  };
}

function setup(options: { recordedDeferred?: boolean } = {}) {
  const target = {
    spaceId: "space-1",
    userId: "owner-1",
    botId: "bot-1",
    threadId: "thread-1",
    externalMessageId: "external-1",
  };
  const bridge = {
    providerId: "slack",
    receive: vi.fn(async (_message: TeamChatInboundMessage, receive?: { defer?: boolean }) => ({
      ...target,
      deferred: options.recordedDeferred ?? Boolean(receive?.defer),
    })),
  };
  const teamChat = { routeToAgent: vi.fn(async () => {}), drop: vi.fn(async () => {}) };
  const deps = {} as MessagingInboundDeps;
  const inbound = vi.fn(async () => {});
  const handle = createTeamChatInboundHandler(deps, inbound, teamChat);
  return {
    bridge,
    teamChat,
    deps,
    inbound,
    target,
    handle: (message: MessagingInboundMessage) =>
      handle(bridge as unknown as TeamChatBridge, message),
  };
}

beforeEach(() => {
  routing.canWake = true;
  routing.wake.mockReset();
});

describe("TeamChat routine routing", () => {
  it("passes a message with nothing for team chat to the regular inbound", async () => {
    const chat = setup();
    const empty = event({ content: " " });

    await chat.handle(empty);

    expect(chat.inbound).toHaveBeenCalledWith(empty);
    expect(chat.bridge.receive).not.toHaveBeenCalled();
  });

  it("gives a sender who cannot wake routines straight to the agent", async () => {
    routing.canWake = false;
    const chat = setup();

    await chat.handle(event());

    expect(chat.bridge.receive).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ eventId: "100.1", kind: "mention" }),
    );
    expect(routing.wake).not.toHaveBeenCalled();
    expect(chat.teamChat.routeToAgent).not.toHaveBeenCalled();
  });

  it("lets a woken routine answer a deferred message alone", async () => {
    routing.wake.mockResolvedValue(true);
    const chat = setup();
    const emulated = event({ provider: "teamchat-emulator" });

    await chat.handle(emulated);

    expect(chat.bridge.receive).toHaveBeenCalledWith(expect.anything(), { defer: true });
    // The wake nonce uses the bridge's provider, as the message's backup job looks it up.
    expect(routing.wake).toHaveBeenCalledExactlyOnceWith(
      chat.deps,
      { ...chat.target, deferred: true },
      emulated,
      { deliveryProvider: "slack", externalMessageId: "external-1" },
    );
    expect(chat.teamChat.routeToAgent).not.toHaveBeenCalled();
    expect(chat.teamChat.drop).not.toHaveBeenCalled();
  });

  it.each(["mention", "ambient"] as const)(
    "hands a deferred %s message to the agent when no routine wakes",
    async (kind) => {
      routing.wake.mockResolvedValue(false);
      const chat = setup();

      await chat.handle(event({ kind }));

      expect(chat.teamChat.routeToAgent).toHaveBeenCalledExactlyOnceWith("external-1", kind);
    },
  );

  it("hands the message to the agent and reports the failure when routing fails", async () => {
    routing.wake.mockRejectedValue(new Error("routine lookup failed"));
    const chat = setup();

    await expect(chat.handle(event())).rejects.toThrow("routine lookup failed");

    expect(chat.teamChat.routeToAgent).toHaveBeenCalledExactlyOnceWith("external-1", "mention");
    expect(chat.teamChat.drop).not.toHaveBeenCalled();
  });

  it("accepts and drops a message routed to a Space being deleted, with no agent fallback", async () => {
    routing.wake.mockRejectedValue(new SpaceDeletionInProgressError());
    const chat = setup();

    await expect(chat.handle(event())).resolves.toBeUndefined();

    expect(chat.teamChat.drop).toHaveBeenCalledExactlyOnceWith("external-1", ["deferred"]);
    expect(chat.teamChat.routeToAgent).not.toHaveBeenCalled();
  });

  it("routes a redelivered message no further once it has moved on", async () => {
    const chat = setup({ recordedDeferred: false });

    await chat.handle(event());

    expect(routing.wake).not.toHaveBeenCalled();
    expect(chat.teamChat.routeToAgent).not.toHaveBeenCalled();
    expect(chat.teamChat.drop).not.toHaveBeenCalled();
  });
});
