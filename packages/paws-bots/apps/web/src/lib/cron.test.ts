import { formatCron } from "@rakazo/core";
import { describe, expect, it } from "vitest";
import { cronLabels } from "./cron";

describe("cronLabels", () => {
  it.each([
    ["*/1 * * * *", "Co minutę"],
    ["*/2 * * * *", "Co 2 minuty"],
    ["*/12 * * * *", "Co 12 minut"],
    ["*/22 * * * *", "Co 22 minuty"],
    ["0 */3 * * *", "Co 3 godziny"],
    ["0 0 */5 * *", "Co 5 dni"],
  ])("uses Polish interval forms for %s", (cron, expected) => {
    expect(formatCron(cron, cronLabels("pl"))).toBe(expected);
  });

  it("writes times the way the language does", () => {
    expect(formatCron("0 21 * * 1-5", cronLabels("es"))).toBe("Weekdays at 21:00");
    expect(formatCron("30 7 1 * *", cronLabels("es"))).toBe("Monthly on day 1 at 7:30");
    expect(formatCron("0 21 * * 1-5", cronLabels("en"))).toBe("Weekdays at 9:00 PM");
  });

  it("names a fixed minute every few hours instead of showing the expression", () => {
    expect(formatCron("15 */2 * * *", cronLabels("es"))).toBe("Every 2 hours at :15");
  });
});
