import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import {
  assertComputerQuotaForRestore,
  ComputerLimitError,
  clearEndedExecutionRunBinding,
  computerHomeKey,
  computerScopeKey,
  ensureComputerRecord,
  resolveMaxComputersPerUser,
  restoreBotUnderComputerQuota,
} from "./computers.js";

function fakePrisma(count = 0, existing = false) {
  return {
    // Looks like a TransactionClient: $queryRaw present, no $transaction.
    $queryRaw: vi.fn(async () => [{ lock: "1" }]),
    computer: {
      findUnique: vi.fn(async () => (existing ? { id: "existing" } : null)),
      count: vi.fn(async () => count),
      upsert: vi.fn(async (args) => args.update as object),
    },
  } as unknown as PrismaClient;
}

function fakeRestorePrisma(results: { alreadyLive: number; inUse: number }) {
  const count = vi.fn(async (args: { where: { id?: string } }) =>
    args.where.id ? results.alreadyLive : results.inUse,
  );
  return {
    computer: { count },
  } as unknown as PrismaClient;
}

/**
 * Root PrismaClient mock whose $transaction + $queryRaw simulate a per-user
 * pg_advisory_xact_lock: concurrent quota transactions for the same user queue,
 * and creating a new computer increments the in-use count (as createBot /
 * setBotComputer do by linking a live bot in the same transaction).
 *
 * references track which bot sits on which computer so the count filter can
 * model the intermediate re-link: a bot's old computer stops counting once
 * the same transaction re-links it to a different one.
 */
function fakeSerializingPrisma(initialInUse = 0) {
  const rows = new Map<string, { id: string }>();
  const ids = new Map<string, string>(); // computer row id -> scopeKey
  const refs = new Map<string, Set<string>>(); // scopeKey -> bot ids
  let locked = false;
  const waiters: Array<() => void> = [];
  const state = { inUse: initialInUse };

  function recomputeInUse() {
    let used = 0;
    for (const bots of refs.values()) if (bots.size > 0) used += 1;
    state.inUse = used;
  }

  function botIdFromScopeKey(scopeKey: string): string | null {
    return scopeKey.startsWith("bot:") ? scopeKey.slice(4) : null;
  }

  async function acquireLock() {
    if (!locked) {
      locked = true;
      return;
    }
    await new Promise<void>((resolve) => {
      waiters.push(resolve);
    });
    locked = true;
  }

  function releaseLock() {
    const next = waiters.shift();
    if (next) {
      next();
      return;
    }
    locked = false;
  }

  function linkBot(botId: string, computerId: string) {
    const scopeKey = ids.get(computerId);
    for (const bots of refs.values()) bots.delete(botId);
    if (scopeKey) refs.get(scopeKey)!.add(botId);
    recomputeInUse();
  }

  const prisma = {
    $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => {
      let held = false;
      const tx = {
        $queryRaw: vi.fn(async () => {
          if (!held) {
            await acquireLock();
            held = true;
          }
          return [{ lock: "1" }];
        }),
        computer: {
          findUnique: vi.fn(async (args: { where: { scopeKey: string } }) => {
            const row = rows.get(args.where.scopeKey);
            return row ? { id: row.id } : null;
          }),
          count: vi.fn(async (args: { where: { bots?: { some?: { id?: { not?: string } } } } }) => {
            const excludeBot = args.where.bots?.some?.id?.not;
            let used = 0;
            for (const bots of refs.values()) {
              if (excludeBot) {
                if ([...bots].some((bot) => bot !== excludeBot)) used += 1;
              } else if (bots.size > 0) {
                used += 1;
              }
            }
            return used;
          }),
          upsert: vi.fn(async (args: { where: { scopeKey: string } }) => {
            const existing = rows.get(args.where.scopeKey);
            if (existing) return existing;
            const row = { id: `comp-${rows.size + 1}` };
            rows.set(args.where.scopeKey, row);
            ids.set(row.id, args.where.scopeKey);
            refs.set(args.where.scopeKey, new Set());
            // Same-transaction bot link makes the new row count as in-use:
            // createBot links the bot right after the row is ensured, so the
            // dedicated path's botId is already known to the quota check.
            const botId = botIdFromScopeKey(args.where.scopeKey);
            if (botId) refs.get(args.where.scopeKey)!.add(botId);
            recomputeInUse();
            return row;
          }),
        },
        bot: {
          update: vi.fn(async (args: { where: { id: string }; data: { computerId: string } }) => {
            linkBot(args.where.id, args.data.computerId);
            return { id: args.where.id };
          }),
        },
      };
      try {
        return await callback(tx);
      } finally {
        if (held) releaseLock();
      }
    }),
    bot: {
      update: vi.fn(async (args: { where: { id: string }; data: { computerId: string } }) => {
        linkBot(args.where.id, args.data.computerId);
        return { id: args.where.id };
      }),
    },
  } as unknown as PrismaClient;

  return { prisma, state, refs };
}

/**
 * Same per-user advisory lock as fakeSerializingPrisma, with archived vs live
 * bot refs so overlapping restores can race the last quota slot.
 */
function fakeSerializingRestorePrisma(
  computers: Array<{ id: string; liveBots?: string[]; archivedBots: string[] }>,
) {
  const live = new Map<string, Set<string>>();
  const archived = new Map<string, Set<string>>();
  for (const computer of computers) {
    live.set(computer.id, new Set(computer.liveBots ?? []));
    archived.set(computer.id, new Set(computer.archivedBots));
  }

  let locked = false;
  const waiters: Array<() => void> = [];

  async function acquireLock() {
    if (!locked) {
      locked = true;
      return;
    }
    await new Promise<void>((resolve) => {
      waiters.push(resolve);
    });
    locked = true;
  }

  function releaseLock() {
    const next = waiters.shift();
    if (next) {
      next();
      return;
    }
    locked = false;
  }

  function inUse() {
    let used = 0;
    for (const bots of live.values()) if (bots.size > 0) used += 1;
    return used;
  }

  const prisma = {
    $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => {
      let held = false;
      const tx = {
        $queryRaw: vi.fn(async () => {
          if (!held) {
            await acquireLock();
            held = true;
          }
          return [{ lock: "1" }];
        }),
        computer: {
          count: vi.fn(async (args: { where: { id?: string } }) => {
            if (args.where.id) return (live.get(args.where.id)?.size ?? 0) > 0 ? 1 : 0;
            return inUse();
          }),
        },
        bot: {
          update: vi.fn(async (args: { where: { id: string } }) => {
            for (const [computerId, bots] of archived) {
              if (bots.delete(args.where.id)) {
                live.get(computerId)!.add(args.where.id);
                break;
              }
            }
            return { id: args.where.id };
          }),
        },
      };
      try {
        return await callback(tx);
      } finally {
        if (held) releaseLock();
      }
    }),
  } as unknown as PrismaClient;

  return { prisma, inUse };
}

const baseInput = {
  mode: "dedicated" as const,
  spaceId: "space-1",
  userId: "user-1",
  botId: "bot-4",
  kind: "docker",
};

const savedEnv = process.env.SANDBOX_MAX_COMPUTERS_PER_USER;
afterEach(() => {
  if (savedEnv === undefined) delete process.env.SANDBOX_MAX_COMPUTERS_PER_USER;
  else process.env.SANDBOX_MAX_COMPUTERS_PER_USER = savedEnv;
  vi.restoreAllMocks();
});

describe("clearEndedExecutionRunBinding", () => {
  function bindingPrisma(run: { status: string } | null) {
    return {
      computer: {
        findUnique: vi.fn(async () => ({ executionRunId: "run-1" })),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
      run: { findUnique: vi.fn(async () => run) },
    } as unknown as PrismaClient;
  }

  it("clears a binding whose run ended", async () => {
    const prisma = bindingPrisma({ status: "cancelled" });
    await clearEndedExecutionRunBinding(prisma, "computer-1");
    expect(prisma.computer.updateMany).toHaveBeenCalledWith({
      where: { id: "computer-1", executionRunId: "run-1" },
      data: { executionRunId: null, executionBotId: null, executionLeaseExpiresAt: null },
    });
  });

  it("clears a binding whose run no longer exists", async () => {
    const prisma = bindingPrisma(null);
    await clearEndedExecutionRunBinding(prisma, "computer-1");
    expect(prisma.computer.updateMany).toHaveBeenCalled();
  });

  it("leaves a binding whose run may still execute", async () => {
    const prisma = bindingPrisma({ status: "running" });
    await clearEndedExecutionRunBinding(prisma, "computer-1");
    expect(prisma.computer.updateMany).not.toHaveBeenCalled();
  });

  it("does nothing when no binding is set", async () => {
    const prisma = {
      computer: {
        findUnique: vi.fn(async () => ({ executionRunId: null })),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
      run: { findUnique: vi.fn(async () => ({ status: "cancelled" })) },
    } as unknown as PrismaClient;
    await clearEndedExecutionRunBinding(prisma, "computer-1");
    expect(prisma.run.findUnique).not.toHaveBeenCalled();
    expect(prisma.computer.updateMany).not.toHaveBeenCalled();
  });
});

describe("team computer keys", () => {
  const team = { mode: "team" as const, spaceId: "space-1" };

  it("keys a team computer by space and user", () => {
    expect(computerScopeKey({ ...team, userId: "user-1" })).toBe("team:space-1:user-1");
    expect(computerScopeKey({ ...team, userId: "user-2" })).toBe("team:space-1:user-2");
    expect(computerScopeKey({ ...baseInput })).toBe("bot:bot-4");
  });

  it("gives each user a distinct home that survives the 40-character container name", () => {
    const first = computerHomeKey({ ...team, userId: "user-1" });
    const second = computerHomeKey({ ...team, userId: "user-2" });
    expect(first).toMatch(/^team-[0-9a-f]{32}$/);
    expect(first).toBe(computerHomeKey({ ...team, userId: "user-1" }));
    expect(first.slice(0, 40)).not.toBe(second.slice(0, 40));
    expect(computerHomeKey({ ...team, spaceId: "space-2", userId: "user-1" })).not.toBe(first);
    expect(computerHomeKey(baseInput)).toBe("bot-4");
  });

  it("shares one team computer per user, not across members of a space", async () => {
    const { prisma } = fakeSerializingPrisma(0);
    const ensureTeam = (userId: string) =>
      ensureComputerRecord(prisma, { ...team, userId, kind: "docker" });
    process.env.SANDBOX_MAX_COMPUTERS_PER_USER = "5";
    const firstBot = await ensureTeam("user-1");
    const secondBot = await ensureTeam("user-1");
    const otherMember = await ensureTeam("user-2");
    expect(secondBot.id).toBe(firstBot.id);
    expect(otherMember.id).not.toBe(firstBot.id);
  });
});

describe("resolveMaxComputersPerUser", () => {
  it("treats unset, empty, and 0 as no configured cap", () => {
    expect(resolveMaxComputersPerUser(undefined)).toBe(0);
    expect(resolveMaxComputersPerUser("")).toBe(0);
    expect(resolveMaxComputersPerUser("0")).toBe(0);
    expect(resolveMaxComputersPerUser("  ")).toBe(0);
  });

  it("accepts positive integers and rejects anything else", () => {
    expect(resolveMaxComputersPerUser("3")).toBe(3);
    for (const value of ["-1", "1.5", "not-a-number"])
      expect(() => resolveMaxComputersPerUser(value)).toThrow(/positive integer/);
  });
});

describe("ensureComputerRecord", () => {
  it("enforces the cap for a new computer when the user is at the limit", async () => {
    process.env.SANDBOX_MAX_COMPUTERS_PER_USER = "2";
    const prisma = fakePrisma(2, false);
    await expect(ensureComputerRecord(prisma, { ...baseInput, botId: "bot-new" })).rejects.toThrow(
      ComputerLimitError,
    );
    expect(prisma.computer.upsert).not.toHaveBeenCalled();
    // The quota lock, then the system bypass on and off around the cross-Space count.
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(4);
  });

  it("does not count archived-bot computers against the cap", async () => {
    process.env.SANDBOX_MAX_COMPUTERS_PER_USER = "1";
    const prisma = fakePrisma(0, false);
    await ensureComputerRecord(prisma, baseInput);
    expect(prisma.computer.upsert).toHaveBeenCalledOnce();
  });

  it("allows a team computer reuse even when the user is at the cap", async () => {
    process.env.SANDBOX_MAX_COMPUTERS_PER_USER = "1";
    const prisma = fakePrisma(1, true);
    await expect(
      ensureComputerRecord(prisma, { ...baseInput, mode: "team" }),
    ).resolves.toBeDefined();
  });

  it("does not enforce anything when the cap is unset", async () => {
    const prisma = fakePrisma(99, false);
    await ensureComputerRecord(prisma, baseInput);
    expect(prisma.computer.upsert).toHaveBeenCalledOnce();
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it("serializes parallel creates so concurrent callers cannot exceed the cap", async () => {
    process.env.SANDBOX_MAX_COMPUTERS_PER_USER = "1";
    const { prisma, state } = fakeSerializingPrisma(0);

    const results = await Promise.allSettled([
      ensureComputerRecord(prisma, {
        ...baseInput,
        spaceId: "space-a",
        botId: "bot-a",
      }),
      ensureComputerRecord(prisma, {
        ...baseInput,
        spaceId: "space-b",
        botId: "bot-b",
      }),
    ]);

    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.status === "rejected" && rejected[0].reason).toBeInstanceOf(
      ComputerLimitError,
    );
    expect(state.inUse).toBe(1);
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
  });

  it("allows the initial dedicated create at cap 1: the bot's team reference is being re-linked", async () => {
    process.env.SANDBOX_MAX_COMPUTERS_PER_USER = "1";
    const { prisma, state, refs } = fakeSerializingPrisma(0);
    // createBot flow, first bot in a space, dedicated mode:
    // 1. team computer ensured: no bots reference it yet.
    const team = await ensureComputerRecord(prisma, {
      mode: "team",
      spaceId: "space-1",
      userId: "user-1",
      kind: "docker",
    });
    // The mock's bot.create analog: link the bot to the team computer.
    await prisma.bot.update({ where: { id: "bot-1" }, data: { computerId: team.id } });
    expect(state.inUse).toBe(1);
    // 2. dedicated computer ensured: the bot is still on the team row, so the
    //    count must exclude this bot's own intermediate reference.
    const dedicated = await ensureComputerRecord(prisma, {
      ...baseInput,
      mode: "dedicated",
      botId: "bot-1",
    });
    // 3. the bot re-links to the dedicated computer (createBot does this).
    await prisma.bot.update({ where: { id: "bot-1" }, data: { computerId: dedicated.id } });
    expect(state.inUse).toBe(1);
    expect(refs.get(`bot:bot-1`)).toBeDefined();
  });

  it("allows team-to-dedicated replacement at cap 1 when the final set is one computer", async () => {
    process.env.SANDBOX_MAX_COMPUTERS_PER_USER = "1";
    const { prisma, state, refs } = fakeSerializingPrisma(0);
    // Existing bot on a team computer (setBotComputer switching to dedicated).
    const team = await ensureComputerRecord(prisma, {
      mode: "team",
      spaceId: "space-1",
      userId: "user-1",
      kind: "docker",
    });
    await prisma.bot.update({ where: { id: "bot-1" }, data: { computerId: team.id } });
    const dedicated = await ensureComputerRecord(prisma, {
      ...baseInput,
      mode: "dedicated",
      botId: "bot-1",
    });
    await prisma.bot.update({ where: { id: "bot-1" }, data: { computerId: dedicated.id } });
    expect(state.inUse).toBe(1);
    expect(refs.get("team:space-1:user-1")?.size).toBe(0);
  });
});

describe("assertComputerQuotaForRestore", () => {
  it("rejects the archive, create, restore bypass when the user is at the cap", async () => {
    process.env.SANDBOX_MAX_COMPUTERS_PER_USER = "1";
    // The archived bot's computer has no live bot referencing it (alreadyLive=0)
    // and the user already has 1 in-use computer (the newly created bot's).
    const prisma = fakeRestorePrisma({ alreadyLive: 0, inUse: 1 });
    await expect(
      assertComputerQuotaForRestore(prisma, { userId: "user-1", computerId: "computer-a" }),
    ).rejects.toThrow(ComputerLimitError);
  });

  it("allows the restore when the user is below the cap", async () => {
    process.env.SANDBOX_MAX_COMPUTERS_PER_USER = "1";
    const prisma = fakeRestorePrisma({ alreadyLive: 0, inUse: 0 });
    await expect(
      assertComputerQuotaForRestore(prisma, { userId: "user-1", computerId: "computer-a" }),
    ).resolves.toBeUndefined();
  });

  it("allows the restore when another live bot already references the computer", async () => {
    process.env.SANDBOX_MAX_COMPUTERS_PER_USER = "1";
    // Team computer shared by a still-live bot in the same space: restoring an
    // archived sibling bot adds nothing to the count, so it must not be refused.
    const prisma = fakeRestorePrisma({ alreadyLive: 1, inUse: 1 });
    await expect(
      assertComputerQuotaForRestore(prisma, { userId: "user-1", computerId: "team-computer" }),
    ).resolves.toBeUndefined();
  });

  it("does not enforce anything when the cap is unset", async () => {
    const prisma = fakeRestorePrisma({ alreadyLive: 0, inUse: 99 });
    await expect(
      assertComputerQuotaForRestore(prisma, { userId: "user-1", computerId: "computer-a" }),
    ).resolves.toBeUndefined();
  });
});

describe("restoreBotUnderComputerQuota", () => {
  it("serializes overlapping restores so only one can take the last quota slot", async () => {
    process.env.SANDBOX_MAX_COMPUTERS_PER_USER = "1";
    const { prisma, inUse } = fakeSerializingRestorePrisma([
      { id: "computer-a", archivedBots: ["bot-a"] },
      { id: "computer-b", archivedBots: ["bot-b"] },
    ]);

    const results = await Promise.allSettled([
      restoreBotUnderComputerQuota(prisma, {
        userId: "user-1",
        botId: "bot-a",
        computerId: "computer-a",
      }),
      restoreBotUnderComputerQuota(prisma, {
        userId: "user-1",
        botId: "bot-b",
        computerId: "computer-b",
      }),
    ]);

    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.status === "rejected" && rejected[0].reason).toBeInstanceOf(
      ComputerLimitError,
    );
    expect(inUse()).toBe(1);
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
  });

  it("unarchives under the lock when the user is below the cap", async () => {
    process.env.SANDBOX_MAX_COMPUTERS_PER_USER = "1";
    const { prisma, inUse } = fakeSerializingRestorePrisma([
      { id: "computer-a", archivedBots: ["bot-a"] },
    ]);
    await restoreBotUnderComputerQuota(prisma, {
      userId: "user-1",
      botId: "bot-a",
      computerId: "computer-a",
    });
    expect(inUse()).toBe(1);
  });
});
