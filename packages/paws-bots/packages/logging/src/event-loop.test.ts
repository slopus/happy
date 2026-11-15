import { afterEach, describe, expect, it, vi } from "vitest";
import { watchEventLoopStalls } from "./event-loop.js";
import { createLogger, installLogger } from "./logger.js";
import { createTestSink } from "./test-sink.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("watchEventLoopStalls", () => {
  it("reports a blocked event loop with heap figures, and not ordinary timer jitter", async () => {
    vi.useFakeTimers();
    const sink = createTestSink();
    installLogger(createLogger({ service: "rakazo-api", sinks: [sink], level: "debug" }));
    let clock = 0;
    const stop = watchEventLoopStalls("api.event_loop_stalled", () => clock);
    const tick = async (elapsed: number) => {
      clock += elapsed;
      await vi.advanceTimersByTimeAsync(1_000);
    };
    await tick(1_000);
    await tick(4_000);
    await tick(41_000);
    stop();
    await tick(60_000);

    expect(sink.events.map((event) => event.message)).toEqual(["api.event_loop_stalled"]);
    expect(sink.events[0]).toMatchObject({ "event_loop.stall_ms": 40_000 });
    expect(sink.events[0]!["memory.heap_limit_bytes"]).toBeGreaterThan(0);
  });
});
