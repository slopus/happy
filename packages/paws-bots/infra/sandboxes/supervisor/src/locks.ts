import { withKeyedLock } from "./supervisor-logic.js";

const botLifecycleLocks = new Map<string, Promise<unknown>>();
const computerScreenLocks = new Map<string, Promise<unknown>>();
const spaceComputerLocks = new Map<string, Promise<unknown>>();

// Serialize create/delete for one bot so DELETE cannot remove a per-bot network
// while POST still needs it between ensureBotNetwork and container attach.
export async function withBotLifecycleLock<T>(botId: string, task: () => Promise<T>): Promise<T> {
  return withKeyedLock(botLifecycleLocks, botId, task);
}

// Serialize screen claim/release/cancel for one computer so a restart-orphan
// cancel cannot race a replacement claim and kill the newer Chromium session.
export async function withComputerScreenLock<T>(
  computerId: string,
  task: () => Promise<T>,
): Promise<T> {
  return withKeyedLock(computerScreenLocks, computerId, task);
}

// Serialize per-space create admission (count + create) so different bots cannot
// race past SANDBOX_MAX_COMPUTERS_PER_SPACE. Callers must already hold the bot
// lifecycle lock; never acquire a bot lock while holding this lock.
export async function withSpaceComputerLock<T>(
  spaceId: string,
  task: () => Promise<T>,
): Promise<T> {
  return withKeyedLock(spaceComputerLocks, spaceId, task);
}
