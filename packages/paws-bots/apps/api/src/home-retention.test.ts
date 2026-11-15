import { describe, expect, it } from "vitest";
import { deletionDates, homeDeletionDue } from "./home-retention.js";

const DAY = 24 * 60 * 60 * 1000;
const at = (day: number) => new Date(Date.UTC(2026, 0, 1) + day * DAY);
const now = at(200);
const billing = (fields: Record<string, unknown> = {}) => ({
  status: null,
  paidAt: null,
  endedAt: null,
  currentPeriodEndsAt: null,
  updatedAt: at(0),
  ...fields,
});
const credits = (fields: Record<string, unknown> = {}) => ({
  mode: "credits",
  balanceMicros: 0n,
  byokFreeUntil: null,
  lots: [],
  ...fields,
});

describe("saved home deletion date", () => {
  it("never deletes while a plan is live or waiting on payment", () => {
    for (const status of ["trialing", "active", "past_due", "unpaid", "paused"])
      expect(
        homeDeletionDue(
          { billing: billing({ status, paidAt: at(0) }), modelCredits: null },
          at(0),
          now,
        ),
      ).toBeNull();
  });

  it("never deletes while the organization can still run bots on credits or a free period", () => {
    const canceled = billing({ status: "canceled", paidAt: at(0), endedAt: at(10) });
    expect(
      homeDeletionDue(
        { billing: canceled, modelCredits: credits({ balanceMicros: 1n }) },
        at(0),
        now,
      ),
    ).toBeNull();
    expect(
      homeDeletionDue(
        { billing: canceled, modelCredits: credits({ mode: "byok", byokFreeUntil: at(201) }) },
        at(0),
        now,
      ),
    ).toBeNull();
  });

  it("gives an ended plan 30 days from its end or its last use, whichever is later", () => {
    const ended = {
      billing: billing({ status: "canceled", paidAt: at(0), endedAt: at(100) }),
      modelCredits: credits(),
    };
    expect(homeDeletionDue(ended, at(50), now)).toEqual({ at: at(130), reason: "plan-ended" });
    expect(homeDeletionDue(ended, at(110), now)).toEqual({ at: at(140), reason: "plan-ended" });
  });

  it("moves the date out from the latest credit purchase, even once those credits are spent", () => {
    const bought = {
      billing: billing({ status: "canceled", paidAt: at(0), endedAt: at(100) }),
      modelCredits: credits({ lots: [{ createdAt: at(120) }] }),
    };
    expect(homeDeletionDue(bought, at(50), now)).toEqual({ at: at(150), reason: "plan-ended" });
    const neverPaid = { billing: null, modelCredits: credits({ lots: [{ createdAt: at(120) }] }) };
    expect(homeDeletionDue(neverPaid, at(10), now)).toEqual({ at: at(210), reason: "unused" });
  });

  it("gives a computer without a paid plan 90 days from its last use", () => {
    expect(homeDeletionDue({ billing: null, modelCredits: null }, at(10), now)).toEqual({
      at: at(100),
      reason: "unused",
    });
    expect(homeDeletionDue({ billing: billing(), modelCredits: null }, at(10), now)).toEqual({
      at: at(100),
      reason: "unused",
    });
    const trialEnded = billing({ status: "canceled", endedAt: at(14) });
    expect(homeDeletionDue({ billing: trialEnded, modelCredits: null }, at(10), now)).toEqual({
      at: at(100),
      reason: "unused",
    });
  });
});

describe("saved home warning dates", () => {
  it("deletes only once the emailed date has ended in every time zone", () => {
    for (const sentAt of ["2026-11-03T00:00:00Z", "2026-11-03T01:00:00Z", "2026-11-03T23:59:59Z"]) {
      const { shown, deleteAfter } = deletionDates(new Date(sentAt));
      expect(shown.toISOString()).toBe("2026-11-10T00:00:00.000Z");
      // The date ends last at UTC-12, 12 hours after it ends in UTC.
      expect(deleteAfter.getTime()).toBeGreaterThanOrEqual(Date.parse("2026-11-11T12:00:00Z"));
      expect(deleteAfter.getTime() - Date.parse(sentAt)).toBeLessThanOrEqual(9 * DAY);
    }
  });
});
