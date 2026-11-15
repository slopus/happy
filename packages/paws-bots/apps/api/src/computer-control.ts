import { randomUUID } from "node:crypto";
import { ORPCError } from "@orpc/server";
import type { AdapterContext } from "@rakazo/adapter-kit";
import type { ComputerExecutionLease } from "@rakazo/adapters";
import {
  acquireComputerExecutionLease,
  anotherPersonHoldsControl,
  ComputerBusyError,
  clearInactiveUserComputerControl,
  computerSupportsUpdate,
  controlLeaseExpiresAt,
  enqueueTakeoverContinuation,
  expireComputerControl,
  hasActiveComputerControl,
  holdsUserControl,
  isSandboxGoneError,
  releaseComputerControlLease,
  releaseComputerExecutionLease,
  replaceComputer,
  scheduleComputerControlExpiry,
  scheduleComputerSleep,
  screenLeaseIdForRun,
} from "@rakazo/adapters";
import type { Actor, ComputerStatus } from "@rakazo/contracts";
import { ACTIVE_RUN_STATUSES } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { createRepos, IsolationError, recordComputerRunEnd, spaceIsShared } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { resolveComputerWork, toComputerStatus } from "./computer-status.js";
import type { RouterDeps } from "./router.js";
import { computerContext } from "./routes/shared.js";

/** What changing who controls a screen needs. */
type ControlDeps = Pick<RouterDeps, "prisma" | "events" | "jobs" | "sandbox">;

const BOOT_LEASE_RETRY_MS = 250;
const BOOT_LEASE_ATTEMPTS = 20;

/**
 * A run lets go of its computer in its executor's finally, a moment after the run ends. A boot
 * sent as the run finishes waits that moment out instead of being refused as busy.
 */
export async function acquireBootLease(
  prisma: PrismaClient,
  input: { computerId: string; runId: string; botId: string },
): Promise<ComputerExecutionLease | null> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await acquireComputerExecutionLease(prisma, input);
    } catch (error) {
      if (!(error instanceof ComputerBusyError) || attempt >= BOOT_LEASE_ATTEMPTS) throw error;
      if (!(await leaseHeldByFinishedRun(prisma, input))) throw error;
      await new Promise((resolve) => setTimeout(resolve, BOOT_LEASE_RETRY_MS));
    }
  }
}

async function leaseHeldByFinishedRun(
  prisma: PrismaClient,
  input: { computerId: string; botId: string },
): Promise<boolean> {
  const lease = await prisma.computerExecutionLease.findUnique({
    where: { computerId_botId: { computerId: input.computerId, botId: input.botId } },
    select: { runId: true, expiresAt: true },
  });
  if (!lease || lease.expiresAt.getTime() <= Date.now()) return false;
  const run = await prisma.run.findUnique({ where: { id: lease.runId }, select: { status: true } });
  return Boolean(run && !(ACTIVE_RUN_STATUSES as readonly string[]).includes(run.status));
}

export async function computerStatus(
  deps: RouterDeps,
  actor: Actor,
  botId: string,
): Promise<ComputerStatus> {
  const repos = createRepos(deps.prisma);
  let bot = await repos.getBot(actor, botId);
  if (await expireStaleComputerControl(deps, bot.computer)) {
    bot = await repos.getBot(actor, botId);
  }
  const [work, shared] = await Promise.all([
    resolveComputerWork(deps.prisma, {
      computerId: bot.computer?.id,
      botId,
      botName: bot.name,
    }),
    spaceIsShared(deps.prisma, actor.spaceId),
  ]);
  return toComputerStatus(botId, bot.computer, work, shared, actor.userId);
}

/** Whether this person holds this bot's user control, so they may drive its screen. */
export function holdsComputerControl(
  computer: Parameters<typeof hasActiveComputerControl>[0] & {
    controlBotId: string | null;
    controlUserId: string | null;
    userId?: string;
  },
  botId: string,
  actor: Actor,
): boolean {
  return (
    hasActiveComputerControl(computer) &&
    computer.controlBotId === botId &&
    holdsUserControl(computer, actor.userId)
  );
}

/** Members share a Space's computers, but only the person holding control can keep or end it. */
export function assertNotAnotherPersonsControl(
  computer: Parameters<typeof anotherPersonHoldsControl>[0],
  actor: Actor,
): void {
  if (anotherPersonHoldsControl(computer, actor.userId)) {
    throw new ORPCError("CONFLICT", { message: "Someone else is using this computer" });
  }
}

/** Hand back this person's control of the bot's screen. Resolves true when it ended a lease. */
export async function releaseComputerControl(
  deps: ControlDeps,
  actor: Actor,
  computer: NonNullable<Awaited<ReturnType<ReturnType<typeof createRepos>["getBot"]>>["computer"]>,
  botId: string,
  reason: "released" | "done" | "skipped" = "released",
  expectedLeaseId?: string,
): Promise<boolean> {
  const leaseId = computer.controlLeaseId;
  if (computer.controlHolder !== "user" || !leaseId || computer.controlBotId !== botId) {
    return false;
  }
  if (expectedLeaseId !== undefined && expectedLeaseId !== leaseId) return false;
  if (!holdsUserControl(computer, actor.userId)) return false;
  const released = await releaseComputerControlLease(
    deps,
    computer,
    botId,
    leaseId,
    computerContext(actor, botId, "screen.release"),
    reason,
  );
  if (released) scheduleComputerSleep(deps.jobs, computer.id);
  return released;
}

/**
 * Answer a bot's request for help on its screen (Done or Skip), ending this person's control
 * first. Only the person it asked answers. Resolves the answered run.
 */
export async function answerComputerRequest(
  deps: RouterDeps,
  actor: Actor,
  botId: string,
  reason: "done" | "skipped",
  runId?: string,
): Promise<string | null> {
  // Only an answer this person may give ends control; any other reply, or a refused one, leaves
  // it alone.
  const waiting = await waitingTakeoverRun(deps, actor.spaceId, botId, runId);
  if (!waiting) return null;
  // Anyone in the Space can take the screen, so holding it never answers for someone else.
  if (waiting.userId !== actor.userId) {
    throw new ORPCError("CONFLICT", { message: "The bot is waiting for someone else" });
  }
  // Hand back before answering, so a failed hand back leaves the request for a retry.
  const bot = await createRepos(deps.prisma).getBot(actor, botId);
  if (bot.computer) await releaseComputerControl(deps, actor, bot.computer, botId, reason);
  const answered = await deps.events.answerTakeoverRequest({
    spaceId: actor.spaceId,
    botId,
    runId: waiting.id,
    reason,
  });
  if (!answered) return null;
  await enqueueTakeoverContinuation(deps.jobs, waiting.id);
  return waiting.id;
}

/** Keep this lease while its page checks in. Resolves whether it was still live to keep. */
export async function renewComputerControl(
  deps: ControlDeps,
  computerId: string,
  leaseId: string,
  expiresAt: Date,
): Promise<boolean> {
  const renewed = await deps.prisma.computer.updateMany({
    where: {
      id: computerId,
      controlHolder: "user",
      controlLeaseId: leaseId,
      // A lapsed lease is being revoked; only a live one is renewed.
      controlLeaseExpiresAt: { gt: new Date() },
    },
    data: { controlLeaseExpiresAt: expiresAt },
  });
  return renewed.count === 1;
}

/** The run of this bot that asked a person for help on its screen and still waits. */
export async function waitingTakeoverRun(
  deps: RouterDeps,
  spaceId: string,
  botId: string,
  runId?: string,
) {
  return deps.prisma.run.findFirst({
    where: { spaceId, botId, status: "waiting_takeover", ...(runId ? { id: runId } : {}) },
    orderBy: { createdAt: "desc" },
    select: { id: true, userId: true },
  });
}

export async function runComputerReplace(
  deps: RouterDeps,
  context: { actor: Actor },
  botId: string,
  mode: "recover" | "reset" | "update",
  operationId: string,
): Promise<ComputerStatus> {
  const repos = createRepos(deps.prisma);
  const bot = await repos.getBot(context.actor, botId);
  if (!bot.computer) throw new IsolationError();
  // Stopping, resetting or updating would end someone else's control of the screen.
  assertNotAnotherPersonsControl(bot.computer, context.actor);
  if (mode === "update" && !computerSupportsUpdate(bot.computer.kind)) {
    throw new ORPCError("BAD_REQUEST", {
      message: "Computer update is not available on this device",
    });
  }
  const manualRunId = `${mode}:${randomUUID()}`;
  let lease: ComputerExecutionLease | null;
  try {
    lease = await acquireComputerExecutionLease(deps.prisma, {
      computerId: bot.computer.id,
      runId: manualRunId,
      botId: bot.id,
    });
  } catch (error) {
    if (error instanceof ComputerBusyError) {
      throw new ORPCError("CONFLICT", { message: "Computer is busy" });
    }
    throw error;
  }
  try {
    await replaceComputer(
      deps,
      bot.computer.id,
      mode,
      {
        ...computerContext(context.actor, bot.id, operationId),
        screenLeaseId: screenLeaseIdForRun(lease, manualRunId),
      },
      "none",
      undefined,
      { handBackIdleTakeover: true },
    );
    scheduleComputerSleep(deps.jobs, bot.computer.id);
  } catch (error) {
    if (error instanceof ComputerBusyError) {
      throw new ORPCError("CONFLICT", { message: "Computer is busy" });
    }
    throw error;
  } finally {
    await releaseComputerExecutionLease(deps.prisma, lease);
  }
  return computerStatus(deps, context.actor, botId);
}

export async function expireStaleComputerControl(
  deps: RouterDeps,
  computer:
    | (NonNullable<Parameters<typeof hasActiveComputerControl>[0]> & {
        id: string;
        controlHolder?: string;
      })
    | null
    | undefined,
): Promise<boolean> {
  if (!computer || hasActiveComputerControl(computer)) return false;
  if (computer.controlHolder !== "user") {
    // Holder "none" with a surviving lease id is a revoke that failed mid-expiry;
    // retry it so the row does not sit busy forever.
    if (computer.controlLeaseId) {
      await expireComputerControl(deps, computer.id, computer.controlLeaseId).catch(
        () => undefined,
      );
      return true;
    }
    return false;
  }
  const leaseId = computer.controlLeaseId;
  // Keep a failed revoke's lease id so reconciliation can retry provider shutdown.
  if (leaseId) {
    await expireComputerControl(deps, computer.id, leaseId).catch(() => undefined);
    return true;
  }
  return clearInactiveUserComputerControl(deps.prisma, computer.id).catch(() => false);
}

export async function computerScreenContext(
  prisma: PrismaClient,
  actor: Actor,
  computerId: string,
  botId: string,
  operationId: string,
): Promise<AdapterContext> {
  const context = computerContext(actor, botId, operationId);
  const lease = await prisma.computerExecutionLease.findUnique({
    where: { computerId_botId: { computerId, botId } },
    select: { runId: true, fence: true, expiresAt: true },
  });
  if (!lease || lease.expiresAt.getTime() <= Date.now()) return context;
  return { ...context, screenLeaseId: screenLeaseIdForRun(lease, lease.runId) };
}

/**
 * The provider killed this sandbox (idle timeout) while the row still says running. Clear the
 * dead ref so the UI offers a boot instead of 500ing, and rethrow anything else. Leave any
 * active control lease alone: expireComputerControl owns that release (provider screen-control,
 * events, takeover continuation).
 */
export async function clearGoneSandbox(
  deps: RouterDeps,
  computer: { id: string; providerRef: string | null; runningSince?: Date | null },
  error: unknown,
): Promise<null> {
  if (!isSandboxGoneError(error)) throw error;
  getLogger().warn(`computer ${computer.id} sandbox ${computer.providerRef} is gone`, { error });
  const cleared = await deps.prisma.computer.updateMany({
    where: { id: computer.id, providerRef: computer.providerRef },
    data: { state: "stopped", providerRef: null },
  });
  if (cleared.count === 1) await recordComputerRunEnd(deps.prisma, computer, "gone");
  return null;
}

export async function keepComputerAwake(deps: RouterDeps, computerId: string) {
  await deps.prisma.computer.updateMany({
    where: { id: computerId, state: "running" },
    data: { updatedAt: new Date() },
  });
  scheduleComputerSleep(deps.jobs, computerId);
}

export function withViewOnly(url: string, viewOnly: boolean) {
  try {
    const parsed = new URL(url);
    parsed.searchParams.set("view_only", viewOnly ? "true" : "false");
    return parsed.toString();
  } catch {
    const join = url.includes("?") ? "&" : "?";
    return `${url}${join}view_only=${viewOnly ? "true" : "false"}`;
  }
}

/**
 * Give this person control of the bot's screen: one holder per computer, and a lease their page's
 * heartbeat renews.
 */
export async function takeComputerControl(
  deps: ControlDeps,
  actor: Actor,
  botId: string,
): Promise<{ leaseId: string; expiresAt: string }> {
  const repos = createRepos(deps.prisma);
  let bot = await repos.getBot(actor, botId);
  if (!bot.computer?.providerRef || bot.computer.state !== "running") {
    throw new ORPCError("BAD_REQUEST", { message: "computer must be running" });
  }
  assertNotAnotherPersonsControl(bot.computer, actor);
  if (holdsComputerControl(bot.computer, bot.id, actor)) {
    const expiresAt = controlLeaseExpiresAt();
    const leaseId = bot.computer.controlLeaseId!;
    if (await renewComputerControl(deps, bot.computer.id, leaseId, expiresAt)) {
      return { leaseId, expiresAt: expiresAt.toISOString() };
    }
    // The lease lapsed or was handed back meanwhile: take control afresh.
    bot = await repos.getBot(actor, botId);
    if (!bot.computer) throw new IsolationError();
  }
  // This person's control of another bot's screen on a shared computer ends first.
  if (hasActiveComputerControl(bot.computer) && bot.computer.controlBotId) {
    await releaseComputerControl(deps, actor, bot.computer, bot.computer.controlBotId);
  } else if (bot.computer.controlLeaseId) {
    await expireComputerControl(deps, bot.computer.id, bot.computer.controlLeaseId);
  }
  bot = await repos.getBot(actor, botId);
  if (!bot.computer?.providerRef || bot.computer.state !== "running") {
    throw new ORPCError("BAD_REQUEST", { message: "computer must be running" });
  }
  const computerId = bot.computer.id;
  const leaseId = randomUUID();
  const expiresAt = controlLeaseExpiresAt();
  // Granted at once: a bot action already running may finish, since it was based on what the
  // screen showed before this person did anything, but every action after this is refused.
  const granted = await deps.prisma.computer.updateMany({
    where: {
      id: computerId,
      state: "running",
      maintenanceId: null,
      controlHolder: { not: "user" },
      controlLeaseId: null,
    },
    data: {
      controlHolder: "user",
      controlLeaseId: leaseId,
      controlLeaseExpiresAt: expiresAt,
      controlBotId: bot.id,
      controlUserId: actor.userId,
      controlFence: { increment: 1 },
    },
  });
  if (granted.count !== 1) {
    const current = await deps.prisma.computer.findUniqueOrThrow({ where: { id: computerId } });
    // A second Take control from the holder, such as a double tap, keeps their lease.
    if (holdsComputerControl(current, bot.id, actor)) {
      const renewed = controlLeaseExpiresAt();
      if (await renewComputerControl(deps, computerId, current.controlLeaseId!, renewed)) {
        return { leaseId: current.controlLeaseId!, expiresAt: renewed.toISOString() };
      }
    }
    assertNotAnotherPersonsControl(current, actor);
    throw new ORPCError("CONFLICT", { message: "Computer is busy" });
  }
  try {
    await scheduleComputerControlExpiry(deps.jobs, computerId, leaseId, expiresAt);
  } catch (error) {
    await deps.prisma.computer.updateMany({
      where: { id: computerId, controlLeaseId: leaseId },
      data: {
        controlHolder: "none",
        controlLeaseId: null,
        controlUserId: null,
        controlLeaseExpiresAt: null,
        controlBotId: null,
      },
    });
    throw error;
  }
  if (bot.thread) {
    await deps.events.append({
      spaceId: actor.spaceId,
      threadId: bot.thread.id,
      botId: bot.id,
      type: "computer.takeover.granted",
      payload: { leaseId },
    });
  }
  scheduleComputerSleep(deps.jobs, computerId);
  return { leaseId, expiresAt: expiresAt.toISOString() };
}
