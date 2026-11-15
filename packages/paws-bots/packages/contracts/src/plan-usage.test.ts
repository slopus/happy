import { describe, expect, it } from "vitest";
import type { BillingStatus } from "./billing.js";
import { modelCreditsUsd } from "./billing.js";
import { planUsagePercent } from "./domain.js";

describe("modelCreditsUsd", () => {
  const status = (overrides: Partial<BillingStatus>) => overrides as BillingStatus;

  it("hides credits from members who only run on their own plans", () => {
    expect(modelCreditsUsd(null)).toBeNull();
    expect(modelCreditsUsd(status({ funding: "byok", balanceUsd: 0 }))).toBeNull();
    expect(modelCreditsUsd(status({ funding: null }))).toBeNull();
  });

  it("shows a credit plan's balance, even when it is spent, and a balance left after switching", () => {
    expect(modelCreditsUsd(status({ funding: "credits", balanceUsd: 0 }))).toBe(0);
    expect(modelCreditsUsd(status({ funding: "byok", balanceUsd: 4.5 }))).toBe(4.5);
  });
});

describe("planUsagePercent", () => {
  it("is the subscription with the most room, judged by its fullest window", () => {
    expect(planUsagePercent([])).toBeNull();
    expect(
      planUsagePercent([
        {
          credentialId: "a",
          name: "A",
          label: "A",
          windows: [
            { period: "session", usedPercent: 12, resetsAt: null },
            { period: "week", usedPercent: 64, resetsAt: null },
          ],
        },
        {
          credentialId: "b",
          name: "B",
          label: "B",
          windows: [{ period: "session", usedPercent: 93, resetsAt: null }],
        },
      ]),
    ).toBe(64);
  });
});
