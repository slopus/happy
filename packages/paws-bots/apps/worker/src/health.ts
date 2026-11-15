import { unlink, writeFile } from "node:fs/promises";
import { getLogger, logSinkHealth } from "@rakazo/logging";

export const WORKER_HEALTH_FILE = "/tmp/rakazo-worker-health.json";

/** A separate Docker process can detect a dead or blocked worker even when it cannot log. */
export function startWorkerHealth(lastReconciled: () => number) {
  let stopped = false;
  let writing: Promise<void> | undefined;
  const publish = () => {
    if (writing || stopped) return;
    writing = writeFile(
      WORKER_HEALTH_FILE,
      JSON.stringify({
        heartbeat: Date.now(),
        reconciled: lastReconciled(),
        telemetry: logSinkHealth(),
      }),
      { mode: 0o600 },
    )
      .catch((error) => {
        getLogger().error("worker heartbeat failed", error);
      })
      .finally(() => {
        writing = undefined;
      });
  };
  void publish();
  const timer = setInterval(() => void publish(), 30_000);
  timer.unref();
  return async () => {
    stopped = true;
    clearInterval(timer);
    await writing;
    await unlink(WORKER_HEALTH_FILE).catch(() => undefined);
  };
}

export function workerHealthIsFresh(value: unknown, now = Date.now()): boolean {
  if (!value || typeof value !== "object") return false;
  const health = value as Record<string, unknown>;
  const checks = [
    ["heartbeat", 90_000],
    ["reconciled", 300_000],
  ] as const;
  return checks.every(([key, limit]) => {
    const timestamp = health[key];
    return (
      typeof timestamp === "number" &&
      Number.isFinite(timestamp) &&
      timestamp > 0 &&
      timestamp <= now + 5_000 &&
      now - timestamp <= limit
    );
  });
}
