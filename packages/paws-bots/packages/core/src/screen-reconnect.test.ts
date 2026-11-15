import { describe, expect, it, vi } from "vitest";
import {
  createScreenReconnect,
  createScreenReconnects,
  SCREEN_RECONNECT_DELAY_MS,
  SCREEN_RECONNECT_STABLE_MS,
  SCREEN_RECONNECT_TRIES,
  SCREEN_RECONNECT_WAIT_MS,
  screenProbeUrl,
  waitForScreenPage,
} from "./screen-reconnect.js";

describe("screen reconnect", () => {
  it("reconnects a screen that drops after connecting", () => {
    const screen = createScreenReconnect();
    expect(screen.report("loading")).toBe("none");
    expect(screen.report("connected", 0)).toBe("none");
    expect(screen.report("disconnected", 1_000)).toBe("reconnect");
  });

  it("shows the error for a screen that never connected", () => {
    const screen = createScreenReconnect();
    expect(screen.report("connecting", 0)).toBe("none");
    expect(screen.report("disconnected", 0)).toBe("error");
    expect(screen.report("failed", 0)).toBe("error");
  });

  it("reconnects a screen that reports its drop as a failure", () => {
    // The computer's embed page marks an unclean disconnect, such as the proxy closing the
    // socket, as an error.
    const screen = createScreenReconnect();
    screen.report("connected", 0);
    expect(screen.report("failed", 1_000)).toBe("reconnect");
    screen.loaded();
    screen.report("connected", 2_000);
    expect(screen.report("failed", 3_000)).toBe("reconnect");
  });

  it("reconnects every drop of a connection that stays up, as often as the computer restarts", () => {
    // A bot's run restarts the screen every ten to twenty seconds; each restart drops the
    // viewer's connection, and each reload brings the screen back for that long again.
    const screen = createScreenReconnect();
    let time = 0;
    for (let drop = 0; drop < 4; drop += 1) {
      screen.loaded();
      screen.report("connected", time);
      expect(screen.report("disconnected", time + SCREEN_RECONNECT_STABLE_MS)).toBe("reconnect");
      expect(screen.delayMs()).toBe(SCREEN_RECONNECT_DELAY_MS);
      time += SCREEN_RECONNECT_STABLE_MS + 2_000;
    }
  });

  it("runs out and shows the error when each connection only flashes up", () => {
    // Two viewers the provider keeps displacing connect for a moment and drop again; the
    // reconnects stay bounded instead of cycling forever.
    const screen = createScreenReconnect();
    let time = 0;
    for (let drop = 1; drop <= SCREEN_RECONNECT_TRIES; drop += 1) {
      screen.loaded();
      screen.report("connected", time);
      expect(screen.report("disconnected", time + 1_000)).toBe("reconnect");
      expect(screen.delayMs()).toBe(SCREEN_RECONNECT_DELAY_MS * 2 ** (drop - 1));
      time += 2_000;
    }
    screen.loaded();
    screen.report("connected", time);
    expect(screen.report("disconnected", time + 1_000)).toBe("error");
  });

  it("spends one try per load, not per report", () => {
    // A dying page can report several terminal states for the same load: a disconnect, an
    // error, a ticket error. Only the load's first report spends a try.
    const screen = createScreenReconnect();
    screen.loaded();
    screen.report("connected", 0);
    expect(screen.report("disconnected", 1_000)).toBe("reconnect");
    expect(screen.delayMs()).toBe(SCREEN_RECONNECT_DELAY_MS);
    for (const state of ["failed", "disconnected", "failed"] as const) {
      expect(screen.report(state, 1_100)).toBe("reconnect");
      expect(screen.delayMs()).toBe(SCREEN_RECONNECT_DELAY_MS);
    }
    screen.loaded();
    expect(screen.report("failed", 3_000)).toBe("reconnect");
    expect(screen.delayMs()).toBe(SCREEN_RECONNECT_DELAY_MS * 2);
  });

  it("loads a reloaded screen again when it never connected, waiting longer each time", () => {
    // The reload races the restart: the page loads, but the screen server refuses its
    // connection once. That reload tries again rather than showing the error.
    const screen = createScreenReconnect();
    screen.loaded();
    screen.report("connected", 0);
    expect(screen.report("disconnected", 1_000)).toBe("reconnect");
    expect(screen.delayMs()).toBe(SCREEN_RECONNECT_DELAY_MS);
    for (let retry = 2; retry <= SCREEN_RECONNECT_TRIES; retry += 1) {
      screen.loaded();
      expect(screen.report("failed", retry * 1_000)).toBe("reconnect");
      expect(screen.delayMs()).toBe(SCREEN_RECONNECT_DELAY_MS * 2 ** (retry - 1));
    }
  });

  it("shows the error once the retries come back without connecting", () => {
    const screen = createScreenReconnect();
    screen.loaded();
    screen.report("connected", 0);
    expect(screen.report("disconnected", 1_000)).toBe("reconnect");
    for (let retry = 2; retry <= SCREEN_RECONNECT_TRIES; retry += 1) {
      screen.loaded();
      expect(screen.report("failed", retry * 1_000)).toBe("reconnect");
    }
    screen.loaded();
    expect(screen.report("failed", 9_000)).toBe("error");
  });

  it("starts the retries over once a reload connects and stays up", () => {
    const screen = createScreenReconnect();
    screen.loaded();
    screen.report("connected", 0);
    screen.report("disconnected", 1_000);
    screen.loaded();
    expect(screen.report("failed", 3_000)).toBe("reconnect");
    screen.loaded();
    screen.report("connected", 4_000);
    // A connection that stays up ends the trouble; a later drop starts the retries over.
    expect(screen.report("disconnected", 4_000 + SCREEN_RECONNECT_STABLE_MS)).toBe("reconnect");
    expect(screen.delayMs()).toBe(SCREEN_RECONNECT_DELAY_MS);
  });

  it("starts over after a retry someone pressed", () => {
    // The screen ran out of tries and showed its error; the person pressed Retry, which is a
    // fresh try at the screen rather than another reload of the same trouble.
    const screen = createScreenReconnect();
    screen.loaded();
    screen.report("connected", 0);
    screen.report("disconnected", 1_000);
    for (let retry = 2; retry <= SCREEN_RECONNECT_TRIES; retry += 1) {
      screen.loaded();
      screen.report("failed", retry * 1_000);
    }
    screen.loaded();
    expect(screen.report("failed", 9_000)).toBe("error");
    screen.reset();
    screen.loaded();
    screen.report("connected", 10_000);
    expect(screen.report("disconnected", 11_000)).toBe("reconnect");
    expect(screen.delayMs()).toBe(SCREEN_RECONNECT_DELAY_MS);
  });

  it("keeps measuring a connection's life when the wall clock jumps backwards", () => {
    vi.useFakeTimers();
    try {
      const screen = createScreenReconnect();
      screen.loaded();
      screen.report("connected");
      vi.advanceTimersByTime(1_000);
      expect(screen.report("disconnected")).toBe("reconnect");
      screen.loaded();
      screen.report("connected");
      vi.advanceTimersByTime(SCREEN_RECONNECT_STABLE_MS);
      // The wall clock is corrected backwards; the connection really stayed up.
      vi.setSystemTime(Date.now() - 60_000);
      expect(screen.report("disconnected")).toBe("reconnect");
      expect(screen.delayMs()).toBe(SCREEN_RECONNECT_DELAY_MS);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("screen reconnects per computer", () => {
  it("gives each bot's screen its own allowance", () => {
    const screens = createScreenReconnects();
    screens.for("bot-a").loaded();
    screens.for("bot-a").report("connected", 0);
    expect(screens.for("bot-a").report("disconnected", 1_000)).toBe("reconnect");
    // bot-a's reload raced a restart and tries again; bot-b's drop is unaffected.
    screens.for("bot-a").loaded();
    expect(screens.for("bot-a").report("failed", 3_000)).toBe("reconnect");
    screens.for("bot-b").loaded();
    screens.for("bot-b").report("connected", 0);
    expect(screens.for("bot-b").report("disconnected", 1_000)).toBe("reconnect");
  });
});

describe("waiting for a dropped screen's page", () => {
  function clock() {
    let time = 0;
    return {
      now: () => time,
      sleep: async (ms: number) => {
        time += ms;
      },
    };
  }

  it("waits while the access check can't reach the API, then loads", async () => {
    const statuses = [503, 503, 503, 200];
    const probe = vi.fn(async () => statuses.shift()!);
    expect(await waitForScreenPage(probe, clock())).toBe("ready");
    expect(probe).toHaveBeenCalledTimes(4);
  });

  it("waits out a dropped request or a restarting screen server too", async () => {
    for (const first of [null, 502]) {
      const statuses = [first, 200];
      const probe = vi.fn(async () => statuses.shift()!);
      expect(await waitForScreenPage(probe, clock())).toBe("ready");
      expect(probe).toHaveBeenCalledTimes(2);
    }
  });

  it("stops at once on a refusal or anything other than unavailable", async () => {
    for (const status of [0, 401, 403, 404, 500, 504]) {
      const probe = vi.fn(async () => status);
      expect(await waitForScreenPage(probe, clock())).toBe("refused");
      expect(probe).toHaveBeenCalledTimes(1);
    }
  });

  it("gives up after fifteen seconds of a page that can't be checked", async () => {
    const time = clock();
    const probe = vi.fn(async () => 503);
    expect(await waitForScreenPage(probe, time)).toBe("timeout");
    expect(probe).toHaveBeenCalledTimes(15);
    expect(time.now()).toBe(SCREEN_RECONNECT_WAIT_MS - 1_000);
  });

  it("stops asking once the screen is closed or its link changes", async () => {
    const closed = new AbortController();
    const probe = vi.fn(async () => {
      closed.abort();
      return 503;
    });
    expect(await waitForScreenPage(probe, { signal: closed.signal, ...clock() })).toBe("cancelled");
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("ends on time while a probe never answers, and aborts it", async () => {
    vi.useFakeTimers();
    try {
      let probeSignal: AbortSignal | undefined;
      const probe = vi.fn((signal: AbortSignal) => {
        probeSignal = signal;
        return new Promise<number | null>(() => undefined);
      });
      const outcome = waitForScreenPage(probe);
      await vi.advanceTimersByTimeAsync(SCREEN_RECONNECT_WAIT_MS - 1);
      expect(probeSignal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await outcome).toBe("timeout");
      expect(probeSignal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops at once and aborts the probe still out when the screen is closed", async () => {
    vi.useFakeTimers();
    try {
      const closed = new AbortController();
      let probeSignal: AbortSignal | undefined;
      const outcome = waitForScreenPage(
        (signal) => {
          probeSignal = signal;
          return new Promise<number | null>(() => undefined);
        },
        { signal: closed.signal },
      );
      await vi.advanceTimersByTimeAsync(2_000);
      closed.abort();
      expect(await outcome).toBe("cancelled");
      expect(probeSignal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the screen's status-only probe", () => {
  it("marks a screen path or URL as a probe, keeping its own query", () => {
    expect(screenProbeUrl("/novnc/session/view/1.t/vnc.html")).toBe(
      "/novnc/session/view/1.t/vnc.html?rakazo_probe=1",
    );
    expect(screenProbeUrl("https://app.example.test/novnc/session/control/1.t/vnc.html?a=b")).toBe(
      "https://app.example.test/novnc/session/control/1.t/vnc.html?a=b&rakazo_probe=1",
    );
    expect(screenProbeUrl("/novnc/x?a=b#top")).toBe("/novnc/x?a=b&rakazo_probe=1#top");
  });
});
