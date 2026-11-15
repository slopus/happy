import { describe, expect, it } from "vitest";
import type { BillingStatus } from "./billing.js";
import { byokYearlySwitchSavings } from "./billing.js";

function status(overrides: Partial<BillingStatus> = {}): BillingStatus {
  return {
    access: true,
    funding: "byok",
    byokPriceCents: 1500,
    byokInterval: "month",
    byokAnnualPriceCents: 14400,
    byokFreeUntil: null,
    monthlyAmountCents: null,
    canManage: true,
    trialAvailable: false,
    trialDays: 7,
    state: "active",
    price: null,
    seats: 1,
    trialEndsAt: null,
    currentPeriodEndsAt: null,
    cancelAtPeriodEnd: false,
    hasCustomer: true,
    ...overrides,
  };
}

describe("switching the own-key plan to yearly", () => {
  it("offers a paid monthly plan the yearly savings", () => {
    expect(byokYearlySwitchSavings(status())).toBe(20);
    expect(byokYearlySwitchSavings(status({ state: "trialing" }))).toBe(20);
  });

  it("is not offered when the yearly price saves nothing", () => {
    expect(byokYearlySwitchSavings(status({ byokPriceCents: 1000 }))).toBeNull();
    expect(byokYearlySwitchSavings(status({ byokPriceCents: 1200 }))).toBeNull();
  });

  it("is not offered without a live monthly own-key plan the owner manages", () => {
    expect(byokYearlySwitchSavings(status({ byokInterval: "year" }))).toBeNull();
    expect(byokYearlySwitchSavings(status({ canManage: false }))).toBeNull();
    expect(byokYearlySwitchSavings(status({ cancelAtPeriodEnd: true }))).toBeNull();
    expect(byokYearlySwitchSavings(status({ state: "past_due" }))).toBeNull();
    expect(byokYearlySwitchSavings(status({ monthlyAmountCents: 3000 }))).toBeNull();
    expect(byokYearlySwitchSavings(status({ byokAnnualPriceCents: null }))).toBeNull();
  });
});
