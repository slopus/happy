import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureReferral, loadBillingStatus } from "./referral";
import { rpc } from "./rpc";

vi.mock("./rpc", () => ({
  rpc: { billing: { status: vi.fn() } },
}));

describe("referral", () => {
  const status = vi.mocked(rpc.billing.status);
  let storage: Map<string, string>;

  beforeEach(() => {
    status.mockReset();
    storage = new Map();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
        removeItem: (key: string) => storage.delete(key),
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends a code from the landing URL with the first billing status only", async () => {
    status.mockResolvedValue({} as Awaited<ReturnType<typeof rpc.billing.status>>);
    captureReferral("?ref=friend42");

    await loadBillingStatus(rpc);
    await loadBillingStatus(rpc);

    expect(status).toHaveBeenNthCalledWith(1, { referralCode: "friend42" });
    expect(status).toHaveBeenNthCalledWith(2, undefined);
  });

  it("keeps the code for another try when the request fails", async () => {
    status
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue({} as Awaited<ReturnType<typeof rpc.billing.status>>);
    captureReferral("?ref=friend42");

    await expect(loadBillingStatus(rpc)).rejects.toThrow("offline");
    await loadBillingStatus(rpc);

    expect(status).toHaveBeenNthCalledWith(2, { referralCode: "friend42" });
  });

  it("never sends a malformed code, which would make billing status fail", async () => {
    status.mockResolvedValue({} as Awaited<ReturnType<typeof rpc.billing.status>>);
    captureReferral(`?ref=${"x".repeat(65)}`);
    storage.set("rakazo:referral", "bad code!");

    await loadBillingStatus(rpc);

    expect(status).toHaveBeenCalledWith(undefined);
    expect(storage.has("rakazo:referral")).toBe(false);
  });

  it("asks for plain status without a code", async () => {
    status.mockResolvedValue({} as Awaited<ReturnType<typeof rpc.billing.status>>);

    await loadBillingStatus(rpc);

    expect(status).toHaveBeenCalledWith(undefined);
  });
});
