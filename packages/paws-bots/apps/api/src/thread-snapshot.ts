import type { ThreadSnapshot } from "@rakazo/contracts";
import {
  ACTIVE_RUN_STATUSES,
  BACKGROUND_RUN_TRIGGERS,
  projectMessages,
  runFailureError,
} from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { spaceIsShared } from "@rakazo/db";
import { resolveComputerWork, toComputerStatus } from "./computer-status.js";
import { THREAD_MESSAGE_PAGE_SIZE } from "./routes/shared.js";
import { loadMessagePage } from "./thread-message-pages.js";
import type { ThreadTarget } from "./thread-target.js";

export async function threadSnapshot(
  deps: { prisma: PrismaClient },
  target: ThreadTarget,
  viewerId?: string,
): Promise<ThreadSnapshot> {
  // Lock the thread row so messages, the event cursor, active runs, and live
  // progress are read from one consistent commit. A torn Promise.all can
  // otherwise advance the client cursor past thread.message.created while the
  // ask message page still omits it — leaving waiting_input with no AskCard.
  if (target.kind === "bot") {
    const [work, core] = await Promise.all([
      resolveComputerWork(deps.prisma, {
        computerId: target.bot.computer?.id,
        botId: target.botId,
        botName: target.bot.name,
      }),
      deps.prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM threads WHERE id = ${target.threadId} FOR SHARE`;
          const [messagePage, last, activeRuns, busyOrFailed, shared] = await Promise.all([
            loadMessagePage(tx, target.threadId, undefined, THREAD_MESSAGE_PAGE_SIZE),
            tx.event.findFirst({
              where: { threadId: target.threadId },
              orderBy: { seq: "desc" },
              select: { seq: true },
            }),
            tx.run.findMany({
              where: {
                botId: target.botId,
                threadId: target.threadId,
                status: { in: [...ACTIVE_RUN_STATUSES] },
                OR: [
                  { trigger: { notIn: [...BACKGROUND_RUN_TRIGGERS] } },
                  { status: { in: ["waiting_input", "waiting_takeover"] } },
                ],
              },
              orderBy: [{ createdAt: "desc" }, { id: "desc" }],
              include: { routine: { select: { name: true } } },
            }),
            tx.run.findFirst({
              where: {
                botId: target.botId,
                threadId: target.threadId,
                // Background ticket work stays silent; waiting is handled above.
                trigger: { notIn: [...BACKGROUND_RUN_TRIGGERS] },
                status: { in: [...ACTIVE_RUN_STATUSES, "failed"] },
              },
              // The id tiebreak keeps ordering deterministic under equal
              // timestamps, matching the supersession probe below.
              orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            }),
            spaceIsShared(tx, target.bot.spaceId),
          ]);
          const run = pickPrimaryPrivateActiveRun(activeRuns) ?? busyOrFailed;
          // A failure only surfaces while it is still the newest terminal run, or a stale
          // failure would reappear on every load. Compare by ordering, not timestamps:
          // equal createdAt values reverse under gt/gte.
          const newestTerminal =
            run?.status === "failed"
              ? await tx.run.findFirst({
                  where: {
                    botId: target.botId,
                    threadId: target.threadId,
                    // Background failures must not bury a user-visible failure.
                    trigger: { notIn: [...BACKGROUND_RUN_TRIGGERS] },
                    status: { in: ["failed", "completed", "cancelled"] },
                  },
                  orderBy: [{ createdAt: "desc" }, { id: "desc" }],
                  select: { id: true },
                })
              : null;
          const currentRun = run?.status === "failed" && newestTerminal?.id !== run.id ? null : run;
          const liveRuns = activeRuns.filter((run) => run.trigger !== "bot_message");
          const liveEvents =
            liveRuns.length > 0
              ? await tx.event.findMany({
                  where: {
                    threadId: target.threadId,
                    runId: { in: liveRuns.map((run) => run.id) },
                    type: {
                      in: [
                        "thread.progress",
                        "thread.subagent",
                        "run.waiting_input",
                        "computer.takeover.requested",
                        "agent.tool.called",
                        "agent.tool.completed",
                      ],
                    },
                  },
                  orderBy: { seq: "asc" },
                })
              : [];
          return { messagePage, last, run: currentRun, activeRuns, liveEvents, shared };
        },
        { timeout: 15_000, maxWait: 5_000 },
      ),
    ]);
    return {
      botId: target.botId,
      threadId: target.threadId,
      cursor: core.last?.seq ?? -1,
      messages: messagesWithLiveEvents(core.messagePage.messages, core.liveEvents, core.activeRuns),
      olderCursor: core.messagePage.olderCursor,
      run: core.run ? mapRun(core.run) : null,
      activeRuns: core.activeRuns.map(mapRun),
      computer: toComputerStatus(target.botId, target.bot.computer, work, core.shared, viewerId),
    };
  }

  const core = await deps.prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT id FROM threads WHERE id = ${target.threadId} FOR SHARE`;
      const [messagePage, last, activeRuns, recentTerminals] = await Promise.all([
        loadMessagePage(tx, target.threadId, undefined, THREAD_MESSAGE_PAGE_SIZE),
        tx.event.findFirst({
          where: { threadId: target.threadId },
          orderBy: { seq: "desc" },
          select: { seq: true },
        }),
        tx.run.findMany({
          where: {
            threadId: target.threadId,
            status: { in: [...ACTIVE_RUN_STATUSES] },
            // Waiting peer and ticket asks stay answerable. Busy ticket runs stay off
            // the transcript; only their waiting_input / waiting_takeover states surface.
            OR: [
              { trigger: { notIn: ["bot_message", ...BACKGROUND_RUN_TRIGGERS] } },
              { status: { in: ["waiting_input", "waiting_takeover"] } },
            ],
          },
          orderBy: { createdAt: "desc" },
          include: { routine: { select: { name: true } } },
        }),
        // Recently updated terminals (completion bumps updatedAt). pickLatestTerminalRun then
        // ranks by completedAt ?? createdAt so null timestamps cannot revive a stale failure.
        tx.run.findMany({
          where: {
            threadId: target.threadId,
            trigger: { notIn: ["bot_message", ...BACKGROUND_RUN_TRIGGERS] },
            status: { in: ["failed", "completed", "cancelled"] },
          },
          orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
          take: 50,
        }),
      ]);
      const liveEvents =
        activeRuns.length > 0
          ? await tx.event.findMany({
              where: {
                threadId: target.threadId,
                runId: { in: activeRuns.map((run) => run.id) },
                type: {
                  in: [
                    "thread.progress",
                    "thread.subagent",
                    "run.waiting_input",
                    "computer.takeover.requested",
                    "agent.tool.called",
                    "agent.tool.completed",
                  ],
                },
              },
              orderBy: { seq: "asc" },
            })
          : [];
      return {
        messagePage,
        last,
        activeRuns,
        terminalRun: pickLatestTerminalRun(recentTerminals),
        liveEvents,
      };
    },
    { timeout: 15_000, maxWait: 5_000 },
  );
  const primaryActiveRun = pickPrimaryActiveRun(core.activeRuns);
  return {
    groupId: target.groupId,
    groupName: target.groupName,
    members: target.members,
    threadId: target.threadId,
    cursor: core.last?.seq ?? -1,
    messages: messagesWithLiveEvents(core.messagePage.messages, core.liveEvents, core.activeRuns),
    olderCursor: core.messagePage.olderCursor,
    // Match the live reducer: a failed latest terminal stays in run even while siblings are
    // still active or start late. A newer completed/cancelled terminal clears it.
    run:
      core.terminalRun?.status === "failed"
        ? mapRun(core.terminalRun)
        : primaryActiveRun
          ? mapRun(primaryActiveRun)
          : null,
    activeRuns: core.activeRuns.map(mapRun),
  };
}

/** Keep waiting asks and takeovers in the group headline ahead of newer busy runs. */
function pickPrimaryActiveRun<T extends { status: string }>(runs: readonly T[]): T | undefined {
  return (
    runs.find((run) => run.status === "waiting_input" || run.status === "waiting_takeover") ??
    runs[0]
  );
}

/** Private threads prioritize takeover, then live work, while pending cards stay active. */
function pickPrimaryPrivateActiveRun<T extends { status: string }>(
  runs: readonly T[],
): T | undefined {
  return (
    runs.find((run) => run.status === "waiting_takeover") ??
    runs.find((run) => run.status === "running") ??
    runs.find((run) => run.status === "leased") ??
    runs[0]
  );
}

function pickLatestTerminalRun<T extends { id: string; createdAt: Date; completedAt: Date | null }>(
  runs: T[],
): T | null {
  if (runs.length === 0) return null;
  return runs.reduce((best, run) => {
    const bestEnd = (best.completedAt ?? best.createdAt).getTime();
    const runEnd = (run.completedAt ?? run.createdAt).getTime();
    if (runEnd !== bestEnd) return runEnd > bestEnd ? run : best;
    if (run.createdAt.getTime() !== best.createdAt.getTime()) {
      return run.createdAt > best.createdAt ? run : best;
    }
    return run.id > best.id ? run : best;
  });
}

function messagesWithLiveEvents(
  persisted: ThreadSnapshot["messages"],
  liveEvents: Parameters<typeof projectMessages>[0],
  runs: NonNullable<Parameters<typeof projectMessages>[1]>,
) {
  const live = projectMessages(liveEvents, runs).filter((message) => {
    if (message.blocks.some((block) => block.kind === "progress" || block.kind === "steps")) {
      return true;
    }
    if (!message.id.startsWith("subagent:")) return false;
    return !persisted.some((row) =>
      row.blocks.some(
        (block) => block.kind === "subagent" && message.id === `subagent:${block.agentId}`,
      ),
    );
  });
  return [...persisted, ...live];
}

function mapRun(run: {
  id: string;
  userId: string;
  botId: string;
  threadId: string;
  taskId: string;
  status: string;
  trigger: string;
  routineId: string | null;
  routine?: { name: string } | null;
  modelProvider: string | null;
  modelId: string | null;
  error: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
}) {
  return {
    id: run.id,
    userId: run.userId,
    botId: run.botId,
    threadId: run.threadId,
    taskId: run.taskId,
    status: run.status as never,
    trigger: run.trigger as never,
    routineId: run.routineId ?? null,
    ...(run.routine ? { routineName: run.routine.name } : {}),
    modelProvider: run.modelProvider,
    modelId: run.modelId,
    // Same display clamp as live run.failed events so a huge stored error cannot bypass it.
    error:
      run.status === "failed"
        ? runFailureError({ type: "run.failed", payload: { error: run.error } })
        : run.error,
    startedAt: run.startedAt?.toISOString() ?? null,
    completedAt: run.completedAt?.toISOString() ?? null,
    createdAt: run.createdAt.toISOString(),
  };
}
