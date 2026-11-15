import { ORPCError } from "@orpc/server";
import { PaymentWalletRequestRejected } from "@rakazo/adapter-kit";
import type { PaymentWalletDeps } from "@rakazo/adapters";
import {
  connectPaymentWallet,
  disconnectPaymentWallet,
  paymentWalletStatus,
} from "@rakazo/adapters";
import { recordSecurityEvent } from "@rakazo/db";
import { paymentWalletConnectedEvent } from "../security-audit.js";
import type { RouterContext } from "./context.js";

export function paymentWalletRoutes(ctx: RouterContext) {
  const { deps, authed } = ctx;
  const wallet: PaymentWalletDeps = {
    prisma: deps.prisma,
    secretStore: deps.secrets,
    paymentWallet: deps.paymentWallet,
  };
  return {
    paymentWallet: {
      status: authed.paymentWallet.status.handler(({ context }) =>
        paymentWalletStatus(wallet, context.actor, {
          onConnected: () => recordSecurityEvent(paymentWalletConnectedEvent(context.actor)),
        }),
      ),
      connect: authed.paymentWallet.connect.handler(async ({ context }) => {
        if (!deps.paymentWallet) throw new ORPCError("NOT_FOUND");
        try {
          return await connectPaymentWallet(wallet, context.actor);
        } catch (error) {
          if (error instanceof PaymentWalletRequestRejected)
            throw new ORPCError("BAD_REQUEST", { message: error.message });
          throw error;
        }
      }),
      disconnect: authed.paymentWallet.disconnect.handler(({ context }) =>
        disconnectPaymentWallet(wallet, context.actor),
      ),
    },
  };
}
