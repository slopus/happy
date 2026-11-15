import { describe, expect, it, vi } from "vitest";
import type * as Events from "./events.js";

vi.mock("./events.js", async (importOriginal) => ({
  ...(await importOriginal<typeof Events>()),
  appendEventInTransaction: vi.fn(),
}));
vi.mock("./bot-instructions.js", () => ({ writeBotInstructions: vi.fn() }));

import { writeBotInstructions } from "./bot-instructions.js";
import { botProfileLabelsChanged, commitBotUpdate } from "./bot-update.js";

describe("botProfileLabelsChanged", () => {
  it("is true when name, description, or color is present", () => {
    expect(botProfileLabelsChanged({})).toBe(false);
    expect(botProfileLabelsChanged({ name: "SEO" })).toBe(true);
    expect(botProfileLabelsChanged({ description: "Helps with SEO" })).toBe(true);
    expect(botProfileLabelsChanged({ color: "#8B5CF6::shape_1" })).toBe(true);
    expect(botProfileLabelsChanged({ avatarSet: "rakazo" })).toBe(true);
  });
});

describe("commitBotUpdate", () => {
  it("does not publish or notify when a restore rejects its baseline", async () => {
    vi.mocked(writeBotInstructions).mockRejectedValueOnce(new Error("Instructions changed"));
    const tx = { $queryRaw: vi.fn().mockResolvedValue([]), bot: { update: vi.fn() } };
    const notify = vi.fn();
    const appendEvent = vi.fn();
    await expect(
      commitBotUpdate(
        {
          prisma: {
            $transaction: async (run: (client: typeof tx) => Promise<unknown>) => run(tx),
          } as never,
          notify,
          spaceId: "space-1",
          threadId: "thread-1",
          botId: "bot-1",
          data: {},
          emitBotUpdated: true,
          expectedInstructions: "Stale instructions",
          instructionRestore: { versionId: "version-1" },
        },
        appendEvent,
      ),
    ).rejects.toThrow("Instructions changed");
    expect(tx.bot.update).not.toHaveBeenCalled();
    expect(appendEvent).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });
  it.each([false, true])(
    "publishes a restore atomically after taking the thread lock (undo=%s)",
    async (undo) => {
      const updated = { id: "bot-1", name: "Chief", description: "" };
      const tx = {
        $queryRaw: vi.fn().mockResolvedValue([]),
        bot: { update: vi.fn().mockResolvedValue(updated) },
      };
      const transaction = vi.fn(async (run: (client: typeof tx) => Promise<unknown>) => run(tx));
      const notify = vi.fn().mockResolvedValue(undefined);
      const appendEvent = vi.fn().mockResolvedValue({ seq: 10 });
      await commitBotUpdate(
        {
          prisma: { $transaction: transaction } as never,
          notify,
          spaceId: "space-1",
          threadId: "thread-1",
          botId: "bot-1",
          data: {},
          emitBotUpdated: true,
          expectedInstructions: "Current instructions",
          instructionRestore: { versionId: "version-1", undo },
        },
        appendEvent,
      );
      expect(writeBotInstructions).toHaveBeenLastCalledWith(tx, {
        botId: "bot-1",
        instructions: undefined,
        reason: "Restore",
        expectedInstructions: "Current instructions",
        versionId: "version-1",
        undo,
      });
      expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(writeBotInstructions).mock.invocationCallOrder.at(-1) ?? 0,
      );
      expect(vi.mocked(writeBotInstructions).mock.invocationCallOrder.at(-1)).toBeLessThan(
        appendEvent.mock.invocationCallOrder[0] ?? 0,
      );
      expect(appendEvent).toHaveBeenCalledWith(
        tx,
        expect.objectContaining({ type: "bot.updated" }),
      );
      expect(notify).toHaveBeenCalledWith("thread-1", 10);
      expect(appendEvent.mock.invocationCallOrder[0]).toBeLessThan(
        notify.mock.invocationCallOrder[0] ?? 0,
      );
    },
  );
  it("writes the bot row and bot.updated in one transaction when labels change", async () => {
    const updated = {
      id: "bot-1",
      name: "SEO Strategist",
      description: "Helps with keyword research",
    };
    const botUpdate = vi.fn().mockResolvedValue(updated);
    const tx = { $queryRaw: vi.fn().mockResolvedValue([]), bot: { update: botUpdate } };
    const transaction = vi.fn(async (run: (client: typeof tx) => Promise<unknown>) => run(tx));
    const notify = vi.fn().mockResolvedValue(undefined);
    const appendEvent = vi.fn().mockResolvedValue({ seq: 9 });
    const prisma = {
      $transaction: transaction,
      bot: { update: vi.fn() },
    };

    await expect(
      commitBotUpdate(
        {
          prisma: prisma as never,
          notify,
          spaceId: "space-1",
          threadId: "thread-1",
          botId: "bot-1",
          data: { name: "SEO Strategist" },
          emitBotUpdated: true,
        },
        appendEvent,
      ),
    ).resolves.toEqual(updated);

    expect(transaction).toHaveBeenCalledOnce();
    expect(botUpdate).toHaveBeenCalledOnce();
    expect(tx.$queryRaw).toHaveBeenCalledOnce();
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      botUpdate.mock.invocationCallOrder[0] ?? 0,
    );
    expect(appendEvent).toHaveBeenCalledWith(tx, {
      spaceId: "space-1",
      threadId: "thread-1",
      botId: "bot-1",
      type: "bot.updated",
      payload: {
        botId: "bot-1",
        name: "SEO Strategist",
        description: "Helps with keyword research",
      },
    });
    expect(notify).toHaveBeenCalledWith("thread-1", 9);
    expect(prisma.bot.update).not.toHaveBeenCalled();
  });

  it("fails the whole update when the durable event write fails", async () => {
    const appendEvent = vi.fn().mockRejectedValue(new Error("event store unavailable"));
    const transaction = vi.fn(async (run: (client: unknown) => Promise<unknown>) =>
      run({
        $queryRaw: vi.fn().mockResolvedValue([]),
        bot: {
          update: vi.fn().mockResolvedValue({
            id: "bot-1",
            name: "SEO",
            description: "",
          }),
        },
      }),
    );
    const notify = vi.fn();
    const prisma = {
      $transaction: transaction,
      bot: { update: vi.fn() },
    };

    await expect(
      commitBotUpdate(
        {
          prisma: prisma as never,
          notify,
          spaceId: "space-1",
          threadId: "thread-1",
          botId: "bot-1",
          data: { name: "SEO" },
          emitBotUpdated: true,
        },
        appendEvent,
      ),
    ).rejects.toThrow("event store unavailable");
    expect(notify).not.toHaveBeenCalled();
    expect(prisma.bot.update).not.toHaveBeenCalled();
  });

  it("skips the write, the event and the notify when the default avatar set moved on", async () => {
    const botUpdate = vi.fn();
    const tx = {
      $queryRaw: vi.fn(async (strings: TemplateStringsArray) =>
        strings.join("").includes("FOR SHARE")
          ? [{ botAvatarSet: "organic" }]
          : ([{ id: "thread-1" }] as Array<unknown>),
      ),
      bot: { update: botUpdate },
    };
    const notify = vi.fn();
    const appendEvent = vi.fn();

    await expect(
      commitBotUpdate(
        {
          prisma: {
            $transaction: async (run: (client: typeof tx) => Promise<unknown>) => run(tx),
          } as never,
          notify,
          spaceId: "space-1",
          threadId: "thread-1",
          botId: "bot-1",
          data: { avatarSet: "rakazo" },
          emitBotUpdated: true,
          expectedUserAvatarSet: { userId: "user-1", botAvatarSet: "rakazo" },
        },
        appendEvent,
      ),
    ).resolves.toBeNull();

    expect(botUpdate).not.toHaveBeenCalled();
    expect(appendEvent).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it("writes the bot when the default avatar set still matches under the lock", async () => {
    const updated = { id: "bot-1", name: "Chief", description: "" };
    const botUpdate = vi.fn().mockResolvedValue(updated);
    const tx = {
      $queryRaw: vi.fn(async (strings: TemplateStringsArray) =>
        strings.join("").includes("FOR SHARE")
          ? [{ botAvatarSet: "rakazo" }]
          : ([{ id: "thread-1" }] as Array<unknown>),
      ),
      bot: { update: botUpdate },
    };
    const notify = vi.fn().mockResolvedValue(undefined);
    const appendEvent = vi.fn().mockResolvedValue({ seq: 4 });

    await expect(
      commitBotUpdate(
        {
          prisma: {
            $transaction: async (run: (client: typeof tx) => Promise<unknown>) => run(tx),
          } as never,
          notify,
          spaceId: "space-1",
          threadId: "thread-1",
          botId: "bot-1",
          data: { avatarSet: "rakazo" },
          emitBotUpdated: true,
          expectedUserAvatarSet: { userId: "user-1", botAvatarSet: "rakazo" },
        },
        appendEvent,
      ),
    ).resolves.toEqual(updated);

    // The default is read before the thread lock and before the bot row.
    const queries = tx.$queryRaw.mock.calls.map(([strings]) => strings.join(""));
    expect(queries[0]).toContain("FOR SHARE");
    expect(queries[1]).toContain("threads");
    expect(botUpdate).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledWith("thread-1", 4);
  });

  it("updates without an event when profile labels are unchanged", async () => {
    const update = vi.fn().mockResolvedValue({
      id: "bot-1",
      name: "Chief",
      description: "",
    });
    const prisma = {
      $transaction: vi.fn(),
      bot: { update },
    };
    const notify = vi.fn();
    const appendEvent = vi.fn();

    await expect(
      commitBotUpdate(
        {
          prisma: prisma as never,
          notify,
          spaceId: "space-1",
          threadId: "thread-1",
          botId: "bot-1",
          data: { pinned: true },
          emitBotUpdated: false,
        },
        appendEvent,
      ),
    ).resolves.toMatchObject({ id: "bot-1" });

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    expect(appendEvent).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledOnce();
  });
});

it("normalizes generated name tokens before updating a bot", async () => {
  const update = vi.fn().mockResolvedValue({ id: "bot-1", name: "Bot", description: "" });
  await commitBotUpdate({
    prisma: { bot: { update } } as never,
    notify: vi.fn(),
    spaceId: "space-1",
    threadId: "thread-1",
    botId: "bot-1",
    data: { name: "__TestTok1__" },
    emitBotUpdated: false,
  });
  expect(update).toHaveBeenCalledWith(expect.objectContaining({ data: { name: "" } }));
});

it("preserves readable numbered bot names on writes", async () => {
  const update = vi
    .fn()
    .mockResolvedValue({ id: "bot-1", name: "CustomerSupportBot2026", description: "" });
  await commitBotUpdate({
    prisma: { bot: { update } } as never,
    notify: vi.fn(),
    spaceId: "space-1",
    threadId: "thread-1",
    botId: "bot-1",
    data: { name: "CustomerSupportBot2026" },
    emitBotUpdated: false,
  });
  expect(update).toHaveBeenCalledWith(
    expect.objectContaining({ data: { name: "CustomerSupportBot2026" } }),
  );
});
