import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import { ComputerLimitError } from "./computers.js";
import { createGroupRepos } from "./groups.js";
import { provisionMessagingIdentity } from "./messaging.js";
import { createRepos } from "./repos.js";
import { asSystem, runAsSystem, runAsTenant } from "./row-security.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE && databaseUrl ? describe : describe.skip;

describePostgres("archived groups and their bots (PostgreSQL)", () => {
  const provider = "sendblue";
  const stamp = String(Date.now()).slice(-7);
  const address = `+1557${stamp}`;
  let prisma: PrismaClient;
  let close: () => Promise<void>;
  let owner: { userId: string; spaceId: string };
  let actor: { userId: string; spaceId: string; email: string; isDeploymentOwner: boolean };
  let computers = 0;

  const signup = { signupsEnabled: undefined, signupAllowlist: undefined };

  /** A bot on a computer of its own, so each live one counts toward the computer quota. */
  async function bot(name: string) {
    const created = await createRepos(prisma).createBot(actor, {
      name,
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    computers += 1;
    const system = asSystem(prisma);
    const computer = await system.computer.create({
      data: {
        spaceId: owner.spaceId,
        userId: owner.userId,
        scope: "dedicated",
        scopeKey: `group-restore-${stamp}-${computers}`,
        homeKey: `group-restore-home-${stamp}-${computers}`,
        kind: "fake",
      },
    });
    await system.bot.update({ where: { id: created.id }, data: { computerId: computer.id } });
    return created;
  }

  const archive = (botIds: string[]) =>
    asSystem(prisma).bot.updateMany({
      where: { id: { in: botIds } },
      data: { archivedAt: new Date() },
    });
  const archivedAt = async (botIds: string[]) =>
    (
      await asSystem(prisma).bot.findMany({
        where: { id: { in: botIds } },
        orderBy: { name: "asc" },
      })
    ).map((row) => row.archivedAt !== null);

  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    close = async () => {
      await db.prisma.$disconnect();
      await db.pool.end();
    };
    owner = await runAsSystem("test fixture", () =>
      provisionMessagingIdentity(prisma, { provider, address }, signup),
    );
    actor = { ...owner, email: "groups@example.test", isDeploymentOwner: false };
  });

  afterEach(() => {
    delete process.env.SANDBOX_MAX_COMPUTERS_PER_USER;
  });

  afterAll(async () => {
    if (prisma) {
      const system = asSystem(prisma, "test fixture cleanup");
      await system.messagingIdentity.deleteMany({ where: { provider, address } });
      if (owner) {
        await system.chatGroup.deleteMany({ where: { spaceId: owner.spaceId } });
        await system.bot.deleteMany({ where: { spaceId: owner.spaceId } });
        await system.organization.deleteMany({ where: { id: owner.spaceId } });
        await system.user.deleteMany({ where: { id: owner.userId } });
      }
    }
    await close?.();
  });

  // Group calls run as the owner, as the API router runs them; fixtures and checks run as system.
  it("lists a group its archived bots hid, and restoring it brings the bots and the group back", () =>
    runAsTenant(owner, async () => {
      const groups = createGroupRepos(prisma);
      const [ada, ben] = [await bot("Ada"), await bot("Ben")];
      const crew = await groups.createGroup(actor, { name: "Crew", botIds: [ada.id, ben.id] });

      await archive([ben.id]);
      expect((await groups.listGroups(actor)).map((group) => group.id)).not.toContain(crew.id);
      const hidden = (await groups.listGroups(actor, { archived: true })).find(
        (group) => group.id === crew.id,
      );
      expect(hidden?.members.map((member) => member.name)).toEqual(["Ada", "Ben"]);

      await groups.archiveGroup(actor, crew.id);
      await archive([ada.id]);
      expect(
        (await groups.listGroups(actor, { archived: true })).map((group) => group.id),
      ).toContain(crew.id);

      await groups.restoreGroup(actor, crew.id);
      expect(await archivedAt([ada.id, ben.id])).toEqual([false, false]);
      expect((await groups.listGroups(actor)).map((group) => group.id)).toContain(crew.id);
      expect(
        (await groups.listGroups(actor, { archived: true })).map((group) => group.id),
      ).not.toContain(crew.id);
      await expect(groups.getGroup(actor, crew.id)).resolves.toMatchObject({ archivedAt: null });
    }));

  it("restores nothing when one of the group's bots doesn't fit the computer quota", () =>
    runAsTenant(owner, async () => {
      const groups = createGroupRepos(prisma);
      await asSystem(prisma).bot.updateMany({
        where: { spaceId: owner.spaceId },
        data: { archivedAt: new Date() },
      });
      const live = await bot("Cy");
      const [dee, eve] = [await bot("Dee"), await bot("Eve")];
      const pair = await groups.createGroup(actor, { name: "Pair", botIds: [dee.id, eve.id] });
      await groups.archiveGroup(actor, pair.id);
      await archive([dee.id, eve.id]);
      // Cy uses one computer; Dee would take the second and Eve has no room left.
      process.env.SANDBOX_MAX_COMPUTERS_PER_USER = "2";

      await expect(groups.restoreGroup(actor, pair.id)).rejects.toBeInstanceOf(ComputerLimitError);
      expect(await archivedAt([dee.id, eve.id])).toEqual([true, true]);
      expect(
        (await asSystem(prisma).chatGroup.findUniqueOrThrow({ where: { id: pair.id } })).archivedAt,
      ).not.toBeNull();
      expect(await archivedAt([live.id])).toEqual([false]);

      process.env.SANDBOX_MAX_COMPUTERS_PER_USER = "3";
      await groups.restoreGroup(actor, pair.id);
      expect(await archivedAt([dee.id, eve.id])).toEqual([false, false]);
    }));
});
