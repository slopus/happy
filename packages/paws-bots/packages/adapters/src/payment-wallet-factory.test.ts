import { describe, expect, it, vi } from "vitest";
import {
  createPaymentWalletProvider,
  resolvePaymentWalletProvider,
} from "./payment-wallet-factory.js";

const linkModule = vi.hoisted(() => ({ loads: 0 }));
vi.mock("./link-wallet.js", async (importOriginal) => {
  linkModule.loads += 1;
  return importOriginal();
});

describe("payment wallet composition", () => {
  it("soft-falls to none for blank, unknown, and missing values", () => {
    for (const value of [undefined, "", "  ", "none", "stripe", "paypal"]) {
      expect(resolvePaymentWalletProvider({ PAYMENT_WALLET_PROVIDER: value })).toBe("none");
    }
    expect(resolvePaymentWalletProvider({ PAYMENT_WALLET_PROVIDER: " Link " })).toBe("link");
    expect(resolvePaymentWalletProvider({ PAYMENT_WALLET_PROVIDER: "EMULATOR" })).toBe("emulator");
  });

  it("never loads the Link adapter unless Link is configured", async () => {
    expect(await createPaymentWalletProvider({})).toBeNull();
    expect(await createPaymentWalletProvider({ PAYMENT_WALLET_PROVIDER: "bogus" })).toBeNull();
    const emulator = await createPaymentWalletProvider({ PAYMENT_WALLET_PROVIDER: "emulator" });
    expect(emulator?.describe().capabilities.offline).toBe(true);
    expect(linkModule.loads).toBe(0);

    const link = await createPaymentWalletProvider({
      PAYMENT_WALLET_PROVIDER: "link",
      PAYMENT_WALLET_CLIENT_ID: "fake-client",
    });
    expect(linkModule.loads).toBe(1);
    expect(link?.displayName).toBe("Link");
    expect(link?.describe()).toMatchObject({ id: "link", capabilities: { offline: false } });
  });
});
