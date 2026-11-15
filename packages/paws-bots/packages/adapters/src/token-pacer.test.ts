import { describe, expect, it } from "vitest";
import type { TokenPacerClock } from "./token-pacer.js";
import { pacerTokensPerMinute, TokenPacer } from "./token-pacer.js";

function fakeClock() {
  let now = 1_000_000;
  const clock: TokenPacerClock & { advance(ms: number): void; sleeps: number[] } = {
    sleeps: [],
    now: () => now,
    advance: (ms) => {
      now += ms;
    },
    sleep: async (ms) => {
      clock.sleeps.push(ms);
      now += ms;
    },
  };
  return clock;
}

describe("TokenPacer", () => {
  it("does not wait while the window has room", async () => {
    const clock = fakeClock();
    const pacer = new TokenPacer(clock);
    await pacer.acquire("k", 60_000, 200_000);
    await pacer.acquire("k", 60_000, 200_000);
    const third = await pacer.acquire("k", 60_000, 200_000);
    expect(third.waitedMs).toBe(0);
    expect(clock.sleeps).toEqual([]);
  });

  it("waits only until enough of the window has expired, not a fixed minute", async () => {
    const clock = fakeClock();
    const pacer = new TokenPacer(clock);
    await pacer.acquire("k", 100_000, 200_000);
    clock.advance(20_000);
    await pacer.acquire("k", 90_000, 200_000);
    clock.advance(5_000);
    const waited = await pacer.acquire("k", 50_000, 200_000);
    // The first 100k leaves 60 s after it was sent, which is 35 s from now.
    expect(waited.waitedMs).toBeGreaterThanOrEqual(35_000);
    expect(waited.waitedMs).toBeLessThan(36_000);
  });

  it("paces keys independently", async () => {
    const clock = fakeClock();
    const pacer = new TokenPacer(clock);
    await pacer.acquire("a", 190_000, 200_000);
    expect((await pacer.acquire("b", 190_000, 200_000)).waitedMs).toBe(0);
  });

  it("lets a request larger than the limit go alone once the window is empty", async () => {
    const clock = fakeClock();
    const pacer = new TokenPacer(clock);
    await pacer.acquire("k", 10_000, 50_000);
    const big = await pacer.acquire("k", 80_000, 50_000);
    expect(big.waitedMs).toBeGreaterThanOrEqual(60_000);
    expect((await new TokenPacer(clock).acquire("k", 80_000, 50_000)).waitedMs).toBe(0);
  });

  it("settles to the reported tokens and corrects later estimates", async () => {
    const clock = fakeClock();
    const pacer = new TokenPacer(clock);
    const first = await pacer.acquire("k", 50_000, 200_000);
    first.slot.settle(100_000);
    // The ratio moved to 1.5: the next 100k estimate counts as 150k and must wait for the first.
    const second = await pacer.acquire("k", 100_000, 200_000);
    expect(second.waitedMs).toBeGreaterThan(0);
  });

  it("frees a released reservation", async () => {
    const clock = fakeClock();
    const pacer = new TokenPacer(clock);
    const first = await pacer.acquire("k", 190_000, 200_000);
    first.slot.release();
    expect((await pacer.acquire("k", 190_000, 200_000)).waitedMs).toBe(0);
  });

  it("stops waiting when the signal aborts", async () => {
    const clock = fakeClock();
    const pacer = new TokenPacer(clock);
    await pacer.acquire("k", 190_000, 200_000);
    const controller = new AbortController();
    controller.abort();
    const result = await pacer.acquire("k", 190_000, 200_000, controller.signal);
    expect(result.waitedMs).toBe(0);
  });
});

describe("pacerTokensPerMinute", () => {
  it("is off unless the limit is set", () => {
    expect(pacerTokensPerMinute("local", {})).toBeUndefined();
    expect(pacerTokensPerMinute("local", { RAKAZO_LOCAL_TOKENS_PER_MINUTE: " " })).toBeUndefined();
  });
  it("paces only the local provider", () => {
    const env = { RAKAZO_LOCAL_TOKENS_PER_MINUTE: "5000" };
    expect(pacerTokensPerMinute("local", env)).toBe(5000);
    expect(pacerTokensPerMinute("openai", env)).toBeUndefined();
  });
  it("rejects a limit that is not a positive integer", () => {
    for (const value of ["0", "-1", "1.5", "lots"]) {
      expect(() =>
        pacerTokensPerMinute("local", { RAKAZO_LOCAL_TOKENS_PER_MINUTE: value }),
      ).toThrow("RAKAZO_LOCAL_TOKENS_PER_MINUTE must be a positive integer");
    }
  });
});
