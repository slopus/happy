import type { Pool, QueryResult } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import { sendUserMessage } from "./events.js";
import { provisionMessagingIdentity } from "./messaging.js";
import { asSystem, runAsSystem, runAsTenant } from "./row-security.js";

const databaseUrl = process.env.DATABASE_URL;
const migrationUrl = process.env.DATABASE_MIGRATION_URL ?? databaseUrl;
const describePostgres = process.env.VERIFY_DATABASE && databaseUrl ? describe : describe.skip;

interface SqlRead {
  text: string;
  values: unknown[];
  rowCount: number;
}

const RUN_FROM = /\bfrom\s+(?:"public"\s*\.\s*)?"?runs"?\b/i;

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

/** Source-run reads only: other run statements during the send are not the replay lookup. */
function trackSourceRunReads(pool: Pool): SqlRead[] {
  const reads: SqlRead[] = [];
  const original = pool.query.bind(pool);
  pool.query = ((...args: unknown[]) => {
    const result = (original as (...inner: unknown[]) => unknown)(...args);
    if (!result || typeof (result as Promise<unknown>).then !== "function") return result;
    return (result as Promise<QueryResult>).then((queryResult) => {
      const text = sqlText(args[0]);
      if (/^\s*select\b/i.test(text) && RUN_FROM.test(text) && text.includes('"sourceMessageId"')) {
        reads.push({ text, values: sqlValues(args), rowCount: queryResult.rowCount ?? 0 });
      }
      return queryResult;
    });
  }) as Pool["query"];
  return reads;
}

describePostgres("replaying a sent message reads its first run (PostgreSQL)", () => {
  const provider = "sendblue";
  const address = `+1559${String(Date.now()).slice(-7)}`;
  const signup = { signupsEnabled: undefined, signupAllowlist: undefined };
  let prisma: PrismaClient;
  let system: PrismaClient;
  let owner: PrismaClient;
  let close: () => Promise<void>;
  let reads: SqlRead[] = [];
  let userId = "";
  let spaceId = "";
  let botId = "";
  let threadId = "";

  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    const ownerDb = createDb(migrationUrl!);
    prisma = db.prisma;
    system = asSystem(prisma);
    owner = ownerDb.prisma;
    reads = trackSourceRunReads(db.pool);
    close = async () => {
      await db.prisma.$disconnect();
      await db.pool.end();
      await ownerDb.prisma.$disconnect();
      await ownerDb.pool.end();
    };
    const provisioned = await runAsSystem("test fixture", () =>
      provisionMessagingIdentity(prisma, { provider, address }, signup),
    );
    ({ userId, spaceId, botId, threadId } = provisioned);
    await system.run.updateMany({
      where: {
        threadId,
        status: { in: ["queued", "running", "leased", "waiting_input", "waiting_takeover"] },
      },
      data: { status: "cancelled" },
    });
  });

  afterAll(async () => {
    if (prisma && userId) {
      await system.messagingIdentity.deleteMany({ where: { provider, address } });
      if (spaceId) await system.organization.deleteMany({ where: { id: spaceId } });
      await system.user.deleteMany({ where: { id: userId } });
    }
    await close?.();
  });

  const input = () => ({
    spaceId,
    threadId,
    botId,
    userId,
    blocks: [{ kind: "text" as const, text: "hello replay" }],
    prompt: "hello replay",
    trigger: "user" as const,
    clientNonce: "nonce-1",
    linkMessageToRun: true,
  });

  function measured<T>(label: string, run: () => Promise<T>) {
    const start = reads.length;
    return run().then((result) => {
      const during = reads.slice(start);
      const rowCount = during.reduce((sum, read) => sum + read.rowCount, 0);
      const lines = during.map(
        (read) => `-- rows ${read.rowCount} values ${JSON.stringify(read.values)}\n${read.text}`,
      );
      process.stdout.write(
        `${label}: ${during.length} source-run statement(s), ${rowCount} rows\n${lines.join("\n")}\n`,
      );
      return { result, rowCount, statements: during.length };
    });
  }

  it("returns the earliest run for the message and reads one source run", async () => {
    const actor = { spaceId, userId };
    const first = await runAsTenant(actor, () => sendUserMessage(prisma, input()));
    if (typeof first.runId !== "string" || typeof first.taskId !== "string") {
      throw new Error("send did not start a run");
    }

    const original = await system.run.findUniqueOrThrow({ where: { id: first.runId } });
    expect(original.sourceMessageId).toBe(first.messageId);
    for (const step of [1, 2, 3]) {
      await runAsSystem("test fixture", () =>
        owner.run.create({
          data: {
            spaceId,
            botId,
            threadId,
            taskId: original.taskId,
            userId,
            status: "queued",
            trigger: "follow_up",
            sourceMessageId: first.messageId,
            createdAt: new Date(original.createdAt.getTime() + step * 1000),
          },
        }),
      );
    }
    const sourceRuns = await system.run.findMany({
      where: { sourceMessageId: first.messageId },
      orderBy: { createdAt: "asc" },
      select: { id: true },
    });
    expect(sourceRuns.map((run) => run.id)).toEqual([
      first.runId,
      expect.any(String),
      expect.any(String),
      expect.any(String),
    ]);

    const messagesBefore = await system.message.count({ where: { threadId } });
    const runsBefore = await system.run.count({ where: { threadId } });
    const {
      result: replay,
      rowCount,
      statements,
    } = await measured("sendUserMessage replay", () =>
      runAsTenant(actor, () => sendUserMessage(prisma, input())),
    );

    expect(replay).toEqual(first);
    expect(await system.message.count({ where: { threadId } })).toBe(messagesBefore);
    expect(await system.run.count({ where: { threadId } })).toBe(runsBefore);
    expect(statements).toBe(1);
    expect(rowCount).toBeLessThanOrEqual(1);
  });
});
