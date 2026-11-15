import type { PaymentWalletProvider } from "@rakazo/adapter-kit";
import { EmulatorPaymentWalletProvider } from "./payment-wallet-emulator.js";

export type PaymentWalletProviderKind = "none" | "link" | "emulator";

/** Blank or unknown values become none so the API still boots and purchase tools stay hidden. */
export function resolvePaymentWalletProvider(
  source: NodeJS.ProcessEnv = process.env,
): PaymentWalletProviderKind {
  const requested = source.PAYMENT_WALLET_PROVIDER?.trim().toLowerCase();
  return requested === "link" || requested === "emulator" ? requested : "none";
}

/** Link loads on demand so deployments without it never load its SDK. */
export async function createPaymentWalletProvider(
  source: NodeJS.ProcessEnv = process.env,
): Promise<PaymentWalletProvider | null> {
  const kind = resolvePaymentWalletProvider(source);
  if (kind === "emulator") return new EmulatorPaymentWalletProvider();
  if (kind !== "link") return null;
  const { LinkWalletProvider } = await import("./link-wallet.js");
  const clientId = source.PAYMENT_WALLET_CLIENT_ID?.trim();
  return new LinkWalletProvider(clientId ? { clientId } : {});
}
