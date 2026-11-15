import type { SandboxProvider } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import type { ThreadEvents } from "@rakazo/db";
import {
  appendEventInTransaction,
  createDb,
  createGroupRepos,
  createRepos,
  provisionMessagingIdentity,
  runAsSystem,
  runAsTenant,
} from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { threadSnapshot } from "./thread-snapshot.js";
import {
  cancelThreadRuns,
  STOPPED_BY_MESSAGE_NOTE,
  stoppedRoutineNote,
  stopThreadRuns,
} from "./thread-stop.js";
import { resolveThreadTarget } from "./thread-target.js";

const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);

describe.skipIf(!enabled)("working bot visibility (PostgreSQL)", () => {
  it("prioritizes running work everywhere, keeps delegated DM progress silent, and stops it", async () => {
    const { prisma, pool } = createDb(process.env.DATABASE_URL!);
    const identity = await runAsSystem("test fixture", () =>
      provisionMessagingIdentity(
        prisma,
        {
          provider: "sendblue",
          address: `working-fixture-${crypto.randomUUID()}`,
        },
        { signupsEnabled: undefined, signupAllowlist: undefined },
      ),
    );
    const actor: Actor = { ...identity, email: "fixture@example.test", isDeploymentOwner: false };
    try {
      await runAsTenant(actor, async () => {
        const repos = createRepos(prisma);
        const groups = createGroupRepos(prisma);
        const input = { title: "", description: "", instructions: "", notifyOnFinish: true };
        const bot = await repos.createBot(actor, { ...input, name: "Research Helper" });
        const peer = await repos.createBot(actor, { ...input, name: "Writing Helper" });
        const group = await groups.createGroup(actor, {
          name: "Sample team",
          botIds: [bot.id, peer.id],
        });
        const target = await resolveThreadTarget(prisma, actor, { botId: bot.id });
        const groupTarget = await resolveThreadTarget(prisma, actor, { groupId: group.id });
        const scope = {
          spaceId: actor.spaceId,
          userId: actor.userId,
          botId: bot.id,
          threadId: target.threadId,
        };
        const task = await prisma.task.create({
          data: { ...scope, prompt: "Inspect sample files", status: "running" },
        });
        const running = await prisma.run.create({
          data: {
            ...scope,
            taskId: task.id,
            status: "running",
            trigger: "bot_message",
            createdAt: new Date(Date.now() - 1000),
          },
        });
        const queued = await prisma.run.create({
          data: { ...scope, taskId: task.id, status: "queued", trigger: "user" },
        });
        await prisma.$transaction((tx) =>
          appendEventInTransaction(tx, {
            ...scope,
            runId: running.id,
            type: "thread.progress",
            payload: { text: "Inspecting sample files" },
          }),
        );
        const assertRosterStatus = async (status: string) => {
          expect((await repos.listBots(actor)).find((row) => row.id === bot.id)?.status).toBe(
            status,
          );
          expect(
            (await repos.listSpaceBotsForSpaces([actor.spaceId], actor.userId)).find(
              (row) => row.id === bot.id,
            )?.status,
          ).toBe(status);
          expect(
            (await groups.listGroups(actor))[0]?.members.find((row) => row.botId === bot.id)
              ?.status,
          ).toBe(status);
          expect(
            (await groups.listSpaceGroupsForSpaces([actor.spaceId], actor.userId))[0]?.members.find(
              (row) => row.botId === bot.id,
            )?.status,
          ).toBe(status);
          const resolved = await resolveThreadTarget(prisma, actor, { groupId: group.id });
          expect(
            resolved.kind === "group" &&
              resolved.members.find((row) => row.botId === bot.id)?.status,
          ).toBe(status);
        };
        await assertRosterStatus("running");
        for (const status of ["waiting_input", "waiting_takeover", "leased"] as const) {
          await prisma.run.update({ where: { id: running.id }, data: { status } });
          await assertRosterStatus(status);
        }
        await prisma.run.update({ where: { id: running.id }, data: { status: "running" } });
        const snapshot = await threadSnapshot({ prisma }, target);
        expect(snapshot.run).toMatchObject({ id: running.id, status: "running" });
        expect(snapshot.activeRuns).toEqual(
          expect.arrayContaining([expect.objectContaining({ id: running.id })]),
        );
        expect(snapshot.messages.flatMap((message) => message.blocks)).not.toContainEqual(
          expect.objectContaining({ kind: "progress", text: "Inspecting sample files" }),
        );
        // Peer work and failures remain silent in groups.
        const peerRun = await prisma.run.create({
          data: {
            ...scope,
            taskId: task.id,
            threadId: groupTarget.threadId,
            status: "running",
            trigger: "bot_message",
          },
        });
        expect(await threadSnapshot({ prisma }, groupTarget)).toMatchObject({
          run: null,
          activeRuns: [],
        });
        await prisma.run.update({
          where: { id: peerRun.id },
          data: { status: "failed", error: "Sample failure" },
        });
        expect(await threadSnapshot({ prisma }, groupTarget)).toMatchObject({
          run: null,
          activeRuns: [],
        });
        await prisma.run.update({ where: { id: running.id }, data: { status: "completed" } });
        // Background work must not override queued conversational work.
        await prisma.run.create({
          data: { ...scope, taskId: task.id, status: "running", trigger: "tickets" },
        });
        await assertRosterStatus("queued");
        await prisma.run.update({ where: { id: running.id }, data: { status: "running" } });
        await stopThreadRuns(
          {
            prisma,
            sandbox: {} as SandboxProvider,
            events: { notify: vi.fn().mockResolvedValue(undefined) } as unknown as ThreadEvents,
          },
          actor,
          target,
        );
        expect(
          await prisma.run.findMany({
            where: { id: { in: [running.id, queued.id] } },
            select: { status: true },
          }),
        ).toEqual([{ status: "cancelled" }, { status: "cancelled" }]);
        expect(await threadSnapshot({ prisma }, target)).toMatchObject({
          run: null,
          activeRuns: [],
        });
      });
    } finally {
      await runAsSystem("test fixture cleanup", async () => {
        await prisma.organization.delete({ where: { id: identity.spaceId } });
        await prisma.user.delete({ where: { id: identity.userId } });
      });
      await prisma.$disconnect();
      await pool.end();
    }
  });

  it("names a working routine and notes it in the chat when it is stopped", async () => {
    const { prisma, pool } = createDb(process.env.DATABASE_URL!);
    const identity = await runAsSystem("test fixture", () =>
      provisionMessagingIdentity(
        prisma,
        { provider: "sendblue", address: `routine-fixture-${crypto.randomUUID()}` },
        { signupsEnabled: undefined, signupAllowlist: undefined },
      ),
    );
    const actor: Actor = { ...identity, email: "fixture@example.test", isDeploymentOwner: false };
    try {
      await runAsTenant(actor, async () => {
        const bot = await createRepos(prisma).createBot(actor, {
          description: "",
          instructions: "",
          notifyOnFinish: true,
          name: "Sample Helper",
        });
        const target = await resolveThreadTarget(prisma, actor, { botId: bot.id });
        const scope = {
          spaceId: actor.spaceId,
          userId: actor.userId,
          botId: bot.id,
          threadId: target.threadId,
        };
        const routine = await prisma.routine.create({
          data: {
            ...scope,
            name: "Sample inbox sweep",
            prompt: "Sweep the sample inbox",
            crons: [],
          },
        });
        const task = await prisma.task.create({
          data: { ...scope, prompt: "Sweep the sample inbox", status: "running" },
        });
        const run = await prisma.run.create({
          data: {
            ...scope,
            taskId: task.id,
            status: "running",
            trigger: "routine",
            routineId: routine.id,
          },
        });

        const snapshot = await threadSnapshot({ prisma }, target);
        expect(snapshot.activeRuns).toEqual([
          expect.objectContaining({ id: run.id, routineName: "Sample inbox sweep" }),
        ]);
        const other = await prisma.routine.create({
          data: { ...scope, name: "Sample report", prompt: "Write the sample report", crons: [] },
        });
        const sameName = await prisma.routine.create({
          data: {
            ...scope,
            name: "Sample inbox sweep",
            prompt: "Sweep the shared inbox",
            crons: [],
          },
        });
        await prisma.run.createMany({
          data: [
            {
              ...scope,
              taskId: task.id,
              status: "queued",
              trigger: "routine",
              routineId: routine.id,
            },
            {
              ...scope,
              taskId: task.id,
              status: "queued",
              trigger: "routine",
              routineId: other.id,
            },
            {
              ...scope,
              taskId: task.id,
              status: "queued",
              trigger: "routine",
              routineId: sameName.id,
            },
          ],
        });

        await stopThreadRuns(
          {
            prisma,
            sandbox: {} as SandboxProvider,
            events: { notify: vi.fn().mockResolvedValue(undefined) } as unknown as ThreadEvents,
          },
          actor,
          target,
        );
        const noteTexts = async () =>
          (
            await prisma.message.findMany({
              where: { threadId: target.threadId, role: "system", botId: bot.id },
              orderBy: { seq: "asc" },
              select: { blocks: true },
            })
          ).map((message) => (message.blocks as Array<{ text: string }>)[0]?.text);
        expect((await noteTexts()).sort()).toEqual(
          [
            stoppedRoutineNote("Sample inbox sweep"),
            stoppedRoutineNote("Sample inbox sweep"),
            stoppedRoutineNote("Sample report"),
          ].sort(),
        );

        await prisma.run.createMany({
          data: [
            {
              ...scope,
              taskId: task.id,
              status: "running",
              trigger: "routine",
              routineId: other.id,
            },
            { ...scope, taskId: task.id, status: "queued", trigger: "user" },
          ],
        });
        await prisma.$transaction(cancelThreadRuns(actor, target, { botId: bot.id }));
        expect((await noteTexts()).slice(3).sort()).toEqual(
          [stoppedRoutineNote("Sample report"), STOPPED_BY_MESSAGE_NOTE].sort(),
        );
      });
    } finally {
      await runAsSystem("test fixture cleanup", async () => {
        await prisma.organization.delete({ where: { id: identity.spaceId } });
        await prisma.user.delete({ where: { id: identity.userId } });
      });
      await prisma.$disconnect();
      await pool.end();
    }
  });
});
