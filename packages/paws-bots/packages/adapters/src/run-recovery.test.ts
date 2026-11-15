import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { findRunRecoveryBlockers } from "./run-recovery.js";

describe("run recovery blockers", () => {
  it("lets a background helper start while the bot's own turn holds the computer", async () => {
    const now = new Date();
    // A live turn's own lease, not a takeover hold.
    const expiresAt = new Date(now.getTime() + 60_000);
    const prisma = {
      computerExecutionLease: {
        findMany: vi.fn(async () => [
          { computerId: "computer", botId: "bot", runId: "chat-turn", expiresAt },
        ]),
      },
    } as unknown as PrismaClient;
    const run = (id: string, trigger: string) => ({
      id,
      botId: "bot",
      trigger,
      bot: { computerId: "computer" },
    });
    const blockers = await findRunRecoveryBlockers(
      prisma,
      [run("next-turn", "user"), run("helper", "helper")],
      now,
    );
    expect([...blockers]).toEqual([["next-turn", "chat-turn"]]);
  });
});
