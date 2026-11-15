const HOUR_MS = 60 * 60 * 1000;

/**
 * Runs the sweep at startup and hourly; every API instance may run it, so sweeps claim their work.
 * Stopping aborts the signal a running sweep was given and waits for it to return.
 */
export function startHourlySweep(
  sweep: (signal: AbortSignal) => Promise<void>,
  onError: (error: unknown) => void,
) {
  const stopping = new AbortController();
  let running: Promise<void> | undefined;
  const tick = () => {
    running ??= sweep(stopping.signal)
      .catch(onError)
      .finally(() => {
        running = undefined;
      });
  };
  const timer = setInterval(tick, HOUR_MS);
  timer.unref();
  tick();
  return async () => {
    clearInterval(timer);
    stopping.abort();
    await running;
  };
}
