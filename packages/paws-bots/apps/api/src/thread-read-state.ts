import { ORPCError } from "@orpc/server";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import {
  markThreadReadFor,
  markThreadUnreadFromFor,
  setThreadSnoozeFor,
  setThreadUnreadFor,
} from "@rakazo/db";
import type { ThreadTarget } from "./thread-target.js";

/** The actor's own read state for a chat. */
function readerOf(actor: Actor, target: ThreadTarget) {
  return { threadId: target.threadId, spaceId: actor.spaceId, userId: actor.userId };
}

/**
 * Marks the chat read up to its latest message for the actor. Returns the seq they had read up
 * to before, or null when it wasn't unread for them or nothing new arrived.
 */
export function markThreadRead(
  prisma: PrismaClient,
  actor: Actor,
  target: ThreadTarget,
): Promise<number | null> {
  return markThreadReadFor(prisma, readerOf(actor, target));
}

/**
 * Marks the chat unread for the actor from one of its messages: their read cursor moves to just
 * before it, so their next open puts the New divider above that message.
 */
export async function markThreadUnreadFrom(
  prisma: PrismaClient,
  actor: Actor,
  target: ThreadTarget,
  messageId: string,
) {
  if (!(await markThreadUnreadFromFor(prisma, readerOf(actor, target), messageId))) {
    throw new ORPCError("NOT_FOUND");
  }
}

export async function setThreadUnreadState(
  prisma: PrismaClient,
  actor: Actor,
  target: ThreadTarget,
  unread: boolean,
) {
  await setThreadUnreadFor(prisma, readerOf(actor, target), unread);
}

/** The longest a chat can be snoozed. */
const MAX_SNOOZE_MS = 366 * 24 * 60 * 60 * 1000;

/** Snoozes the chat for the actor until `until`, or wakes it with null. */
export async function setThreadSnooze(
  prisma: PrismaClient,
  actor: Actor,
  target: ThreadTarget,
  until: string | null,
  now = Date.now(),
) {
  const wake = until === null ? null : new Date(until);
  if (wake && (wake.getTime() <= now || wake.getTime() - now > MAX_SNOOZE_MS)) {
    throw new ORPCError("BAD_REQUEST", { message: "Pick a time within the next year" });
  }
  await setThreadSnoozeFor(prisma, readerOf(actor, target), wake);
}
