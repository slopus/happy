import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import { provisionMessagingIdentity, redeemMessagingLinkCode } from "./messaging.js";

describe("provisionMessagingIdentity", () => {
  it("returns the existing identity without creating anything when already provisioned", async () => {
    const existing = {
      id: "mi-1",
      provider: "sendblue",
      address: "+15551234567",
      dmThreadId: null,
      userId: "user-1",
      spaceId: "ws-1",
      botId: "bot-1",
      verifiedAt: null,
      lastInboundAt: null,
      outboundSinceInbound: 0,
      createdAt: new Date("2026-08-28T00:00:00.000Z"),
      updatedAt: new Date("2026-08-28T00:00:00.000Z"),
    };
    const prisma = {
      messagingIdentity: { findUnique: vi.fn(async () => existing) },
      thread: { findFirst: vi.fn(async () => ({ id: "thread-1" })) },
      user: { create: vi.fn() },
    };
    const result = await provisionMessagingIdentity(
      prisma as unknown as PrismaClient,
      { provider: "sendblue", address: "+15551234567" },
      { signupsEnabled: undefined, signupAllowlist: undefined },
    );

    expect(result).toEqual({
      provider: "sendblue",
      address: "+15551234567",
      userId: "user-1",
      spaceId: "ws-1",
      botId: "bot-1",
      threadId: "thread-1",
      created: false,
    });
    expect(prisma.messagingIdentity.findUnique).toHaveBeenCalledWith({
      where: { provider_address: { provider: "sendblue", address: "+15551234567" } },
    });
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it("rejects malformed addresses", async () => {
    const prisma = { messagingIdentity: { findUnique: vi.fn() } };
    for (const bad of ["", "+1 (555) 123-4567", "has space", "a".repeat(129)]) {
      await expect(
        provisionMessagingIdentity(
          prisma as unknown as PrismaClient,
          { provider: "sendblue", address: bad },
          { signupsEnabled: undefined, signupAllowlist: undefined },
        ),
      ).rejects.toThrow(/Invalid messaging address/);
    }
    expect(prisma.messagingIdentity.findUnique).not.toHaveBeenCalled();
  });

  it("throws instead of returning an empty thread id when the thread is missing", async () => {
    const existing = {
      id: "mi-1",
      provider: "sendblue",
      address: "+15551234567",
      dmThreadId: null,
      userId: "user-1",
      spaceId: "ws-1",
      botId: "bot-1",
      verifiedAt: null,
      lastInboundAt: null,
      outboundSinceInbound: 0,
      createdAt: new Date("2026-08-28T00:00:00.000Z"),
      updatedAt: new Date("2026-08-28T00:00:00.000Z"),
    };
    const prisma = {
      messagingIdentity: { findUnique: vi.fn(async () => existing) },
      thread: { findFirst: vi.fn(async () => null) },
    };
    await expect(
      provisionMessagingIdentity(
        prisma as unknown as PrismaClient,
        { provider: "sendblue", address: "+15551234567" },
        { signupsEnabled: undefined, signupAllowlist: undefined },
      ),
    ).rejects.toThrow(/thread/i);
  });
});

describe("provisionMessagingIdentity create race", () => {
  it("resolves the thread for the winning identity's bot, not the loser's", async () => {
    const winner = {
      id: "mi-winner",
      provider: "sendblue",
      address: "+15551234567",
      userId: "user-1",
      spaceId: "ws-1",
      botId: "bot-winner",
    };
    const prisma = {
      messagingIdentity: {
        findUnique: vi
          .fn()
          .mockImplementationOnce(async () => null)
          .mockImplementationOnce(async () => winner),
        create: vi.fn(async () => {
          throw new Error("Unique constraint failed on the fields: (`provider`,`address`)");
        }),
      },
      user: {
        findUnique: vi.fn(async () => ({
          id: "user-1",
          email: "msg-sendbluex@messaging.invalid",
        })),
      },
      spaceMember: { findFirst: vi.fn(async () => ({ spaceId: "ws-1" })) },
      bot: { findFirst: vi.fn(async () => ({ id: "bot-loser" })) },
      thread: {
        findFirst: vi.fn(async ({ where }: { where: { botId: string } }) =>
          where.botId === "bot-winner" ? { id: "thread-winner" } : { id: "thread-loser" },
        ),
      },
    };
    const result = await provisionMessagingIdentity(
      prisma as unknown as PrismaClient,
      { provider: "sendblue", address: "+15551234567" },
      { signupsEnabled: undefined, signupAllowlist: undefined },
    );

    expect(result).toEqual({
      provider: "sendblue",
      address: "+15551234567",
      userId: "user-1",
      spaceId: "ws-1",
      botId: "bot-winner",
      threadId: "thread-winner",
      created: false,
    });
  });
});

describe("messaging link codes", () => {
  it("normalizes exactly-one-code messages and rejects everything else", async () => {
    const { normalizeMessagingLinkCode } = await import("./messaging.js");
    expect(normalizeMessagingLinkCode("abcd-2345")).toBe("ABCD2345");
    expect(normalizeMessagingLinkCode("  ABCD 2345 ")).toBe("ABCD2345");
    expect(normalizeMessagingLinkCode("hello there")).toBeNull();
    expect(normalizeMessagingLinkCode("ABCD2345 please")).toBeNull();
    expect(normalizeMessagingLinkCode("ABCD234")).toBeNull();
    expect(normalizeMessagingLinkCode("")).toBeNull();
  });

  it("formats codes for humans and round-trips through normalization", async () => {
    const { formatMessagingLinkCode, normalizeMessagingLinkCode } = await import("./messaging.js");
    expect(formatMessagingLinkCode("ABCD2345")).toBe("ABCD-2345");
    expect(normalizeMessagingLinkCode(formatMessagingLinkCode("ABCD2345"))).toBe("ABCD2345");
  });
});

describe("messaging identity isolation", () => {
  function fixture() {
    const users = [{ id: "attacker", email: "msg-sendblue15550001111@messaging.invalid" }];
    const identities: {
      provider: string;
      address: string;
      userId: string;
      spaceId: string;
      botId: string;
    }[] = [];
    const prisma = {
      user: {
        findUnique: vi.fn(
          async ({ where }: { where: { id?: string; email?: string } }) =>
            users.find((user) => (where.id ? user.id === where.id : user.email === where.email)) ??
            null,
        ),
        create: vi.fn(async ({ data }: { data: { id: string; email: string } }) => {
          users.push(data);
          return data;
        }),
      },
      messagingIdentity: {
        findUnique: vi.fn(
          async ({
            where,
          }: {
            where: { provider_address: { provider: string; address: string } };
          }) =>
            identities.find(
              (row) =>
                row.provider === where.provider_address.provider &&
                row.address === where.provider_address.address,
            ) ?? null,
        ),
        create: vi.fn(async ({ data }: { data: (typeof identities)[number] }) => {
          identities.push(data);
          return data;
        }),
      },
      spaceMember: {
        findFirst: vi.fn(async ({ where }: { where: { userId: string } }) => ({
          spaceId: `space-${where.userId}`,
        })),
      },
      bot: {
        findFirst: vi.fn(async ({ where }: { where: { userId: string } }) => ({
          id: `bot-${where.userId}`,
        })),
      },
      thread: {
        findFirst: vi.fn(async ({ where }: { where: { botId: string } }) => ({
          id: `thread-${where.botId}`,
        })),
      },
    };
    const provision = (provider: string, address: string) =>
      provisionMessagingIdentity(
        prisma as unknown as PrismaClient,
        { provider, address },
        { signupsEnabled: "true", signupAllowlist: "" },
      );
    return { prisma, users, provision };
  }

  it("never attaches a new sender to a preclaimed synthetic email", async () => {
    const f = fixture();
    const result = await f.provision("sendblue", "+15550001111");
    expect(result.userId).not.toBe("attacker");
    expect(result.spaceId).not.toBe("space-attacker");
    expect(f.users).toHaveLength(2);
    expect(f.users[1]!.email).not.toBe(f.users[0]!.email);
    expect(f.prisma.user.findUnique).toHaveBeenCalledWith({ where: { id: result.userId } });
    expect(await f.provision("sendblue", "+15550001111")).toMatchObject({
      userId: result.userId,
      created: false,
    });
    expect(f.prisma.user.create).toHaveBeenCalledTimes(1);
  });

  it("keeps punctuation, long addresses, case, and tuple boundaries distinct", async () => {
    const f = fixture();
    const requests = [
      ["slack", "a-b"],
      ["slack", "ab"],
      ["slack", "AB"],
      ["slack", `${"a".repeat(70)}1`],
      ["slack", `${"a".repeat(70)}2`],
      ["slack-a", "b"],
    ] as const;
    const results = [];
    for (const [provider, address] of requests) results.push(await f.provision(provider, address));
    expect(new Set(results.map((result) => result.userId)).size).toBe(requests.length);
  });

  it("resumes a crash after user creation by its internal key", async () => {
    const f = fixture();
    f.prisma.bot.findFirst.mockRejectedValueOnce(new Error("simulated crash"));
    await expect(f.provision("sendblue", "+15550001111")).rejects.toThrow("simulated crash");
    const orphan = f.users[1]!;
    expect(await f.provision("sendblue", "+15550001111")).toMatchObject({ userId: orphan.id });
    expect(f.prisma.user.create).toHaveBeenCalledTimes(1);
  });

  it("propagates database failures instead of treating them as identity races", async () => {
    const f = fixture();
    f.prisma.user.create.mockRejectedValueOnce(new Error("database unavailable"));
    await expect(f.provision("sendblue", "+15550001111")).rejects.toThrow("database unavailable");
    expect(f.prisma.messagingIdentity.create).not.toHaveBeenCalled();
  });
});

it("cannot redeem another space's personal link code through a workspace installation", async () => {
  const transaction = vi.fn();
  const prisma = {
    messagingLinkCode: {
      findUnique: vi.fn(async () => ({
        id: "code-a",
        spaceId: "space-a",
        expiresAt: new Date(Date.now() + 60_000),
      })),
    },
    $transaction: transaction,
  } as unknown as PrismaClient;
  expect(
    await redeemMessagingLinkCode(prisma, {
      code: "ABCD2345",
      provider: "slack",
      address: "Tb:U1",
      dmThreadId: "slack~b:D1",
      spaceId: "space-b",
    }),
  ).toBeNull();
  expect(transaction).not.toHaveBeenCalled();
});
