import type { Pool, QueryResult } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import { createGroupRepos } from "./groups.js";
import { provisionMessagingIdentity } from "./messaging.js";
import { createRepos } from "./repos.js";
import { asSystem, runAsSystem, runAsTenant } from "./row-security.js";
import { createSpaceForMember } from "./spaces.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE && databaseUrl ? describe : describe.skip;

/** Rows Postgres returned for one statement that reads `messages`. */
interface MessageRead {
  text: string;
  values: unknown[];
  rowCount: number;
}

const MESSAGE_FROM = /\bfrom\s+(?:"public"\s*\.\s*)?"?messages"?\b/i;

function sqlText(input: unknown): string {
  if (typeof input === "string") return input;
  if (input && typeof input === "object" && "text" in input && typeof input.text === "string") {
    return input.text;
  }
  return "";
}

function sqlValues(args: unknown[]): unknown[] {
  const [first, second] = args;
  if (Array.isArray(second)) return second;
  if (first && typeof first === "object" && "values" in first && Array.isArray(first.values)) {
    return first.values;
  }
  return [];
}

/** Sum of rows actually sent to the app, not rows Prisma later drops in memory. */
function trackMessageReads(pool: Pool): MessageRead[] {
  const reads: MessageRead[] = [];
  const original = pool.query.bind(pool);
  pool.query = ((...args: unknown[]) => {
    const result = (original as (...inner: unknown[]) => unknown)(...args);
    if (!result || typeof (result as Promise<unknown>).then !== "function") return result;
    return (result as Promise<QueryResult>).then((queryResult) => {
      const text = sqlText(args[0]);
      if (/^\s*select\b/i.test(text) && MESSAGE_FROM.test(text)) {
        reads.push({ text, values: sqlValues(args), rowCount: queryResult.rowCount ?? 0 });
      }
      return queryResult;
    });
  }) as Pool["query"];
  return reads;
}

interface Actor {
  userId: string;
  spaceId: string;
  email: string;
  isDeploymentOwner: boolean;
}

interface SeededGroup {
  id: string;
  threadId: string;
  name: string;
  preview: string;
  unread: boolean;
  updatedAt: string;
}

describePostgres("group sidebar previews (PostgreSQL)", () => {
  const provider = "sendblue";
  const stamp = String(Date.now()).slice(-7);
  const ownerAddress = `+1556${stamp}`;
  const signup = { signupsEnabled: undefined, signupAllowlist: undefined };
  let prisma: PrismaClient;
  let close: () => Promise<void>;
  let owner: { userId: string; spaceId: string };
  let actor: Actor;
  let reads: MessageRead[] = [];
  let computers = 0;
  let alpha: SeededGroup;
  let beta: SeededGroup;
  let gamma: SeededGroup;
  let delta: SeededGroup;
  let otherSpaceId = "";

  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    reads = trackMessageReads(db.pool);
    close = async () => {
      await db.prisma.$disconnect();
      await db.pool.end();
    };
    const provisioned = await runAsSystem("test fixture", () =>
      provisionMessagingIdentity(prisma, { provider, address: ownerAddress }, signup),
    );
    owner = provisioned;
    actor = {
      userId: owner.userId,
      spaceId: owner.spaceId,
      email: "groups-preview@example.com",
      isDeploymentOwner: false,
    };
    await asSystem(prisma).bot.update({
      where: { id: provisioned.botId },
      data: { archivedAt: new Date("2026-01-01T00:00:00.000Z") },
    });

    const ada = await bot(actor, "Ada");
    const ben = await bot(actor, "Ben");
    const groups = createGroupRepos(prisma);
    alpha = await seedGroup(groups, actor, "Alpha", [ada.id, ben.id], 40, true, "2026-04-03");
    beta = await seedGroup(groups, actor, "Beta", [ada.id, ben.id], 40, false, "2026-04-02");
    gamma = await seedGroup(groups, actor, "Gamma", [ada.id, ben.id], 5, true, "2026-04-01");

    const other = await runAsSystem("test fixture", () =>
      createSpaceForMember(prisma, {
        currentSpaceId: owner.spaceId,
        userId: owner.userId,
        name: "Other space",
      }),
    );
    otherSpaceId = other.id;
    const otherActor = { ...actor, spaceId: other.id };
    const cy = await bot(otherActor, "Cy");
    const dee = await bot(otherActor, "Dee");
    delta = await seedGroup(groups, otherActor, "Delta", [cy.id, dee.id], 5, false, "2026-04-04");
  });

  afterAll(async () => {
    if (prisma) {
      await asSystem(prisma).messagingIdentity.deleteMany({
        where: { provider, address: ownerAddress },
      });
      if (owner) {
        await asSystem(prisma).organization.deleteMany({ where: { id: owner.spaceId } });
        await asSystem(prisma).user.deleteMany({ where: { id: owner.userId } });
      }
    }
    await close?.();
  });

  async function bot(who: Actor, name: string) {
    return runAsTenant(who, async () => {
      const created = await createRepos(prisma).createBot(who, {
        name,
        description: "",
        instructions: "",
        notifyOnFinish: true,
      });
      computers += 1;
      const computer = await prisma.computer.create({
        data: {
          spaceId: who.spaceId,
          userId: who.userId,
          scope: "dedicated",
          scopeKey: `group-preview-${stamp}-${computers}`,
          homeKey: `group-preview-home-${stamp}-${computers}`,
          kind: "fake",
        },
      });
      await prisma.bot.update({ where: { id: created.id }, data: { computerId: computer.id } });
      return created;
    });
  }

  async function seedGroup(
    groups: ReturnType<typeof createGroupRepos>,
    who: Actor,
    name: string,
    botIds: string[],
    count: number,
    unread: boolean,
    day: string,
  ): Promise<SeededGroup> {
    const created = await runAsTenant(who, () => groups.createGroup(who, { name, botIds }));
    const updatedAt = new Date(`${day}T00:00:00.000Z`);
    await runAsTenant(who, async () => {
      await prisma.message.createMany({
        data: Array.from({ length: count }, (_, seq) => ({
          id: `${created.threadId}-${seq}`,
          threadId: created.threadId,
          seq,
          role: "user",
          blocks: [{ kind: "text", text: `${name} ${seq}` }],
          createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, seq)),
        })),
      });
      await prisma.thread.update({
        where: { id: created.threadId },
        data: {
          nextMessageSeq: count,
          ...(unread
            ? { reads: { create: { spaceId: who.spaceId, userId: who.userId, unread } } }
            : {}),
        },
      });
      await prisma.$executeRaw`
        UPDATE chat_groups SET "updatedAt" = ${updatedAt} WHERE id = ${created.id}
      `;
    });
    return {
      id: created.id,
      threadId: created.threadId,
      name,
      preview: `${name} ${count - 1}`,
      unread,
      updatedAt: updatedAt.toISOString(),
    };
  }

  function messageRowsDuring<T>(
    label: string,
    run: () => Promise<T>,
  ): Promise<{ result: T; rowCount: number }> {
    const start = reads.length;
    return run().then((result) => {
      const during = reads.slice(start);
      const rowCount = during.reduce((sum, read) => sum + read.rowCount, 0);
      const lines = during.map(
        (read) => `-- rows ${read.rowCount} values ${JSON.stringify(read.values)}\n${read.text}\n`,
      );
      process.stdout.write(
        `${label}: ${during.length} message statement(s), ${rowCount} rows\n${lines.join("\n")}\n`,
      );
      return { result, rowCount };
    });
  }

  it("previews the newest message of each group and reads at most one message row per thread", async () => {
    const groups = createGroupRepos(prisma);
    const { result: listed, rowCount } = await messageRowsDuring("listGroups", () =>
      runAsTenant(owner, () => groups.listGroups(actor)),
    );
    expect(
      listed.map((group) => ({
        name: group.name,
        preview: group.preview,
        unread: group.unread,
        updatedAt: group.updatedAt,
      })),
    ).toEqual([
      {
        name: alpha.name,
        preview: alpha.preview,
        unread: alpha.unread,
        updatedAt: alpha.updatedAt,
      },
      { name: beta.name, preview: beta.preview, unread: beta.unread, updatedAt: beta.updatedAt },
      {
        name: gamma.name,
        preview: gamma.preview,
        unread: gamma.unread,
        updatedAt: gamma.updatedAt,
      },
    ]);
    expect(rowCount).toBeLessThanOrEqual(listed.length);
  });

  it("previews that same newest message when one group is opened, and reads at most one message row", async () => {
    const groups = createGroupRepos(prisma);
    const { result: record, rowCount } = await messageRowsDuring("getGroup", () =>
      runAsTenant(owner, () => groups.getGroup(actor, alpha.id)),
    );
    expect(groups.mapGroup(record)).toMatchObject({
      id: alpha.id,
      preview: alpha.preview,
      unread: alpha.unread,
      updatedAt: alpha.updatedAt,
    });
    expect(rowCount).toBeLessThanOrEqual(1);
  });

  it("previews the newest message of a group in another space and reads at most one message row", async () => {
    const groups = createGroupRepos(prisma);
    const { result: listed, rowCount } = await messageRowsDuring("listSpaceGroupsForSpaces", () =>
      runAsSystem("cross-space group previews", () =>
        groups.listSpaceGroupsForSpaces([otherSpaceId], owner.userId),
      ),
    );
    expect(
      listed.map((group) => ({
        id: group.id,
        spaceId: group.spaceId,
        name: group.name,
        preview: group.preview,
        unread: group.unread,
        updatedAt: group.updatedAt,
      })),
    ).toEqual([
      {
        id: delta.id,
        spaceId: otherSpaceId,
        name: delta.name,
        preview: delta.preview,
        unread: delta.unread,
        updatedAt: delta.updatedAt,
      },
    ]);
    expect(rowCount).toBeLessThanOrEqual(listed.length);
  });

  it("keeps the newest preview after the group is archived", async () => {
    const groups = createGroupRepos(prisma);
    await runAsTenant(owner, () => groups.archiveGroup(actor, gamma.id));
    const { result: archived, rowCount } = await messageRowsDuring("listArchivedGroups", () =>
      runAsTenant(owner, () => groups.listGroups(actor, { archived: true })),
    );
    const stored = await runAsTenant(owner, () =>
      prisma.chatGroup.findUniqueOrThrow({ where: { id: gamma.id } }),
    );
    expect(archived.find((group) => group.id === gamma.id)).toMatchObject({
      preview: gamma.preview,
      unread: gamma.unread,
      updatedAt: stored.updatedAt.toISOString(),
    });
    expect(rowCount).toBeLessThanOrEqual(1);
    const active = await runAsTenant(owner, () => groups.listGroups(actor));
    expect(active.map((group) => [group.name, group.preview])).toEqual([
      [alpha.name, alpha.preview],
      [beta.name, beta.preview],
    ]);
  });
});
