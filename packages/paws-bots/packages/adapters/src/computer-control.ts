import type { AdapterContext, JobPublisher, SandboxProvider } from "@rakazo/adapter-kit";
import {
  computerControlExpireJob,
  computerControlExpireJobKey,
  runContinueJob,
} from "@rakazo/adapter-kit";
import { COMPUTER_CONTROL_LEASE_MS } from "@rakazo/core";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { recordComputerRunEnd } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { toComputerRef } from "./computer-support.js";
import { isSandboxGoneError } from "./sandbox-errors.js";

// Who holds a computer's user control is decided in one place, next to the computer rows.
export {
  anotherPersonHoldsControl,
  hasActiveComputerControl,
  holdsUserControl,
  userControlHeldBy,
} from "@rakazo/db";

export const CONTROL_LEASE_MS = COMPUTER_CONTROL_LEASE_MS;

export function controlLeaseExpiresAt(now = new Date()): Date {
  return new Date(now.getTime() + CONTROL_LEASE_MS);
}

export function scheduleComputerControlExpiry(
  jobs: JobPublisher,
  computerId: string,
  leaseId: string,
  expiresAt: Date,
): Promise<void> {
  return jobs.enqueue(computerControlExpireJob(computerId, leaseId, expiresAt));
}

export async function enqueueTakeoverContinuation(
  jobs: JobPublisher,
  runId: string | null,
): Promise<void> {
  if (!runId) return;
  try {
    await jobs.enqueue(runContinueJob(runId));
  } catch (error) {
    // The release is durable; reconciliation will retry this queued run.
    getLogger().error("takeover continuation enqueue", error);
  }
}

/**
 * Clears controlHolder=user left without a lease id. A lease with an id ends only through
 * expireComputerControl, which stops the person's input first.
 */
export async function clearInactiveUserComputerControl(
  prisma: PrismaClient,
  computerId: string,
): Promise<boolean> {
  const cleared = await prisma.computer.updateMany({
    where: { id: computerId, controlHolder: "user", controlLeaseId: null },
    data: {
      controlHolder: "none",
      controlLeaseId: null,
      controlUserId: null,
      controlLeaseExpiresAt: null,
      controlBotId: null,
    },
  });
  return cleared.count === 1;
}

/** Revoke provider screen control. Gone sandbox ⇒ already released; drop the stranded ref
 * unless clearGoneRef: false (mid-replacement still names that ref for activation CAS). */
export async function revokeScreenControl(
  deps: { prisma: PrismaClient; sandbox: SandboxProvider | undefined },
  computer: {
    id: string;
    homeKey: string;
    kind: string;
    providerRef: string | null;
    runningSince?: Date | null;
  },
  context: AdapterContext,
  leaseId: string | undefined,
  opts?: { clearGoneRef?: boolean },
): Promise<void> {
  if (!computer.providerRef) return;
  try {
    await deps.sandbox?.setScreenControl?.(toComputerRef(computer), false, context, leaseId);
  } catch (error) {
    if (!isSandboxGoneError(error)) throw error;
    if (opts?.clearGoneRef === false) return;
    getLogger().warn(`computer ${computer.id} sandbox ${computer.providerRef} is gone`, { error });
    // Fence by lease + skip booting/suspending so a stale gone-cleanup cannot clobber an
    // in-flight replace/boot that still names this providerRef.
    const cleared = await deps.prisma.computer.updateMany({
      where: {
        id: computer.id,
        providerRef: computer.providerRef,
        state: { notIn: ["booting", "suspending"] },
        ...(leaseId != null ? { controlLeaseId: leaseId } : {}),
      },
      data: { state: "stopped", providerRef: null },
    });
    if (cleared.count === 1) await recordComputerRunEnd(deps.prisma, computer, "gone");
  }
}

type ControlDeps = {
  prisma: PrismaClient;
  sandbox: SandboxProvider;
  jobs: JobPublisher;
  events: ThreadEvents;
};

/** End this lease: the provider stops taking its input, then the holder row is cleared. */
export async function releaseComputerControlLease(
  deps: ControlDeps,
  computer: Parameters<typeof revokeScreenControl>[1] & { spaceId: string },
  botId: string | null,
  leaseId: string,
  context: AdapterContext,
  reason: "released" | "expired" | "done" | "skipped",
): Promise<boolean> {
  await revokeScreenControl(deps, computer, context, leaseId);
  const released = await deps.events.releaseUserControl({
    spaceId: computer.spaceId,
    computerId: computer.id,
    botId,
    leaseId,
    reason,
  });
  if (!released) return false;
  await deps.jobs
    .cancel(computerControlExpireJobKey(computer.id, leaseId))
    .catch((error) => getLogger().error("computer control expiry cancellation", error));
  return true;
}

/**
 * Maintenance that clears a person's control itself ends the teaching recording made under it,
 * as every other way of ending control does.
 */
export async function endTeachingWithLease(
  deps: { events: Pick<ThreadEvents, "draftRecordingsOfLease"> },
  spaceId: string,
  leaseId: string | null,
): Promise<void> {
  if (!leaseId) return;
  await deps.events.draftRecordingsOfLease({ spaceId, leaseId });
}

/** Ends a lease its page stopped renewing; a renewed one is checked again when it would lapse. */
export async function expireComputerControl(
  deps: ControlDeps,
  computerId: string,
  leaseId: string,
  now = new Date(),
): Promise<boolean> {
  const computer = await deps.prisma.computer.findUnique({ where: { id: computerId } });
  if (!computer || computer.controlLeaseId !== leaseId) return false;
  if (computer.controlLeaseExpiresAt && computer.controlLeaseExpiresAt.getTime() > now.getTime()) {
    await scheduleComputerControlExpiry(
      deps.jobs,
      computer.id,
      leaseId,
      computer.controlLeaseExpiresAt,
    );
    return false;
  }
  // Mark the lease spent so neither input nor a heartbeat revives it, but keep it on the row:
  // the bot treats the screen as the person's until the provider has stopped their input. A
  // heartbeat that renewed the lease since the read above keeps it.
  const claimed = await deps.prisma.computer.updateMany({
    where: {
      id: computer.id,
      controlLeaseId: leaseId,
      OR: [{ controlLeaseExpiresAt: null }, { controlLeaseExpiresAt: { lte: now } }],
    },
    data: { controlLeaseExpiresAt: new Date(0) },
  });
  if (claimed.count !== 1) {
    const renewed = await deps.prisma.computer.findUnique({ where: { id: computer.id } });
    if (renewed?.controlLeaseId === leaseId && renewed.controlLeaseExpiresAt) {
      await scheduleComputerControlExpiry(
        deps.jobs,
        computer.id,
        leaseId,
        renewed.controlLeaseExpiresAt,
      );
    }
    return false;
  }
  const context: AdapterContext = {
    operationId: "computer.control-expire",
    traceId: "computer.control-expire",
    spaceId: computer.spaceId,
    userId: computer.userId,
    ...(computer.controlBotId ? { botId: computer.controlBotId } : {}),
    signal: new AbortController().signal,
  };
  return releaseComputerControlLease(
    deps,
    computer,
    computer.controlBotId,
    leaseId,
    context,
    "expired",
  );
}
