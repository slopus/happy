import { createHmac } from "node:crypto";
import {
  ACTIVE_RUN_STATUSES,
  BACKGROUND_HELPER_TRIGGER,
  displayName,
  isBackgroundRunTrigger,
  isRunWaitingOnUser,
  truncatePlainText,
} from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { runAsSystem } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { credentialDigest } from "./credential-digest.js";
import { EncryptedSecretStore } from "./secrets.js";

/** One bot at work, as a row on the card. Opens its chat when tapped. */
export type WorkActivityRow = {
  status: "working" | "waiting";
  /** The bot's name. */
  title: string;
  /** The bot's latest step, or empty. */
  line: string;
  spaceId: string;
  botId?: string;
  groupId?: string;
};

/** What a phone's live status card shows: every bot of the user's still at work. */
export type WorkActivityState = {
  /** Bots at work, including those past the rows shown. */
  count: number;
  /** Bots waiting on the user. */
  waiting: number;
  /** Bots waiting on the user first, then the newest work. */
  rows: WorkActivityRow[];
};

export type WorkActivityPush = {
  state: WorkActivityState;
  /** Nothing is at work any more: the card goes away. */
  ended: boolean;
  /** Something new needs the user, or the card ends: show it at once. */
  urgent: boolean;
  /** Unix seconds, read before the state, so a later push never carries an older state. */
  at: number;
};

/** Delivers updates to one phone's live status card, and starts one on a phone that has none. */
export interface WorkActivityPushProvider {
  send(token: string, push: WorkActivityPush): Promise<"sent" | "invalid" | "unavailable">;
  /** `token` is the phone's token for starting cards, not a card's. */
  start(token: string, push: WorkActivityPush): Promise<"sent" | "invalid" | "unavailable">;
}

/** Cards kept per user: one per phone they use. Phones that can start a card are capped alike. */
const MAX_CARDS_PER_USER = 5;
/**
 * Work this new may be a message the phone just sent, which starts its own card and registers it
 * a moment later; a phone is started a card only once that would have happened.
 */
const START_GRACE_MS = 10_000;
/** The card's height fits this many rows; the count covers the rest. */
export const WORK_ACTIVITY_ROWS = 4;
const LINE_MAX_CHARS = 120;
/** Progress events read back per page to find the latest step, and the most pages read. */
const STEP_PAGE_SIZE = 50;
const STEP_PAGES = 10;
/** Runs whose latest step this process remembers. */
const STEP_CACHE_SIZE = 1_000;
/** A run that ended this recently may be the change its owner's card has yet to show. */
const JUST_ENDED_MS = 10 * 60_000;
/** A busy thread or user is looked at most this often. The last change always goes out. */
const UPDATE_WINDOW_MS = 3_000;
/** A push that did not go through is tried again this much later, a few times, with backoff. */
const RETRY_MS = 30_000;
const MAX_RETRIES = 4;
const EMPTY_STATE: WorkActivityState = { count: 0, waiting: 0, rows: [] };

/**
 * Keeps each phone's live status card in step with the user's bots: registered when the user
 * sends, updated as any of their runs change, and ended once none is at work.
 */
export class WorkActivities {
  private readonly encryption: EncryptedSecretStore;
  private readonly pending = new Map<string, { again: boolean }>();
  /** Each run's newest progress read and the step it showed, so later updates read only what is new. */
  private readonly steps = new Map<string, { seq: number; line: string }>();
  /** Retries already scheduled per user since their last push went through. */
  private readonly retries = new Map<string, number>();
  /** Users whose phones are due a card once the grace for new work passes. */
  private readonly startsDue = new Set<string>();

  constructor(
    private readonly prisma: PrismaClient,
    private readonly digestKey: string,
    private readonly provider: WorkActivityPushProvider,
    private readonly windowMs = UPDATE_WINDOW_MS,
  ) {
    this.encryption = new EncryptedSecretStore(digestKey);
  }

  /**
   * Follows the user's work with this card for as long as `sessionId` lasts. False when none of
   * their bots is at work.
   */
  async register(userId: string, sessionId: string, token: string): Promise<boolean> {
    if ((await this.state(userId)).count === 0) return false;
    const tokenDigest = credentialDigest(token);
    // A card another account registered on this phone starts over, with nothing of that account's.
    await runAsSystem("drop a live status card another account registered", () =>
      this.prisma.workActivityToken.deleteMany({ where: { tokenDigest, userId: { not: userId } } }),
    );
    // Re-registering, as each app open does, counts as recent so the cap below keeps the card,
    // and keeps its last state so nothing is sent twice. Only a new card seals its token.
    const { count } = await runAsSystem("refresh a live status card", () =>
      this.prisma.workActivityToken.updateMany({
        where: { tokenDigest, userId },
        data: { sessionId, createdAt: new Date() },
      }),
    );
    if (!count) {
      const sealed = await this.encryption.put(
        token,
        {
          operationId: "work-activity.register",
          traceId: "work-activity.register",
          spaceId: "",
          userId,
          signal: new AbortController().signal,
        },
        { recordId: recordId(tokenDigest) },
      );
      await runAsSystem("register a live status card", () =>
        this.prisma.workActivityToken.upsert({
          where: { tokenDigest },
          create: { tokenDigest, userId, sessionId, ciphertext: sealed.ciphertext },
          update: { userId, sessionId, createdAt: new Date() },
        }),
      );
    }
    // This phone shows the work now: it is started no other card for it, even once this one goes.
    await runAsSystem("record a phone's own live status card", () =>
      this.prisma.workActivityStartToken.updateMany({
        where: { userId, sessionId },
        data: { startedAt: new Date() },
      }),
    );
    // A user's phones are few; the oldest cards beyond that end, so each update fans out a little.
    const extra = await runAsSystem("find a user's oldest live status cards", () =>
      this.prisma.workActivityToken.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
        skip: MAX_CARDS_PER_USER,
        select: { tokenDigest: true, userId: true, ciphertext: true },
      }),
    );
    await this.endCards(extra);
    // The work may have moved on before the card registered.
    this.userChanged(userId);
    return true;
  }

  /**
   * Lets the server start a card on this phone when the user's bots get to work from elsewhere,
   * for as long as `sessionId` lasts. `token` is the phone's token for starting cards.
   */
  async registerStarts(userId: string, sessionId: string, token: string): Promise<void> {
    const tokenDigest = credentialDigest(token);
    // Another account signed in on this phone before: its work no longer starts cards here.
    await runAsSystem("drop a phone another account registered for live status cards", () =>
      this.prisma.workActivityStartToken.deleteMany({
        where: { tokenDigest, userId: { not: userId } },
      }),
    );
    const { count } = await runAsSystem("refresh a phone registered for live status cards", () =>
      this.prisma.workActivityStartToken.updateMany({
        where: { tokenDigest, userId },
        data: { sessionId, createdAt: new Date() },
      }),
    );
    if (!count) {
      // iOS gave this phone a new token: it replaces the old one and keeps its last start, so a
      // card the user dismissed is not started again for the same work.
      const previous = await runAsSystem("find a phone's earlier token for live status cards", () =>
        this.prisma.workActivityStartToken.findMany({
          where: { userId, sessionId },
          select: { tokenDigest: true, startedAt: true },
        }),
      );
      const startedAt =
        previous
          .map((phone) => phone.startedAt)
          .filter((date): date is Date => date !== null)
          .sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
      if (previous.length)
        await runAsSystem("drop a phone's earlier token for live status cards", () =>
          this.prisma.workActivityStartToken.deleteMany({
            where: { tokenDigest: { in: previous.map((phone) => phone.tokenDigest) }, userId },
          }),
        );
      const sealed = await this.encryption.put(
        token,
        {
          operationId: "work-activity.register-starts",
          traceId: "work-activity.register-starts",
          spaceId: "",
          userId,
          signal: new AbortController().signal,
        },
        { recordId: startRecordId(tokenDigest) },
      );
      await runAsSystem("register a phone for live status cards", () =>
        this.prisma.workActivityStartToken.upsert({
          where: { tokenDigest },
          create: { tokenDigest, userId, sessionId, ciphertext: sealed.ciphertext, startedAt },
          update: { userId, sessionId, createdAt: new Date() },
        }),
      );
    }
    const extra = await runAsSystem("find a user's oldest phones for live status cards", () =>
      this.prisma.workActivityStartToken.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
        skip: MAX_CARDS_PER_USER,
        select: { tokenDigest: true },
      }),
    );
    if (extra.length)
      await runAsSystem("drop a user's oldest phones for live status cards", () =>
        this.prisma.workActivityStartToken.deleteMany({
          where: { tokenDigest: { in: extra.map((phone) => phone.tokenDigest) }, userId },
        }),
      );
    // Work already going shows on this phone too.
    this.userChanged(userId);
  }

  /** A thread changed: update the cards of everyone with work in it, going or just ended. */
  threadChanged(threadId: string): void {
    this.throttle(`thread:${threadId}`, async () => {
      const runs = await runAsSystem("find whose work a thread change touches", () =>
        this.prisma.run.findMany({
          where: {
            threadId,
            OR: [
              { status: { in: [...ACTIVE_RUN_STATUSES] } },
              { updatedAt: { gte: new Date(Date.now() - JUST_ENDED_MS) } },
            ],
          },
          distinct: ["userId"],
          select: { userId: true },
        }),
      );
      for (const { userId } of runs) this.userChanged(userId);
    });
  }

  /** A session ended or was replaced: its cards end, or move to the session that replaced it. */
  async endSession(userId: string, sessionId: string, nextSessionId?: string): Promise<void> {
    if (nextSessionId) {
      await runAsSystem("move live status cards to a replacement session", () =>
        this.prisma.workActivityToken.updateMany({
          where: { userId, sessionId },
          data: { sessionId: nextSessionId },
        }),
      );
      await runAsSystem("move a phone's live status card starts to a replacement session", () =>
        this.prisma.workActivityStartToken.updateMany({
          where: { userId, sessionId },
          data: { sessionId: nextSessionId },
        }),
      );
      return;
    }
    // A signed-out phone is started no more cards.
    await runAsSystem("stop starting live status cards for a session", () =>
      this.prisma.workActivityStartToken.deleteMany({ where: { userId, sessionId } }),
    );
    this.userChanged(userId);
  }

  /** The account is being deleted: its cards end now, before their rows go with it. */
  async endUser(userId: string): Promise<void> {
    const cards = await runAsSystem("load a deleted account's live status cards", () =>
      this.prisma.workActivityToken.findMany({
        where: { userId },
        select: { tokenDigest: true, userId: true, ciphertext: true },
      }),
    );
    await this.endCards(cards);
  }

  /** Ends these cards on their phones at once and forgets them. */
  private async endCards(
    cards: Array<{ tokenDigest: string; userId: string; ciphertext: string }>,
  ): Promise<void> {
    const at = Math.floor(Date.now() / 1000);
    await Promise.all(
      cards.map(async (card) => {
        const token = await this.encryption.load(card.ciphertext, recordId(card.tokenDigest));
        await this.provider.send(token, { state: EMPTY_STATE, ended: true, urgent: true, at });
        await runAsSystem("drop a live status card", () =>
          this.prisma.workActivityToken.deleteMany({
            where: { tokenDigest: card.tokenDigest, userId: card.userId },
          }),
        );
      }),
    );
  }

  userChanged(userId: string): void {
    this.throttle(`user:${userId}`, () => this.sync(userId));
  }

  /** Runs now, then at most once per window while changes keep coming; the last one always runs. */
  private throttle(key: string, run: () => Promise<void>): void {
    const pending = this.pending.get(key);
    if (pending) {
      pending.again = true;
      return;
    }
    const entry = { again: false };
    this.pending.set(key, entry);
    void run()
      .catch((error) => getLogger().warn("work_activity.sync_failed", { error }))
      .finally(() => {
        const timer = setTimeout(() => {
          this.pending.delete(key);
          if (entry.again) this.throttle(key, run);
        }, this.windowMs);
        timer.unref?.();
      });
  }

  async sync(userId: string): Promise<void> {
    const at = Math.floor(Date.now() / 1000);
    const cards = await runAsSystem("load a user's live status cards", () =>
      this.prisma.workActivityToken.findMany({ where: { userId } }),
    );
    const phones = await runAsSystem("load a user's phones for live status cards", () =>
      this.prisma.workActivityStartToken.findMany({ where: { userId } }),
    );
    if (!cards.length && !phones.length) return;
    const sessions = await runAsSystem("check the sessions behind a user's cards", () =>
      this.prisma.session.findMany({
        where: {
          id: {
            in: [...new Set([...cards, ...phones].map((card) => card.sessionId))],
          },
          userId,
          expiresAt: { gt: new Date() },
        },
        select: { id: true },
      }),
    );
    const live = new Set(sessions.map((session) => session.id));
    const { state, since, newest } = await this.work(userId);
    const started = await this.startCards(userId, state, since, newest, at, cards, phones, live);
    // Keyed, so the stored digest reveals nothing about the chat content it stands for.
    const digest = createHmac("sha256", this.digestKey).update(JSON.stringify(state)).digest("hex");
    const retried = this.retries.get(userId) ?? 0;
    const results = await Promise.all(
      cards.map(async (card) => {
        // A signed-out, expired or revoked session's card ends, and is sent nothing newer.
        const ended = state.count === 0 || !live.has(card.sessionId);
        if (!ended && digest === card.lastState) return "sent";
        const token = await this.encryption.load(card.ciphertext, recordId(card.tokenDigest));
        const result = await this.provider.send(token, {
          // An ending card leaves at once, so it needs no rows.
          state: ended ? EMPTY_STATE : state,
          ended,
          urgent: ended || state.waiting > card.lastWaiting,
          at,
        });
        if (result === "invalid" || (ended && (result === "sent" || retried >= MAX_RETRIES))) {
          await runAsSystem("drop a live status card", () =>
            this.prisma.workActivityToken.deleteMany({
              where: { tokenDigest: card.tokenDigest, userId },
            }),
          );
        } else if (result === "sent") {
          await runAsSystem("record a live status card update", () =>
            this.prisma.workActivityToken.updateMany({
              // Only while this user still owns the card.
              where: { tokenDigest: card.tokenDigest, userId },
              data: { lastState: digest, lastWaiting: state.waiting },
            }),
          );
        }
        return result;
      }),
    );
    results.push(...started);
    // Nothing else may change to send it again, so a push that did not go through is retried.
    if (!results.includes("unavailable") || retried >= MAX_RETRIES) {
      this.retries.delete(userId);
      return;
    }
    this.retries.set(userId, retried + 1);
    setTimeout(() => this.userChanged(userId), RETRY_MS * 2 ** retried).unref?.();
  }

  /**
   * Starts a card on each of the user's signed-in phones that has none, once per stretch of work:
   * a card the user dismissed stays gone until their bots are next at work.
   */
  private async startCards(
    userId: string,
    state: WorkActivityState,
    since: Date | undefined,
    newest: Date | undefined,
    at: number,
    cards: Array<{ sessionId: string }>,
    phones: Array<{
      tokenDigest: string;
      sessionId: string;
      ciphertext: string;
      startedAt: Date | null;
    }>,
    live: Set<string>,
  ): Promise<Array<"sent" | "invalid" | "unavailable">> {
    if (!state.count || !since || !newest) return [];
    const shown = new Set(cards.map((card) => card.sessionId));
    const now = Date.now();
    const due = phones.filter(
      (phone) =>
        live.has(phone.sessionId) &&
        !shown.has(phone.sessionId) &&
        (!phone.startedAt || phone.startedAt < since),
    );
    if (!due.length) return [];
    const wait = newest.getTime() + START_GRACE_MS - now;
    if (wait > 0) {
      if (!this.startsDue.has(userId)) {
        this.startsDue.add(userId);
        setTimeout(() => {
          this.startsDue.delete(userId);
          this.userChanged(userId);
        }, wait).unref?.();
      }
      return [];
    }
    const startedAt = new Date(now);
    return Promise.all(
      due.map(async (phone): Promise<"sent" | "invalid" | "unavailable"> => {
        const where = { tokenDigest: phone.tokenDigest, userId, sessionId: phone.sessionId };
        const previous = phone.startedAt;
        // Claimed before sending: the API and the worker both follow the user's work, and only
        // one of them starts the card. A phone signed out meanwhile has no row left to claim.
        const { count } = await runAsSystem("claim a live status card start", () =>
          this.prisma.workActivityStartToken.updateMany({
            where: { ...where, startedAt: previous },
            data: { startedAt },
          }),
        );
        if (!count) return "sent";
        let result: "sent" | "invalid" | "unavailable";
        try {
          const token = await this.encryption.load(
            phone.ciphertext,
            startRecordId(phone.tokenDigest),
          );
          result = await this.provider.start(token, { state, ended: false, urgent: true, at });
        } catch (error) {
          // One phone's failure never holds back the user's other cards.
          getLogger().warn("work_activity.start_failed", { error });
          result = "unavailable";
        }
        if (result === "invalid")
          await runAsSystem("forget a phone Apple no longer knows", () =>
            this.prisma.workActivityStartToken.deleteMany({ where }),
          );
        // Not started after all: the retry may claim it again.
        else if (result === "unavailable")
          await runAsSystem("release a live status card start", () =>
            this.prisma.workActivityStartToken.updateMany({
              where: { ...where, startedAt },
              data: { startedAt: previous },
            }),
          );
        return result;
      }),
    );
  }

  private async state(userId: string): Promise<WorkActivityState> {
    return (await this.work(userId)).state;
  }

  /** The user's work as the card shows it, and when its oldest and newest shown work began. */
  private async work(
    userId: string,
  ): Promise<{ state: WorkActivityState; since?: Date; newest?: Date }> {
    const runs = await runAsSystem("read a user's work in progress", () =>
      this.prisma.run.findMany({
        where: { userId, status: { in: [...ACTIVE_RUN_STATUSES] } },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          status: true,
          trigger: true,
          createdAt: true,
          spaceId: true,
          threadId: true,
          botId: true,
          bot: { select: { name: true } },
          thread: { select: { groupId: true } },
        },
      }),
    );
    // One row per bot in a chat: a continuation is the same work. A question still open there
    // outranks newer work beside it, which a pending question does not hold back.
    const byChat = new Map<string, (typeof runs)[number]>();
    const started: number[] = [];
    for (const run of runs) {
      // Background work, and a bot's helpers working for it in hidden threads, are not more bots.
      if (isBackgroundRunTrigger(run.trigger) || run.trigger === BACKGROUND_HELPER_TRIGGER)
        continue;
      // A continuation is part of the stretch of work its chat began, so the oldest run counts.
      started.push(run.createdAt.getTime());
      const key = `${run.threadId}:${run.botId}`;
      const newest = byChat.get(key);
      if (!newest) byChat.set(key, run);
      else if (isRunWaitingOnUser(run.status) && !isRunWaitingOnUser(newest.status))
        byChat.set(key, { ...newest, status: run.status });
    }
    const shown = [...byChat.values()];
    const waiting = shown.filter((run) => isRunWaitingOnUser(run.status));
    const ordered = [...waiting, ...shown.filter((run) => !isRunWaitingOnUser(run.status))];
    const rows = await Promise.all(
      ordered.slice(0, WORK_ACTIVITY_ROWS).map(
        async (run): Promise<WorkActivityRow> => ({
          status: isRunWaitingOnUser(run.status) ? "waiting" : "working",
          title: displayName(run.bot.name, "Bot"),
          line: isRunWaitingOnUser(run.status) ? "" : await this.latestStep(run.id),
          spaceId: run.spaceId,
          ...(run.thread.groupId ? { groupId: run.thread.groupId } : { botId: run.botId }),
        }),
      ),
    );
    return {
      state: { count: shown.length, waiting: waiting.length, rows },
      ...(started.length
        ? { since: new Date(Math.min(...started)), newest: new Date(Math.max(...started)) }
        : {}),
    };
  }

  private async latestStep(runId: string): Promise<string> {
    // Only progress newer than the step last found is read again: a long stream of text would
    // otherwise be decrypted on every update.
    const known = this.steps.get(runId);
    let line = known?.line ?? "";
    let newest = known?.seq;
    let before: number | undefined;
    for (let page = 0; page < STEP_PAGES; page += 1) {
      const progress = await runAsSystem("read a run's latest step", () =>
        this.prisma.event.findMany({
          where: {
            runId,
            type: "thread.progress",
            seq: {
              ...(known ? { gt: known.seq } : {}),
              ...(before === undefined ? {} : { lt: before }),
            },
          },
          orderBy: { seq: "desc" },
          take: STEP_PAGE_SIZE,
          select: { seq: true, payload: true },
        }),
      );
      if (newest === known?.seq && progress[0]) newest = progress[0].seq;
      const step = progress.find(({ payload }) => {
        const event = payload as { activity?: unknown; text?: unknown };
        return event.activity === true && typeof event.text === "string";
      });
      if (step) {
        // An empty step is the bot clearing its last one.
        const text = (step.payload as { text: string }).text;
        line = truncatePlainText(text.trim().replace(/\s+/g, " "), LINE_MAX_CHARS);
        break;
      }
      if (progress.length < STEP_PAGE_SIZE) break;
      before = progress.at(-1)!.seq;
    }
    if (newest !== undefined) {
      this.steps.delete(runId);
      this.steps.set(runId, { seq: newest, line });
      // Oldest first: the runs least recently shown go once the cache is full.
      if (this.steps.size > STEP_CACHE_SIZE) this.steps.delete(this.steps.keys().next().value!);
    }
    return line;
  }
}

function recordId(tokenDigest: string): string {
  return `work-activity:${tokenDigest}`;
}

function startRecordId(tokenDigest: string): string {
  return `work-activity-start:${tokenDigest}`;
}
