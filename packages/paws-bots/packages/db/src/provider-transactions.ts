/**
 * A transaction that waits on a provider (an integration, a payment processor) keeps its
 * pooled connection for the whole call, and every caller queued on a lock it holds keeps
 * one too. When the provider hangs, a few of them take every connection in the process,
 * and sign-in and every other request time out waiting for one. Transactions for one
 * provider scope run one at a time per process — the key matches the advisory lock
 * Postgres already enforces — and however many scopes wait, at most `slots` of them hold
 * a connection at once. The rest wait here, without a connection.
 */
export class ProviderTransactionBusyError extends Error {
  constructor() {
    super("Try again in a moment.");
    this.name = "ProviderTransactionBusyError";
  }
}

export interface ProviderTransactionGate {
  /**
   * Runs `fn` for `key` once no other transaction for that key runs and a slot is free,
   * or throws ProviderTransactionBusyError after `waitMs`.
   */
  run<T>(key: string, fn: () => Promise<T>, waitMs: number): Promise<T>;
}

export function createProviderTransactionGate(slots: number): ProviderTransactionGate {
  const running = new Set<string>();
  let waiters: Array<{
    key: string;
    resolve: () => void;
    reject: (error: ProviderTransactionBusyError) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];

  // Admit in arrival order every waiter whose key is free, until no slot remains.
  const admitWaiters = () => {
    for (;;) {
      const index = waiters.findIndex((waiter) => !running.has(waiter.key));
      if (index === -1 || running.size >= slots) return;
      const waiter = waiters.splice(index, 1)[0];
      if (!waiter) return;
      clearTimeout(waiter.timer);
      running.add(waiter.key);
      waiter.resolve();
    }
  };

  return {
    async run(key, fn, waitMs) {
      if (running.has(key) || running.size >= slots) {
        await new Promise<void>((resolve, reject) => {
          const waiter = {
            key,
            resolve,
            reject,
            timer: setTimeout(() => {
              waiters = waiters.filter((entry) => entry !== waiter);
              reject(new ProviderTransactionBusyError());
            }, waitMs),
          };
          waiters.push(waiter);
        });
      } else {
        running.add(key);
      }
      try {
        return await fn();
      } finally {
        running.delete(key);
        admitWaiters();
      }
    },
  };
}

/**
 * How many provider-waiting transactions may hold a pooled connection at once: half the
 * pool they share (see createPool), and always one. Slow providers then pin at most half
 * the pool however many integrations wait, and sign-in and every other request keep the
 * rest — with more than one slot so an unrelated integration never queues behind another
 * scope's slow provider.
 */
export function providerTransactionSlots(poolMax: number): number {
  return Math.max(1, Math.floor(poolMax / 2));
}

// One slot until the process says how large its pool is, as before slots followed the pool.
let gate = createProviderTransactionGate(1);

/** Size the gate from the pool provider transactions use; call where that pool is created. */
export function configureProviderTransactionPool(poolMax: number): void {
  gate = createProviderTransactionGate(providerTransactionSlots(poolMax));
}

export function runProviderTransaction<T>(
  key: string,
  fn: () => Promise<T>,
  waitMs: number,
): Promise<T> {
  return gate.run(key, fn, waitMs);
}
