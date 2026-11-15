// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
}));

import { ErrorBoundary } from "../components/ErrorBoundary";
import {
  importChunk,
  installPreloadRecovery,
  lazyComponent,
  readPreloadRecoveryState,
  recoveringByReload,
} from "./preload-recovery";

const uninstalls: Array<() => void> = [];

afterEach(() => {
  for (const uninstall of uninstalls.splice(0)) uninstall();
  vi.unstubAllGlobals();
});

function createTarget(store = new Map<string, string>(), onLine = true, state = {}) {
  let listener: EventListener | undefined;
  const reload = vi.fn();
  const target = {
    addEventListener: (_type: string, next: EventListener) => {
      listener = next;
    },
    clearTimeout: vi.fn(),
    removeEventListener: vi.fn(),
    location: { reload },
    navigator: { onLine },
    sessionStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
      removeItem: (key: string) => store.delete(key),
    },
    setTimeout: vi.fn(() => 1),
  };
  uninstalls.push(installPreloadRecovery(target as unknown as Window, () => state));
  /** What Vite's preload helper does when a chunk is missing: announce it, then reject unless cancelled. */
  const failChunk = async <T,>(): Promise<T> => {
    const event = new Event("vite:preloadError", { cancelable: true });
    listener?.(event);
    if (event.defaultPrevented) return undefined as T;
    throw new Error("Failed to fetch dynamically imported module");
  };
  return { failChunk, reload };
}

async function settled(promise: Promise<unknown>) {
  const pending = Symbol("pending");
  const result = await Promise.race([
    promise.then(
      () => "resolved",
      () => "rejected",
    ),
    new Promise((resolve) => setTimeout(() => resolve(pending), 10)),
  ]);
  return result === pending ? "pending" : result;
}

describe("preload recovery", () => {
  it("arms overlay restoration only for an automatic reload and consumes it once", async () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      removeItem: (key: string) => {
        store.delete(key);
      },
    };
    const state = { settings: true, integrations: false };
    const { failChunk } = createTarget(store, true, state);
    expect(readPreloadRecoveryState(storage)).toEqual({});
    void importChunk(failChunk);
    expect(readPreloadRecoveryState(storage)).toEqual(state);
    expect(readPreloadRecoveryState(storage)).toEqual({});
    expect(store.get("rk:preload-recovery")).toBe("1");
  });

  it("does not block startup when session storage access is restricted", () => {
    const target = {
      get sessionStorage(): Storage {
        throw new Error("Storage is restricted");
      },
    };
    expect(() => installPreloadRecovery(target as Window)()).not.toThrow();
  });

  it("ignores malformed recovery state", () => {
    const store = new Map([["rk:preload-recovery-state", "invalid"]]);
    expect(
      readPreloadRecoveryState({
        getItem: (key: string) => store.get(key) ?? null,
        removeItem: (key: string) => {
          store.delete(key);
        },
      }),
    ).toEqual({});
    expect(store.size).toBe(0);
  });

  it("reloads once and holds every failed import pending instead of resolving undefined", async () => {
    const { failChunk, reload } = createTarget();

    const first = importChunk(failChunk);
    const second = importChunk(failChunk);

    expect(await settled(first)).toBe("pending");
    expect(await settled(second)).toBe("pending");
    expect(reload).toHaveBeenCalledOnce();
    expect(recoveringByReload()).toBe(true);
  });

  it("lets a failure after the recovery reload reach the error boundary", async () => {
    const { failChunk, reload } = createTarget(new Map([["rk:preload-recovery", "1"]]));

    await expect(importChunk(failChunk)).rejects.toThrow("dynamically imported module");
    expect(reload).not.toHaveBeenCalled();
    expect(recoveringByReload()).toBe(false);
  });

  it("leaves an offline failure to the error boundary instead of reloading", async () => {
    const { failChunk, reload } = createTarget(new Map(), false);

    await expect(importChunk(failChunk)).rejects.toThrow("dynamically imported module");
    expect(reload).not.toHaveBeenCalled();
  });

  it("passes through imports that load", async () => {
    createTarget();
    await expect(importChunk(async () => ({ value: 1 }))).resolves.toEqual({ value: 1 });
  });

  async function renderLazy(failChunk: () => Promise<() => ReactNode>) {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const Section = lazyComponent(failChunk);
    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <ErrorBoundary fallback="failed">
          <Suspense fallback="loading">
            <Section />
          </Suspense>
        </ErrorBoundary>,
      );
    });
    await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
    const text = container.textContent;
    act(() => root.unmount());
    return text;
  }

  it("keeps a stale lazy component on its loading state while the page reloads", async () => {
    const { failChunk, reload } = createTarget();

    expect(await renderLazy(failChunk)).toBe("loading");
    expect(reload).toHaveBeenCalledOnce();
  });

  it("shows the error fallback when the loop guard stops another reload", async () => {
    const { failChunk, reload } = createTarget(new Map([["rk:preload-recovery", "1"]]));

    expect(await renderLazy(failChunk)).toBe("failed");
    expect(reload).not.toHaveBeenCalled();
  });
});
