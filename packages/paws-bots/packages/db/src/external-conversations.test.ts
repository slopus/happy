import type { Actor } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import { createExternalConversationRepos } from "./external-conversations.js";
import { IsolationError } from "./scope.js";

const actor: Actor = {
  userId: "user-1",
  spaceId: "space-1",
  email: "owner@example.com",
  isDeploymentOwner: true,
};

function sqlText(query: unknown): string {
  if (!query || typeof query !== "object" || !("strings" in query)) return "";
  const strings = Reflect.get(query, "strings");
  return Array.isArray(strings) ? strings.join("") : "";
}

describe("createExternalConversationRepos", () => {
  it("lists conversations for the actor's spaces", async () => {
    const findMany = vi.fn(async () => [
      {
        id: "ext-1",
        spaceId: "space-1",
        botId: "bot-1",
        provider: "slack",
        displayName: "launch",
        participantNames: ["Ada"],
        teamChatAmbientEnabled: true,
        teamChatRules: "Ping on dates",
        automatedSenderPolicies: {},
        updatedAt: new Date("2026-09-01T00:00:00.000Z"),
        thread: {
          id: "thread-1",
          reads: [{ unread: true }],
        },
      },
    ]);
    const queryRaw = vi.fn(async (query: unknown) => {
      const text = sqlText(query);
      if (text.includes("external_messages")) {
        return [{ externalConversationId: "ext-1", senderId: "B1", senderName: "Pager" }];
      }
      return [
        {
          id: "message-1",
          threadId: "thread-1",
          seq: 3,
          role: "user",
          blocks: [{ kind: "text", text: "Latest" }],
          botId: null,
          replyToMessageId: null,
          replyQuote: null,
          runId: null,
          clientNonce: null,
          createdAt: new Date("2026-09-01T00:00:00.000Z"),
        },
      ];
    });
    const repos = createExternalConversationRepos({
      externalConversation: { findMany },
      $queryRaw: queryRaw,
    } as never);

    await expect(repos.listForSpaces(["space-1"], "user-1")).resolves.toEqual([
      expect.objectContaining({
        id: "ext-1",
        threadId: "thread-1",
        preview: "Latest",
        unread: true,
        automatedSenders: [{ id: "B1", name: "Pager" }],
      }),
    ]);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ spaceId: { in: ["space-1"] } }),
      }),
    );
  });

  it("returns no rows for an empty space list", async () => {
    const queryRaw = vi.fn();
    const repos = createExternalConversationRepos({
      externalConversation: { findMany: vi.fn() },
      $queryRaw: queryRaw,
    } as never);
    await expect(repos.listForSpaces([], "user-1")).resolves.toEqual([]);
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it("updates policy only inside the actor boundary", async () => {
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const repos = createExternalConversationRepos({
      externalConversation: { updateMany },
    } as never);
    const policy = {
      teamChatAmbientEnabled: false,
      teamChatRules: null,
      automatedSenderPolicies: {},
    };
    await expect(repos.updatePolicy(actor, "ext-1", policy)).resolves.toEqual(policy);
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "ext-1", spaceId: "space-1", userId: "user-1" },
      data: policy,
    });
  });

  it("throws IsolationError when the policy row is missing", async () => {
    const repos = createExternalConversationRepos({
      externalConversation: { updateMany: vi.fn(async () => ({ count: 0 })) },
    } as never);
    await expect(
      repos.updatePolicy(actor, "missing", {
        teamChatAmbientEnabled: null,
        teamChatRules: null,
        automatedSenderPolicies: {},
      }),
    ).rejects.toBeInstanceOf(IsolationError);
  });
});
