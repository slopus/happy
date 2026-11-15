import { localStore } from "../paws/runtime";
export const SEEN_RUN_ERROR_LIMIT = 100;
const SEEN_RUN_ERROR_STORAGE_KEY_PREFIX = "rakazo:seen-run-error:";

type RunErrorStorage = Pick<Storage, "getItem" | "key" | "length" | "removeItem" | "setItem">;

function browserStorage(): RunErrorStorage | null {
  try {
    return typeof localStore === "undefined" ? null : localStore;
  } catch {
    return null;
  }
}

export function readSeenRunErrorIds(
  storage: RunErrorStorage | null = browserStorage(),
): Set<string> {
  if (!storage) return new Set();
  try {
    const ids = new Set<string>();
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key?.startsWith(SEEN_RUN_ERROR_STORAGE_KEY_PREFIX)) {
        ids.add(key.slice(SEEN_RUN_ERROR_STORAGE_KEY_PREFIX.length));
      }
    }
    return ids;
  } catch {
    return new Set();
  }
}

export function rememberSeenRunErrorId(
  id: string,
  storage: RunErrorStorage | null = browserStorage(),
): void {
  if (!storage) return;
  try {
    const currentKey = `${SEEN_RUN_ERROR_STORAGE_KEY_PREFIX}${id}`;
    if (storage.getItem(currentKey) !== null) return;
    const entries: Array<{ key: string; seenAt: number }> = [];
    let newestSeenAt = 0;
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key?.startsWith(SEEN_RUN_ERROR_STORAGE_KEY_PREFIX)) {
        const storedSeenAt = Number(storage.getItem(key));
        const seenAt = Number.isFinite(storedSeenAt) ? storedSeenAt : 0;
        entries.push({ key, seenAt });
        newestSeenAt = Math.max(newestSeenAt, seenAt);
      }
    }
    const seenAt = Math.max(Date.now(), newestSeenAt + 1);
    storage.setItem(currentKey, String(seenAt));
    entries.push({ key: currentKey, seenAt });
    entries.sort((left, right) => right.seenAt - left.seenAt || right.key.localeCompare(left.key));
    for (const { key } of entries.slice(SEEN_RUN_ERROR_LIMIT)) storage.removeItem(key);
  } catch {
    // Keep the current-session error behavior when storage is unavailable.
  }
}
