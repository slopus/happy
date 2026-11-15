import type { ProductEvent } from "@rakazo/contracts";
import { abortableDelay } from "./async.js";
import { isRetryableError, reconnectDelayMs, retryDelayMs } from "./retry-policy.js";

type ThreadHead = { threadId: string; cursor: number };
type SnapshotRecovery =
  | { phase: "snapshot" }
  | { phase: "replay"; projectionFloor: number; readonly suppressEffectsThrough: number }
  | { phase: "live" };

/** No frame at all for this long means the stream is half-open; the server beats far faster. */
export const IDLE_TIMEOUT_MS = 45_000;

/**
 * Recover a durable stream while its caller owns snapshot commits and UI effects.
 * Missing snapshot state is replayed from storage without retaining delivered payloads.
 */
export async function runThreadSubscription(options: {
  signal: AbortSignal;
  loadInitial: () => Promise<ThreadHead | null>;
  loadHead: () => Promise<ThreadHead | null>;
  refresh: () => Promise<unknown>;
  currentSnapshot: () => ThreadHead | null;
  subscribe: (cursor: number, signal: AbortSignal) => Promise<AsyncIterable<ProductEvent>>;
  beforeEvent?: (event: ProductEvent) => void;
  applyEvent: (event: ProductEvent) => void;
  onEvent: (event: ProductEvent, initial: ThreadHead) => void;
  random?: () => number;
}): Promise<void> {
  const { signal, random = Math.random } = options;
  const stopped = Symbol("stopped");
  // A 401 (session gone), 426 (build retired) or other 4xx is the server's answer: retrying
  // cannot succeed and only polls the server. A 429 may ask for a longer wait.
  let refused = false;
  let lastFailure: unknown;
  const isStopped = () => signal.aborted || refused;
  const snapshotAbort = new AbortController();
  let activeAttempt: AbortController | undefined;
  // Reusing a pending cancellation promise would retain every frame raced against it.
  const untilAborted = async <T>(
    work: Promise<T>,
    abort: AbortSignal,
  ): Promise<T | typeof stopped> => {
    let onAbort!: () => void;
    const cancelled = new Promise<typeof stopped>((resolve) => {
      onAbort = () => resolve(stopped);
      abort.addEventListener("abort", onAbort, { once: true });
      if (abort.aborted) onAbort();
    });
    try {
      return await Promise.race([work, cancelled]);
    } finally {
      abort.removeEventListener("abort", onAbort);
    }
  };
  const onAbort = () => {
    activeAttempt?.abort(signal.reason);
    snapshotAbort.abort(signal.reason);
  };
  const noteFailure = (error: unknown) => {
    // Keep whichever failure asked for the longer wait (a 429's Retry-After).
    if (retryDelayMs(error, 0) >= retryDelayMs(lastFailure, 0)) lastFailure = error;
    if (!isRetryableError(error)) {
      refused = true;
      onAbort();
    }
    return null;
  };
  const wait = async (ms: number, abort: AbortSignal) => {
    const delay = retryDelayMs(lastFailure, ms, random);
    lastFailure = undefined;
    await abortableDelay(delay, abort);
    return !isStopped() && !abort.aborted;
  };
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();
  let snapshotTask: Promise<void> | undefined;
  try {
    if (isStopped()) return;
    let initial = await untilAborted(options.loadInitial().catch(noteFailure), signal);
    if (initial === stopped || isStopped()) return;
    let headRetryMs = 250;
    while (!initial && !isStopped()) {
      initial = await untilAborted(options.loadHead().catch(noteFailure), signal);
      if (initial === stopped || isStopped()) return;
      if (initial) break;
      if (!(await wait(headRetryMs, signal))) return;
      headRetryMs = Math.min(headRetryMs * 2, 5_000);
    }
    if (!initial || isStopped()) return;
    const head = initial;
    let cursor = head.cursor;
    let effectsCursor = head.cursor;
    let generation = 0;
    // A snapshot on screen counts as current only if it reaches the head. An older one (say,
    // painted from a cache while its fresh load failed) would otherwise never get the events
    // between its cursor and the head, since the stream starts from the head.
    const shown = options.currentSnapshot();
    const recovery: { current: SnapshotRecovery } = {
      current:
        shown?.threadId === head.threadId && shown.cursor >= head.cursor
          ? { phase: "live" }
          : { phase: "snapshot" },
    };
    const commitRecovery = () => {
      if (isStopped() || recovery.current.phase !== "snapshot") return;
      const committed = options.currentSnapshot();
      if (committed?.threadId !== head.threadId) return;
      recovery.current = {
        phase: "replay",
        projectionFloor: committed.cursor,
        suppressEffectsThrough: effectsCursor,
      };
      cursor = Math.min(committed.cursor, effectsCursor);
      generation += 1;
      activeAttempt?.abort();
      snapshotAbort.abort();
    };
    if (recovery.current.phase === "snapshot") {
      snapshotTask = (async () => {
        let snapshotRetryMs = 250;
        while (!snapshotAbort.signal.aborted) {
          if (!(await wait(snapshotRetryMs, snapshotAbort.signal))) return;
          await untilAborted(options.refresh().catch(noteFailure), snapshotAbort.signal);
          if (snapshotAbort.signal.aborted) return;
          commitRecovery();
          snapshotRetryMs = Math.min(snapshotRetryMs * 2, 5_000);
        }
      })();
    }
    let retryMs = 250;
    while (!isStopped()) {
      const attempt = new AbortController();
      activeAttempt = attempt;
      const attemptGeneration = ++generation;
      let opened = false;
      try {
        const events = await untilAborted(
          options.subscribe(cursor, attempt.signal),
          attempt.signal,
        );
        if (events === stopped || isStopped() || generation !== attemptGeneration) continue;
        opened = true;
        const iterator = events[Symbol.asyncIterator]();
        try {
          let pending: Promise<IteratorResult<ProductEvent>> | undefined;
          while (!isStopped()) {
            pending ??= iterator.next();
            let timer: ReturnType<typeof setTimeout> | undefined;
            const next = await untilAborted(
              Promise.race([
                pending,
                new Promise<"idle">((resolve) => {
                  timer = setTimeout(() => resolve("idle"), IDLE_TIMEOUT_MS);
                }),
              ]),
              attempt.signal,
            ).finally(() => clearTimeout(timer));
            if (
              isStopped() ||
              generation !== attemptGeneration ||
              next === stopped ||
              next === "idle" ||
              next.done
            )
              break;
            pending = undefined;
            const event = next.value;
            retryMs = 250;
            // Heartbeats only prove the socket is alive; they carry no state and no cursor.
            if (event.type === "heartbeat") continue;
            cursor = Math.max(cursor, event.seq);
            const replay = recovery.current.phase === "replay" ? recovery.current : null;
            const deliverEffects = !replay || event.seq > replay.suppressEffectsThrough;
            if (deliverEffects) options.beforeEvent?.(event);
            const snapshot = options.currentSnapshot();
            if (replay && snapshot?.threadId === head.threadId) {
              replay.projectionFloor = Math.max(replay.projectionFloor, snapshot.cursor);
            }
            if (
              recovery.current.phase !== "snapshot" &&
              snapshot?.threadId === event.threadId &&
              (!replay || event.seq > replay.projectionFloor)
            ) {
              options.applyEvent(event);
            }
            if (deliverEffects) {
              options.onEvent(event, head);
              effectsCursor = Math.max(effectsCursor, event.seq);
            }
            if (
              replay &&
              event.seq >= Math.max(replay.projectionFloor, replay.suppressEffectsThrough)
            ) {
              recovery.current = { phase: "live" };
            }
          }
        } finally {
          // Abort before return: a pending read can otherwise keep Safari's socket open.
          attempt.abort();
          void iterator.return?.(undefined).catch(() => {});
        }
      } catch (error) {
        // Reconnect from the last durable event after a transient failure.
        noteFailure(error);
      } finally {
        attempt.abort();
        activeAttempt = undefined;
      }
      if (isStopped()) return;
      if (generation !== attemptGeneration) continue;
      const reconnect = new AbortController();
      activeAttempt = reconnect;
      try {
        const spread = opened ? reconnectDelayMs(lastFailure, random) : 0;
        if (spread > 0) {
          lastFailure = undefined;
          await abortableDelay(spread, reconnect.signal);
          if (isStopped()) return;
          if (generation !== attemptGeneration) continue;
        }
        await untilAborted(options.refresh().catch(noteFailure), reconnect.signal);
        if (isStopped()) return;
        commitRecovery();
        if (generation !== attemptGeneration) continue;
        await wait(retryMs, reconnect.signal);
      } finally {
        reconnect.abort();
        activeAttempt = undefined;
      }
      if (isStopped()) return;
      if (generation !== attemptGeneration) continue;
      retryMs = Math.min(retryMs * 2, 5_000);
    }
  } finally {
    activeAttempt?.abort();
    snapshotAbort.abort();
    signal.removeEventListener("abort", onAbort);
    await snapshotTask;
  }
}
