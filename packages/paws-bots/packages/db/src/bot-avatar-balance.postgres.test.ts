import { BOT_COLORS } from "@rakazo/contracts";
import {
  newClientId,
  ORGANIC_AVATAR_HEART_FAMILY,
  organicAvatarFamily,
  organicAvatarLook,
  seededLogoAvatarColor,
} from "@rakazo/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import { provisionMessagingIdentity } from "./messaging.js";
import { createRepos } from "./repos.js";
import { asSystem, runAsSystem, runAsTenant } from "./row-security.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE && databaseUrl ? describe : describe.skip;

describePostgres("new bot avatars (PostgreSQL)", () => {
  const provider = "sendblue";
  // A prefix no other test file uses, so parallel files never share this account.
  const address = `+1554${Math.floor(Math.random() * 9_000_000 + 1_000_000)}`;
  let prisma: PrismaClient;
  let close: () => Promise<void>;
  let owner: { userId: string; spaceId: string };

  const actor = () => ({
    userId: owner.userId,
    spaceId: owner.spaceId,
    email: "avatars@example.com",
    isDeploymentOwner: false,
  });
  const botInput = (name: string) => ({
    name,
    title: "",
    description: "",
    instructions: "",
    notifyOnFinish: true,
  });

  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    close = async () => {
      await db.prisma.$disconnect();
      await db.pool.end();
    };
    owner = await runAsSystem("test fixture", () =>
      provisionMessagingIdentity(
        prisma,
        { provider, address },
        { signupsEnabled: undefined, signupAllowlist: undefined },
      ),
    );
  });

  afterAll(async () => {
    if (prisma && owner) {
      const system = asSystem(prisma, "test fixture cleanup");
      await system.messagingIdentity.deleteMany({ where: { provider, address } });
      await system.organization.deleteMany({ where: { id: owner.spaceId } });
      await system.user.deleteMany({ where: { id: owner.userId } });
    }
    await close?.();
  });

  it("gives each new bot a shape and colour the user's other bots use least", async () => {
    const repos = createRepos(prisma);
    const system = asSystem(prisma);
    const before = await system.bot.findMany({
      where: { spaceId: owner.spaceId, userId: owner.userId },
      select: { id: true, color: true },
    });

    const created = await runAsTenant(owner, async () => {
      const bots = [];
      for (let index = 0; index < 9; index++) {
        bots.push(
          await repos.createBot(actor(), { ...botInput(`Helper ${index}`), avatarSet: "organic" }),
        );
      }
      // A bot made by a bot goes through the same choice.
      bots.push(
        await repos.createBot(actor(), {
          ...botInput("Child"),
          avatarSet: "organic",
          parentBotId: bots[0]!.id,
        }),
      );
      return bots;
    });

    const all = [...before, ...created];
    const lookOf = (id: string) => organicAvatarLook(organicAvatarFamily(id));
    // Eight automatic looks: the heart is excluded and the two round families share a look.
    const firstEight = all.slice(0, 8);
    expect(new Set(firstEight.map((bot) => lookOf(bot.id))).size).toBe(firstEight.length);
    expect(
      created.every((bot) => organicAvatarFamily(bot.id) !== ORGANIC_AVATAR_HEART_FAMILY),
    ).toBe(true);
    // The starter bot counts too: no colour repeats until the palette is used up.
    const firstColors = all.slice(0, BOT_COLORS.length).map((bot) => bot.color);
    expect(new Set(firstColors).size).toBe(firstColors.length);
    expect(created.every((bot) => /^c[a-z0-9]{24}$/.test(bot.id))).toBe(true);

    // Existing bots keep their id and colour.
    const after = await system.bot.findMany({
      where: { id: { in: before.map((bot) => bot.id) } },
      select: { id: true, color: true },
    });
    expect(after).toEqual(expect.arrayContaining(before));
  });

  it("defaults new creation to Original and reloads explicit sets without altering photos or shapes", async () => {
    const repos = createRepos(prisma);
    const created = await runAsTenant(owner, () =>
      repos.createBot(actor(), botInput("Original default")),
    );
    expect(created.avatarSet).toBe("organic");
    expect(BOT_COLORS).toContain(created.color);
    for (const color of ["#8B5CF6", "#8B5CF6::shape_3", "data:image/png;base64,aGVsbG8="]) {
      const original = await runAsTenant(owner, () =>
        repos.createBot(actor(), { ...botInput("Original look"), avatarSet: "organic", color }),
      );
      expect(original).toMatchObject({ avatarSet: "organic", color });
      await asSystem(prisma).bot.update({
        where: { id: original.id },
        data: { avatarSet: "rakazo" },
      });
      const reloaded = await runAsTenant(owner, () => repos.listBots(actor()));
      expect(reloaded.find((bot) => bot.id === original.id)).toMatchObject({
        avatarSet: "rakazo",
        color,
      });
    }
  });

  it("persists the preview seed and colour through a lost response and retry", async () => {
    const repos = createRepos(prisma);
    for (const explicit of [undefined, "#123456"]) {
      const id = `c${newClientId().replaceAll("-", "").slice(0, 24)}`;
      const input = { ...botInput("Preview"), id, avatarSet: "rakazo" as const, color: explicit };
      const [first, retry] = await runAsTenant(owner, () =>
        Promise.all([repos.createBot(actor(), input), repos.createBot(actor(), input)]),
      );
      expect(first).toMatchObject({ id, color: explicit ?? seededLogoAvatarColor(id) });
      expect(retry).toMatchObject({ id: first.id, color: first.color, threadId: first.threadId });
      expect(await runAsTenant(owner, () => repos.getBot(actor(), id))).toMatchObject({
        id,
        color: first.color,
      });
      const system = asSystem(prisma);
      expect(await system.thread.count({ where: { botId: id } })).toBe(1);
      await system.bot.update({ where: { id }, data: { archivedAt: new Date() } });
      await expect(runAsTenant(owner, () => repos.createBot(actor(), input))).rejects.toThrow();
      expect(await system.bot.findUnique({ where: { id } })).toMatchObject({
        color: first.color,
        spawnKey: id,
        archivedAt: expect.any(Date),
      });
    }
  });

  it("rejects identity collisions instead of changing or returning another bot", async () => {
    const repos = createRepos(prisma);
    const id = `c${newClientId().replaceAll("-", "").slice(0, 24)}`;
    const original = await runAsTenant(owner, () =>
      repos.createBot(actor(), {
        ...botInput("Keep me"),
        id,
        spawnKey: "different-key",
        color: "#123456",
      }),
    );
    await expect(
      runAsTenant(owner, () =>
        repos.createBot(actor(), {
          ...botInput("Collision"),
          id,
          color: "#654321",
        }),
      ),
    ).rejects.toThrow();
    const otherAddress = `${address}1`;
    const other = await runAsSystem("test fixture", () =>
      provisionMessagingIdentity(
        prisma,
        { provider, address: otherAddress },
        { signupsEnabled: undefined, signupAllowlist: undefined },
      ),
    );
    try {
      await expect(
        runAsTenant(other, () =>
          repos.createBot(
            { ...actor(), ...other },
            {
              ...botInput("Foreign collision"),
              id,
              spawnKey: "different-key",
            },
          ),
        ),
      ).rejects.toThrow();
      expect(await runAsTenant(owner, () => repos.getBot(actor(), id))).toMatchObject({
        id: original.id,
        name: "Keep me",
        color: "#123456",
      });
    } finally {
      const system = asSystem(prisma, "test fixture cleanup");
      await system.messagingIdentity.deleteMany({ where: { provider, address: otherAddress } });
      await system.organization.deleteMany({ where: { id: other.spaceId } });
      await system.user.deleteMany({ where: { id: other.userId } });
    }
  });

  it("serializes concurrent creation before reading the existing avatar looks", async () => {
    const repos = createRepos(prisma);
    await asSystem(prisma).bot.updateMany({
      where: { spaceId: owner.spaceId, userId: owner.userId },
      data: { archivedAt: new Date() },
    });
    const created = await runAsTenant(owner, () =>
      Promise.all(
        Array.from({ length: 8 }, (_, index) =>
          repos.createBot(actor(), { ...botInput(`Concurrent ${index}`), avatarSet: "organic" }),
        ),
      ),
    );
    expect(new Set(created.map((bot) => organicAvatarLook(organicAvatarFamily(bot.id)))).size).toBe(
      8,
    );
    expect(
      created.every((bot) => organicAvatarFamily(bot.id) !== ORGANIC_AVATAR_HEART_FAMILY),
    ).toBe(true);
  });

  it("keeps a colour the caller chose and skips archived bots", async () => {
    const repos = createRepos(prisma);
    const system = asSystem(prisma);
    const live = await system.bot.findMany({
      where: { spaceId: owner.spaceId, userId: owner.userId, archivedAt: null },
      select: { id: true },
    });
    // Archive every bot but one; the next bot then avoids only that one's family.
    const [kept, ...rest] = live;
    await system.bot.updateMany({
      where: { id: { in: rest.map((bot) => bot.id) } },
      data: { archivedAt: new Date() },
    });
    const next = await runAsTenant(owner, () =>
      repos.createBot(actor(), { ...botInput("Picked"), avatarSet: "organic", color: "#123456" }),
    );
    expect(next.color).toBe("#123456");
    expect(organicAvatarLook(organicAvatarFamily(next.id))).not.toBe(
      organicAvatarLook(organicAvatarFamily(kept!.id)),
    );
  });
});
