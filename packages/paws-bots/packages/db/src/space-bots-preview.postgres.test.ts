import type { Pool, QueryResult } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "./client.js";
import { createDb } from "./client.js";
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

interface SeededBot {
  name: string;
  preview: string;
  unread: boolean;
  updatedAt: string;
  status: "idle";
  runErrorId: null;
}

const MESSAGE_BOTS = [
  { name: "Ada", count: 40, unread: true, day: 3 },
  { name: "Bea", count: 40, unread: false, day: 2 },
  { name: "Cy", count: 5, unread: true, day: 1 },
] as const;

const EMPTY_BOT = {
  name: "Dee",
  updatedAt: new Date("2026-03-15T12:00:00.000Z"),
} as const;

describePostgres("cross-space bot sidebar previews (PostgreSQL)", () => {
  const provider = "sendblue";
  const stamp = String(Date.now()).slice(-7);
  const ownerAddress = `+1557${stamp}`;
  const signup = { signupsEnabled: undefined, signupAllowlist: undefined };
  let prisma: PrismaClient;
  let close: () => Promise<void>;
  let owner: { userId: string; spaceId: string };
  let actor: Actor;
  let reads: MessageRead[] = [];
  let computers = 0;
  let spaceB = "";
  let expected: SeededBot[] = [];

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
      email: "space-bots-preview@example.com",
      isDeploymentOwner: false,
    };
    await asSystem(prisma).bot.update({
      where: { id: provisioned.botId },
      data: { archivedAt: new Date("2026-01-01T00:00:00.000Z") },
    });

    const other = await runAsSystem("test fixture", () =>
      createSpaceForMember(prisma, {
        currentSpaceId: owner.spaceId,
        userId: owner.userId,
        name: "Other space",
      }),
    );
    spaceB = other.id;
    const actorB = { ...actor, spaceId: spaceB };
    expected = [];
    for (const spec of MESSAGE_BOTS) {
      expected.push(await seedMessages(actorB, spec));
    }
    expected.push(await seedEmpty(actorB));
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
          scopeKey: `space-bots-preview-${stamp}-${computers}`,
          homeKey: `space-bots-preview-home-${stamp}-${computers}`,
          kind: "fake",
        },
      });
      await prisma.bot.update({ where: { id: created.id }, data: { computerId: computer.id } });
      return created;
    });
  }

  async function seedMessages(who: Actor, spec: (typeof MESSAGE_BOTS)[number]): Promise<SeededBot> {
    const created = await bot(who, spec.name);
    const newestSeq = spec.count - 1;
    const newestAt = new Date(Date.UTC(2026, 3, spec.day, 0, 0, newestSeq));
    await runAsTenant(who, async () => {
      await prisma.message.createMany({
        data: Array.from({ length: spec.count }, (_, seq) => ({
          id: `${created.threadId}-${seq}`,
          threadId: created.threadId,
          seq,
          role: "user",
          blocks: [{ kind: "text", text: `${spec.name} ${seq}` }],
          createdAt: new Date(Date.UTC(2026, 3, spec.day, 0, 0, seq)),
        })),
      });
      await prisma.thread.update({
        where: { id: created.threadId },
        data: {
          nextMessageSeq: spec.count,
          ...(spec.unread
            ? { reads: { create: { spaceId: who.spaceId, userId: who.userId, unread: true } } }
            : {}),
        },
      });
    });
    return {
      name: spec.name,
      preview: `${spec.name} ${newestSeq}`,
      unread: spec.unread,
      updatedAt: newestAt.toISOString(),
      status: "idle",
      runErrorId: null,
    };
  }

  async function seedEmpty(who: Actor): Promise<SeededBot> {
    const created = await bot(who, EMPTY_BOT.name);
    await runAsTenant(who, async () => {
      await prisma.$executeRaw`
        UPDATE bots SET "updatedAt" = ${EMPTY_BOT.updatedAt} WHERE id = ${created.id}
      `;
    });
    return {
      name: EMPTY_BOT.name,
      preview: "",
      unread: false,
      updatedAt: EMPTY_BOT.updatedAt.toISOString(),
      status: "idle",
      runErrorId: null,
    };
  }

  function messageRowsDuring<T>(
    label: string,
    run: () => Promise<T>,
  ): Promise<{ result: T; rowCount: number; statements: number }> {
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
      return { result, rowCount, statements: during.length };
    });
  }

  it("previews the newest message of each bot in another space and reads at most one message row per thread", async () => {
    const { result: listed, rowCount } = await messageRowsDuring("listSpaceBotsForSpaces", () =>
      runAsSystem("space navigation across the member's Spaces", () =>
        createRepos(prisma).listSpaceBotsForSpaces([spaceB], owner.userId),
      ),
    );
    expect(
      listed.map((bot) => ({
        name: bot.name,
        preview: bot.preview,
        unread: bot.unread,
        updatedAt: bot.updatedAt,
        status: bot.status,
        runErrorId: bot.runErrorId,
      })),
    ).toEqual(expected);
    expect(rowCount).toBe(MESSAGE_BOTS.length);
  });

  it("reads no messages when the member has no other spaces", async () => {
    const { result, rowCount, statements } = await messageRowsDuring(
      "listSpaceBotsForSpaces empty",
      () =>
        runAsSystem("space navigation across the member's Spaces", () =>
          createRepos(prisma).listSpaceBotsForSpaces([], owner.userId),
        ),
    );
    expect(result).toEqual([]);
    expect(statements).toBe(0);
    expect(rowCount).toBe(0);
  });
});
