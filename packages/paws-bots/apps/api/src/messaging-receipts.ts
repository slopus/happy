import { randomUUID } from "node:crypto";
import type { MessagingReceipt, MessagingSurface } from "@rakazo/adapter-kit";
import { providerOfThreadId } from "@rakazo/adapters";
import { getLogger } from "@rakazo/logging";

// A reaction stays on the message, so it only goes on a late one: a fast reply
// is its own acknowledgement.
const RECEIPT_DELAY_MS: Record<MessagingReceipt, number> = {
  typing: 0,
  reaction: 60_000,
};

const RECEIPT_TIMEOUT_MS = 2000;

export interface MessagingReceipts {
  acknowledge(threadId: string, handle: string, handled: () => Promise<boolean>): void;
  stop(): void;
}

export function createMessagingReceipts(
  messaging: Pick<MessagingSurface, "platforms" | "acknowledge">,
): MessagingReceipts {
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let stopped = false;

  const send = async (threadId: string, handle: string): Promise<void> => {
    const operationId = `messaging.acknowledge:${randomUUID()}`;
    await messaging.acknowledge(threadId, handle, {
      operationId,
      traceId: operationId,
      spaceId: "",
      userId: "",
      signal: AbortSignal.timeout(RECEIPT_TIMEOUT_MS),
    });
  };
  const logFailure = (error: unknown) => getLogger().error("messaging receipt error", error);

  return {
    acknowledge(threadId, handle, handled) {
      if (stopped) return;
      const provider = providerOfThreadId(threadId);
      const receipt = messaging.platforms().find((platform) => platform.provider === provider)
        ?.capabilities.receipt;
      if (!receipt) return;
      const delay = RECEIPT_DELAY_MS[receipt];
      if (delay <= 0) {
        send(threadId, handle).catch(logFailure);
        return;
      }
      const timer = setTimeout(() => {
        timers.delete(timer);
        (async () => {
          if ((await handled()) || stopped) return;
          await send(threadId, handle);
        })().catch(logFailure);
      }, delay);
      timer.unref?.();
      timers.add(timer);
    },
    stop() {
      stopped = true;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    },
  };
}
