import type { Pool, QueryResult } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import { provisionMessagingIdentity } from "./messaging.js";
import { createRepos } from "./repos.js";
import { asSystem, runAsSystem, runAsTenant } from "./row-security.js";

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

describePostgres("listBots sidebar previews (PostgreSQL)", () => {
  const provider = "sendblue";
  const stamp = String(Date.now()).slice(-7);
  const ownerAddress = `+1555${stamp}`;
  const signup = { signupsEnabled: undefined, signupAllowlist: undefined };
  const window = 16;
  let prisma: PrismaClient;
  let pool: Pool;
  let close: () => Promise<void>;
  let owner: { userId: string; spaceId: string };
  let reads: MessageRead[] = [];
  let longUpdatedAt = "";
  let peerUpdatedAt = "";
  let shortUpdatedAt = "";

  const actorFor = (identity: { userId: string; spaceId: string }) => ({
    userId: identity.userId,
    spaceId: identity.spaceId,
    email: "listbots@example.com",
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
    pool = db.pool;
    reads = trackMessageReads(pool);
    close = async () => {
      await db.prisma.$disconnect();
      await db.pool.end();
    };
    const provisioned = await runAsSystem("test fixture", () =>
      provisionMessagingIdentity(prisma, { provider, address: ownerAddress }, signup),
    );
    owner = provisioned;
    const actor = actorFor(owner);
    const repos = createRepos(prisma);
    // The messaging fixture's own bot is not one of the three seeded chats.
    await runAsSystem("test fixture", () =>
      prisma.bot.update({
        where: { id: provisioned.botId },
        data: { archivedAt: new Date("2026-01-01T00:00:00.000Z") },
      }),
    );
    const longBot = await runAsTenant(owner, () => repos.createBot(actor, botInput("Long")));
    const peerBot = await runAsTenant(owner, () => repos.createBot(actor, botInput("Peer")));
    const shortBot = await runAsTenant(owner, () => repos.createBot(actor, botInput("Short")));
    await runAsTenant(owner, async () => {
      const task = await prisma.task.create({
        data: {
          spaceId: owner.spaceId,
          botId: peerBot.id,
          threadId: peerBot.threadId,
          userId: owner.userId,
          prompt: "peer",
          status: "completed",
        },
      });
      const peerRun = await prisma.run.create({
        data: {
          spaceId: owner.spaceId,
          botId: peerBot.id,
          threadId: peerBot.threadId,
          taskId: task.id,
          userId: owner.userId,
          status: "completed",
          trigger: "bot_message",
        },
      });
      await seedThread(longBot.threadId, 40);
      await seedThread(peerBot.threadId, 40, { peerRunId: peerRun.id, peerFromSeq: 40 - window });
      await seedThread(shortBot.threadId, 5);
    });
    longUpdatedAt = atSeq(39);
    peerUpdatedAt = atSeq(39);
    shortUpdatedAt = atSeq(4);
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

  function atSeq(seq: number): string {
    return new Date(Date.UTC(2026, 0, 1, 0, 0, seq)).toISOString();
  }

  async function seedThread(
    threadId: string,
    count: number,
    peer?: { peerRunId: string; peerFromSeq: number },
  ) {
    await prisma.message.createMany({
      data: Array.from({ length: count }, (_, seq) => {
        const hidden = peer !== undefined && seq >= peer.peerFromSeq;
        return {
          id: `${threadId}-${seq}`,
          threadId,
          seq,
          role: hidden || seq % 2 === 1 ? "bot" : "user",
          blocks: [{ kind: "text", text: hidden ? `Peer chatter ${seq}` : `Message ${seq}` }],
          runId: hidden ? peer.peerRunId : null,
          createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, seq)),
        };
      }),
    });
    await prisma.thread.update({ where: { id: threadId }, data: { nextMessageSeq: count } });
  }

  it("previews the newest visible message and reads at most one window per thread", async () => {
    const actor = actorFor(owner);
    const start = reads.length;
    const listed = await runAsTenant(owner, () => createRepos(prisma).listBots(actor));
    const during = reads.slice(start);
    const rowCount = during.reduce((sum, read) => sum + read.rowCount, 0);
    process.stdout.write(
      `listBots message reads (${rowCount} rows)\n${during
        .map((read) => `-- rows ${read.rowCount}\n${read.text}\n`)
        .join("\n")}\n`,
    );

    const byName = new Map(listed.map((bot) => [bot.name, bot]));
    expect(listed.map((bot) => bot.name)).toEqual(["Long", "Peer", "Short"]);
    expect(byName.get("Long")).toMatchObject({ preview: "Message 39", updatedAt: longUpdatedAt });
    // The newest 16 rows are a peer-run tail, so the preview is the message just before it.
    expect(byName.get("Peer")).toMatchObject({
      preview: "Message 23",
      updatedAt: peerUpdatedAt,
    });
    expect(byName.get("Short")).toMatchObject({ preview: "Message 4", updatedAt: shortUpdatedAt });
    expect(byName.get("Long")?.status).toBe("idle");
    expect(byName.get("Peer")?.runErrorId).toBeNull();

    const threads = 3;
    const fallbackWindows = 1;
    expect(rowCount).toBeGreaterThanOrEqual(window * 2 + 5);
    expect(rowCount).toBeLessThanOrEqual(window * threads + window * fallbackWindows);
  });

  it("keeps an archived bot on the archived roster with the same preview", async () => {
    const actor = actorFor(owner);
    const short = await asSystem(prisma).bot.findFirstOrThrow({
      where: { spaceId: owner.spaceId, userId: owner.userId, name: "Short" },
    });
    await asSystem(prisma).bot.update({
      where: { id: short.id },
      data: { archivedAt: new Date() },
    });

    const [active, archived] = await runAsTenant(owner, () => {
      const repos = createRepos(prisma);
      return Promise.all([repos.listBots(actor), repos.listBots(actor, { archived: true })]);
    });
    expect(active.map((bot) => bot.name)).toEqual(["Long", "Peer"]);
    expect(archived.find((bot) => bot.name === "Short")).toMatchObject({
      preview: "Message 4",
      updatedAt: shortUpdatedAt,
    });
  });
});
