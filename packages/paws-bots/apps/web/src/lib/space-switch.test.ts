import { afterEach, describe, expect, it, vi } from "vitest";

type Transition = { update: () => Promise<void>; done: () => void; skip: () => void };

/** A fake document whose view transitions run their update only when told to. */
function stubTransitions() {
  const transitions: Transition[] = [];
  const classes = new Set<string>();
  vi.stubGlobal("window", {
    matchMedia: () => ({ matches: false }),
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
  });
  vi.stubGlobal("document", {
    documentElement: {
      classList: {
        add: (name: string) => classes.add(name),
        remove: (name: string) => classes.delete(name),
      },
    },
    startViewTransition(update: () => Promise<void>) {
      let done = () => {};
      let skip = () => {};
      let abort = () => {};
      const ready = new Promise<void>((_resolve, reject) => {
        abort = () => reject(new DOMException("Document hidden", "InvalidStateError"));
      });
      const finished = new Promise<void>((resolve, reject) => {
        done = resolve;
        skip = () => {
          abort();
          reject(new Error("Transition skipped"));
        };
      });
      transitions.push({ update, done, skip });
      return { ready, finished };
    },
  });
  return { transitions, classes };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("switching spaces in place", () => {
  it("releases a skipped transition without an unhandled rejection", async () => {
    const { transitions, classes } = stubTransitions();
    const { remountShellForSpace } = await import("./space-switch");
    remountShellForSpace(() => true);
    expect(classes.has("rk-space-switching")).toBe(true);
    transitions[0]!.skip();
    await Promise.resolve();
    expect(classes.has("rk-space-switching")).toBe(false);
  });

  it("does not remount when the switch is abandoned", async () => {
    const { transitions } = stubTransitions();
    const { remountShellForSpace } = await import("./space-switch");
    const commit = vi.fn(() => false);
    remountShellForSpace(commit);
    await transitions[0]!.update();
    expect(commit).toHaveBeenCalledOnce();
  });

  it("releases each held screen with its own shell, even when switches overlap", async () => {
    vi.useFakeTimers();
    const { transitions, classes } = stubTransitions();
    const { markShellReady, remountShellForSpace } = await import("./space-switch");
    remountShellForSpace(() => true);
    const first = transitions[0]!.update();
    await vi.advanceTimersByTimeAsync(1_000);
    remountShellForSpace(() => true);
    const second = transitions[1]!.update();
    let secondDone = false;
    void second.then(() => {
      secondDone = true;
    });
    // Only the first switch has waited long enough to give up.
    await vi.advanceTimersByTimeAsync(500);
    await first;
    expect(secondDone).toBe(false);
    markShellReady();
    await vi.advanceTimersByTimeAsync(0);
    expect(secondDone).toBe(true);
    // The class stays until the last transition finishes.
    transitions[0]!.done();
    await vi.advanceTimersByTimeAsync(0);
    expect(classes.has("rk-space-switching")).toBe(true);
    transitions[1]!.done();
    await vi.advanceTimersByTimeAsync(0);
    expect(classes.has("rk-space-switching")).toBe(false);
  });
});

describe("shell navigation", () => {
  it("uses the latest router navigate without replacing the guard", async () => {
    const { guardShellNavigate } = await import("./space-switch");
    const first = vi.fn();
    const latest = vi.fn();
    let navigate = first;
    const guarded = guardShellNavigate(
      () => navigate,
      () => true,
    );
    guarded("/app/a");
    navigate = latest;
    guarded("/app/b");
    expect(first).toHaveBeenCalledExactlyOnceWith("/app/a", undefined);
    expect(latest).toHaveBeenCalledExactlyOnceWith("/app/b", undefined);
  });

  it("navigates during the switch commit and ignores late work after unmount", async () => {
    vi.useFakeTimers();
    const { transitions } = stubTransitions();
    const { guardShellNavigate, remountShellForSpace, markShellReady } = await import(
      "./space-switch"
    );
    const navigate = vi.fn();
    let alive = true;
    const guarded = guardShellNavigate(
      () => navigate,
      () => alive,
    );
    remountShellForSpace(() => {
      guarded("/app/bot-b", { replace: true });
      return true;
    });
    const update = transitions[0]!.update();
    guarded(-1);
    expect(navigate.mock.calls).toEqual([["/app/bot-b", { replace: true }], [-1]]);
    alive = false;
    guarded("/app/bot-a");
    guarded(-1);
    expect(navigate).toHaveBeenCalledTimes(2);
    markShellReady();
    await update;
    transitions[0]!.done();
  });
});

describe("space switch decision", () => {
  it("commits despite query and hash changes on the same pathname", async () => {
    const { spaceSwitchDecision } = await import("./space-switch");
    const started = new URL("https://example.test/app/bot-a");
    const current = new URL("https://example.test/app/bot-a?panel=files#preview");
    expect(spaceSwitchDecision(true, started.pathname, current.pathname, false)).toBe("commit");
  });

  it("abandons superseded requests and navigation to another pathname", async () => {
    const { spaceSwitchDecision } = await import("./space-switch");
    expect(spaceSwitchDecision(false, "/app/a", "/app/a", true)).toBe("abandon");
    expect(spaceSwitchDecision(true, "/app/a", "/app/c", false)).toBe("abandon");
  });

  it("reloads if a call starts before the transition commits", async () => {
    const { spaceSwitchDecision } = await import("./space-switch");
    expect(spaceSwitchDecision(true, "/app/a", "/app/a", true)).toBe("reload");
  });
});
