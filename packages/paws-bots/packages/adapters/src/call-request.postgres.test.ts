import { randomUUID } from "node:crypto";
import type { BackgroundJob } from "@rakazo/adapter-kit";
import { createDb, createThreadEvents, runAsSystem, runAsTenant } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { reconcileCallRequests, requestUserCall, settleCallRequest } from "./call-request.js";

const postgres =
  process.env.VERIFY_DATABASE === "1" && process.env.DATABASE_URL ? describe : describe.skip;

postgres("call isolation and cooldown (PostgreSQL)", () => {
  it("serializes concurrent rings, rejects other owners and spaces, and recovers expiry", async () => {
    const { prisma, pool } = createDb(process.env.DATABASE_URL!);
    const id = `call-test-${randomUUID()}`;
    const userId = `${id}-user`;
    const spaceId = `${id}-space`;
    const organizationId = `${id}-org`;
    const fixture = <T>(fn: () => Promise<T>) => runAsSystem("test fixture", fn);
    try {
      const runs = await fixture(async () => {
        await prisma.user.create({
          data: { id: userId, name: "Call tester", email: `${id}@rakazo.test` },
        });
        await prisma.organization.create({
          data: { id: organizationId, name: "Call tests", slug: id, createdAt: new Date() },
        });
        await prisma.space.create({ data: { id: spaceId, organizationId, name: "Call tests" } });
        await prisma.userVoiceCredential.create({
          data: { userId, provider: "scripted", secretId: "fake-secret" },
        });
        const runs = [];
        for (const suffix of ["a", "b"]) {
          const bot = await prisma.bot.create({
            data: {
              spaceId,
              userId,
              name: suffix,
              color: "ink",
              thread: { create: { spaceId, userId } },
            },
            include: { thread: true },
          });
          const threadId = bot.thread!.id;
          const task = await prisma.task.create({
            data: {
              spaceId,
              userId,
              botId: bot.id,
              threadId,
              prompt: "Call test",
              status: "running",
            },
          });
          runs.push(
            await prisma.run.create({
              data: {
                spaceId,
                userId,
                botId: bot.id,
                threadId,
                taskId: task.id,
                status: "running",
                trigger: "user_message",
              },
            }),
          );
        }
        return runs;
      });
      const jobs = {
        enqueue: vi.fn(async (_job: BackgroundJob) => undefined),
        enqueueIn: vi.fn(),
        cancelIn: vi.fn(),
        cancel: vi.fn(),
        close: vi.fn(),
      };
      const deps = { prisma, events: createThreadEvents(prisma), jobs, phoneCallsEnabled: true };
      const input = { reason: "Review", opening: "Ready?" };
      // Agent runs ring from the worker; the API answers inside the owner's request.
      const ring = (run: (typeof runs)[number]) =>
        runAsSystem("agent run tool call", () => requestUserCall(deps, run, input));
      for (const field of ["userId", "spaceId", "botId", "threadId"] as const) {
        expect(await ring({ ...runs[0]!, [field]: "other" })).toHaveProperty("error");
      }
      const results = await Promise.all(runs.map(ring));
      expect(results.filter((result) => "ok" in result)).toHaveLength(1);
      expect(await fixture(() => prisma.message.count({ where: { thread: { userId } } }))).toBe(1);
      jobs.enqueue.mockClear();
      await runAsSystem("job reconciler", () => reconcileCallRequests(deps));
      const plan = await fixture(() =>
        prisma.$transaction(async (tx) => {
          await tx.$executeRaw`SET LOCAL enable_seqscan = off`;
          return tx.$queryRaw<Array<{ "QUERY PLAN": string }>>`
          EXPLAIN SELECT "threadId", blocks FROM messages
          WHERE role = 'bot' AND "clientNonce" LIKE 'call:%' AND "clientNonce" LIKE '%:request'
            AND blocks #> ARRAY['0', 'status'] = '"ringing"'::jsonb
          ORDER BY "createdAt" ASC LIMIT 100`;
        }),
      );
      expect(plan.map((row) => row["QUERY PLAN"]).join("\n")).toContain(
        "messages_call_recovery_idx",
      );
      expect(jobs.enqueue).toHaveBeenCalledOnce();
      const job = jobs.enqueue.mock.calls[0]?.[0];
      expect(job).toMatchObject({ name: "call.expire" });
      const message = await fixture(() =>
        prisma.message.findFirstOrThrow({ where: { thread: { userId } } }),
      );
      const asOwner = <T>(fn: () => Promise<T>) => runAsTenant({ spaceId, userId }, fn);
      const block = (message.blocks as unknown as Array<{ callId: string }>)[0]!;
      const settle = () =>
        asOwner(() =>
          settleCallRequest(deps, {
            threadId: message.threadId,
            callId: block.callId,
            from: ["ringing"],
            status: "answered",
          }),
        );
      // An event insert failure must roll back the status, leaving answer retryable.
      let failEvent = true;
      const failingPrisma = prisma.$extends({
        query: {
          event: {
            create({ args, query }) {
              if (failEvent && args.data.type === "thread.message.updated") {
                failEvent = false;
                throw new Error("event insert failed");
              }
              return query(args);
            },
          },
        },
      });
      await expect(
        asOwner(() =>
          settleCallRequest(
            { ...deps, prisma: failingPrisma as unknown as typeof prisma },
            {
              threadId: message.threadId,
              callId: block.callId,
              from: ["ringing"],
              status: "answered",
            },
          ),
        ),
      ).rejects.toThrow("event insert failed");
      expect(
        (await fixture(() => prisma.message.findUniqueOrThrow({ where: { id: message.id } })))
          .blocks,
      ).toEqual(message.blocks);
      expect((await Promise.all([settle(), settle()])).filter(Boolean)).toHaveLength(1);
    } finally {
      await prisma.organization.deleteMany({ where: { id: organizationId } });
      await prisma.user.deleteMany({ where: { id: userId } });
      await prisma.$disconnect();
      await pool.end();
    }
  });
});
