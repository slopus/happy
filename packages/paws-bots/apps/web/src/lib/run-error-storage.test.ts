import type { ThreadSnapshot } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  readSeenRunErrorIds,
  rememberSeenRunErrorId,
  SEEN_RUN_ERROR_LIMIT,
} from "./run-error-storage";
import { threadRunError } from "./thread-events";

function storage(values = new Map<string, string>()) {
  return {
    get length() {
      return values.size;
    },
    getItem: (key: string) => values.get(key) ?? null,
    key: (index: number) => [...values.keys()][index] ?? null,
    removeItem: (key: string) => values.delete(key),
    setItem: (key: string, value: string) => values.set(key, value),
  };
}

function failedSnapshot(id: string): ThreadSnapshot {
  return {
    botId: "bot-1",
    threadId: "thread-1",
    cursor: 1,
    messages: [],
    olderCursor: null,
    run: {
      id,
      botId: "bot-1",
      threadId: "thread-1",
      taskId: "task-1",
      status: "failed",
      trigger: "user",
      routineId: null,
      modelProvider: null,
      modelId: null,
      error: "connection refused",
      startedAt: null,
      completedAt: null,
      createdAt: "2026-08-31T00:00:00.000Z",
    },
  };
}

describe("seen run error storage", () => {
  it("keeps the shell usable when browser storage access is blocked", () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get: () => {
        throw new DOMException("blocked", "SecurityError");
      },
    });

    try {
      expect(() => readSeenRunErrorIds()).not.toThrow();
      expect(() => rememberSeenRunErrorId("run-1")).not.toThrow();
    } finally {
      if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor);
      else Reflect.deleteProperty(globalThis, "localStorage");
    }
  });

  it("shows a new failure once, then suppresses the same stored failure after reload", () => {
    const localStorage = storage();
    const failed = failedSnapshot("run-old");

    const firstLoad = readSeenRunErrorIds(localStorage);
    expect(threadRunError(failed, firstLoad)).toBe("connection refused");

    rememberSeenRunErrorId("run-old", localStorage);
    expect(threadRunError(failed, firstLoad)).toBe("connection refused");

    const reloaded = readSeenRunErrorIds(localStorage);
    expect(threadRunError(failed, reloaded)).toBeNull();
    expect(threadRunError(failedSnapshot("run-new"), reloaded)).toBe("connection refused");
  });

  it("bounds persisted failures to the newest IDs", () => {
    const localStorage = storage();
    for (let index = 0; index <= SEEN_RUN_ERROR_LIMIT; index += 1) {
      rememberSeenRunErrorId(`run-${index}`, localStorage);
    }

    const reloaded = readSeenRunErrorIds(localStorage);
    expect(reloaded).toHaveLength(SEEN_RUN_ERROR_LIMIT);
    expect(reloaded.has("run-0")).toBe(false);
    expect(reloaded.has(`run-${SEEN_RUN_ERROR_LIMIT}`)).toBe(true);
  });

  it("does not lose an ID when another tab writes from a stale read", () => {
    const values = new Map<string, string>();
    const currentTab = storage(values);
    const staleTab = {
      get length() {
        return currentTab.length;
      },
      getItem: () => null,
      key: currentTab.key,
      removeItem: currentTab.removeItem,
      setItem: currentTab.setItem,
    };

    rememberSeenRunErrorId("run-current", currentTab);
    rememberSeenRunErrorId("run-stale", staleTab);

    expect(readSeenRunErrorIds(currentTab)).toEqual(new Set(["run-current", "run-stale"]));
  });

  it("does not refresh or prune an ID that is already recorded", () => {
    const values = new Map<string, string>();
    for (let index = 0; index < SEEN_RUN_ERROR_LIMIT; index += 1) {
      values.set(`rakazo:seen-run-error:run-${index}`, String(index + 1));
    }
    const currentStorage = storage(values);
    const setItem = vi.fn(currentStorage.setItem);
    const removeItem = vi.fn(currentStorage.removeItem);

    rememberSeenRunErrorId("run-0", { ...currentStorage, setItem, removeItem });

    expect(setItem).not.toHaveBeenCalled();
    expect(removeItem).not.toHaveBeenCalled();
    expect(readSeenRunErrorIds(currentStorage)).toHaveLength(SEEN_RUN_ERROR_LIMIT);
  });

  it("retains the ID just seen when stored timestamps tie", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1);
    const localStorage = storage();
    try {
      for (let index = 0; index < SEEN_RUN_ERROR_LIMIT; index += 1) {
        rememberSeenRunErrorId(`z-run-${index}`, localStorage);
      }
      rememberSeenRunErrorId("a-new-run", localStorage);

      const reloaded = readSeenRunErrorIds(localStorage);
      expect(reloaded).toHaveLength(SEEN_RUN_ERROR_LIMIT);
      expect(reloaded.has("a-new-run")).toBe(true);
    } finally {
      now.mockRestore();
    }
  });
});
