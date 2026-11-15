import type { RealtimeFanout } from "@rakazo/adapter-kit";
import { abortableDelay } from "@rakazo/core";
import type { PrismaClient } from "./client.js";
import { ChangeLatch, threadTopic } from "./event-stream.js";
import { runAsSystem } from "./row-security.js";

/** Who may see a roster change: every member of these Spaces, and these people. */
export type RosterChange = { spaceIds?: readonly string[]; userIds?: readonly string[] };

/** What a member's sidebar shows: their Spaces, and the chats in them. */
export type RosterScope = { spaceIds: readonly string[]; threadIds: readonly string[] };

/** A streaming reply changes its chat often; the sidebar refetches at most this often. */
export const ROSTER_SIGNAL_SPACING_MS = 10_000;
const IDLE_WAIT_MS = 60_000;

const spaceTopic = (spaceId: string) => `roster-space:${spaceId}`;
const userTopic = (userId: string) => `roster-user:${userId}`;

export async function publishRosterChange(
  realtime: RealtimeFanout | undefined,
  change: RosterChange,
): Promise<void> {
  if (!realtime) return;
  const topics = [
    ...(change.spaceIds ?? []).map(spaceTopic),
    ...(change.userIds ?? []).map(userTopic),
  ];
  await Promise.all(topics.map((topic) => realtime.publish(topic, "").catch(() => undefined)));
}

export function loadRosterScope(prisma: PrismaClient, userId: string): Promise<RosterScope> {
  return runAsSystem("roster signals across the member's Spaces", async () => {
    const memberships = await prisma.spaceMember.findMany({
      where: { userId },
      select: { spaceId: true },
    });
    const spaceIds = memberships.map((membership) => membership.spaceId);
    const threads = await prisma.thread.findMany({
      where: { spaceId: { in: spaceIds }, helperBotId: null },
      select: { id: true },
    });
    return { spaceIds, threadIds: threads.map((thread) => thread.id) };
  });
}

/**
 * Signals once when following starts, then whenever the member's sidebar may have changed: a
 * roster change published for them or one of their Spaces, or any event in a chat of those
 * Spaces. Signals carry no content. The scope is re-read after each wake so new chats and Spaces
 * join, and signals are spaced so a burst becomes one.
 */
export async function* followRosterChanges(
  realtime: RealtimeFanout,
  userId: string,
  loadScope: () => Promise<RosterScope>,
  signal?: AbortSignal,
  spacingMs = ROSTER_SIGNAL_SPACING_MS,
): AsyncGenerator<void> {
  const latch = new ChangeLatch();
  const subscriptions = new Map<string, () => Promise<void>>();
  const watch = async () => {
    const scope = await loadScope();
    const topics = new Set([
      userTopic(userId),
      ...scope.spaceIds.map(spaceTopic),
      ...scope.threadIds.map(threadTopic),
    ]);
    for (const [topic, unsubscribe] of subscriptions) {
      if (topics.has(topic)) continue;
      subscriptions.delete(topic);
      await unsubscribe();
    }
    for (const topic of topics) {
      if (subscriptions.has(topic)) continue;
      subscriptions.set(topic, await realtime.subscribe(topic, () => latch.notify()));
    }
  };
  try {
    await watch();
    let seen = latch.generation;
    // The first signal tells the client push works, and covers what it missed while away.
    yield;
    while (!signal?.aborted) {
      await latch.waitForChange(seen, IDLE_WAIT_MS, signal);
      if (signal?.aborted) return;
      if (latch.generation === seen) {
        // An idle check also picks up chats a missed roster signal never told this stream about.
        await watch().catch(() => undefined);
        continue;
      }
      seen = latch.generation;
      // A failed re-read keeps the chats already watched; the next wake tries again.
      await watch().catch(() => undefined);
      yield;
      await abortableDelay(spacingMs, signal);
    }
  } finally {
    await Promise.all([...subscriptions.values()].map((unsubscribe) => unsubscribe()));
  }
}
