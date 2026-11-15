import type { RunActivityRow } from "@rakazo/contracts";
import { chatSnoozed } from "./chat-snooze.js";
import { isRunWaitingOnUser, isRunWorking } from "./run-state.js";
import { isAgedStuckWork } from "./stuck-work.js";

type ActivityRun = Pick<RunActivityRow, "botId" | "groupId" | "status" | "updatedAt">;
type ActivityBot = { id: string; unread: boolean; snoozedUntil?: string | null };
type ActivityGroup = { id: string; unread: boolean; snoozedUntil?: string | null };

/** A question or forgotten queue wins over work, and an unread failure is something to look at. */
export function activityAttention(
  run: ActivityRun,
  unread = false,
): "needs_attention" | "working" | "unread" | null {
  if (isRunWaitingOnUser(run.status) || isAgedStuckWork(run.status, run.updatedAt))
    return "needs_attention";
  if (isRunWorking(run.status)) return "working";
  if (!unread) return null;
  return run.status === "failed" ? "needs_attention" : "unread";
}

const chatKey = (run: ActivityRun) => (run.groupId ? `group:${run.groupId}` : `bot:${run.botId}`);

/**
 * Splits activity into what needs the user, what is running, unread chats, and the rest. A snoozed
 * chat stays out of all of them until it wakes, as it does in the chat list.
 */
export function activitySections<
  Run extends ActivityRun,
  Bot extends ActivityBot,
  Group extends ActivityGroup,
>({
  active,
  recent,
  bots: allBots,
  groups: allGroups,
  now = Date.now(),
}: {
  active: readonly Run[];
  recent: readonly Run[];
  bots: readonly Bot[];
  groups: readonly Group[];
  now?: number;
}) {
  const bots = allBots.filter((bot) => !chatSnoozed(bot, now));
  const groups = allGroups.filter((group) => !chatSnoozed(group, now));
  const snoozed = new Set([
    ...allBots.filter((bot) => chatSnoozed(bot, now)).map((bot) => `bot:${bot.id}`),
    ...allGroups.filter((group) => chatSnoozed(group, now)).map((group) => `group:${group.id}`),
  ]);
  const listed = (run: Run) => !snoozed.has(chatKey(run));
  active = active.filter(listed);
  recent = recent.filter(listed);
  const unreadChats = new Set([
    ...bots.filter((bot) => bot.unread).map((bot) => `bot:${bot.id}`),
    ...groups.filter((group) => group.unread).map((group) => `group:${group.id}`),
  ]);
  const runUnread = (run: Run) => unreadChats.has(chatKey(run));
  // One run speaks for each chat: a question first, then live work, then the latest outcome
  // (`recent` is newest first).
  const byChat = new Map<string, Run>();
  const waiting = active.filter((run) => activityAttention(run) === "needs_attention");
  for (const run of [...waiting, ...active, ...recent]) {
    if (!byChat.has(chatKey(run))) byChat.set(chatKey(run), run);
  }
  const latest = [...byChat.values()];
  const attention = latest.filter(
    (run) => activityAttention(run, runUnread(run)) === "needs_attention",
  );
  const working = latest.filter((run) => activityAttention(run, runUnread(run)) === "working");
  const busy = new Set([...attention, ...working].map(chatKey));
  const settled = latest.filter((run) => !busy.has(chatKey(run)));
  return {
    attention,
    working,
    unreadGroups: groups.filter((group) => group.unread && !busy.has(`group:${group.id}`)),
    unreadBots: bots.filter((bot) => bot.unread && !busy.has(`bot:${bot.id}`)),
    /** Each quiet chat's latest run, unread ones included, for views that hide the Unread section. */
    settled,
    recent: settled.filter((run) => !runUnread(run)),
  };
}
