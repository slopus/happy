import {
  computerScreenSize,
  computerSupportsTerminal,
  computerSupportsUpdate,
  DISK_WARNING_PERCENT,
  diskUsedPercent,
  holdsUserControl,
} from "@rakazo/adapters";
import type { ComputerStatus } from "@rakazo/contracts";
import { ACTIVE_RUN_STATUSES } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";

/** What this bot is doing with its computer: which run holds it, and whether one waits for a person. */
export async function resolveComputerWork(
  prisma: PrismaClient,
  input: {
    computerId: string | null | undefined;
    botId: string;
    botName: string;
  },
): Promise<ComputerWork> {
  if (!input.computerId) return { busyBotName: null, takeoverRequested: false };
  const [lease, waiting] = await Promise.all([
    prisma.computerExecutionLease.findUnique({
      where: { computerId_botId: { computerId: input.computerId, botId: input.botId } },
      select: { expiresAt: true, runId: true },
    }),
    prisma.run.findFirst({
      where: { botId: input.botId, status: "waiting_takeover" },
      select: { id: true },
    }),
  ]);
  const run = lease
    ? await prisma.run.findUnique({ where: { id: lease.runId }, select: { status: true } })
    : null;
  const leaseActive = Boolean(lease && lease.expiresAt.getTime() > Date.now());
  const runActive = Boolean(
    run?.status && (ACTIVE_RUN_STATUSES as readonly string[]).includes(run.status),
  );
  const working = run?.status !== "waiting_takeover" && (leaseActive || runActive);
  return { busyBotName: working ? input.botName : null, takeoverRequested: Boolean(waiting) };
}

export interface ComputerWork {
  busyBotName: string | null;
  takeoverRequested: boolean;
}

export function toComputerStatus(
  botId: string,
  computer: {
    kind: string;
    state: string;
    scope: string;
    controlHolder: string;
    controlBotId?: string | null;
    homeRevision: string;
    maintenanceId?: string | null;
    diskUsedBytes?: bigint | null;
    diskFreeBytes?: bigint | null;
    diskDismissedPercent?: number | null;
    controlUserId?: string | null;
    controlLeaseId?: string | null;
    userId?: string | null;
  } | null,
  work: ComputerWork = { busyBotName: null, takeoverRequested: false },
  shared = false,
  viewerId?: string,
): ComputerStatus {
  const controlledByOther = Boolean(
    viewerId && computer?.controlHolder === "user" && !holdsUserControl(computer, viewerId),
  );
  // Only the holder learns their lease, the one their screen hands back when it closes.
  const ownLeaseId =
    viewerId &&
    computer?.controlHolder === "user" &&
    computer.controlBotId === botId &&
    computer.controlLeaseId &&
    holdsUserControl(computer, viewerId)
      ? computer.controlLeaseId
      : undefined;
  const kind = (computer?.kind ?? "fake") as ComputerStatus["kind"];
  const state =
    kind === "none"
      ? "stopped"
      : computer?.maintenanceId
        ? "booting"
        : computer?.state === "quarantined"
          ? "error"
          : computer?.state === "suspending"
            ? "running"
            : computer?.state === "stopped" ||
                computer?.state === "booting" ||
                computer?.state === "running" ||
                computer?.state === "suspended" ||
                computer?.state === "error"
              ? computer.state
              : "stopped";
  const screen = computerScreenSize(computer?.kind);
  const diskPercent = computer ? diskUsedPercent(computer) : null;
  const diskFull =
    diskPercent !== null &&
    diskPercent >= DISK_WARNING_PERCENT &&
    diskPercent > (computer?.diskDismissedPercent ?? 0);
  return {
    botId,
    ...(shared ? { shared } : {}),
    ...(controlledByOther ? { controlledByOther } : {}),
    ...(ownLeaseId ? { controlLeaseId: ownLeaseId } : {}),
    mode: computer?.scope === "dedicated" ? "dedicated" : "team",
    kind,
    state,
    controlHolder: (computer?.controlHolder ?? "none") as ComputerStatus["controlHolder"],
    controlBotId: computer?.controlBotId ?? null,
    takeoverRequested: work.takeoverRequested,
    screenAvailable: !computer?.maintenanceId && (state === "running" || state === "booting"),
    screenWidth: screen.width,
    screenHeight: screen.height,
    homeRevision: computer?.homeRevision ?? null,
    busyBotName: work.busyBotName,
    canUpdate: computerSupportsUpdate(kind),
    terminalAvailable: computerSupportsTerminal(kind),
    ...(diskFull ? { diskFullPercent: diskPercent } : {}),
  };
}
