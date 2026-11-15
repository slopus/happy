import { listenWindow } from "../paws/runtime";
import { localStore, scopedStorageKey, isLocalStorageEvent } from "../paws/runtime";
import { useSyncExternalStore } from "react";

/** Local storage, or null where it is missing or the browser blocks it (reading it throws). */
export function readableLocalStorage(): Storage | null {
  try {
    return typeof localStore === "undefined" ? null : localStore;
  } catch {
    return null;
  }
}

/** Reads a saved string. Missing, blocked, or unavailable storage reads as nothing saved. */
export function readStoredString(key: string): string | null {
  try {
    return typeof localStore === "undefined" ? null : localStore.getItem(key);
  } catch {
    return null;
  }
}

/** Saves a string, or removes the key for `null`. Storage failures are ignored. */
export function writeStoredString(key: string, value: string | null): void {
  try {
    if (typeof localStore === "undefined") return;
    if (value === null) localStore.removeItem(key);
    else localStore.setItem(key, value);
  } catch {
    // Private mode / quota: the in-memory value still applies.
  }
}

export type StoredPreference<T> = {
  get(): T;
  set(value: T): T;
  subscribe(listener: () => void): () => void;
  use(): T;
};

/**
 * A device-local preference: read once from storage, kept in memory, and shared with every
 * subscriber. A change saved in another tab replaces the value here too. `parse` receives `null`
 * when nothing is saved or storage is unreadable, so it also decides the default; `serialize`
 * returning `null` removes the key.
 */
export function createStoredPreference<T>({
  key,
  parse,
  serialize,
}: {
  key: string;
  parse: (raw: string | null) => T;
  serialize: (value: T) => string | null;
}): StoredPreference<T> {
  const listeners = new Set<() => void>();
  let loaded = false;
  let current: T;

  function get(): T {
    if (!loaded) {
      current = parse(readStoredString(key));
      loaded = true;
    }
    return current;
  }

  function notify() {
    for (const listener of listeners) listener();
  }

  function set(value: T): T {
    current = value;
    loaded = true;
    writeStoredString(key, serialize(value));
    notify();
    return value;
  }

  // Preferences are module singletons, so this listener lives as long as the page.
  if (typeof window !== "undefined") {
    listenWindow("storage", (event) => {
      // A null key means another tab cleared all of local storage. Session storage is not ours.
      if (event.key !== scopedStorageKey(key) && event.key !== null) return;
      if (!isLocalStorageEvent(event)) return;
      // Read the saved value now: a queued event can be older than a write made since.
      current = parse(readStoredString(key));
      loaded = true;
      notify();
    });
  }

  function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  return {
    get,
    set,
    subscribe,
    use: () => useSyncExternalStore(subscribe, get, get),
  };
}
