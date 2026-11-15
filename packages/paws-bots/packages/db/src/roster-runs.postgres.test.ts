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

/** Count rows Postgres sends, before Prisma applies a nested take in memory. */
function trackRunReads(pool: Pool) {
  const reads: number[] = [];
  const original = pool.query.bind(pool);
  pool.query = ((...args: unknown[]) => {
    const result = (original as (...args: unknown[]) => unknown)(...args);
    if (!result || typeof (result as Promise<unknown>).then !== "function") return result;
    return (result as Promise<QueryResult>).then((result) => {
      const input = args[0];
      const text =
        typeof input === "string"
          ? input
          : input && typeof input === "object" && "text" in input
            ? String(input.text)
            : "";
      if (/^\s*select\b/i.test(text) && /\bfrom\s+(?:"public"\s*\.\s*)?"?runs"?\b/i.test(text))
        reads.push(result.rowCount ?? 0);
      return result;
    });
  }) as Pool["query"];
  return reads;
}

describePostgres("bounded latest bot roster runs (PostgreSQL)", () => {
  let prisma: PrismaClient;
  let close: () => Promise<void>;
  let reads: number[];
  let owner: { userId: string; spaceId: string };
  let otherSpace = "";
  const address = `+1559${String(Date.now()).slice(-7)}`;
  const actorFor = (spaceId: string) => ({
    ...owner,
    spaceId,
    email: "roster@example.com",
    isDeploymentOwner: false,
  });
  const expected = [
    { name: "Failed", status: "idle", runErrorId: "" as string | null },
    { name: "Recovered", status: "idle", runErrorId: null },
    { name: "Waiting", status: "waiting_input", runErrorId: null },
    { name: "Empty", status: "idle", runErrorId: null },
  ];
  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    reads = trackRunReads(db.pool);
    close = async () => {
      await prisma.$disconnect();
      await db.pool.end();
    };
    const identity = await runAsSystem("test fixture", () =>
      provisionMessagingIdentity(
        prisma,
        { provider: "sendblue", address },
        { signupsEnabled: undefined, signupAllowlist: undefined },
      ),
    );
    owner = identity;
    await asSystem(prisma).bot.update({
      where: { id: identity.botId },
      data: { archivedAt: new Date() },
    });
    otherSpace = (
      await runAsSystem("test fixture", () =>
        createSpaceForMember(prisma, {
          currentSpaceId: owner.spaceId,
          userId: owner.userId,
          name: "Other",
        }),
      )
    ).id;
    for (const spaceId of [owner.spaceId, otherSpace]) {
      for (const spec of expected) {
        await runAsTenant({ ...owner, spaceId }, async () => {
          const bot = await createRepos(prisma).createBot(actorFor(spaceId), {
            name: spec.name,
            description: "",
            instructions: "",
            notifyOnFinish: true,
          });
          if (spec.name === "Empty") return;
          const task = await prisma.task.create({
            data: {
              spaceId,
              userId: owner.userId,
              botId: bot.id,
              threadId: bot.threadId,
              prompt: "test",
              status: "completed",
            },
          });
          const common = {
            spaceId,
            userId: owner.userId,
            botId: bot.id,
            threadId: bot.threadId,
            taskId: task.id,
          };
          await prisma.run.createMany({
            data: Array.from({ length: 40 }, (_, index) => ({
              ...common,
              status: "completed",
              trigger: "user_message",
              createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)),
            })),
          });
          const failedId = `${bot.id}-z`;
          const at = new Date("2026-02-01T00:00:00Z");
          // Tied timestamps must resolve by descending ID, not insertion order.
          await prisma.run.createMany({
            data: [
              { ...common, id: failedId, status: "failed", trigger: "user_message", createdAt: at },
              {
                ...common,
                id: `${bot.id}-a`,
                status: "completed",
                trigger: "user_message",
                createdAt: at,
              },
              {
                ...common,
                status: "failed",
                trigger: "bot_message",
                createdAt: new Date("2026-04-01T00:00:00Z"),
              },
              {
                ...common,
                status: "running",
                trigger: "tickets",
                createdAt: new Date("2026-04-01T00:00:00Z"),
              },
            ],
          });
          if (spec.name === "Failed" && spaceId === owner.spaceId) spec.runErrorId = failedId;
          if (spec.name !== "Failed")
            await prisma.run.create({
              data: {
                ...common,
                status: spec.name === "Waiting" ? "waiting_input" : "completed",
                trigger: "user_message",
                createdAt: new Date(
                  spec.name === "Waiting" ? "2026-01-02T00:00:00Z" : "2026-03-01T00:00:00Z",
                ),
              },
            });
        });
      }
    }
  });
  afterAll(async () => {
    if (owner) {
      await asSystem(prisma).messagingIdentity.deleteMany({
        where: { provider: "sendblue", address },
      });
      await asSystem(prisma).organization.deleteMany({
        where: { id: { in: [owner.spaceId, otherSpace] } },
      });
      await asSystem(prisma).user.deleteMany({ where: { id: owner.userId } });
    }
    await close?.();
  });
  it("bounds current-space run rows and preserves failure, recovery and active status", async () => {
    const start = reads.length;
    const bots = await runAsTenant(owner, () =>
      createRepos(prisma).listBots(actorFor(owner.spaceId)),
    );
    expect(bots.map(({ name, status, runErrorId }) => ({ name, status, runErrorId }))).toEqual(
      expected,
    );
    // Three latest runs plus the Waiting bot's one foreground active run.
    expect(reads.slice(start).reduce((a, b) => a + b, 0)).toBe(4);
  });
  it("bounds cross-space rows and never includes another user's bots", async () => {
    const start = reads.length;
    const bots = await runAsSystem("cross-space roster", () =>
      createRepos(prisma).listSpaceBotsForSpaces([otherSpace], owner.userId),
    );
    expect(bots.map(({ name, status }) => ({ name, status }))).toEqual(
      expected.map(({ name, status }) => ({ name, status })),
    );
    expect(bots.find((bot) => bot.name === "Failed")?.runErrorId).toBeTruthy();
    expect(
      bots.filter((bot) => bot.name !== "Failed").every((bot) => bot.runErrorId === null),
    ).toBe(true);
    expect(reads.slice(start).reduce((a, b) => a + b, 0)).toBe(4);
    await expect(
      runAsTenant(owner, () =>
        createRepos(prisma).listSpaceBotsForSpaces([otherSpace], owner.userId),
      ),
    ).resolves.toEqual([]);
  });
});
