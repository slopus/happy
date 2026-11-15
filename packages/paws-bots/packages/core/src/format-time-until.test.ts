import { expect, it } from "vitest";
import { formatTimeUntil } from "./format-time-until.js";

const now = Date.parse("2026-11-10T12:00:00Z");
const at = (minutes: number) => new Date(now + minutes * 60_000).toISOString();

it("says how long until a reset in the two largest units", () => {
  expect(formatTimeUntil(at(25), "en", now)).toBe("25m");
  expect(formatTimeUntil(at(150), "en", now)).toBe("2h 30m");
  expect(formatTimeUntil(at(3 * 1440 + 240), "en", now)).toBe("3d 4h");
});

it("is empty for an unknown time and never counts below a minute", () => {
  expect(formatTimeUntil(null, "en", now)).toBe("");
  expect(formatTimeUntil(at(-5), "en", now)).toBe("1m");
});
