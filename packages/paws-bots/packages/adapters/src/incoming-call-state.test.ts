import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { loadUserIncomingCalls } from "./call-request.js";

describe("incoming-call stream snapshots", () => {
  it("loads only the call owner's one-to-one requests and removes expired or answered state", async () => {
    const bot = { id: "bot-1", spaceId: "space-1", name: "Caller", color: "", avatarSet: "rakazo" };
    const call = {
      kind: "call_request",
      callId: "call-1",
      reason: "Review",
      opening: "Hello",
      status: "ringing",
      expiresAt: new Date(Date.now() + 45000).toISOString(),
    };
    const findMany = vi.fn(async () => [
      { role: "bot", thread: { bot }, blocks: [call] },
      { role: "bot", thread: { bot }, blocks: [{ ...call, expiresAt: new Date(0).toISOString() }] },
      { role: "bot", thread: { bot }, blocks: [{ ...call, status: "answered" }] },
    ]);
    const prisma = { message: { findMany } } as unknown as PrismaClient;
    expect(await loadUserIncomingCalls(prisma, "user-1")).toEqual([
      {
        ...bot,
        incomingCall: {
          callId: call.callId,
          reason: call.reason,
          opening: call.opening,
          expiresAt: call.expiresAt,
        },
      },
    ]);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          thread: {
            userId: "user-1",
            groupId: null,
            externalConversationId: null,
            bot: { userId: "user-1", archivedAt: null },
          },
        }),
      }),
    );
  });
});
