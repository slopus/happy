import { setTimeout as sleep } from "node:timers/promises";
import type {
  AdapterContext,
  ArtifactStore,
  BackgroundJobAttempt,
  JobPublisher,
  MessagingOutboundAttachment,
  MessagingOutboundStatus,
  MessagingSurface,
} from "@rakazo/adapter-kit";
import {
  messagingReplyJobKey,
  messagingSendJob,
  messagingSendJobKey,
  RetryJobLaterError,
  runContinueJob,
} from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import {
  botMessageHopExhausted,
  botMessageMaxHops,
  chatAppAskText,
  chatAppTakeoverText,
  nextBotMessageHop,
  pageLinksAsTitles,
  teamChatResponseText,
} from "@rakazo/core";
import type { DatabaseOutage, Prisma, PrismaClient, ThreadEvents } from "@rakazo/db";
import {
  accountDeactivated,
  appendEventInTransaction,
  CrossSpaceCommunicationBlockedError,
  createThreadMessageInTransaction,
  crossSpaceCommunicationAllowed,
  databaseCapacityBackoffMs,
  databaseOutage,
  isDatabaseUnavailable,
  runAsSystem,
  SpaceDeletionInProgressError,
  THREAD_LOCK_TRANSACTION_OPTIONS,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { MessagingSendError } from "./chat-sdk-surface.js";
import { splitOutboundBody } from "./messaging-platforms.js";
import { resolveMessagingThreadId } from "./team-chat-messaging.js";
import { isUserProgressClientNonce } from "./user-progress.js";

/**
 * Margin under vendor consecutive-outbound caps (sendblue enforces one hard):
 * past this many DMs without a reply from the owner, rows stay pending until
 * the next inbound resets the counter.
 */
export const MESSAGING_DM_OUTBOUND_CAP = 140;

/**
 * How long one send may take, file upload included. Providers that take the abort signal stop
 * there; the vendor clients Rakazo configures (Slack, Sendblue) already give up well before it.
 */
export const MESSAGING_SEND_TIMEOUT_MS = 60_000;

/**
 * When a claimed send counts as dead and its backup job may send the message again: strictly
 * longer than the timeout, and the same window the previous release gives its own claims. The
 * sender waits for a provider call it cannot abort until just before it, and records a call that
 * lands later still against its own claim, so only a crash, or a call that lands after its
 * backup job took over, can lead to a second post.
 */
export const MESSAGING_SEND_STALE_MS = 2 * MESSAGING_SEND_TIMEOUT_MS;
const STALE_MARGIN_MS = 10_000;

/** When a recorded message's backup job is due: once its send's claim would be stale. */
export const MESSAGING_SEND_BACKUP_MS = MESSAGING_SEND_STALE_MS + 30_000;

/**
 * A claimed row: marked sent before its handle is known, as the previous release marks its own,
 * so either release sees the other's sends in flight. A finished send always gets a handle (an
 * empty one when the provider gives none). This release also sets `claimedAt` until the send
 * settles, which tells its claims apart from the previous release's.
 */
const IN_FLIGHT = { status: "sent", providerHandle: null } as const;

/** How soon a message held behind the sendblue cap checks again, should no reply arrive. */
const DM_CAP_RECHECK_MS = 15 * 60_000;

/** A message still unsent this long after its last change has lost its backup job. */
const STALLED_OUTBOUND_MS = 5 * 60_000;
const SWEEP_BATCH = 100;

/** Statuses of a message waiting for a send. */
const WAITING = ["pending", "retry"];
const TERMINAL_RUN = ["completed", "failed", "cancelled"];

/**
 * The send order every sender agrees on: rows carry explicit per-part createdAt values, and id
 * breaks the ties that remain so two senders never order one conversation's rows differently.
 */
const SEND_ORDER: Prisma.MessagingOutboundOrderByWithRelationInput[] = [
  { createdAt: "asc" },
  { id: "asc" },
];

/** One conversation's queue: a person's direct messages, or one provider thread. */
export type OutboundLane = { identityId: string } | { identityId: null; threadId: string };

export type OutboundRow = Omit<Prisma.MessagingOutboundCreateManyInput, "createdAt">;

type LaneRow = {
  id: string;
  idempotencyKey: string;
  kind: string;
  identityId: string | null;
  threadId: string | null;
  body: string;
  status: string;
  providerHandle: string | null;
  sourceMessageId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

const LANE_ROW = {
  id: true,
  idempotencyKey: true,
  kind: true,
  identityId: true,
  threadId: true,
  body: true,
  status: true,
  providerHandle: true,
  sourceMessageId: true,
  createdAt: true,
  updatedAt: true,
} as const;

export interface MessagingDeliveryDeps {
  prisma: PrismaClient;
  messaging: MessagingSurface;
  events: Pick<ThreadEvents, "sendUserMessage" | "notify">;
  jobs: Pick<JobPublisher, "enqueue" | "enqueueIn" | "cancel" | "cancelIn">;
  artifacts: Pick<ArtifactStore, "get">;
  /** The process's database outage streak; defaults to the shared one. */
  outage?: DatabaseOutage;
}

type IdentityRow = {
  id: string;
  provider: string;
  address: string;
  dmThreadId: string | null;
  outboundSinceInbound: number;
  spaceId: string;
};

/** What became of one claimed row's send. */
type SendOutcome =
  | { kind: "sent"; handle: string }
  | { kind: "failed" }
  /** Not sent and not failed: the conversation waits (the sendblue cap). */
  | { kind: "held" }
  /** The provider call is still running past its time; the backup job takes the row over. */
  | { kind: "unsettled" }
  | { kind: "error"; error: unknown; attachmentName: string | null };

/**
 * Every outgoing chat message, for 1:1 chats, groups and team chat alike: recorded with a
 * backup job in one transaction, sent straight away by the process that recorded it, and sent
 * by the backup job only when that process could not. A clean failure moves the job up to now,
 * or to the provider's retry-after, and the job's own retries carry on from there.
 */
export class MessagingDelivery {
  private readonly outage: DatabaseOutage;

  constructor(private readonly deps: MessagingDeliveryDeps) {
    this.outage = deps.outage ?? databaseOutage;
  }

  /**
   * Records rows for one conversation in the caller's transaction. Under the conversation's
   * lock every writer takes positions after the newest committed row, so two writers' rows
   * never interleave. `replace` restarts rows a previous cycle left under the same keys.
   * Returns the ids of the rows it added; `send` the conversation once the transaction commits.
   */
  async recordIn(
    tx: Prisma.TransactionClient,
    lane: OutboundLane,
    rows: OutboundRow[],
    options: { replace?: boolean } = {},
  ): Promise<string[]> {
    if (rows.length === 0) return [];
    await lockLane(tx, lane);
    if (options.replace) {
      await tx.messagingOutbound.deleteMany({
        where: { idempotencyKey: { in: rows.map((row) => row.idempotencyKey) } },
      });
    }
    const latest = await tx.messagingOutbound.aggregate({
      _max: { createdAt: true },
      where: laneWhere(lane),
    });
    const base = Math.max(Date.now(), (latest._max.createdAt?.getTime() ?? 0) + 1);
    const created = await tx.messagingOutbound.createManyAndReturn({
      data: rows.map((row, index) => ({ ...row, createdAt: new Date(base + index) })),
      skipDuplicates: true,
      select: { id: true },
    });
    const backupAt = new Date(Date.now() + MESSAGING_SEND_BACKUP_MS);
    for (const { id } of created) {
      await this.deps.jobs.enqueueIn(tx, messagingSendJob(id, backupAt));
    }
    return created.map(({ id }) => id);
  }

  /** Records rows in a transaction of their own and sends them. */
  async record(
    lane: OutboundLane,
    rows: OutboundRow[],
    options: { replace?: boolean } = {},
  ): Promise<void> {
    if (rows.length === 0) return;
    await this.deps.prisma.$transaction((tx) => this.recordIn(tx, lane, rows, options));
    await this.send([lane]);
  }

  /**
   * Sends what the conversations have queued, in order, from this process. Never throws and never
   * retries here: what this process cannot send stays with its backup job, and a database outage
   * is logged once for the process, not once per send.
   */
  async send(lanes: OutboundLane[]): Promise<void> {
    const unique = new Map(lanes.map((lane) => [laneKey(lane), lane]));
    await Promise.all(
      [...unique.values()].map((lane) =>
        runAsSystem("send recorded chat messages", () => this.drainLane(lane)).then(
          () => this.outage.succeeded(),
          (error) => this.reportFailure("messaging outbound send error", error),
        ),
      ),
    );
  }

  /** Logs a failure of the direct path, or counts it in the outage when the database is down. */
  reportFailure(message: string, error: unknown): void {
    if (!this.outage.failed(error, "messaging delivery")) getLogger().error(message, error);
  }

  /**
   * The backup job for one outgoing message. It runs only when the send that recorded the
   * message did not finish in time, failed cleanly, or found the conversation busy.
   */
  async sendJob(outboundId: string, attempt?: BackgroundJobAttempt): Promise<void> {
    await runAsSystem("send a recorded chat message", async () => {
      const row = await this.deps.prisma.messagingOutbound.findUnique({
        where: { id: outboundId },
        select: LANE_ROW,
      });
      if (!row) return;
      const inFlight = row.status === "sent" && row.providerHandle === null;
      if (!WAITING.includes(row.status) && !inFlight) return;
      const lane = laneOf(row);
      if (!lane) {
        await this.deps.prisma.messagingOutbound.updateMany({
          where: { id: row.id, status: { in: WAITING } },
          data: { status: "failed" },
        });
        return;
      }
      await this.drainLane(lane, { rowId: row.id, attempt });
    });
  }

  /**
   * Records and sends what a run said where its turn came from: a 1:1 chat or group, the
   * team-chat thread that started it, or the thread a delegation chain started in. `progress`
   * sends a running 1:1 run's interim messages; everything else waits for the run to pause or end.
   */
  async deliverRun(runId: string, options: { progress?: boolean } = {}): Promise<void> {
    await runAsSystem("deliver what a run said", async () => {
      const run = await this.deps.prisma.run.findUnique({
        where: { id: runId },
        include: {
          sourceMessage: true,
          bot: { select: { name: true } },
          thread: { select: { externalConversation: { select: { botId: true } } } },
          externalMessage: { include: { externalConversation: true } },
        },
      });
      if (!run) return;
      const terminal = TERMINAL_RUN.includes(run.status);
      const lanes: OutboundLane[] = [];
      if (run.externalMessage) {
        // Team chat answers once, when the run ends; nothing of it goes to a linked 1:1 chat.
        if (!options.progress && terminal) {
          const lane = await this.recordTeamChatReply({
            ...run,
            externalMessage: run.externalMessage,
          });
          if (lane) lanes.push(lane);
        }
      } else if (run.trigger === "messaging") {
        const channelBlock = ((run.sourceMessage?.blocks ?? []) as MessageBlock[]).find(
          (block): block is Extract<MessageBlock, { kind: "channel_message" }> =>
            block.kind === "channel_message",
        );
        if (channelBlock) {
          if (!options.progress) {
            const lane = await this.recordChannelRun(run, channelBlock);
            if (lane) lanes.push(lane);
          }
        } else {
          const lane = await this.recordDirectRun(run, options.progress ?? false);
          if (lane) lanes.push(lane);
        }
      } else if (run.trigger === "bot_message" && !options.progress) {
        // A delegated run answers its owner's 1:1 chat, and once it ends, the team-chat thread
        // the delegation started in. Only a run in that conversation's own thread, by its bot,
        // runs with the shared chat's privacy: a continuation in the bot's private thread may
        // have read its owner's memory and stays in the app.
        const direct = await this.recordDirectRun(run, false);
        if (direct) lanes.push(direct);
        if (
          (run.status === "completed" || run.status === "failed") &&
          run.thread.externalConversation?.botId === run.botId
        ) {
          const delegated = await this.recordDelegatedReply(run);
          if (delegated) lanes.push(delegated);
        }
      }
      if (!options.progress) {
        if (run.trigger === "messaging") {
          await this.deps.prisma.run.updateMany({
            where: { id: runId },
            data: { messagingMirroredAt: new Date() },
          });
        }
        // Recorded: the rows carry their own backups now. Only chat runs get a reply job.
        if (terminal && (run.trigger === "messaging" || run.trigger === "bot_message"))
          await this.deps.jobs.cancel(messagingReplyJobKey(runId));
      }
      await this.send(lanes);
    });
  }

  /**
   * The previous release's whole-outbox drain: sends every conversation that has unsent rows,
   * so its queued jobs finish under this release.
   */
  async drainAll(): Promise<void> {
    const rows = await runAsSystem("find conversations with unsent chat messages", () =>
      this.deps.prisma.messagingOutbound.findMany({
        where: { status: { in: WAITING } },
        distinct: ["identityId", "threadId"],
        select: { identityId: true, threadId: true },
      }),
    );
    await this.send(rows.flatMap((row) => laneOf(row) ?? []));
  }

  /**
   * Safety sweep, one page per call: a message waiting long after its last change whose backup
   * job is gone, or held by a worker that died, gets a fresh one. A job still waiting out a retry
   * or a busy conversation is left alone. Rows recorded by the previous release have no job. So
   * does a claim of this release whose sender died and whose job gave up, such as on a database
   * outage during its last try. The previous release's stale claims are never sent again: many of
   * them went out.
   */
  async sweepStalled(now = new Date()): Promise<void> {
    const before = new Date(now.getTime() - STALLED_OUTBOUND_MS);
    const cursor = this.sweepCursor;
    const stalled = await this.deps.prisma.messagingOutbound.findMany({
      where: {
        OR: [{ status: { in: WAITING } }, { ...IN_FLIGHT, claimedAt: { not: null } }],
        updatedAt: { lt: before },
        ...(cursor
          ? {
              AND: [
                {
                  OR: [
                    { updatedAt: { gt: cursor.at } },
                    { updatedAt: cursor.at, id: { gt: cursor.id } },
                  ],
                },
              ],
            }
          : {}),
      },
      orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
      take: SWEEP_BATCH,
      select: { id: true, updatedAt: true },
    });
    for (const { id } of stalled) {
      await this.deps.jobs.enqueue({
        ...messagingSendJob(id, now),
        keepExisting: true,
        replaceLockedBefore: before,
      });
    }
    const last = stalled.at(-1);
    this.sweepCursor =
      stalled.length === SWEEP_BATCH && last ? { at: last.updatedAt, id: last.id } : undefined;
  }

  private sweepCursor: { at: Date; id: string } | undefined;

  /** Sends one conversation's rows in order until it is empty or has to wait. */
  private async drainLane(
    lane: OutboundLane,
    job?: { rowId: string; attempt?: BackgroundJobAttempt },
  ): Promise<void> {
    for (;;) {
      const claim = await this.claimHead(lane, job?.rowId);
      if (claim.kind === "empty") return;
      if (claim.kind === "blocked") {
        // Someone else owns the head; check back once they had their time.
        if (job) await this.deps.jobs.enqueue(messagingSendJob(job.rowId, claim.retryAt));
        return;
      }
      const { row, claimedAt } = claim;
      // The claim's last moment: past it, the backup job may send the row again.
      const deadline = claimedAt.getTime() + MESSAGING_SEND_STALE_MS - STALE_MARGIN_MS;
      const own = job?.rowId === row.id;
      const outcome = await this.sendRow(row, deadline, (late) =>
        // A call that lands after the deadline is still recorded against its own claim, and the
        // conversation carries on, so the backup job sends nothing more.
        this.settleLate(row, claimedAt, late, lane),
      );
      if (outcome.kind === "unsettled") {
        getLogger().warn("messaging send still running past its time; its backup job takes over");
        if (own)
          await this.deps.jobs.enqueue(
            messagingSendJob(row.id, new Date(deadline + STALE_MARGIN_MS + 5_000)),
          );
        return;
      }
      if (outcome.kind === "held") {
        await this.deps.prisma.messagingOutbound.updateMany({
          where: { id: row.id, ...IN_FLIGHT, updatedAt: claimedAt },
          data: { status: "pending", claimedAt: null },
        });
        if (own) {
          await this.deps.jobs.enqueue(
            messagingSendJob(row.id, new Date(Date.now() + DM_CAP_RECHECK_MS)),
          );
        }
        return;
      }
      if (outcome.kind === "error") {
        const failure = outcome.error instanceof MessagingSendError ? outcome.error : null;
        const attempt = own ? job?.attempt : undefined;
        const last = attempt !== undefined && attempt.number >= attempt.max;
        if (!failure?.permanent && !last) {
          await this.retryLater(row, claimedAt, failure?.retryAfterMs ?? null, own, outcome.error);
          return;
        }
        getLogger().warn("messaging outbound failed", {
          reason: outcome.error instanceof Error ? outcome.error.message : String(outcome.error),
        });
        await this.settle(row, claimedAt, { kind: "failed" }, outcome.attachmentName);
        continue;
      }
      await this.settle(row, claimedAt, outcome);
    }
  }

  /**
   * Records how a claimed send ended, retrying the write while the claim is still this sender's:
   * a message that went out must not be left claimed for its backup job to send again. Returns
   * false when the claim was lost, to a backup job that took over a stale one.
   */
  private async settle(
    row: LaneRow,
    claimedAt: Date,
    outcome: { kind: "sent"; handle: string } | { kind: "failed" },
    attachmentName: string | null = null,
  ): Promise<boolean> {
    const giveUpAt = claimedAt.getTime() + MESSAGING_SEND_STALE_MS + 60_000;
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.finish(row, claimedAt, outcome, attachmentName);
      } catch (error) {
        const wait = databaseCapacityBackoffMs(attempt);
        if (Date.now() + wait >= giveUpAt) throw error;
        await sleep(wait);
      }
    }
  }

  /** A send that outlived its deadline and then went out: record it, and carry on. */
  private async settleLate(row: LaneRow, claimedAt: Date, late: SendOutcome, lane: OutboundLane) {
    if (late.kind !== "sent") return;
    try {
      if (await this.settle(row, claimedAt, late)) await this.send([lane]);
    } catch (error) {
      this.reportFailure("messaging late send bookkeeping error", error);
    }
  }

  /**
   * Claims the conversation's first waiting row for this process, under the conversation's lock.
   * Any send in flight holds the conversation, this release's or the previous one's. Anyone may
   * take a pending head; a head waiting on a retry belongs to its backup job, and so does a send
   * whose claim went stale. Such a send of this release holds the conversation until its backup
   * job settles it, so nothing behind it goes first; the previous release's is done once stale.
   */
  private async claimHead(
    lane: OutboundLane,
    ownRowId: string | undefined,
  ): Promise<
    | { kind: "empty" }
    | { kind: "blocked"; retryAt: Date }
    | { kind: "claimed"; row: LaneRow; claimedAt: Date }
  > {
    return this.deps.prisma.$transaction(async (tx) => {
      await lockLane(tx, lane);
      const now = Date.now();
      const staleBefore = new Date(now - MESSAGING_SEND_STALE_MS);
      const inFlight = await tx.messagingOutbound.findFirst({
        where: {
          ...laneWhere(lane),
          ...IN_FLIGHT,
          OR: [
            { updatedAt: { gt: staleBefore } },
            { claimedAt: { not: null }, ...(ownRowId ? { NOT: { id: ownRowId } } : {}) },
          ],
        },
        orderBy: { updatedAt: "desc" },
        select: { updatedAt: true },
      });
      if (inFlight) {
        const staleAt = inFlight.updatedAt.getTime() + MESSAGING_SEND_STALE_MS;
        // A stale one's backup job sends the rows behind it once it settles it.
        const retryAt = staleAt > now ? staleAt + 5_000 : now + MESSAGING_SEND_BACKUP_MS;
        return { kind: "blocked" as const, retryAt: new Date(retryAt) };
      }
      const head = await tx.messagingOutbound.findFirst({
        where: {
          ...laneWhere(lane),
          OR: [{ status: { in: WAITING } }, ...(ownRowId ? [{ id: ownRowId, ...IN_FLIGHT }] : [])],
        },
        orderBy: SEND_ORDER,
        select: LANE_ROW,
      });
      if (!head) return { kind: "empty" as const };
      const mine = head.id === ownRowId;
      if (head.status !== "pending" && !mine)
        return { kind: "blocked" as const, retryAt: new Date(now + MESSAGING_SEND_BACKUP_MS) };
      // Compare-and-set on what was read here, under the lock the previous release takes too, so
      // its drain and this one can never both claim the row. The claim's time identifies it.
      const claimedAt = new Date(now);
      const claimed = await tx.messagingOutbound.updateMany({
        where: {
          id: head.id,
          status: head.status,
          providerHandle: null,
          updatedAt: head.updatedAt,
        },
        data: { status: "sent", updatedAt: claimedAt, claimedAt },
      });
      if (claimed.count !== 1) return { kind: "blocked" as const, retryAt: new Date(now + 5_000) };
      return { kind: "claimed" as const, row: head, claimedAt };
    });
  }

  /**
   * Settles a row that went out, or that will never go out, and removes its backup job, if the
   * claim is still this sender's. Returns false when another sender took it over.
   */
  private async finish(
    row: LaneRow,
    claimedAt: Date,
    outcome: { kind: "sent"; handle: string } | { kind: "failed" },
    attachmentName: string | null = null,
  ): Promise<boolean> {
    return this.deps.prisma.$transaction(async (tx) => {
      const settled = await tx.messagingOutbound.updateMany({
        where: { id: row.id, ...IN_FLIGHT, updatedAt: claimedAt },
        data:
          outcome.kind === "sent"
            ? { providerHandle: outcome.handle ?? "", claimedAt: null }
            : { status: "failed", claimedAt: null },
      });
      if (settled.count !== 1) return false;
      await this.deps.jobs.cancelIn(tx, messagingSendJobKey(row.id));
      if (outcome.kind === "failed" && attachmentName) {
        // The reply's text went out on its own rows; say the file did not follow instead of
        // dropping it silently. Keyed so it is recorded once, and given the file's place so the
        // rows queued behind the file still wait for it.
        const notice = await tx.messagingOutbound.createManyAndReturn({
          data: [
            {
              idempotencyKey: `${row.idempotencyKey}:notice`,
              kind: row.kind,
              identityId: row.identityId,
              threadId: row.threadId,
              body: `Could not send "${attachmentName}".`,
              sourceMessageId: row.sourceMessageId,
              createdAt: row.createdAt,
            },
          ],
          skipDuplicates: true,
          select: { id: true },
        });
        for (const { id } of notice) {
          await this.deps.jobs.enqueueIn(
            tx,
            messagingSendJob(id, new Date(Date.now() + MESSAGING_SEND_BACKUP_MS)),
          );
        }
      }
      return true;
    });
  }

  /**
   * A clean, retryable failure. The row waits for its backup job, which runs now or at the
   * provider's retry-after. Inside that job the error goes back to the queue, so its attempt
   * count and backoff apply.
   */
  private async retryLater(
    row: LaneRow,
    claimedAt: Date,
    retryAfterMs: number | null,
    own: boolean,
    error: unknown,
  ): Promise<void> {
    const claim = { id: row.id, ...IN_FLIGHT, updatedAt: claimedAt };
    if (own) {
      await this.deps.prisma.messagingOutbound.updateMany({
        where: claim,
        data: { status: "retry", claimedAt: null },
      });
      if (retryAfterMs) throw new RetryJobLaterError(retryAfterMs, { cause: error });
      throw error;
    }
    await this.deps.prisma.$transaction(async (tx) => {
      const released = await tx.messagingOutbound.updateMany({
        where: claim,
        data: { status: "retry", claimedAt: null },
      });
      if (released.count !== 1) return;
      await this.deps.jobs.enqueueIn(
        tx,
        messagingSendJob(row.id, new Date(Date.now() + (retryAfterMs ?? 0))),
      );
    });
  }

  /**
   * Sends one claimed row. The provider gets the send timeout as its abort signal; a call that
   * cannot be aborted is waited for until the claim's deadline, and handed to `late` if it
   * settles after that, rather than abandoned.
   */
  private async sendRow(
    row: LaneRow,
    deadline: number,
    late: (outcome: SendOutcome) => Promise<void>,
  ): Promise<SendOutcome> {
    let attachmentName: string | null = null;
    const context: AdapterContext = {
      operationId: `messaging.send:${row.id}`,
      traceId: `messaging.send:${row.id}`,
      spaceId: "",
      userId: "",
      signal: AbortSignal.timeout(MESSAGING_SEND_TIMEOUT_MS),
    };
    const work = (async (): Promise<SendOutcome> => {
      if (row.kind !== "dm") return this.sendToThread(row, context);
      const identity = row.identityId
        ? await this.deps.prisma.messagingIdentity.findUnique({ where: { id: row.identityId } })
        : null;
      // Nothing more reaches a deactivated person's chat app, including what was queued before.
      if (!identity || (await accountDeactivated(this.deps.prisma, identity.userId)))
        return { kind: "failed" };
      // Sendblue's consecutive-outbound vendor cap; other providers have no equivalent
      // limit, so do not hold Slack/WhatsApp/Telegram DMs.
      if (
        identity.provider === "sendblue" &&
        identity.outboundSinceInbound >= MESSAGING_DM_OUTBOUND_CAP
      )
        return { kind: "held" };
      const threadId = await this.resolveDirectThread(identity, context);
      const invitePair = connectInvitePair(row.idempotencyKey);
      if (invitePair) {
        const result = await this.sendConnectInvite(row, threadId, invitePair, context);
        if (result.kind === "sent") await this.countOutbound(identity);
        return result;
      }
      let attachment: MessagingOutboundAttachment | undefined;
      const artifactId = fileArtifactId(row.idempotencyKey);
      if (artifactId) {
        // Scoped to the identity's Space: delivery runs across every Space.
        const artifact = await this.deps.prisma.artifact.findFirst({
          where: { id: artifactId, spaceId: identity.spaceId },
          select: { name: true, mimeType: true, storageKey: true, userId: true },
        });
        // Deleted since the reply was recorded, or not in this Space.
        if (!artifact) return { kind: "failed" };
        attachmentName = artifact.name;
        const data = await this.deps.artifacts.get(artifact.storageKey, {
          ...context,
          spaceId: identity.spaceId,
          userId: artifact.userId,
        });
        attachment = { name: artifact.name, mimeType: artifact.mimeType, data };
      }
      const sent = await this.deps.messaging.sendToThread(
        {
          threadId,
          body: row.body,
          idempotencyKey: row.idempotencyKey,
          ...(attachment ? { attachment } : {}),
        },
        context,
      );
      await this.countOutbound(identity);
      return { kind: "sent", handle: sent.handle };
    })().catch((error): SendOutcome => {
      // The message is fine; the database is not. Its backup job sends it once that is back,
      // and the outage never gives the message up as failed.
      if (isDatabaseUnavailable(error)) throw error;
      return { kind: "error", error, attachmentName };
    });
    return settleBy(work, deadline, late);
  }

  /** Group posts, the group intro, and team-chat replies go straight to their provider thread. */
  private async sendToThread(row: LaneRow, context: AdapterContext): Promise<SendOutcome> {
    if (!row.threadId) return { kind: "failed" };
    if (row.kind === "group" || row.kind === "intro") {
      // A reply a deactivated person's bot queued for a group is not posted after all.
      const source = row.sourceMessageId
        ? await this.deps.prisma.message.findUnique({
            where: { id: row.sourceMessageId },
            select: { thread: { select: { userId: true } } },
          })
        : null;
      if (source && (await accountDeactivated(this.deps.prisma, source.thread.userId)))
        return { kind: "failed" };
    }
    const sent = await this.deps.messaging.sendToThread(
      { threadId: row.threadId, body: row.body, idempotencyKey: row.idempotencyKey },
      context,
    );
    return { kind: "sent", handle: sent.handle };
  }

  /** Never fails the send: the message is already out, so a lost count must not resend it. */
  private async countOutbound(identity: { id: string }): Promise<void> {
    await this.deps.prisma.messagingIdentity
      .update({
        where: { id: identity.id },
        data: { outboundSinceInbound: { increment: 1 } },
      })
      .catch((error) => this.reportFailure("messaging outbound counter error", error));
  }

  /**
   * Delivers a connect invite while holding the connection row lock. Revoke's status update
   * blocks behind this lock, so it cannot commit (and delete the row) between the pending check
   * and the send. Only used for rare approval DMs.
   *
   * At most once: a provider error, or a failure once the provider call has started, settles the
   * row as failed, so it is never sent again and a YES or NO never answers a request that may not
   * have arrived. A lost invite is fine; reconnecting starts a fresh cycle. A database outage
   * before the provider call leaves the row to its backup job.
   */
  private async sendConnectInvite(
    row: LaneRow,
    threadId: string,
    pair: { requesterBotId: string; targetBotId: string },
    context: AdapterContext,
  ): Promise<SendOutcome> {
    let attempted = false;
    try {
      return await this.deps.prisma.$transaction(
        async (tx) => {
          const communicationAllowed = await crossSpaceCommunicationAllowed(
            tx,
            pair.requesterBotId,
            pair.targetBotId,
          );
          const locked = await tx.$queryRaw<Array<{ status: string }>>`
            SELECT status FROM agent_connections
            WHERE "requesterBotId" = ${pair.requesterBotId}
              AND "targetBotId" = ${pair.targetBotId}
            FOR UPDATE
          `;
          // An invite queued before its requester was deactivated is not sent for them.
          const requester = await tx.bot.findUnique({
            where: { id: pair.requesterBotId },
            select: { userId: true },
          });
          const requesterDeactivated =
            requester && (await accountDeactivated(tx, requester.userId));
          if (locked[0]?.status !== "pending" || !communicationAllowed || requesterDeactivated)
            return { kind: "failed" as const };
          const outbound = await tx.messagingOutbound.findUnique({
            where: { id: row.id },
            select: { id: true },
          });
          // Revoked between the claim and this lock.
          if (!outbound) return { kind: "failed" as const };
          attempted = true;
          const sent = await this.deps.messaging.sendToThread(
            { threadId, body: row.body },
            context,
          );
          return { kind: "sent" as const, handle: sent.handle };
        },
        { maxWait: 5_000, timeout: 20_000 },
      );
    } catch (error) {
      if (!attempted && isDatabaseUnavailable(error)) throw error;
      return { kind: "failed" };
    }
  }

  /**
   * DM rows address the identity, not a thread: the conversation id is learned from inbound
   * webhooks and cached, with a provider lookup as fallback for identities that predate it.
   */
  private async resolveDirectThread(
    identity: IdentityRow,
    context: AdapterContext,
  ): Promise<string> {
    if (identity.dmThreadId) return identity.dmThreadId;
    const threadId = await this.deps.messaging.openDirectThread(
      identity.provider,
      identity.address,
      context,
    );
    await this.deps.prisma.messagingIdentity.update({
      where: { id: identity.id },
      data: { dmThreadId: threadId },
    });
    return threadId;
  }

  /**
   * A 1:1 messaging run's messages, and a delegated run's, go to the bot's linked chat. One row
   * per platform-sized part, then one per image or file, so a retry re-sends only the parts that
   * failed. `progress` sends a running run's interim messages up to the first other message that
   * sends anything, such as a card or a file: it waits for the whole reply, and nothing posted
   * after it goes ahead of it.
   */
  private async recordDirectRun(
    run: { id: string; botId: string; userId: string; status: string },
    progress: boolean,
  ): Promise<OutboundLane | undefined> {
    const identity = await this.deps.prisma.messagingIdentity.findUnique({
      where: { botId: run.botId },
    });
    // The linked DM is one person's chat. In a shared Space another member's run on this bot, such
    // as a reply to their message_bot, stays in the app instead of reaching that person's chat app.
    if (!identity || identity.userId !== run.userId) return undefined;
    const messages = await this.deps.prisma.message.findMany({
      where: { runId: run.id, role: "bot" },
      orderBy: { seq: "asc" },
    });
    const sendsFiles = this.deps.messaging
      .platforms()
      .some((platform) => platform.provider === identity.provider && platform.capabilities.files);
    const linkedPages = linkedPageIds(messages);
    // A run that ended, such as one cancelled or expired while it waited, leaves its question
    // pending with nothing to resume, so the chat app is not asked it.
    const asks = !TERMINAL_RUN.includes(run.status);
    const rowsByMessage = messages.map((message) => {
      const body = extractText(message.blocks, linkedPages, { asks });
      const parts = body ? splitOutboundBody(identity.provider, body) : [];
      return [
        ...parts.map((part, index) => ({
          idempotencyKey: index === 0 ? `msg:${message.id}` : `msg:${message.id}:${index + 1}`,
          kind: "dm",
          identityId: identity.id,
          body: part,
          sourceMessageId: message.id,
        })),
        ...(sendsFiles ? extractArtifactIds(message.blocks) : []).map((artifactId) => ({
          idempotencyKey: `msg:${message.id}:file:${artifactId}`,
          kind: "dm",
          identityId: identity.id,
          body: "",
          sourceMessageId: message.id,
        })),
      ];
    });
    const held = progress
      ? rowsByMessage.findIndex(
          (rows, index) =>
            rows.length > 0 && !isUserProgressClientNonce(messages[index]!.clientNonce),
        )
      : -1;
    const rows = (held === -1 ? rowsByMessage : rowsByMessage.slice(0, held)).flat();
    if (rows.length === 0) return undefined;
    const lane = { identityId: identity.id };
    await this.deps.prisma.$transaction((tx) => this.recordIn(tx, lane, rows));
    return lane;
  }

  /**
   * Channel runs post to the group with an attribution prefix, then fan the post out internally
   * to peer approved bots: context only by default, a waking run on @-mention, bounded by the
   * shared bot-message hop budget.
   */
  private async recordChannelRun(
    run: { id: string; botId: string },
    channelBlock: Extract<MessageBlock, { kind: "channel_message" }>,
  ): Promise<OutboundLane | undefined> {
    const { prisma } = this.deps;
    const identity = await prisma.messagingIdentity.findUnique({ where: { botId: run.botId } });
    // A deactivated person's bot neither posts to the group nor reaches its other bots.
    if (!identity || (await accountDeactivated(prisma, identity.userId))) return undefined;
    const channel = await prisma.messagingChannel.findUnique({
      where: { id: channelBlock.channelId },
    });
    if (!channel) return undefined;
    const owner = await prisma.user.findUnique({
      where: { id: identity.userId },
      select: { name: true },
    });
    const firstName = owner?.name.trim().split(/\s+/)[0] || "Owner";
    const fromLabel = `${firstName}'s agent`;
    const replies = await prisma.message.findMany({
      select: { id: true, blocks: true },
      where: { runId: run.id, role: "bot" },
      orderBy: { seq: "asc" },
    });
    // Ask answers are entered privately in the app. Check the same snapshot as the replies so a
    // resumed run cannot publish an answer-influenced response.
    if (
      replies.some((message) =>
        (message.blocks as MessageBlock[]).some(
          (block) => block.kind === "ask" && block.status === "answered",
        ),
      )
    )
      return undefined;
    const linkedPages = linkedPageIds(replies);
    const messages = replies
      .map((message) => ({ message, text: extractText(message.blocks, linkedPages) }))
      .filter((entry) => entry.text);
    if (messages.length === 0) return undefined;
    // One row per platform-sized part, like the DM path: the adapter truncates an oversized body
    // instead of failing, which would drop the reply's tail.
    const lane = { identityId: null, threadId: channel.threadId };
    await prisma.$transaction((tx) =>
      this.recordIn(
        tx,
        lane,
        messages.flatMap(({ message, text }) =>
          splitOutboundBody(identity.provider, `${fromLabel}: ${text}`).map((part, index) => ({
            idempotencyKey: index === 0 ? `msg:${message.id}` : `msg:${message.id}:${index + 1}`,
            kind: "group",
            threadId: channel.threadId,
            body: part,
            sourceMessageId: message.id,
          })),
        ),
      ),
    );
    const hop = nextBotMessageHop(channelBlock.hop);
    const peers = await prisma.messagingChannelMember.findMany({
      where: {
        channelId: channel.id,
        status: "approved",
        identityId: { not: null },
        NOT: { identityId: identity.id },
      },
    });
    await this.fanOutToPeers({ identity, channel, channelBlock, fromLabel, hop, peers, messages });
    return lane;
  }

  private async fanOutToPeers({
    identity,
    channel,
    channelBlock,
    fromLabel,
    hop,
    peers,
    messages,
  }: {
    identity: { provider: string; address: string; botId: string };
    channel: { id: string; name: string | null };
    channelBlock: Extract<MessageBlock, { kind: "channel_message" }>;
    fromLabel: string;
    hop: number;
    peers: Array<{ identityId: string | null }>;
    messages: Array<{ message: { id: string }; text: string }>;
  }): Promise<void> {
    const { prisma, events, jobs } = this.deps;
    for (const { message, text } of messages) {
      for (const peer of peers) {
        const peerIdentity = await prisma.messagingIdentity.findUnique({
          where: { id: peer.identityId! },
        });
        if (!peerIdentity || (await accountDeactivated(prisma, peerIdentity.userId))) continue;
        if (!(await crossSpaceCommunicationAllowed(prisma, identity.botId, peerIdentity.botId)))
          continue;
        const peerThread = await prisma.thread.findFirst({ where: { botId: peerIdentity.botId } });
        if (!peerThread) continue;
        const peerBot = await prisma.bot.findUnique({
          where: { id: peerIdentity.botId },
          select: { name: true },
        });
        const block: MessageBlock = {
          kind: "channel_message",
          provider: identity.provider,
          ...(channelBlock.transport ? { transport: channelBlock.transport } : {}),
          channelId: channel.id,
          fromAddress: identity.address,
          fromLabel,
          text,
          hop,
        };
        const clientNonce = `messaging-peer:${message.id}:${peerIdentity.botId}`;
        const mentioned = peerBot?.name
          ? new RegExp(`@${escapeRegExp(peerBot.name)}\\b`, "i").test(text)
          : false;
        if (mentioned && !botMessageHopExhausted(hop)) {
          const sent = await events
            .sendUserMessage({
              spaceId: peerIdentity.spaceId,
              threadId: peerThread.id,
              botId: peerIdentity.botId,
              userId: peerIdentity.userId,
              blocks: [block],
              prompt: `[Group "${channel.name ?? "group"}" — ${fromLabel}]: ${text}`,
              trigger: "messaging",
              clientNonce,
              crossSpaceSenderBotId: identity.botId,
            })
            .catch((error: unknown) => {
              if (
                error instanceof CrossSpaceCommunicationBlockedError ||
                error instanceof SpaceDeletionInProgressError
              )
                return null;
              throw error;
            });
          if (sent?.runId) {
            await jobs.enqueue(runContinueJob(sent.runId)).catch((error) => {
              getLogger().error("messaging peer wake enqueue error", error);
            });
          }
          continue;
        }
        // Context only: the peer sees the post in history without a wake.
        const existing = await prisma.message.findUnique({
          where: { threadId_clientNonce: { threadId: peerThread.id, clientNonce } },
        });
        if (existing) continue;
        const event = await prisma
          .$transaction(async (tx) => {
            const created = await createThreadMessageInTransaction(tx, {
              threadId: peerThread.id,
              role: "user",
              blocks: [block],
              clientNonce,
            });
            if (!(await crossSpaceCommunicationAllowed(tx, identity.botId, peerIdentity.botId)))
              throw new CrossSpaceCommunicationBlockedError();
            return appendEventInTransaction(tx, {
              spaceId: peerIdentity.spaceId,
              threadId: peerThread.id,
              botId: peerIdentity.botId,
              type: "thread.message.created",
              payload: { messageId: created.id, role: "user", blocks: [block] },
            });
          }, THREAD_LOCK_TRANSACTION_OPTIONS)
          .catch((error: unknown) => {
            if (error instanceof CrossSpaceCommunicationBlockedError) return null;
            throw error;
          });
        if (event) await events.notify(peerThread.id, event.seq).catch(() => undefined);
      }
    }
  }

  /**
   * A team-chat run's answer, in the thread its message came from: the reply, silence when an
   * ambient run chose none, or a short failure notice. Taking the message from running to
   * delivered and recording the reply commit together, so it is recorded once.
   */
  private async recordTeamChatReply(run: {
    id: string;
    status: string;
    sourceMessageId: string | null;
    bot: { name: string };
    externalMessage: {
      id: string;
      kind: string;
      replyThreadId: string | null;
      externalConversation: { conversationId: string };
    };
  }): Promise<OutboundLane | undefined> {
    const message = run.externalMessage;
    const lane = {
      identityId: null,
      threadId: resolveMessagingThreadId(
        message.externalConversation.conversationId,
        message.replyThreadId,
      ),
    };
    const reply =
      run.status === "completed"
        ? await this.deps.prisma.message.findFirst({
            where: { runId: run.id, role: "bot" },
            orderBy: { seq: "desc" },
            select: { id: true, blocks: true },
          })
        : null;
    const ambient = message.kind === "ambient";
    const body =
      run.status === "completed"
        ? teamChatResponseText(
            Array.isArray(reply?.blocks) ? (reply.blocks as MessageBlock[]) : [],
            run.bot.name,
            ambient,
          )
        : ambient
          ? ""
          : `${run.bot.name} could not complete that request. Open Rakazo for details.`;
    const recorded = await this.deps.prisma.$transaction(async (tx) => {
      const claimed = await tx.externalMessage.updateMany({
        where: { id: message.id, status: "running" },
        data: { status: "delivered" },
      });
      if (claimed.count !== 1 || !body) return false;
      await this.recordIn(tx, lane, [
        {
          idempotencyKey:
            run.status === "completed"
              ? `external-message:${message.id}`
              : `external-message:${message.id}:failure`,
          kind: "team",
          threadId: lane.threadId,
          body,
          sourceMessageId: reply?.id ?? run.sourceMessageId,
        },
      ]);
      return true;
    });
    return recorded ? lane : undefined;
  }

  /**
   * A bot another bot delegated to answers in the team-chat thread the chain started in, found by
   * walking the delegation back to a run a team-chat message started.
   */
  private async recordDelegatedReply(run: {
    id: string;
    status: string;
    sourceMessageId: string | null;
    bot: { name: string };
  }): Promise<OutboundLane | undefined> {
    const origin = await this.findExternalOrigin(run.sourceMessageId);
    if (!origin) return undefined;
    const reply =
      run.status === "completed"
        ? await this.deps.prisma.message.findFirst({
            where: { runId: run.id, role: "bot" },
            orderBy: { seq: "desc" },
            select: { id: true, blocks: true },
          })
        : null;
    const body =
      run.status === "failed"
        ? `${run.bot.name} could not complete the delegated request. Open Rakazo for details.`
        : teamChatResponseText(
            Array.isArray(reply?.blocks) ? (reply.blocks as MessageBlock[]) : [],
            run.bot.name,
            true,
          );
    if (!body) return undefined;
    const lane = {
      identityId: null,
      threadId: resolveMessagingThreadId(
        origin.externalConversation.conversationId,
        origin.replyThreadId,
      ),
    };
    const recorded = await this.deps.prisma.$transaction(async (tx) => {
      if (!(await claimPreviousReleaseRelay(tx, run.id))) return false;
      await this.recordIn(tx, lane, [
        {
          idempotencyKey: `team-chat-run:${run.id}`,
          kind: "team",
          threadId: lane.threadId,
          body,
          sourceMessageId: reply?.id ?? run.sourceMessageId,
        },
      ]);
      return true;
    });
    return recorded ? lane : undefined;
  }

  private async findExternalOrigin(sourceMessageId: string | null) {
    const { prisma } = this.deps;
    let current: string | null = sourceMessageId;
    const visited = new Set<string>();
    const maxHops = botMessageMaxHops();
    for (let depth = 0; current && depth <= maxHops; depth += 1) {
      const source = await prisma.message.findUnique({
        where: { id: current },
        select: { replyTo: { select: { runId: true } } },
      });
      const parentRunId = source?.replyTo?.runId;
      if (!parentRunId || visited.has(parentRunId)) return null;
      visited.add(parentRunId);
      const external = await prisma.externalMessage.findUnique({
        where: { runId: parentRunId },
        select: { replyThreadId: true, externalConversation: { select: { conversationId: true } } },
      });
      if (external) return external;
      const parent = await prisma.run.findUnique({
        where: { id: parentRunId },
        select: { sourceMessageId: true },
      });
      current = parent?.sourceMessageId ?? null;
    }
    return null;
  }
}

/**
 * Every writer and sender of one conversation serializes here: on the person's messaging
 * identity or the group's channel row, which the previous release locks too, and on an advisory
 * lock for threads with no such row (team chat). Always in that order.
 */
async function lockLane(tx: Prisma.TransactionClient, lane: OutboundLane): Promise<void> {
  if (lane.identityId === null)
    await tx.$queryRaw`SELECT id FROM messaging_channels WHERE "threadId" = ${lane.threadId} FOR UPDATE`;
  else
    await tx.$queryRaw`SELECT id FROM messaging_identities WHERE id = ${lane.identityId} FOR UPDATE`;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`messaging_outbound:${laneKey(lane)}`}, 0))`;
}

/**
 * The previous release relays a delegated reply with no outbound row and then marks the run, so
 * this release checks that marker and sets it in the transaction that records its own relay:
 * false when that release already posted the reply. The run's row lock keeps the column until
 * commit; its deferred drop first carries every marker into a row under the relay's key.
 */
async function claimPreviousReleaseRelay(
  tx: Prisma.TransactionClient,
  runId: string,
): Promise<boolean> {
  const [run] = await tx.$queryRaw<Array<{ tracked: boolean; relayed: boolean }>>`
    SELECT to_jsonb(r) ? 'teamChatMirroredAt' AS tracked,
      (to_jsonb(r) ->> 'teamChatMirroredAt') IS NOT NULL AS relayed
    FROM runs AS r WHERE r.id = ${runId} FOR UPDATE`;
  if (!run?.tracked) return true;
  if (run.relayed) return false;
  await tx.$executeRaw`UPDATE runs SET "teamChatMirroredAt" = now() AT TIME ZONE 'UTC' WHERE id = ${runId}`;
  return true;
}

function laneKey(lane: OutboundLane): string {
  return lane.identityId === null ? `thread:${lane.threadId}` : `dm:${lane.identityId}`;
}

function laneWhere(lane: OutboundLane): Prisma.MessagingOutboundWhereInput {
  return lane.identityId === null
    ? { identityId: null, threadId: lane.threadId }
    : { identityId: lane.identityId };
}

function laneOf(row: { identityId: string | null; threadId: string | null }): OutboundLane | null {
  if (row.identityId) return { identityId: row.identityId };
  if (row.threadId) return { identityId: null, threadId: row.threadId };
  return null;
}

/**
 * The send's outcome, or `unsettled` when it is still running at the deadline; the outcome of a
 * call that settles after that goes to `late`.
 */
async function settleBy(
  work: Promise<SendOutcome>,
  deadline: number,
  late: (outcome: SendOutcome) => Promise<void>,
): Promise<SendOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const expired = new Promise<SendOutcome>((resolve) => {
    timer = setTimeout(
      () => {
        timedOut = true;
        resolve({ kind: "unsettled" });
      },
      Math.max(0, deadline - Date.now()),
    );
  });
  // A late failure is the backup job's to retry once the claim is stale.
  work.then((outcome) => (timedOut ? late(outcome) : undefined)).catch(() => undefined);
  try {
    return await Promise.race([work, expired]);
  } finally {
    clearTimeout(timer);
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** `connect:{requesterBotId}:{targetBotId}`: agent-connection approval DMs. */
function connectInvitePair(
  idempotencyKey: string,
): { requesterBotId: string; targetBotId: string } | null {
  const match = /^connect:([^:]+):([^:]+)$/.exec(idempotencyKey);
  if (!match) return null;
  return { requesterBotId: match[1]!, targetBotId: match[2]! };
}

/** Outbound status webhooks update rows by provider handle. */
export async function applyMessagingOutboundStatus(
  prisma: PrismaClient,
  event: MessagingOutboundStatus,
): Promise<void> {
  const status = ["ERROR", "DECLINED", "FAILED"].includes(event.status)
    ? "failed"
    : ["SENT", "DELIVERED", "READ"].includes(event.status)
      ? "sent"
      : null;
  if (!status) return;
  await prisma.messagingOutbound.updateMany({
    where: { providerHandle: event.handle },
    data: { status },
  });
}

/** The artifact a reply's file row sends, from its `msg:<message>:file:<artifact>` key. */
function fileArtifactId(idempotencyKey: string): string | null {
  return /^msg:[^:]+:file:([^:]+)$/.exec(idempotencyKey)?.[1] ?? null;
}

/** Artifacts of the message's image and file blocks, in block order. */
function extractArtifactIds(blocks: unknown): string[] {
  if (!Array.isArray(blocks)) return [];
  return blocks.flatMap((block: { kind?: unknown; artifactId?: unknown } | null) =>
    (block?.kind === "image" || block?.kind === "file") && typeof block.artifactId === "string"
      ? [block.artifactId]
      : [],
  );
}

function textBlocks(blocks: unknown): string[] {
  if (!Array.isArray(blocks)) return [];
  return blocks.flatMap((block: { kind?: unknown; text?: unknown } | null) =>
    block?.kind === "text" && typeof block.text === "string" ? [block.text] : [],
  );
}

/** Pages the run's replies already link by name, so their cards add nothing more. */
function linkedPageIds(messages: readonly { blocks: unknown }[]): Set<string> {
  const ids = new Set<string>();
  for (const message of messages)
    for (const text of textBlocks(message.blocks)) {
      // Only links the conversion names count; one inside a code example stays as written, so a
      // page counts when fewer of its links remain after converting than were written.
      const converted = pageLinksAsTitles(text);
      const count = (source: string, link: string) => source.split(link).length - 1;
      for (const match of text.matchAll(/\]\(page:([A-Za-z0-9_-]{1,64})\)/g))
        if (count(converted, match[0]) < count(text, match[0])) ids.add(match[1]!);
    }
  return ids;
}

/**
 * The text other channels get. A page card cannot travel, so a page the reply does not name goes
 * as its title. With `asks`, for a 1:1 chat, a pending question or takeover request goes as text
 * too, so the person learns the bot is waiting on them.
 */
function extractText(
  blocks: unknown,
  linkedPages: ReadonlySet<string>,
  options: { asks?: boolean } = {},
): string {
  if (!Array.isArray(blocks)) return "";
  return blocks
    .flatMap(
      (block: { kind?: unknown; text?: unknown; pageId?: unknown; title?: unknown } | null) => {
        if (block?.kind === "text" && typeof block.text === "string")
          return [pageLinksAsTitles(block.text)];
        if (options.asks && block?.kind === "ask") {
          const ask = chatAppAskText(block as MessageBlock);
          return ask ? [ask] : [];
        }
        if (options.asks && block?.kind === "computer") {
          const takeover = chatAppTakeoverText(block as Parameters<typeof chatAppTakeoverText>[0]);
          return takeover ? [takeover] : [];
        }
        if (
          block?.kind === "page" &&
          typeof block.title === "string" &&
          typeof block.pageId === "string" &&
          !linkedPages.has(block.pageId)
        )
          return [block.title];
        return [];
      },
    )
    .join("\n")
    .trim();
}
