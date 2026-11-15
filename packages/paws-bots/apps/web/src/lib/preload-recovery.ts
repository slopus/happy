import { sessionStore } from "../paws/runtime";
import type { ComponentType } from "react";
import { lazy, useLayoutEffect, useState } from "react";

const PRELOAD_RECOVERY_KEY = "rk:preload-recovery";
const PRELOAD_RECOVERY_STATE_KEY = "rk:preload-recovery-state";
let restoredState: Record<string, unknown> = {};
const overlayState: Record<string, unknown> = {};

/** Only recovery reloads write this snapshot; reading it consumes it. */
export function readPreloadRecoveryState(
  storage: Pick<Storage, "getItem" | "removeItem">,
): Record<string, unknown> {
  try {
    const saved = storage.getItem(PRELOAD_RECOVERY_STATE_KEY);
    storage.removeItem(PRELOAD_RECOVERY_STATE_KEY);
    const value: unknown = JSON.parse(saved ?? "null");
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** Opt in read-only overlay state, never create or confirmation dialogs. */
export function usePreloadRecoveryState<T>(key: string, initial: T) {
  const state = useState<T>(() => (key in restoredState ? (restoredState[key] as T) : initial));
  const [value] = state;
  useLayoutEffect(() => {
    delete restoredState[key];
    overlayState[key] = value;
    return () => {
      delete overlayState[key];
    };
  }, [key, value]);
  return state;
}

const PRELOAD_RECOVERY_COOLDOWN_MS = 30_000;
let reloading = false;
let reloadOnce: () => boolean = () => false;
const untilReload = new Promise<never>(() => {});

/**
 * Every dynamic import goes through here. When a stale chunk has started the
 * recovery reload, the import stays pending instead of rejecting, so Suspense
 * keeps its fallback until the page unloads rather than rendering an error.
 */
export function importChunk<T>(load: () => Promise<T>): Promise<T> {
  return load().catch((error: unknown) => {
    if (reloading) return untilReload;
    throw error;
  });
}

/** `React.lazy` for a named export, held pending like `importChunk` during recovery. */
export function lazyComponent<Props>(load: () => Promise<ComponentType<Props>>) {
  return lazy(() => importChunk(load).then((component) => ({ default: component })));
}

type PreloadRecoveryWindow = Pick<
  Window,
  | "addEventListener"
  | "clearTimeout"
  | "location"
  | "navigator"
  | "removeEventListener"
  | "sessionStorage"
  | "setTimeout"
>;

/**
 * Vite emits this event when a lazy chunk from an older deployment no longer
 * exists. Reload once so the browser receives the current asset manifest.
 * The event is not cancelled: cancelling makes the import resolve to
 * `undefined`, which crashes `React.lazy` before the reload lands. The import
 * rejects instead and `importChunk` holds it pending while the page reloads.
 * While offline a reload would only reach the browser's offline page, so the
 * failure is left to the app's error boundaries, which offer a retry.
 */
export function installPreloadRecovery(
  target: PreloadRecoveryWindow = window,
  getState: () => Record<string, unknown> = () => overlayState,
): () => void {
  let storage: Storage;
  try {
    storage = target.sessionStorage;
  } catch {
    restoredState = {};
    return () => {};
  }
  restoredState = readPreloadRecoveryState(storage);
  const clearRecovery = target.setTimeout(
    () => storage.removeItem(PRELOAD_RECOVERY_KEY),
    PRELOAD_RECOVERY_COOLDOWN_MS,
  );
  reloadOnce = () => {
    if (reloading) return false;
    if (!target.navigator.onLine || storage.getItem(PRELOAD_RECOVERY_KEY)) return false;
    storage.setItem(PRELOAD_RECOVERY_KEY, "1");
    try {
      storage.setItem(PRELOAD_RECOVERY_STATE_KEY, JSON.stringify(getState()));
    } catch {
      // Recovery still works when the overlay snapshot cannot be stored.
    }
    reloading = true;
    target.location.reload();
    return true;
  };
  const onPreloadError = () => void reloadOnce();

  target.addEventListener("vite:preloadError", onPreloadError);
  return () => {
    reloading = false;
    reloadOnce = () => false;
    target.clearTimeout(clearRecovery);
    target.removeEventListener("vite:preloadError", onPreloadError);
  };
}

/**
 * True once a recovery reload is under way. Failures from then on are replaced by the reloaded page,
 * so they are not worth reporting.
 */
export function recoveringByReload(): boolean {
  return reloading;
}

/**
 * Reload to pick up a newer deployment, under the same guard as stale-chunk recovery: at most one
 * reload per cooldown, never offline, and with read-only overlays restored afterwards. False when
 * the guard refused.
 */
export function recoveryReload(): boolean {
  return reloadOnce();
}
