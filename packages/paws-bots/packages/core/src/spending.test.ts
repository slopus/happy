import { describe, expect, it } from "vitest";
import {
  formatMinorAmount,
  parseLimitInput,
  parsePageAmount,
  spendingPeriodStart,
} from "./spending.js";

describe("parsePageAmount", () => {
  it.each([
    ["$23.40", 2340, "usd"],
    ["$5", 500, "usd"],
    ["US$1,234.56", 123456, "usd"],
    ["1 234,56 €", 123456, "eur"],
    ["€12,5", 1250, "eur"],
    ["£0.99", 99, "gbp"],
    ["₪50", 5000, "ils"],
    ['120 ש"ח', 12000, "ils"],
    ["NIS 7.90", 790, "ils"],
    ["EUR 1.234,00", 123400, "eur"],
    ["USD 10", 1000, "usd"],
    // Every other dollar is worth less, so reading it as US dollars over-counts.
    ["CA$10.00", 1000, "usd"],
    // A separator before three digits groups thousands: the larger reading.
    ["$1.234", 123400, "usd"],
    ["$1,000,000", 100000000, "usd"],
    // A decimal part with no whole part is still a fraction, not whole units.
    ["$.99", 99, "usd"],
    ["€,50", 50, "eur"],
    [".99 USD", 99, "usd"],
    [",50 €", 50, "eur"],
    ["$.5", 50, "usd"],
    ["$0.99", 99, "usd"],
    ["€0,50", 50, "eur"],
    ["$00.99", 99, "usd"],
  ])("reads %s", (text, amount, currency) => {
    expect(parsePageAmount(text)).toEqual({ amount, currency });
  });

  it.each([
    "",
    "Total",
    "¥1,200",
    "12.00",
    "$1 or €2",
    "$5 and $6",
    "₹500",
    "$",
    "$1,2,3",
    "$1.2345",
    "$1,234,56",
    "$30,000,000",
    "$..99",
    "$,.99",
    "$.999",
    "€,500",
    "$.1,234",
  ])("refuses %j", (text) => {
    expect(parsePageAmount(text)).toBeNull();
  });
});

describe("spendingPeriodStart", () => {
  const set = new Date("2026-01-01T00:00:00Z");
  // A Wednesday evening in New York, already Thursday in UTC.
  const now = new Date("2026-11-05T02:30:00Z");

  it("starts a day at local midnight", () => {
    expect(spendingPeriodStart("day", set, "America/New_York", now).toISOString()).toBe(
      "2026-11-04T05:00:00.000Z",
    );
    expect(spendingPeriodStart("day", set, null, now).toISOString()).toBe(
      "2026-11-05T00:00:00.000Z",
    );
  });

  it("starts a week on Monday", () => {
    expect(spendingPeriodStart("week", set, "America/New_York", now).toISOString()).toBe(
      "2026-11-02T05:00:00.000Z",
    );
    // Monday itself starts its own week.
    expect(
      spendingPeriodStart("week", set, "UTC", new Date("2026-11-02T00:00:00Z")).toISOString(),
    ).toBe("2026-11-02T00:00:00.000Z");
    // Sunday belongs to the week that began six days earlier.
    expect(
      spendingPeriodStart("week", set, "UTC", new Date("2026-11-08T23:59:00Z")).toISOString(),
    ).toBe("2026-11-02T00:00:00.000Z");
  });

  it("starts a month on the first, across a daylight-saving change", () => {
    expect(spendingPeriodStart("month", set, "America/New_York", now).toISOString()).toBe(
      "2026-11-01T04:00:00.000Z",
    );
    expect(spendingPeriodStart("month", set, "Asia/Jerusalem", now).toISOString()).toBe(
      "2026-10-31T22:00:00.000Z",
    );
  });

  it("counts a limit that never resets from when it was set", () => {
    expect(spendingPeriodStart("none", set, "Asia/Jerusalem", now)).toBe(set);
  });
});

describe("formatMinorAmount", () => {
  it.each([
    [1000, "jpy", "¥1,000"],
    [1000, "JPY", "¥1,000"],
    [0, "jpy", "¥0"],
    [1000, "krw", "₩1,000"],
    [1234, "kwd", "KWD\u00a01.234"],
    [2340, "eur", "€23.40"],
    [2340, "gbp", "£23.40"],
  ])("formats %s minor units of %s", (amount, currency, expected) => {
    expect(formatMinorAmount(amount, currency)).toBe(expected);
  });

  it("uses the requested locale without changing the currency scale", () => {
    expect(formatMinorAmount(1000, "jpy", "ja-JP")).toBe("￥1,000");
    expect(formatMinorAmount(1234, "kwd", "de-DE")).toBe("1,234\u00a0KWD");
  });

  it("keeps the existing fallback for invalid currency codes", () => {
    expect(formatMinorAmount(1234, "invalid")).toBe("12.34 INVALID");
  });

  it("formats minor units as money", () => {
    expect(formatMinorAmount(2340, "usd")).toBe("$23.40");
    expect(formatMinorAmount(5000, "ils", "en-US")).toBe("₪50.00");
  });
});

describe("parseLimitInput", () => {
  it.each([
    ["200", 20_000],
    ["200.5", 20_050],
    ["12,50", 1_250],
    ["1,000", 100_000],
    ["1 000", 100_000],
    [" 75 ", 7_500],
    ["1000000", 100_000_000],
  ])("reads %j", (text, amount) => {
    expect(parseLimitInput(text)).toBe(amount);
  });

  it.each(["", "0", "-5", "abc", "$20", "1e3", "1000001", "1,2,3", "1.2345"])(
    "refuses %j",
    (text) => {
      expect(parseLimitInput(text)).toBeNull();
    },
  );
});
