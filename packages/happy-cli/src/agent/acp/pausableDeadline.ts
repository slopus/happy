export type PausableDeadline = {
  pause(): () => void;
  cancel(): void;
};

/** One local-work budget. Overlapping external waits pause it until the last release. */
export function createPausableDeadline(budgetMs: number, onTimeout: () => void): PausableDeadline {
  let remaining = budgetMs;
  let resumedAt = performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pauses = 0;
  let closed = false;

  const clearTimer = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  const expire = () => {
    if (closed) return;
    closed = true;
    clearTimer();
    onTimeout();
  };
  const resume = () => {
    resumedAt = performance.now();
    timer = setTimeout(expire, remaining);
  };
  resume();

  return {
    pause() {
      if (closed) return () => {};
      if (pauses === 0) {
        remaining = Math.max(0, remaining - Math.max(0, performance.now() - resumedAt));
        clearTimer();
        if (remaining === 0) {
          expire();
          return () => {};
        }
      }
      pauses += 1;
      let released = false;
      return () => {
        if (closed || released) return;
        released = true;
        pauses -= 1;
        if (pauses === 0) resume();
      };
    },
    cancel() {
      closed = true;
      clearTimer();
    },
  };
}
