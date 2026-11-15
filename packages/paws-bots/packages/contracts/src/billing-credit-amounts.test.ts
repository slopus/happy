import { describe, expect, it } from "vitest";
import { creditAmountChoices, MODEL_CREDIT_AMOUNTS } from "./billing.js";

describe("credit amount choices", () => {
  it("offers only current amounts to a plan on one of them", () => {
    expect(creditAmountChoices(3000)).toEqual([...MODEL_CREDIT_AMOUNTS]);
  });
  it("keeps a plan's retired amount so it still shows as chosen", () => {
    expect(creditAmountChoices(50000)).toEqual([...MODEL_CREDIT_AMOUNTS, 50000]);
  });
});
