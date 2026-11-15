import type { ModelCallObserver } from "@rakazo/adapter-kit";
import { creditAccount, organizationForMember, reserveModelCredits } from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { hostedModelCreditObserver } from "./model-credit-observer.js";

vi.mock("@rakazo/db", () => ({
  organizationForMember: vi.fn(),
  creditAccount: vi.fn(),
  reserveModelCredits: vi.fn(),
  recordModelCreditReceipt: vi.fn(),
}));

const scope = { userId: "user-1", spaceId: "space-1" };
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(organizationForMember).mockResolvedValue({ organizationId: "org-1" } as never);
});

describe("hosted model credit gate", () => {
  it("refuses an unfunded BYOK account even if old owner and subscription records exist", async () => {
    vi.mocked(creditAccount).mockResolvedValue({ mode: "byok", balanceMicros: 0n } as never);
    const findUnique = vi.fn(async () => ({ ownerUserId: scope.userId, status: "active" }));
    await expect(
      hostedModelCreditObserver(
        { deploymentSettings: { findUnique }, billingAccount: { findUnique } } as never,
        scope,
      ),
    ).rejects.toThrow("Connect your own API key");
    expect(findUnique).not.toHaveBeenCalled();
    expect(reserveModelCredits).not.toHaveBeenCalled();
  });
  it("lets a BYOK account with a balance reserve credits", async () => {
    vi.mocked(creditAccount).mockResolvedValue({ mode: "byok", balanceMicros: 1n } as never);
    await expect(hostedModelCreditObserver({} as never, scope)).resolves.toBeDefined();
  });
  it("requires a reservation before a funded-mode account may use the server key", async () => {
    vi.mocked(creditAccount).mockResolvedValue({ mode: "credits" } as never);
    vi.mocked(reserveModelCredits).mockRejectedValue(new Error("Not enough model credits"));
    const observer = await hostedModelCreditObserver({} as never, scope);
    const call = {
      callId: "call-1",
      maxCostUsd: 0.02,
      provider: "test-provider",
      modelId: "test-model",
      runId: "run-1",
    } as Parameters<ModelCallObserver["beforeCall"]>[0];
    await expect(observer.beforeCall(call)).rejects.toThrow("Not enough model credits");
    expect(reserveModelCredits).toHaveBeenCalledWith({}, "org-1", 0.02, {
      ...scope,
      callId: "call-1",
      runId: "run-1",
      provider: "test-provider",
      model: "test-model",
    });
  });
});
