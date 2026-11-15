/** How long a dropped screen waits before it loads again by itself. */
export const SCREEN_RECONNECT_DELAY_MS = 1_000;
/**
 * How many times a screen loads itself again over one trouble before its error shows: the
 * load right after a drop, then one more for each reload that comes back without connecting
 * for long. A connection that stays up for SCREEN_RECONNECT_STABLE_MS ends the trouble, so a
 * screen the computer keeps restarting — each restart drops it, each reload brings it back —
 * reconnects every time without the error.
 */
export const SCREEN_RECONNECT_TRIES = 3;
/**
 * How long a connection must stay up before the next drop counts as a new trouble rather
 * than the same one. The restarts a working bot causes are at least this far apart, while a
 * connection that only flashes up — such as one of two viewers a provider keeps displacing —
 * drops within a second or two of connecting.
 */
export const SCREEN_RECONNECT_STABLE_MS = 5_000;
/**
 * Marks a screen request as a status-only probe. The web server answers it itself right after
 * the access check (204, 403 or 503) and never passes it to the computer, so its answer can't
 * be a redirect or anything the computer wrote.
 */
export const SCREEN_PROBE_PARAM = "rakazo_probe";

/** The status-only probe for a screen URL, absolute or a path. */
export function screenProbeUrl(url: string): string {
  const [base, hash] = url.split("#", 2) as [string, string | undefined];
  const joined = `${base}${base.includes("?") ? "&" : "?"}${SCREEN_PROBE_PARAM}=1`;
  return hash === undefined ? joined : `${joined}#${hash}`;
}

/** How often a dropped screen asks whether its page loads again, and for how long at most. */
export const SCREEN_RECONNECT_PROBE_MS = 1_000;
export const SCREEN_RECONNECT_WAIT_MS = 15_000;

/** The states a framed screen page reports about its connection. */
export const SCREEN_PAGE_STATES = [
  "loading",
  "connecting",
  "connected",
  "failed",
  "disconnected",
] as const;
export type ScreenPageState = (typeof SCREEN_PAGE_STATES)[number];

export type ScreenReconnect = {
  /** A new page load: only a drop after this load connected can reconnect by itself. */
  loaded(): void;
  /**
   * A retry someone pressed starts the screen over: its tries and its trouble are forgotten.
   * A page load alone never does this, so an automatic reload keeps the budget.
   */
  reset(): void;
  /**
   * The wait before the reconnect that report last asked for: one delay after a drop, doubled
   * for each try this trouble has already taken.
   */
  delayMs(): number;
  /**
   * What to do about a reported state: load the screen again after the delay, show the
   * page's error, or nothing. Each reconnect goes through the screen's full authorization.
   */
  report(state: ScreenPageState, now?: number): "reconnect" | "error" | "none";
};

/**
 * The clock a connection's life is measured on. A corrected wall clock can jump backwards,
 * which would make a connection that stayed up look like one that only flashed; a clock that
 * only moves forward cannot.
 */
function stableClock(): number {
  const clock = (globalThis as { performance?: { now(): number } }).performance;
  return clock ? clock.now() : Date.now();
}

/**
 * Reconnects a screen that dropped after connecting, as often as each connection stays up,
 * and never one that never connected. A reload the drop's restart raced — the page loads but
 * the screen server refuses its connection — tries again, waiting longer each time, and so
 * does a screen whose connections only flash up, until it runs out and shows its error.
 */
export function createScreenReconnect(): ScreenReconnect {
  let connected = false;
  // A drop's screen is coming back: its reloads haven't connected for long yet.
  let reconnecting = false;
  // The page now showing is a load made after the last try this trouble took.
  let freshLoad = false;
  let tries = 0;
  let connectedAt: number | undefined;
  return {
    loaded() {
      connected = false;
      freshLoad = true;
    },
    reset() {
      connected = false;
      reconnecting = false;
      freshLoad = false;
      tries = 0;
      connectedAt = undefined;
    },
    delayMs() {
      return SCREEN_RECONNECT_DELAY_MS * 2 ** Math.max(0, tries - 1);
    },
    report(state, now = stableClock()) {
      if (state === "connected") {
        if (!connected) connectedAt = now;
        connected = true;
        reconnecting = false;
        freshLoad = false;
        return "none";
      }
      if (state !== "disconnected" && state !== "failed") return "none";
      // A screen that had connected and then dropped may report it as a failure: the computer's
      // embed page marks an unclean disconnect, such as the proxy closing the socket, as an error.
      if (connected) {
        connected = false;
        reconnecting = true;
        freshLoad = false;
        // A connection that stayed up ended the previous trouble; one that only flashed up
        // spends another try of the same trouble.
        const stable = connectedAt !== undefined && now - connectedAt >= SCREEN_RECONNECT_STABLE_MS;
        tries = stable ? 1 : tries + 1;
        return tries <= SCREEN_RECONNECT_TRIES ? "reconnect" : "error";
      }
      // A failure while no reconnect is under way is a first load that never connected.
      if (!reconnecting) return "error";
      // The dying page can report several terminal states for one load. Only the first spends
      // a try; the rest re-arm the reconnect that try asked for, so the apps don't show their
      // error for a report that is only another word for the same drop.
      if (!freshLoad) return tries <= SCREEN_RECONNECT_TRIES ? "reconnect" : "error";
      freshLoad = false;
      tries += 1;
      return tries <= SCREEN_RECONNECT_TRIES ? "reconnect" : "error";
    },
  };
}

/** One reconnect allowance per computer screen, so one bot's drop doesn't use another's. */
export function createScreenReconnects(): { for(key: string): ScreenReconnect } {
  const screens = new Map<string, ScreenReconnect>();
  return {
    for(key) {
      let screen = screens.get(key);
      if (!screen) {
        screen = createScreenReconnect();
        screens.set(key, screen);
      }
      return screen;
    },
  };
}

/** Answers that mean the screen isn't reachable yet rather than refused: wait them out. */
const SCREEN_NOT_YET = new Set<number | null>([null, 502, 503]);

/**
 * Before a dropped screen loads again, wait while its page can't be reached: the access check
 * couldn't reach the API (503), the screen's server is restarting (502), or the request didn't
 * get through at all (null). So the one reconnect isn't spent on an outage. `probe` returns
 * the page's HTTP status through the full access check, or null if it couldn't be asked. A
 * load, a refusal or any other answer ends the wait at once.
 */
export async function waitForScreenPage(
  probe: (signal: AbortSignal) => Promise<number | null>,
  options: {
    /** Aborted when the screen is closed or its link changes: the wait and its probe stop. */
    signal?: AbortSignal;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
  } = {},
): Promise<"ready" | "refused" | "timeout" | "cancelled"> {
  const { signal } = options;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  // The limit holds even when a probe never answers: it is raced against the time left.
  const deadline = now() + SCREEN_RECONNECT_WAIT_MS;
  for (;;) {
    if (signal?.aborted) return "cancelled";
    const left = deadline - now();
    if (left <= 0) return "timeout";
    const attempt = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: () => void = () => {};
    const status = await Promise.race([
      probe(attempt.signal).catch(() => null),
      new Promise<"expired">((resolve) => {
        timer = setTimeout(() => resolve("expired"), left);
      }),
      new Promise<"cancelled">((resolve) => {
        onAbort = () => resolve("cancelled");
        signal?.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    if (status === "expired" || status === "cancelled") {
      attempt.abort();
      return status === "expired" ? "timeout" : "cancelled";
    }
    if (signal?.aborted) return "cancelled";
    if (status !== null && status >= 200 && status < 300) return "ready";
    if (!SCREEN_NOT_YET.has(status)) return "refused";
    if (deadline - now() <= SCREEN_RECONNECT_PROBE_MS) return "timeout";
    await sleep(SCREEN_RECONNECT_PROBE_MS);
  }
}

/** How often an open computer screen checks in, keeping the computer awake. */
export const COMPUTER_HEARTBEAT_MS = 60_000;
/** How often the page of a person holding control checks in, well inside its lease. */
export const COMPUTER_CONTROL_HEARTBEAT_MS = 15_000;
/**
 * A person keeps control while their page checks in; one silent this long loses it. Installed
 * mobile apps check in every 60 seconds, so this leaves them a margin.
 */
export const COMPUTER_CONTROL_LEASE_MS = 90_000;
