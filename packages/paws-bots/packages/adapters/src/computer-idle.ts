import type {
  AdapterContext,
  AgentHomeStore,
  ComputerRef,
  JobPublisher,
  SandboxProvider,
} from "@rakazo/adapter-kit";
import {
  computerSleepJob,
  isSandboxProviderOutage,
  runJobKey,
  SandboxRateLimitError,
  SandboxUnavailableError,
  SandboxUnresponsiveError,
  WorkspaceTooLargeError,
} from "@rakazo/adapter-kit";
import { COMPUTER_ALLOWANCE_USED_ERROR } from "@rakazo/contracts";
import { COMPUTER_USING_RUNS, QUEUE_HOLDING_RUN_STATUSES, withAbort } from "@rakazo/core";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import {
  appendEventInTransaction,
  clearEndedExecutionRunBinding,
  createGroupRepos,
  createThreadMessageInTransaction,
  isUniqueViolation,
  recordComputerRunEnd,
  recordComputerRunSeen,
  THREAD_LOCK_TRANSACTION_OPTIONS,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { activeCodingAgent } from "./coding-agent-activity.js";
import {
  endTeachingWithLease,
  expireComputerControl,
  hasActiveComputerControl,
} from "./computer-control.js";
import { diskUpdate, measureComputerDisk } from "./computer-disk.js";
import { screenLeaseIdForRun, toComputerRef } from "./computer-lifecycle.js";
import { BrowserStillRunningError } from "./computer-screens.js";
import { checkpointComputerWorkspace } from "./computer-workspace.js";
import { HomeSaveConflictError } from "./home-object-store.js";
import { sandboxAllowanceUsedUp } from "./sandbox-allowance.js";
import { isSandboxDamagedError, isSandboxGoneError } from "./sandbox-errors.js";

export const DEFAULT_SANDBOX_IDLE_MS = 10 * 60 * 1000;
/**
 * Default uptime cap for providers that bill while running. Background work and viewers
 * do not extend it; executing runs, active user control leases, and a working coding agent
 * defer suspension.
 * COMPUTER_MAX_ACTIVE_MS configures the limit; 0 disables it.
 */
export const DEFAULT_COMPUTER_MAX_ACTIVE_MS = 2 * 60 * 60 * 1000;
/**
 * How long a run waiting for takeover keeps a computer that does not bill while running awake
 * after asking, so the user can answer the push and finish a login, Duo, or CAPTCHA step on the
 * same open page. Billed computers get no grace: an ignored request would keep them running.
 */
export const TAKEOVER_IDLE_GRACE_MS = 30 * 60 * 1000;
/**
 * A suspend claim this old belongs to a sleep job that died mid-checkpoint, usually with its
 * worker in a deploy. The computer is still up on its provider, so the next idle check takes the
 * claim over instead of leaving it running until its next use.
 */
export const ABANDONED_SUSPEND_CLAIM_MS = 60 * 60 * 1000;
const IDLE_SWEEP_INTERVAL_MS = 10 * 60 * 1000;
const STATUS_CHECK_TIMEOUT_MS = 15_000;
const EXECUTING_RUN_STATUSES = ["leased", "running"] as const;
const BACKGROUND_WORK_MARKER_PREFIX = "/tmp/rakazo-background-";
const BACKGROUND_WORK_IDLE_SENTINEL = "rakazo-background-idle";

export const BACKGROUND_WORK_LAUNCH = [
  `marker="${BACKGROUND_WORK_MARKER_PREFIX}$1-$2-$3"`,
  "set -o noclobber",
  'exec 9>"$marker" || exit 1',
  "set +o noclobber",
  'exec bash -lc "$4"',
].join("\n");

// Unobservable proc entries are skipped; unexpected errors invalidate the whole scan.
// --sweep removes only unheld markers after a successful scan, before returning holders.
const LINUX_BACKGROUND_HOLDERS = [
  "linux_background_holders() {",
  '  python3 - "$prefix" "$@" <<\'PY\'',
  "import errno",
  "import os",
  "import sys",
  "",
  "prefix = sys.argv[1]",
  "unobservable = {errno.ENOENT, errno.ESRCH, errno.EACCES, errno.EPERM}",
  "holders = set()",
  "held_markers = set()",
  "",
  "def inspect(pid):",
  "    try:",
  '        with os.scandir("/proc/" + pid + "/fd") as entries:',
  "            for entry in entries:",
  "                if not entry.name.isascii() or not entry.name.isdigit():",
  "                    continue",
  "                try:",
  "                    target = os.readlink(entry.path)",
  "                except OSError as error:",
  "                    if error.errno in unobservable:",
  "                        continue",
  "                    raise",
  "                if target.startswith(prefix):",
  "                    holders.add(int(pid))",
  "                    held_markers.add(target)",
  "    except OSError as error:",
  "        if error.errno not in unobservable:",
  "            raise",
  "",
  "try:",
  '    if not os.access("/proc", os.R_OK | os.X_OK):',
  "        sys.exit(2)",
  '    if len(sys.argv) > 2 and sys.argv[2] != "--sweep":',
  "        pid = sys.argv[2]",
  "        if not pid.isascii() or not pid.isdigit() or int(pid) <= 0:",
  "            sys.exit(2)",
  "        inspect(pid)",
  "    else:",
  '        with os.scandir("/proc") as entries:',
  "            for entry in entries:",
  "                if entry.name.isascii() and entry.name.isdigit() and int(entry.name) > 0:",
  "                    inspect(entry.name)",
  "except OSError:",
  "    sys.exit(2)",
  "",
  'if len(sys.argv) > 2 and sys.argv[2] == "--sweep":',
  "    for marker in sys.argv[3:]:",
  "        if marker not in held_markers:",
  "            try:",
  "                os.unlink(marker)",
  "            except OSError:",
  "                pass",
  "",
  "for pid in sorted(holders):",
  "    print(pid)",
  "PY",
  "}",
].join("\n");

/** Terminate background shell wrappers for one cancelled run. Browser teardown stays screen-scoped. */
export const CANCEL_COMPUTER_RUN_WORK = [
  'computerId="$1"',
  'runId="$2"',
  '[ -n "$computerId" ] && [ -n "$runId" ] || exit 0',
  `prefix="${BACKGROUND_WORK_MARKER_PREFIX}$computerId-$runId-"`,
  LINUX_BACKGROUND_HOLDERS,
  "if [ -d /proc ]; then",
  '  holders="$(linux_background_holders)" || holders=""',
  "  for pid in $holders; do",
  '    current="$(linux_background_holders "$pid")" || continue',
  '    [ "$current" = "$pid" ] && kill -TERM "$pid" 2>/dev/null || true',
  "  done",
  "  sleep 0.2",
  '  holders="$(linux_background_holders)" || holders=""',
  "  for pid in $holders; do",
  '    current="$(linux_background_holders "$pid")" || continue',
  // Never signal a process group. Sandbox work can share the caller's PGID.
  '    [ "$current" = "$pid" ] && kill -KILL "$pid" 2>/dev/null || true',
  "  done",
  '  markers=("$prefix"*)',
  '  if holders="$(linux_background_holders)" && [ -z "$holders" ]; then',
  // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion
  '    for marker in "${markers[@]}"; do rm -f -- "$marker" 2>/dev/null || true; done',
  "  fi",
  "  exit 0",
  'elif [ "$(uname -s 2>/dev/null)" = "Darwin" ] && command -v lsof >/dev/null 2>&1; then',
  `  pkill -TERM -f "rakazo-background-launch $computerId $runId " 2>/dev/null || true`,
  '  for marker in "$prefix"*; do',
  '    [ -e "$marker" ] || continue',
  '    for pid in $(lsof -t -- "$marker" 2>/dev/null); do',
  '      kill -TERM "$pid" 2>/dev/null || true',
  "    done",
  "  done",
  "else",
  "  exit 0",
  "fi",
  "sleep 0.2",
  `pkill -KILL -f "rakazo-background-launch $computerId $runId " 2>/dev/null || true`,
  'if [ "$(uname -s 2>/dev/null)" = "Darwin" ] && command -v lsof >/dev/null 2>&1; then',
  '  for marker in "$prefix"*; do',
  '    [ -e "$marker" ] || continue',
  '    for pid in $(lsof -t -- "$marker" 2>/dev/null); do',
  '      kill -KILL "$pid" 2>/dev/null || true',
  "    done",
  "  done",
  "fi",
  'rm -f -- "$prefix"* 2>/dev/null || true',
].join("\n");

/**
 * Kill the primary browser session without matching chromium-screen-* profiles.
 * Covers Docker (--user-data-dir=.../chromium) and portable launches that only
 * use the symlinked primary profile (E2B desktop.launch / Daytona nohup).
 */
export const CANCEL_PRIMARY_BROWSER_WORK = [
  "pkill -TERM -f -- '--user-data-dir=.*/.browser-profiles/chromium$' || true",
  "pkill -TERM -f -- '--user-data-dir=.*/.browser-profiles/chromium ' || true",
  // Portable primary browsers often omit --user-data-dir; match argv0 only so
  // unrelated processes (e.g. node --engine=chromium) are not killed.
  "if [ -d /proc ]; then for pid in /proc/[0-9]*; do",
  '  cmdline="$(tr "\\0" " " <"$pid/cmdline" 2>/dev/null)" || continue',
  '  case "$cmdline" in *chromium-screen-*) continue ;; esac',
  '  argv0=""; IFS= read -r -d "" argv0 <"$pid/cmdline" || true',
  '  case "$argv0" in',
  "    */google-chrome|*/google-chrome-*|google-chrome|google-chrome-*|*/chromium|*/chromium-*|chromium|chromium-*|*/chrome|chrome|*/firefox|*/firefox-*|firefox|firefox-*)",
  `      kill -TERM "\${pid#/proc/}" 2>/dev/null || true`,
  "      ;;",
  "  esac",
  "done; fi",
  "sleep 0.2",
  "pkill -KILL -f -- '--user-data-dir=.*/.browser-profiles/chromium$' || true",
  "pkill -KILL -f -- '--user-data-dir=.*/.browser-profiles/chromium ' || true",
  "if [ -d /proc ]; then for pid in /proc/[0-9]*; do",
  '  cmdline="$(tr "\\0" " " <"$pid/cmdline" 2>/dev/null)" || continue',
  '  case "$cmdline" in *chromium-screen-*) continue ;; esac',
  '  argv0=""; IFS= read -r -d "" argv0 <"$pid/cmdline" || true',
  '  case "$argv0" in',
  "    */google-chrome|*/google-chrome-*|google-chrome|google-chrome-*|*/chromium|*/chromium-*|chromium|chromium-*|*/chrome|chrome|*/firefox|*/firefox-*|firefox|firefox-*)",
  `      kill -KILL "\${pid#/proc/}" 2>/dev/null || true`,
  "      ;;",
  "  esac",
  "done; fi",
  'rm -f "$HOME/.browser-profiles/chromium/SingletonLock" "$HOME/.browser-profiles/chromium/SingletonCookie" "$HOME/.browser-profiles/chromium/SingletonSocket" 2>/dev/null || true',
].join("; ");

export function cancelComputerRunWorkArgv(computerId: string, runId: string): string[] {
  return ["bash", "-c", CANCEL_COMPUTER_RUN_WORK, "rakazo-cancel-run-work", computerId, runId];
}

export async function cancelComputerRunWork(
  sandbox: Pick<SandboxProvider, "execute" | "cancelRunWork">,
  computer: ComputerRef,
  computerId: string,
  runId: string,
  context: AdapterContext,
): Promise<void> {
  if (!computerId || !runId) return;
  try {
    if (sandbox.cancelRunWork) {
      await sandbox.cancelRunWork(computer, computerId, runId, context);
      return;
    }
    if (computer.kind === "desktop") return;

    for await (const _event of sandbox.execute(
      computer,
      { argv: cancelComputerRunWorkArgv(computerId, runId), timeoutMs: 15_000 },
      context,
    )) {
      // Drain so providers can finish the exec session.
    }
  } catch {
    // Best effort after the run is already cancelled.
  }
}

/** Stop a group's cancelled runs on their computers, then expire their leases. */
export async function stopCancelledGroupRuns(
  deps: {
    prisma: PrismaClient;
    jobs: Pick<JobPublisher, "cancel">;
    sandbox: Pick<SandboxProvider, "execute" | "cancelRunWork" | "releaseScreen">;
  },
  actor: { spaceId: string; userId: string },
  cancelled: {
    cancelledRunIds: string[];
    computers: Array<
      Parameters<typeof toComputerRef>[0] & {
        id: string;
        botId: string;
        runId: string;
        fence: number;
      }
    >;
  },
): Promise<void> {
  await Promise.all(
    cancelled.cancelledRunIds.map((runId) =>
      deps.jobs.cancel(runJobKey(runId)).catch(() => undefined),
    ),
  );
  await Promise.all(
    cancelled.computers.map(async (computer) => {
      if (!computer.providerRef) return;
      const context = {
        operationId: "stop",
        traceId: "stop",
        spaceId: actor.spaceId,
        userId: actor.userId,
        botId: computer.botId,
        runId: computer.runId,
        screenLeaseId: screenLeaseIdForRun(computer, computer.runId),
        cancelRunWork: true,
        signal: new AbortController().signal,
      };
      const ref = toComputerRef(computer);
      await cancelComputerRunWork(deps.sandbox, ref, computer.id, computer.runId, context);
      await deps.sandbox.releaseScreen?.(ref, context).catch(() => undefined);
    }),
  );
  // Expire the leases only after teardown: while they were live, no other run could claim
  // these screens.
  await createGroupRepos(deps.prisma).releaseArchivedRunLeases(cancelled.cancelledRunIds);
}

export const BACKGROUND_WORK_PROBE = [
  `prefix="${BACKGROUND_WORK_MARKER_PREFIX}$1-"`,
  `idle() { printf '${BACKGROUND_WORK_IDLE_SENTINEL}\\n'; exit 1; }`,
  LINUX_BACKGROUND_HOLDERS,
  'markers=("$prefix"*)',
  "if [ -d /proc ]; then",
  `  holders="$(linux_background_holders --sweep "\${markers[@]}")" || exit 2`,
  '  [ -n "$holders" ] && exit 0',
  "  idle",
  "fi",
  'if [ "$(uname -s 2>/dev/null)" = "Darwin" ]; then',
  "  command -v lsof >/dev/null 2>&1 || exit 2",
  "  busy=0",
  `  for marker in "\${markers[@]}"; do`,
  '    [ -e "$marker" ] || continue',
  '    if lsof -t -- "$marker" >/dev/null 2>&1; then',
  "      busy=1",
  "    else",
  '      rm -f -- "$marker"',
  "    fi",
  "  done",
  '  [ "$busy" -eq 1 ] && exit 0',
  "  idle",
  "fi",
  "exit 2",
].join("\n");

export function sandboxIdleMs(): number {
  const raw = Number(process.env.SANDBOX_IDLE_MS ?? DEFAULT_SANDBOX_IDLE_MS);
  return Number.isFinite(raw) && raw >= 30_000 ? raw : DEFAULT_SANDBOX_IDLE_MS;
}

export function computerMaxActiveMs(): number {
  const raw = Number(process.env.COMPUTER_MAX_ACTIVE_MS?.trim() || DEFAULT_COMPUTER_MAX_ACTIVE_MS);
  return Number.isFinite(raw) && (raw === 0 || raw >= 60_000)
    ? raw
    : DEFAULT_COMPUTER_MAX_ACTIVE_MS;
}

/**
 * Uptime cap for providers that do not bill while running, so one abandoned background command
 * cannot hold a self-hosted computer and its memory for days. COMPUTER_MAX_ACTIVE_UNBILLED_MS
 * configures it; unset, 0, or an invalid value leaves it off.
 */
export function unbilledComputerMaxActiveMs(): number {
  const raw = Number(process.env.COMPUTER_MAX_ACTIVE_UNBILLED_MS?.trim() || 0);
  return Number.isFinite(raw) && raw >= 60_000 ? raw : 0;
}

export function computerIdleSleepEnabled(): boolean {
  return process.env.SANDBOX_IDLE_MS?.trim() !== "0";
}

export function scheduleComputerSleep(
  jobs: JobPublisher,
  computerId: string,
  notAfter?: Date,
  notBefore?: Date,
): void {
  if (!computerId || !computerIdleSleepEnabled()) return;
  const idleAt = Date.now() + sandboxIdleMs();
  const at = Math.max(
    notAfter ? Math.min(idleAt, notAfter.getTime()) : idleAt,
    notBefore?.getTime() ?? 0,
  );
  jobs.enqueue(computerSleepJob(computerId, new Date(at))).catch((error) => {
    // The idle sweeper queues a fresh check for every running computer.
    getLogger().warn("computer.sleep_schedule_failed", { "computer.id": computerId, error });
  });
}

/** When a rate-limited provider said it takes requests again. */
export function rateLimitEnds(error: unknown): Date | undefined {
  return error instanceof SandboxRateLimitError && error.retryAfterMs
    ? new Date(Date.now() + error.retryAfterMs)
    : undefined;
}

function activeLimitReached(
  sandbox: SandboxProvider,
  ref: ComputerRef,
  runningSince: Date | null | undefined,
): boolean {
  // Electron owns a native computer's lifetime.
  if (ref.kind === "desktop") return false;
  const limit =
    sandbox.billsWhileRunning?.(ref) === true
      ? computerMaxActiveMs()
      : unbilledComputerMaxActiveMs();
  return limit > 0 && runningSince != null && Date.now() - runningSince.getTime() >= limit;
}

export async function touchRunningComputer(
  deps: { sandbox: SandboxProvider; jobs: JobPublisher },
  computer: {
    id: string;
    homeKey: string;
    providerRef: string;
    kind: string;
    runningSince?: Date | null;
    controlHolder?: string;
    controlLeaseId?: string | null;
    controlLeaseExpiresAt?: Date | null;
  },
): Promise<void> {
  // A person's control keeps an idle computer up, but never past its lifetime limit.
  if (activeLimitReached(deps.sandbox, toComputerRef(computer), computer.runningSince)) {
    scheduleComputerSleep(deps.jobs, computer.id, new Date(Date.now()));
    return;
  }
  scheduleComputerSleep(deps.jobs, computer.id);
  await deps.sandbox.keepAlive?.(toComputerRef(computer));
}

export async function sleepComputerIfIdle(
  deps: {
    prisma: PrismaClient;
    sandbox: SandboxProvider;
    home: AgentHomeStore;
    jobs: JobPublisher;
    events: ThreadEvents;
  },
  computerId: string,
): Promise<void> {
  if (!computerIdleSleepEnabled()) return;
  let computer = await loadComputer(deps.prisma, computerId);
  if (!computer?.providerRef || !mayNeedSleep(computer)) return;
  // Native computers have no provisioned runtime to suspend; Electron owns their lifetime.
  if (computer.kind === "desktop") return;

  if (computer.controlBotId && computer.controlLeaseId && !hasActiveComputerControl(computer)) {
    try {
      await expireComputerControl(deps, computer.id, computer.controlLeaseId);
    } catch (error) {
      scheduleComputerSleep(deps.jobs, computer.id, undefined, rateLimitEnds(error));
      if (deferSleep(error, computer)) return;
      throw error;
    }
    computer = await loadComputer(deps.prisma, computerId);
    if (!computer?.providerRef || !mayNeedSleep(computer)) return;
  }
  if (computer.executionRunId) {
    // A legacy binding a pre-lease release left behind. Both suspension claims below
    // require it null, and a stranded one names a run nothing will clean up, so the
    // computer could never sleep. Runs that may still execute are left to their owner.
    await clearEndedExecutionRunBinding(deps.prisma, computer.id);
    computer = await loadComputer(deps.prisma, computerId);
    if (!computer?.providerRef || !mayNeedSleep(computer)) return;
  }

  const ref = toComputerRef(computer);
  const ctx: AdapterContext = {
    operationId: "computer.sleep",
    traceId: "computer.sleep",
    spaceId: computer.spaceId,
    userId: computer.userId,
    botId: computer.controlBotId ?? undefined,
    signal: new AbortController().signal,
  };
  // A status read that never answers counts as not seen rather than holding up the check.
  const statusSignal = AbortSignal.timeout(STATUS_CHECK_TIMEOUT_MS);
  const status = deps.sandbox.isRunning?.(ref, { ...ctx, signal: statusSignal });
  if (status && (await withAbort(status, statusSignal).catch(() => false))) {
    await recordComputerRunSeen(deps.prisma, computer);
  }
  // Past the lifetime limit only a run executing right now, or a coding agent CLI still writing
  // its session, holds the computer up. Waiting runs and other background work start it again
  // when they next need it. Otherwise a run waiting for takeover holds an unbilled computer for
  // TAKEOVER_IDLE_GRACE_MS. Once its organization has spent this period's allowance, nothing holds
  // the computer up. A person's control holds an idle computer up, but never past those limits;
  // stopping the computer then ends the control and any recording under it.
  const activeControl = hasActiveComputerControl(computer);
  const allowanceUsed = await sandboxAllowanceUsedUp(deps, computer);
  const limitReached =
    allowanceUsed || activeLimitReached(deps.sandbox, ref, computer.runningSince);
  const activeStatuses = limitReached
    ? EXECUTING_RUN_STATUSES
    : activeControl
      ? [...QUEUE_HOLDING_RUN_STATUSES]
      : QUEUE_HOLDING_RUN_STATUSES.filter((status) => status !== "waiting_takeover");
  const runHolds = () =>
    allowanceUsed
      ? Promise.resolve(null)
      : findActiveRun(deps.prisma, computerId, activeStatuses, limitReached);
  const backgroundHolds = async () =>
    !allowanceUsed &&
    ((!limitReached && (await hasActiveBackgroundWork(deps.sandbox, ref, ctx, computerId))) ||
      (await activeCodingAgent(deps.sandbox, ref, ctx, sandboxIdleMs())) !== undefined);
  const graceEndsAt = () =>
    allowanceUsed || activeControl || deps.sandbox.billsWhileRunning?.(ref) === true
      ? Promise.resolve(null)
      : takeoverGraceEndsAt(deps.prisma, computerId);
  const runHeld = Boolean(await runHolds());
  const takeoverHeldUntil = runHeld ? null : await graceEndsAt();
  if (!runHeld && !takeoverHeldUntil && (await suspendStoppedComputer(deps, computer, ref, ctx))) {
    return;
  }
  if (runHeld || takeoverHeldUntil || (await backgroundHolds())) {
    // Recheck when the takeover grace ends so the computer sleeps on time.
    scheduleComputerSleep(deps.jobs, computerId, takeoverHeldUntil ?? undefined);
    await sendHeldHeartbeat(deps.sandbox, ref);
    return;
  }

  const checkpointedAt = new Date();
  const recorded = await deps.prisma.computer.updateMany({
    where: {
      id: computerId,
      state: computer.state,
      maintenanceId: null,
      providerRef: computer.providerRef,
      updatedAt: computer.updatedAt,
      executionRunId: null,
      executionLeases: await noBlockingExecutionLease(deps.prisma, computerId, checkpointedAt),
    },
    data: { state: "suspending", updatedAt: checkpointedAt },
  });
  if (recorded.count !== 1) {
    scheduleComputerSleep(deps.jobs, computerId);
    return;
  }
  const suspensionClaim = {
    id: computerId,
    state: "suspending",
    providerRef: computer.providerRef,
    updatedAt: checkpointedAt,
  };

  // Read beside the save so the warning and the next run's note show what the last run left,
  // including when the save fails because build output outgrew it.
  const disk = measureComputerDisk(deps.sandbox, ref, ctx).then((measured) =>
    measured ? diskUpdate(measured) : {},
  );
  let damaged = false;
  try {
    const revision = await checkpointComputerWorkspace(
      deps.home,
      deps.sandbox,
      computer.homeKey,
      ref,
      ctx,
      { prisma: deps.prisma, computer },
    );
    const saved =
      revision === undefined
        ? { count: 1 }
        : await deps.prisma.computer.updateMany({
            where: suspensionClaim,
            data: {
              homeRevision: revision,
              homeRevisionAt: checkpointedAt,
              updatedAt: checkpointedAt,
            },
          });
    if (saved.count !== 1) {
      await deps.prisma.computer.updateMany({
        where: suspensionClaim,
        data: { ...(await disk), state: "running" },
      });
      scheduleComputerSleep(deps.jobs, computerId);
      return;
    }
  } catch (error) {
    if (isSandboxGoneError(error)) {
      // Nothing is left to checkpoint or stop. Retrying would fail the same way every idle
      // window, so clear the dead ref and let the next use boot from the last saved revision.
      const cleared = await deps.prisma.computer.updateMany({
        where: suspensionClaim,
        data: {
          state: "stopped",
          providerRef: null,
          runningSince: null,
          controlHolder: "none",
          controlLeaseId: null,
          controlUserId: null,
          controlLeaseExpiresAt: null,
          controlBotId: null,
        },
      });
      if (cleared.count === 1) {
        await recordComputerRunEnd(deps.prisma, computer, "gone");
        await endTeachingWithLease(deps, computer.spaceId, computer.controlLeaseId);
      }
      return;
    }
    if (isSandboxDamagedError(error)) {
      // Nothing on it can run, so no checkpoint can be taken, now or later. Stop it anyway with
      // its disk kept, rather than resume and fail on it every idle window; Recover rebuilds it.
      damaged = true;
      getLogger().warn("computer.checkpoint_skipped", {
        "computer.id": computerId,
        provider: computer.kind,
        reason: "damaged",
        error,
      });
    } else if (
      error instanceof WorkspaceTooLargeError &&
      (await providerKeepsHome(deps.sandbox, ref).catch(() => false))
    ) {
      // The provider's disk is the source of truth and survives the stop; this save is only a
      // backup, and the next start prefers the newer disk over the older backup.
      getLogger().warn("computer.checkpoint_skipped", {
        "computer.id": computerId,
        provider: computer.kind,
        reason: sleepDeferReason(error),
      });
    } else {
      await deps.prisma.computer.updateMany({
        where: suspensionClaim,
        data: { ...(await disk), state: "running" },
      });
      scheduleComputerSleep(deps.jobs, computerId, undefined, rateLimitEnds(error));
      if (deferSleep(error, computer)) {
        if (error instanceof WorkspaceTooLargeError)
          await announceUnsavedHome(deps, computer, error);
        return;
      }
      throw error;
    }
  }

  const [current, activeAfterCheckpoint, takeoverAfterCheckpoint, backgroundAfterCheckpoint] =
    await Promise.all([
      deps.prisma.computer.findUnique({
        where: { id: computerId },
        select: { state: true, providerRef: true, updatedAt: true },
      }),
      runHolds(),
      graceEndsAt(),
      backgroundHolds(),
    ]);
  if (activeAfterCheckpoint || takeoverAfterCheckpoint || backgroundAfterCheckpoint) {
    await deps.prisma.computer.updateMany({
      where: suspensionClaim,
      data: { ...(await disk), state: "running" },
    });
    scheduleComputerSleep(
      deps.jobs,
      computerId,
      activeAfterCheckpoint ? undefined : (takeoverAfterCheckpoint ?? undefined),
    );
    if (backgroundAfterCheckpoint) await sendHeldHeartbeat(deps.sandbox, ref);
    return;
  }
  if (
    current?.state !== "suspending" ||
    current.providerRef !== computer.providerRef ||
    current.updatedAt.getTime() !== checkpointedAt.getTime()
  ) {
    await deps.prisma.computer.updateMany({
      where: suspensionClaim,
      data: { ...(await disk), state: "running" },
    });
    scheduleComputerSleep(deps.jobs, computerId);
    return;
  }

  try {
    // Nothing on a damaged computer can be read, so a provider that cannot save it either stops
    // it anyway, keeping its last good copy, rather than leave it running.
    await deps.sandbox.stop(ref, ctx, damaged ? { discardUnsaved: true } : undefined);
  } catch (error) {
    await deps.prisma.computer.updateMany({
      where: suspensionClaim,
      data: { ...(await disk), state: "running" },
    });
    scheduleComputerSleep(deps.jobs, computerId, undefined, rateLimitEnds(error));
    if (deferSleep(error, computer)) {
      if (error instanceof WorkspaceTooLargeError) await announceUnsavedHome(deps, computer, error);
      return;
    }
    throw error;
  }
  const suspended = await deps.prisma.computer.updateMany({
    where: suspensionClaim,
    data: {
      ...(await disk),
      state: "suspended",
      runningSince: null,
      controlHolder: "none",
      controlLeaseId: null,
      controlUserId: null,
      controlLeaseExpiresAt: null,
      controlBotId: null,
    },
  });
  if (suspended.count !== 1) {
    // A Reset, a stale-claim recovery, or a deletion took the computer while it stopped. The
    // new owner restarts it from the saved revision; there is nothing left for this job to do.
    getLogger().warn("computer.suspend_superseded", { "computer.id": computerId });
    return;
  }
  const reason = allowanceUsed ? "allowance" : limitReached ? "active_limit" : "idle";
  await recordComputerRunEnd(deps.prisma, computer, reason);
  await endTeachingWithLease(deps, computer.spaceId, computer.controlLeaseId);
  getLogger().info("computer.suspended", {
    "computer.id": computerId,
    provider: computer.kind,
    reason,
    activeMs: computer.runningSince ? Date.now() - computer.runningSince.getTime() : undefined,
  });
  await announceSuspended(deps, computer);
  if (allowanceUsed)
    await postComputerNote(
      deps,
      computer,
      `computer-allowance:${computer.id}:${computer.runningSince?.toISOString() ?? ""}`,
      `${COMPUTER_ALLOWANCE_USED_ERROR} The computer was saved and stopped.`,
    );
}

/**
 * A computer its provider already stopped needs no checkpoint when nothing could have changed its
 * files since the last save: the provider keeps its disk, and the next start takes whichever of
 * the two is newer. Starting it only to save it again costs a start, and a start is where a
 * provider's restore can fail. Returns whether it was marked suspended.
 */
async function suspendStoppedComputer(
  deps: {
    prisma: PrismaClient;
    sandbox: SandboxProvider;
    events: ThreadEvents;
    jobs: JobPublisher;
  },
  computer: NonNullable<Awaited<ReturnType<typeof loadComputer>>>,
  ref: ComputerRef,
  ctx: AdapterContext,
): Promise<boolean> {
  const savedAt = computer.homeRevisionAt;
  if (!deps.sandbox.isStopped || !savedAt) return false;
  if (!(await deps.sandbox.isStopped(ref, ctx).catch(() => false))) return false;
  if (await changedSinceSave(deps.prisma, computer, savedAt)) return false;
  const suspended = await deps.prisma.computer.updateMany({
    where: {
      id: computer.id,
      state: computer.state,
      maintenanceId: null,
      providerRef: computer.providerRef,
      updatedAt: computer.updatedAt,
      executionRunId: null,
      executionLeases: await noBlockingExecutionLease(deps.prisma, computer.id, new Date()),
    },
    data: {
      state: "suspended",
      runningSince: null,
      controlHolder: "none",
      controlLeaseId: null,
      controlUserId: null,
      controlLeaseExpiresAt: null,
      controlBotId: null,
    },
  });
  if (suspended.count !== 1) return false;
  await recordComputerRunEnd(deps.prisma, computer, "gone");
  await endTeachingWithLease(deps, computer.spaceId, computer.controlLeaseId);
  getLogger().info("computer.suspended", {
    "computer.id": computer.id,
    provider: computer.kind,
    reason: "provider_stopped",
  });
  await announceSuspended(deps, computer);
  return true;
}

/**
 * Whether a run or a user in control may have changed the computer's files since `savedAt`.
 * Uploads and terminals need control; everything else happens in a run.
 */
async function changedSinceSave(
  prisma: PrismaClient,
  computer: { id: string; spaceId: string; controlHolder: string },
  savedAt: Date,
): Promise<boolean> {
  if (computer.controlHolder === "user") return true;
  const bots = await prisma.bot.findMany({
    where: { computerId: computer.id },
    select: { id: true },
  });
  const botIds = bots.map((bot) => bot.id);
  const [run, takeover] = await Promise.all([
    prisma.run.findFirst({
      where: { botId: { in: botIds }, updatedAt: { gt: savedAt } },
      select: { id: true },
    }),
    prisma.event.findFirst({
      where: {
        spaceId: computer.spaceId,
        createdAt: { gt: savedAt },
        type: "computer.takeover.granted",
        botId: { in: botIds },
      },
      select: { id: true },
    }),
  ]);
  return Boolean(run || takeover);
}

async function announceSuspended(
  deps: { prisma: PrismaClient; events: ThreadEvents },
  computer: { id: string; spaceId: string },
): Promise<void> {
  const bots = await deps.prisma.bot.findMany({
    where: { computerId: computer.id },
    select: { id: true, thread: { select: { id: true } } },
  });
  for (const bot of bots) {
    if (!bot.thread) continue;
    await deps.events.append({
      spaceId: computer.spaceId,
      threadId: bot.thread.id,
      botId: bot.id,
      type: "computer.status",
      payload: { status: "suspended" },
    });
  }
}

/** System notes reach users and the bot through the existing thread history. */
async function announceUnsavedHome(
  deps: { prisma: PrismaClient; events: ThreadEvents },
  computer: { id: string; spaceId: string; homeRevisionAt: Date | null; runningSince: Date | null },
  error: WorkspaceTooLargeError,
): Promise<void> {
  // A successful save or a new runtime starts a new episode. The unique message nonce also
  // deduplicates retries across workers; the message and its event commit together.
  await postComputerNote(
    deps,
    computer,
    `computer-unsaved:${computer.id}:${computer.runningSince?.toISOString() ?? ""}:${computer.homeRevisionAt?.toISOString() ?? ""}:${error.limit}`,
    `${error.message}. It will keep running unsaved. Remove large files or files you no longer need so it can be saved.`,
  );
}

/** Posts a system note once per `clientNonce` to the thread of every bot on the computer. */
async function postComputerNote(
  deps: { prisma: PrismaClient; events: ThreadEvents },
  computer: { id: string; spaceId: string },
  clientNonce: string,
  text: string,
): Promise<void> {
  const blocks = [{ kind: "meta" as const, text }];
  const bots = await deps.prisma.bot.findMany({
    where: { computerId: computer.id },
    select: { id: true, thread: { select: { id: true } } },
  });
  for (const bot of bots) {
    if (!bot.thread) continue;
    const threadId = bot.thread.id;
    try {
      const seq = await deps.prisma.$transaction(async (tx) => {
        const existing = await tx.message.findUnique({
          where: { threadId_clientNonce: { threadId, clientNonce } },
          select: { id: true },
        });
        if (existing) return undefined;
        const message = await createThreadMessageInTransaction(tx, {
          threadId,
          botId: bot.id,
          role: "system",
          blocks,
          clientNonce,
        });
        const event = await appendEventInTransaction(tx, {
          spaceId: computer.spaceId,
          threadId,
          botId: bot.id,
          type: "thread.message.created",
          payload: { messageId: message.id, role: "system", blocks },
        });
        return event.seq;
      }, THREAD_LOCK_TRANSACTION_OPTIONS);
      if (seq !== undefined) await deps.events.notify(threadId, seq).catch(() => undefined);
    } catch (cause) {
      // A competing worker already wrote the same nonce. Other failures are retried next tick.
      if (!isUniqueViolation(cause)) {
        getLogger().error("computer.notice_failed", cause);
      }
    }
  }
}

/** Whether the provider running `computer` keeps its disk when it stops. */
export function providerKeepsHome(
  sandbox: SandboxProvider,
  computer: ComputerRef,
): Promise<boolean> {
  return (
    sandbox.keepsHome?.(computer) ?? Promise.resolve(sandbox.describe().capabilities.persistentHome)
  );
}

/**
 * Keeps a held computer up. The next idle check is already scheduled: it sends the heartbeat a
 * provider outage missed, and it or the holding run recovers a gone sandbox.
 */
async function sendHeldHeartbeat(sandbox: SandboxProvider, ref: ComputerRef): Promise<void> {
  try {
    await sandbox.keepAlive?.(ref);
  } catch (error) {
    if (!isSandboxGoneError(error) && !isSandboxProviderOutage(error)) throw error;
  }
}

/** A running computer, or one whose suspend claim was abandoned while it was still up. */
function mayNeedSleep(computer: { state: string; updatedAt: Date }): boolean {
  return (
    computer.state === "running" ||
    (computer.state === "suspending" &&
      Date.now() - computer.updatedAt.getTime() >= ABANDONED_SUSPEND_CLAIM_MS)
  );
}

/**
 * A provider that is rate limiting, too busy to answer, or that can only bring the sandbox back
 * from its own snapshot cannot be checkpointed or stopped now, and a workspace over the save
 * limits cannot be saved where the provider keeps no disk, so stopping it would lose its files.
 * The caller has already scheduled the next idle check, so the job succeeds instead of spending its retries on the same answer.
 */
function deferSleep(error: unknown, computer: { id: string; kind: string }): boolean {
  const reason = sleepDeferReason(error);
  if (!reason) return false;
  getLogger().warn("computer.sleep_deferred", {
    "computer.id": computer.id,
    provider: computer.kind,
    reason,
    error,
  });
  return true;
}

/** Why a save or stop that failed with `error` left the computer up, to be tried again later. */
export function sleepDeferReason(error: unknown): string | undefined {
  return error instanceof SandboxRateLimitError
    ? "rate_limited"
    : error instanceof SandboxUnresponsiveError
      ? "unresponsive"
      : error instanceof SandboxUnavailableError
        ? "unavailable"
        : error instanceof WorkspaceTooLargeError
          ? error.limit === "bytes"
            ? "too_large"
            : "too_many_files"
          : error instanceof HomeSaveConflictError
            ? "saved_elsewhere"
            : error instanceof BrowserStillRunningError
              ? "browser_running"
              : undefined;
}

/**
 * Gives every computer that may still be up on its provider a pending idle check. Each sleep job
 * schedules the next one, but a job that exhausted its retries, or died with its worker, leaves
 * its computer running and billing until the next use. Runs about every ten minutes on the
 * reconciler's tick and leaves a check that is already pending alone.
 */
export function createIdleComputerSweeper(
  deps: { prisma: PrismaClient; jobs: JobPublisher },
  options: { intervalMs?: number } = {},
): () => Promise<void> {
  const intervalMs = options.intervalMs ?? IDLE_SWEEP_INTERVAL_MS;
  let lastRun: number | undefined;
  return async () => {
    const now = Date.now();
    if (!computerIdleSleepEnabled()) return;
    if (lastRun !== undefined && now - lastRun < intervalMs) return;
    lastRun = now;
    const abandonedBefore = new Date(now - ABANDONED_SUSPEND_CLAIM_MS);
    const computers = await deps.prisma.computer.findMany({
      where: {
        providerRef: { not: null },
        kind: { not: "desktop" },
        OR: [{ state: "running" }, { state: "suspending", updatedAt: { lte: abandonedBefore } }],
      },
      select: { id: true },
    });
    await Promise.all(
      computers.map((computer) =>
        deps.jobs.enqueue({
          ...computerSleepJob(computer.id, new Date(now + sandboxIdleMs())),
          keepExisting: true,
          // A job locked this long belongs to a worker that died with the claim.
          replaceLockedBefore: abandonedBefore,
        }),
      ),
    );
  };
}

function loadComputer(prisma: PrismaClient, computerId: string) {
  return prisma.computer.findUnique({
    where: { id: computerId },
    select: {
      id: true,
      homeKey: true,
      providerRef: true,
      kind: true,
      scope: true,
      state: true,
      spaceId: true,
      userId: true,
      controlHolder: true,
      controlLeaseId: true,
      controlLeaseExpiresAt: true,
      controlBotId: true,
      executionRunId: true,
      runningSince: true,
      homeRevisionAt: true,
      updatedAt: true,
    },
  });
}

function findActiveRun(
  prisma: PrismaClient,
  computerId: string,
  statuses: readonly string[],
  liveLeaseOnly = false,
) {
  return prisma.run.findFirst({
    where: {
      bot: { computerId },
      ...COMPUTER_USING_RUNS,
      status: { in: statuses as (typeof QUEUE_HOLDING_RUN_STATUSES)[number][] },
      ...(liveLeaseOnly ? { leaseExpiresAt: { gt: new Date(Date.now()) } } : {}),
    },
    select: { id: true },
  });
}

/**
 * A live execution lease means a run is using the computer, except the one a run waiting for
 * takeover keeps for up to a day so no other bot takes its screen. Once the idle check has
 * found that the waiting run no longer holds the computer, that lease must not hold it either.
 * The fence lets a run that resumes in the meantime block the claim again.
 */
async function noBlockingExecutionLease(prisma: PrismaClient, computerId: string, now: Date) {
  const leases = await prisma.computerExecutionLease.findMany({
    where: { computerId, expiresAt: { gt: now } },
    select: { runId: true, fence: true },
  });
  const waiting =
    leases.length === 0
      ? []
      : await prisma.run.findMany({
          where: { id: { in: leases.map((lease) => lease.runId) }, status: "waiting_takeover" },
          select: { id: true },
        });
  const heldForTakeover = leases.filter((lease) => waiting.some((run) => run.id === lease.runId));
  return {
    none: {
      expiresAt: { gt: now },
      ...(heldForTakeover.length > 0 ? { NOT: heldForTakeover } : {}),
    },
  };
}

/** When the newest takeover request of a run still waiting on this computer stops holding it. */
async function takeoverGraceEndsAt(prisma: PrismaClient, computerId: string): Promise<Date | null> {
  const waiting = await prisma.run.findMany({
    where: { bot: { computerId }, status: "waiting_takeover" },
    select: { id: true },
  });
  if (waiting.length === 0) return null;
  const requested = await prisma.event.findFirst({
    where: {
      runId: { in: waiting.map((run) => run.id) },
      type: "computer.takeover.requested",
      createdAt: { gt: new Date(Date.now() - TAKEOVER_IDLE_GRACE_MS) },
    },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  return requested ? new Date(requested.createdAt.getTime() + TAKEOVER_IDLE_GRACE_MS) : null;
}

async function hasActiveBackgroundWork(
  sandbox: SandboxProvider,
  computer: ReturnType<typeof toComputerRef>,
  context: AdapterContext,
  computerId: string,
): Promise<boolean> {
  if (sandbox.inspectBackgroundWork) {
    try {
      return (await sandbox.inspectBackgroundWork(computer, computerId, context)) !== "idle";
    } catch (error) {
      // A gone or damaged sandbox runs nothing; the checkpoint below then stops the computer.
      return !isSandboxGoneError(error) && !isSandboxDamagedError(error);
    }
  }
  try {
    return (await probeBackgroundWork(sandbox, computer, computerId, context)) !== "idle";
  } catch (error) {
    return !isSandboxGoneError(error) && !isSandboxDamagedError(error);
  }
}

/** The Linux marker probe, for providers without their own inspectBackgroundWork. */
export async function probeBackgroundWork(
  sandbox: Pick<SandboxProvider, "execute">,
  computer: ComputerRef,
  computerId: string,
  context: AdapterContext,
): Promise<"active" | "idle"> {
  let exitCode: number | undefined;
  let stdout = "";
  for await (const event of sandbox.execute(
    computer,
    {
      argv: ["bash", "-c", BACKGROUND_WORK_PROBE, "rakazo-background-probe", computerId],
      timeoutMs: 10_000,
    },
    context,
  )) {
    if (event.type === "stdout") stdout += event.data;
    if (event.type === "exit") exitCode = event.code;
  }
  // Only the probe's explicit idle result permits suspension; unsupported or failed probes retry.
  return exitCode === 1 && stdout.trim() === BACKGROUND_WORK_IDLE_SENTINEL ? "idle" : "active";
}
