import { describe, expect, it } from "vitest";
import { throttleKey, windowCounter } from "./window-counter.js";

describe("windowCounter", () => {
  it("counts within the window and starts over after it", () => {
    let at = 0;
    const count = windowCounter(1_000, () => at);
    expect(count("a")).toBe(1);
    expect(count("a")).toBe(2);
    at = 1_000;
    expect(count("a")).toBe(1);
  });

  it("keeps a caller's count when other keys fill the table", () => {
    let at = 0;
    const count = windowCounter(60_000, () => at);
    for (let i = 0; i < 5; i++) count("target");
    for (let i = 0; i < 20_000; i++) {
      at = i;
      count(`flood:${i}`);
    }
    expect(count("target")).toBe(6);
  });

  it("makes callers past a full table share one window", () => {
    const count = windowCounter(60_000, () => 0);
    for (let i = 0; i < 10_000; i++) count(`flood:${i}`);
    expect(count("late:1")).toBe(1);
    expect(count("late:2")).toBe(2);
  });

  it("counts callers past a full table by a coarser network, not all together", () => {
    const count = windowCounter(60_000, () => 0);
    // One /48's /64s fill the table.
    for (let i = 0; i < 10_000; i++) count(throttleKey(`2001:db8:a:${i.toString(16)}::1`));
    expect(count(throttleKey("2001:db8:a:ffff::1"))).toBe(1);
    expect(count(throttleKey("2001:db8:a:fffe::1"))).toBe(2);
    expect(count(throttleKey("2001:db8:b:1::1"))).toBe(1);
    expect(count(throttleKey("203.0.113.5"))).toBe(1);
    expect(count(throttleKey("203.0.113.9"))).toBe(2);
  });

  it("shares one window only past a full coarse table too", () => {
    const count = windowCounter(60_000, () => 0);
    // Distinct /64s, each its own /48: the first 10,000 fill the fine table,
    // the rest fill the coarse one.
    for (let i = 0; i < 20_000; i++) {
      const group = i.toString(16);
      count(throttleKey(`2001:db8:${group}:${group}::1`));
    }
    expect(count(throttleKey("2001:db8:ffff:1::1"))).toBe(1);
    expect(count(throttleKey("203.0.113.5"))).toBe(2);
  });

  it("frees expired windows for new callers", () => {
    let at = 0;
    const count = windowCounter(1_000, () => at);
    for (let i = 0; i < 10_000; i++) count(`old:${i}`);
    at = 1_000;
    expect(count("new:1")).toBe(1);
    expect(count("new:2")).toBe(1);
  });
});

describe("throttleKey", () => {
  it("groups an IPv6 caller by its /64, since one host can use the whole prefix", () => {
    expect(throttleKey("2001:db8:1:2::1")).toBe(throttleKey("2001:db8:1:2:ffff:1:2:3"));
    expect(throttleKey("2001:db8:1:2::1")).toBe(throttleKey("2001:0DB8:0001:0002::"));
    expect(throttleKey("2001:db8:1:2::1")).not.toBe(throttleKey("2001:db8:1:3::1"));
    expect(throttleKey("1::2:3:4:5:6.7.8.9")).toBe(throttleKey("1:0:2:3::"));
    expect(throttleKey("::1")).not.toBe(throttleKey("2001:db8::1"));
  });

  it("keys IPv4 by the full address and a missing address together", () => {
    expect(throttleKey("203.0.113.5")).not.toBe(throttleKey("203.0.113.6"));
    expect(throttleKey(undefined)).toBe(throttleKey(undefined));
    expect(throttleKey(undefined)).not.toBe(throttleKey("203.0.113.5"));
  });
});
