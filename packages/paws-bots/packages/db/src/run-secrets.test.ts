import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import { clearEndedRunState } from "./run-secrets.js";

describe("clearEndedRunState", () => {
  it("drops each cancelled run's checkpoint and waiting one-time answer", async () => {
    const prisma = {
      externalEffect: { deleteMany: vi.fn(async () => ({ count: 2 })) },
      message: { findMany: vi.fn(async () => []) },
      run: {
        findMany: vi.fn(async () => [
          { id: "run-1", userId: "user-1", spaceId: "space-1" },
          { id: "run-2", userId: "user-2", spaceId: "space-1" },
        ]),
      },
      secret: { deleteMany: vi.fn(async () => ({ count: 1 })) },
    };
    await clearEndedRunState(prisma as unknown as PrismaClient, ["run-1", "run-2"]);
    expect(prisma.externalEffect.deleteMany).toHaveBeenCalledOnce();
    // Each answer is matched under its own run's user and space, which the secrets index covers.
    expect(prisma.secret.deleteMany).toHaveBeenCalledWith({
      where: {
        OR: [
          { userId: "user-1", spaceId: "space-1", kind: "run-secret:run-1" },
          { userId: "user-1", spaceId: "space-1", kind: "run-code:run-1" },
          { userId: "user-1", spaceId: "space-1", kind: "run-code-spent:run-1" },
          { userId: "user-1", spaceId: "space-1", kind: { startsWith: "run-login:run-1:" } },
          { userId: "user-2", spaceId: "space-1", kind: "run-secret:run-2" },
          { userId: "user-2", spaceId: "space-1", kind: "run-code:run-2" },
          { userId: "user-2", spaceId: "space-1", kind: "run-code-spent:run-2" },
          { userId: "user-2", spaceId: "space-1", kind: { startsWith: "run-login:run-2:" } },
        ],
      },
    });
  });

  it("denies only effects behind an unanswered approval card", async () => {
    const card = (approvalEffectId: string, status: "pending" | "answered") => ({
      kind: "ask",
      approvalEffectId,
      text: "Review before sending",
      status,
      actions: [
        { id: "allow", label: "Allow once" },
        { id: "deny", label: "Deny" },
      ],
      ...(status === "answered" ? { answer: "allow" } : {}),
    });
    const prisma = {
      externalEffect: { deleteMany: vi.fn(), updateMany: vi.fn(async () => ({ count: 1 })) },
      message: {
        findMany: vi.fn(async () => [
          { blocks: [{ kind: "text", text: "Sending now" }, card("effect-open", "pending")] },
          { blocks: [card("effect-answered", "answered")] },
        ]),
      },
      run: { findMany: vi.fn(async () => []) },
      secret: { deleteMany: vi.fn() },
    };
    await clearEndedRunState(prisma as unknown as PrismaClient, ["run-1"]);
    // An effect with no card may belong to a tool that is still running; it keeps its status.
    expect(prisma.externalEffect.updateMany).toHaveBeenCalledOnce();
    expect(prisma.externalEffect.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["effect-open"] }, runId: { in: ["run-1"] }, status: "intended" },
      data: { status: "denied" },
    });
  });

  it("leaves effects alone when no card is open", async () => {
    const prisma = {
      externalEffect: { deleteMany: vi.fn(), updateMany: vi.fn() },
      message: { findMany: vi.fn(async () => [{ blocks: [{ kind: "text", text: "Done" }] }]) },
      run: { findMany: vi.fn(async () => []) },
      secret: { deleteMany: vi.fn() },
    };
    await clearEndedRunState(prisma as unknown as PrismaClient, ["run-1"]);
    expect(prisma.externalEffect.updateMany).not.toHaveBeenCalled();
  });

  it("does nothing without runs", async () => {
    const prisma = {
      externalEffect: { deleteMany: vi.fn() },
      run: { findMany: vi.fn() },
      secret: { deleteMany: vi.fn() },
    };
    await clearEndedRunState(prisma as unknown as PrismaClient, []);
    expect(prisma.run.findMany).not.toHaveBeenCalled();
    expect(prisma.secret.deleteMany).not.toHaveBeenCalled();
  });
});
