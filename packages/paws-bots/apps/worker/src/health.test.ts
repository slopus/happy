import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startWorkerHealth, workerHealthIsFresh } from "./health.js";

const files = vi.hoisted(() => ({
  writeFile: vi.fn(async (_path: string, _data: string, _options: unknown) => {}),
  unlink: vi.fn(async () => {}),
}));
vi.mock("node:fs/promises", () => files);
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("worker health", () => {
  it("publishes reconciliation freshness and removes its heartbeat on shutdown", async () => {
    vi.useFakeTimers();
    const stop = startWorkerHealth(() => 123);
    await vi.advanceTimersByTimeAsync(30_000);
    const heartbeat = JSON.parse(files.writeFile.mock.calls.at(-1)![1] as string);
    expect(heartbeat.reconciled).toBe(123);
    await stop();
    expect(files.unlink).toHaveBeenCalled();
    const calls = files.writeFile.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(files.writeFile).toHaveBeenCalledTimes(calls);
  });

  it("Docker probes reject stale heartbeats and stalled reconciliation", () => {
    expect(workerHealthIsFresh({ heartbeat: 1_000_000, reconciled: 1_000_000 }, 1_000_000)).toBe(
      true,
    );
    for (const health of [
      {},
      { heartbeat: 0, reconciled: 1_000_000 },
      { heartbeat: 1_000_000, reconciled: 0 },
      { heartbeat: "invalid", reconciled: NaN },
      { heartbeat: 1_000_000 - 90_001, reconciled: 1_000_000 },
      { heartbeat: 1_000_000, reconciled: 1_000_000 - 300_001 },
      { heartbeat: 1_000_000 + 5_001, reconciled: 1_000_000 },
    ]) {
      expect(workerHealthIsFresh(health, 1_000_000)).toBe(false);
    }
    for (const name of ["images", "prod", "topology", ""]) {
      const suffix = name ? `.${name}` : "";
      const source = readFileSync(
        new URL(`../../../infra/compose/docker-compose${suffix}.yml`, import.meta.url),
        "utf8",
      );
      expect(source.slice(source.indexOf("\n  worker:"))).toContain(
        'test: ["CMD", "node", "dist/health-check.js"]',
      );
    }
  });
});
