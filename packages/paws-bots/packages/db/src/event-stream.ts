import type { RealtimeFanout } from "@rakazo/adapter-kit";
import type { ProductEvent } from "@rakazo/contracts";
import { getLogger } from "@rakazo/logging";
import type { PrismaClient } from "./client.js";
import { readRunTimingFields } from "./run-timing.js";

const EVENT_BATCH_SIZE = 200;
const PUSH_CATCH_UP_MS = 30_000;
const POLL_ONLY_CATCH_UP_MS = 400;
const INCOMING_CALL_POLL_MS = 3_000;

/** Timing metadata is returned by the transaction that recorded first output. */
export async function notifyCommittedEvent(
  prisma: PrismaClient,
  realtime: RealtimeFanout | undefined,
  threadId: string,
  seq: number,
  firstResponseRunId?: string,
): Promise<void> {
  await notifyRealtime(realtime, threadId, seq);
  if (!firstResponseRunId) return;
  getLogger().info("run.first_response", {
    "run.id": firstResponseRunId,
    ...(await readRunTimingFields(prisma, firstResponseRunId)),
  });
}

export async function notifyRealtime(
  realtime: RealtimeFanout | undefined,
  threadId: string,
  cursor: number,
): Promise<void> {
  await realtime?.publish(threadTopic(threadId), JSON.stringify({ cursor })).catch(() => undefined);
}

export async function eventsAfter(
  prisma: PrismaClient,
  threadId: string,
  cursor: number,
  limit?: number,
) {
  return prisma.event.findMany({
    where: { threadId, seq: { gt: cursor } },
    orderBy: { seq: "asc" },
    ...(limit ? { take: limit } : {}),
  });
}

export async function* followThreadEvents(
  prisma: PrismaClient,
  threadId: string,
  cursor: number,
  realtime?: RealtimeFanout,
  signal?: AbortSignal,
  catchUpMs = realtime ? PUSH_CATCH_UP_MS : POLL_ONLY_CATCH_UP_MS,
): AsyncGenerator<ProductEvent> {
  let seq = cursor;
  const latch = new ChangeLatch();
  const unsubscribe = realtime
    ? await realtime
        .subscribe(threadTopic(threadId), () => latch.notify())
        .catch(() => async () => {})
    : async () => {};
  try {
    while (!signal?.aborted) {
      const observedGeneration = latch.generation;
      let batchSize = 0;
      do {
        const events = await eventsAfter(prisma, threadId, seq, EVENT_BATCH_SIZE);
        batchSize = events.length;
        for (const event of events) {
          seq = event.seq;
          yield mapProductEvent(event);
        }
      } while (batchSize === EVENT_BATCH_SIZE && !signal?.aborted);
      if (signal?.aborted) break;
      await latch.waitForChange(observedGeneration, catchUpMs, signal);
    }
  } finally {
    await unsubscribe();
  }
}

const THREAD_TOPIC = "thread:";

export function threadTopic(threadId: string): string {
  return `${THREAD_TOPIC}${threadId}`;
}

/** The same fanout, also telling `onThread` about each thread change this process publishes. */
export function observeThreadChanges(
  realtime: RealtimeFanout,
  onThread: (threadId: string) => void,
): RealtimeFanout {
  return {
    describe: () => realtime.describe(),
    publish: async (topic, payload) => {
      // The change is committed whether or not other processes heard about it.
      try {
        await realtime.publish(topic, payload);
      } finally {
        if (topic.startsWith(THREAD_TOPIC)) onThread(topic.slice(THREAD_TOPIC.length));
      }
    },
    subscribe: (topic, onMessage) => realtime.subscribe(topic, onMessage),
    close: () => realtime.close(),
  };
}

export function mapProductEvent(event: {
  id: string;
  spaceId: string;
  threadId: string;
  botId: string;
  seq: number;
  type: string;
  payload: unknown;
  runId: string | null;
  createdAt: Date;
}): ProductEvent {
  return {
    id: event.id,
    spaceId: event.spaceId,
    threadId: event.threadId,
    botId: event.botId,
    seq: event.seq,
    type: event.type as ProductEvent["type"],
    runId: event.runId ?? undefined,
    createdAt: event.createdAt.toISOString(),
    payload: event.payload as Record<string, unknown>,
  };
}

/** One account stream; signals carry no content, and a periodic re-read covers a missed publish. */
export async function* followIncomingCallSignals(
  realtime: RealtimeFanout | undefined,
  userId: string,
  signal?: AbortSignal,
): AsyncGenerator<void> {
  const latch = new ChangeLatch();
  const unsubscribe = await realtime
    ?.subscribe(`incoming-calls:${userId}`, () => latch.notify())
    .catch(() => undefined);
  // Without fanout each wake re-reads every ringing request, so poll gently.
  const catchUpMs = unsubscribe ? PUSH_CATCH_UP_MS : INCOMING_CALL_POLL_MS;
  try {
    let seen = latch.generation;
    yield;
    while (!signal?.aborted) {
      await latch.waitForChange(seen, catchUpMs, signal);
      if (signal?.aborted) return;
      seen = latch.generation;
      yield;
    }
  } finally {
    await unsubscribe?.();
  }
}

export class ChangeLatch {
  generation = 0;
  private wake: (() => void) | undefined;

  notify(): void {
    this.generation += 1;
    this.wake?.();
  }

  async waitForChange(expected: number, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    if (this.generation !== expected || signal?.aborted) return;
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", finish);
        if (this.wake === finish) this.wake = undefined;
        resolve();
      };
      const timer = setTimeout(finish, timeoutMs);
      this.wake = finish;
      signal?.addEventListener("abort", finish, { once: true });
      if (this.generation !== expected || signal?.aborted) finish();
    });
  }
}
