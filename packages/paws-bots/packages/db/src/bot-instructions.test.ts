import { describe, expect, it, vi } from "vitest";
import { InstructionConflictError, writeBotInstructions } from "./bot-instructions.js";

function fixture() {
  const bot = {
    id: "bot-1",
    instructions: "Draft only",
    instructionHistory: [] as Array<{
      id: string;
      instructions: string;
      reason: string;
      createdAt: string;
    }>,
  };
  const tx = {
    $queryRaw: vi.fn(async () => []),
    bot: {
      findUniqueOrThrow: vi.fn(async () => bot),
      update: vi.fn(async ({ data }: { data: Partial<typeof bot> }) => Object.assign(bot, data)),
    },
  };
  return { bot, tx };
}

describe("instruction history", () => {
  it("keeps the last 20 prior versions, restores without losing history, and rejects stale undo", async () => {
    const { bot, tx } = fixture();
    for (let index = 0; index < 25; index++)
      await writeBotInstructions(tx as never, {
        botId: bot.id,
        instructions: `Version ${index}`,
        reason: "Learned preference",
      });
    expect(bot.instructionHistory).toHaveLength(20);
    expect(bot.instructionHistory[0]!.instructions).toBe("Version 23");
    const versionId = bot.instructionHistory[0]!.id;
    await expect(
      writeBotInstructions(tx as never, {
        botId: bot.id,
        versionId,
        expectedInstructions: "stale",
        reason: "Undo",
      }),
    ).rejects.toThrow("changed");
    expect(bot.instructions).toBe("Version 24");
    await writeBotInstructions(tx as never, {
      botId: bot.id,
      versionId,
      expectedInstructions: "Version 24",
      reason: "Restore",
    });
    expect(bot.instructions).toBe("Version 23");
    expect(bot.instructionHistory[0]!.instructions).toBe("Version 24");
    expect(bot.instructionHistory).toHaveLength(20);
    await expect(
      writeBotInstructions(tx as never, {
        botId: bot.id,
        versionId: "expired",
        expectedInstructions: bot.instructions,
        reason: "Restore",
      }),
    ).rejects.toThrow("unavailable");
  });
  it("rejects stale manual edits and requires a baseline for historical restores", async () => {
    const { bot, tx } = fixture();
    await writeBotInstructions(tx as never, {
      botId: bot.id,
      instructions: "Newer edit",
      reason: "Manual edit",
    });
    await expect(
      writeBotInstructions(tx as never, {
        botId: bot.id,
        instructions: "Stale draft",
        expectedInstructions: "Draft only",
        reason: "Manual edit",
      }),
    ).rejects.toBeInstanceOf(InstructionConflictError);
    await expect(
      writeBotInstructions(tx as never, {
        botId: bot.id,
        versionId: bot.instructionHistory[0]!.id,
        reason: "Restore",
      }),
    ).rejects.toBeInstanceOf(InstructionConflictError);
    expect(bot.instructions).toBe("Newer edit");
  });
  it("allows restoring older history with a current baseline while Undo requires the latest version", async () => {
    const { bot, tx } = fixture();
    await writeBotInstructions(tx as never, {
      botId: bot.id,
      instructions: "First edit",
      reason: "Manual edit",
    });
    await writeBotInstructions(tx as never, {
      botId: bot.id,
      instructions: "Second edit",
      reason: "Manual edit",
    });
    const versionId = bot.instructionHistory[1]!.id;
    await expect(
      writeBotInstructions(tx as never, {
        botId: bot.id,
        versionId,
        expectedInstructions: bot.instructions,
        undo: true,
        reason: "Undo",
      }),
    ).rejects.toBeInstanceOf(InstructionConflictError);
    await writeBotInstructions(tx as never, {
      botId: bot.id,
      versionId,
      expectedInstructions: bot.instructions,
      reason: "Restore",
    });
    expect(bot.instructions).toBe("Draft only");
  });
  it("records manual edits and skips unchanged instructions", async () => {
    const { bot, tx } = fixture();
    expect(
      await writeBotInstructions(tx as never, {
        botId: bot.id,
        instructions: bot.instructions,
        reason: "Manual edit",
      }),
    ).toBeNull();
    expect(bot.instructionHistory).toEqual([]);
    await writeBotInstructions(tx as never, {
      botId: bot.id,
      instructions: "Never send",
      reason: "Manual edit",
    });
    expect(bot.instructionHistory[0]).toMatchObject({
      instructions: "Draft only",
      reason: "Manual edit",
    });
  });
  it("rejects undo after intervening edits", async () => {
    const { bot, tx } = fixture();
    const versionId = await writeBotInstructions(tx as never, {
      botId: bot.id,
      instructions: "New",
      reason: "Manual edit",
    });
    await writeBotInstructions(tx as never, {
      botId: bot.id,
      instructions: "Other",
      reason: "Manual edit",
    });
    await writeBotInstructions(tx as never, {
      botId: bot.id,
      instructions: "New",
      reason: "Manual edit",
    });
    await expect(
      writeBotInstructions(tx as never, {
        botId: bot.id,
        versionId: versionId!,
        expectedInstructions: "New",
        undo: true,
        reason: "Undo",
      }),
    ).rejects.toThrow("changed");
  });
});
