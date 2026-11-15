import type {
  AdapterContext,
  AdapterDescriptor,
  BackgroundJob,
  HttpPaymentAuthorization,
  HttpPaymentChallenge,
  JobPublisher,
  PaymentCardSecret,
  PaymentWalletCapabilities,
  PaymentWalletProvider,
  PurchaseRequest,
  PurchaseSnapshot,
} from "@rakazo/adapter-kit";
import type { PrismaClient, Purchase } from "@rakazo/db";
import { fakeSpendingPrisma } from "./fake-spending.js";
import { readStripeChargeChallenge, stripeChargeAuthorization } from "./mpp-stripe.js";

export const FAKE_PAY_TOKEN = "fake_pay_token_secret";
export const FAKE_SHARED_PAYMENT_TOKEN = "spt_fake_secret";

/** A wallet whose purchase status a test sets directly. */
export class FakePaymentWallet implements PaymentWalletProvider {
  readonly displayName = "Fake Wallet";
  readonly created: PurchaseRequest[] = [];
  readonly snapshots = new Map<string, PurchaseSnapshot>();
  getError: Error | undefined;

  describe(): AdapterDescriptor<PaymentWalletCapabilities> {
    return {
      id: "fake",
      contractVersion: "1",
      adapterVersion: "0",
      capabilities: { offline: true, credentials: ["card", "pay_token", "http_payment"] },
    };
  }
  beginConnect(): never {
    throw new Error("unused");
  }
  pollConnect(): never {
    throw new Error("unused");
  }
  refresh(): never {
    throw new Error("unused");
  }
  async disconnect() {}
  async createPurchase(_credential: unknown, request: PurchaseRequest) {
    this.created.push(request);
    const id = `remote-${request.idempotencyKey}`;
    const snapshot: PurchaseSnapshot = this.snapshots.get(id) ?? {
      id,
      status: "pending_approval",
      approvalUrl: `https://wallet.example.test/approve/${id}`,
    };
    this.snapshots.set(id, snapshot);
    return snapshot;
  }
  async getPurchase(_credential: unknown, id: string, _context: AdapterContext) {
    if (this.getError) throw this.getError;
    return this.snapshots.get(id) ?? { id, status: "pending_approval" as const };
  }
  async revealCard(): Promise<PaymentCardSecret> {
    return { number: "4242424242424242", cvc: "123" };
  }
  async revealPayToken(): Promise<string> {
    return FAKE_PAY_TOKEN;
  }
  async readHttpPaymentChallenge(header: string): Promise<HttpPaymentChallenge | null> {
    return readStripeChargeChallenge(header);
  }
  async authorizeHttpPayment(
    _credential: unknown,
    _id: string,
    approved: string,
    header: string,
  ): Promise<HttpPaymentAuthorization> {
    return {
      headers: {
        authorization: await stripeChargeAuthorization(approved, header, FAKE_SHARED_PAYMENT_TOKEN),
      },
      secrets: [FAKE_SHARED_PAYMENT_TOKEN],
    };
  }
}

type Row = Record<string, unknown>;

function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, expected]) => {
    if (key === "OR") return (expected as Row[]).some((branch) => matches(row, branch));
    const actual = row[key];
    if (expected instanceof Date)
      return actual instanceof Date && actual.getTime() === expected.getTime();
    if (expected && typeof expected === "object" && "lte" in expected) {
      return actual instanceof Date && actual.getTime() <= (expected.lte as Date).getTime();
    }
    if (expected && typeof expected === "object" && "gte" in expected) {
      return actual instanceof Date && actual.getTime() >= (expected.gte as Date).getTime();
    }
    if (expected && typeof expected === "object" && "not" in expected) {
      return actual !== expected.not;
    }
    return actual === expected;
  });
}

/** Just the Prisma calls the purchase lifecycle makes, over in-memory rows. */
export function fakePurchasePrisma(fixture: {
  spaceId: string;
  userId: string;
  botId: string;
  threadId: string;
}) {
  const purchases: Purchase[] = [];
  const runs: Row[] = [];
  const tasks: Row[] = [];
  const live = { thread: true, member: true, bot: true, threadGeneration: 0 };
  let clock = 0;
  const stamp = () => new Date(Date.UTC(2026, 0, 1) + ++clock);
  const purchase = {
    findUnique: async ({ where }: { where: Row }) =>
      purchases.find((row) => matches(row, where)) ?? null,
    findFirst: async ({ where }: { where: Row }) =>
      purchases.find((row) => matches(row, where)) ?? null,
    findMany: async ({ where, select }: { where: Row; select?: Record<string, boolean> }) =>
      purchases
        .filter((row) => matches(row, where))
        .map((row) =>
          Object.fromEntries(
            Object.keys(select ?? { id: true }).map((key) => [key, row[key as keyof Purchase]]),
          ),
        ),
    upsert: async ({ where, create }: { where: Row; create: Row }) => {
      const existing = purchases.find((row) => matches(row, where));
      if (existing) return existing;
      const row = {
        id: `purchase-${purchases.length + 1}`,
        approvalUrl: null,
        nextPollAt: null,
        wokenStatus: null,
        cardCiphertext: null,
        tokenCiphertext: null,
        merchantAccountId: null,
        paymentChallenge: null,
        requestCiphertext: null,
        credentialType: "card",
        createdAt: new Date(),
        ...create,
        updatedAt: stamp(),
      } as Purchase;
      purchases.push(row);
      return row;
    },
    updateMany: async ({ where, data }: { where: Row; data: Row }) => {
      const found = purchases.filter((row) => matches(row, where));
      for (const row of found) Object.assign(row, data, { updatedAt: stamp() });
      return { count: found.length };
    },
  };
  const spending = fakeSpendingPrisma();
  const tx = {
    ...spending.client,
    purchase,
    thread: {
      updateMany: async ({ where }: { where: Row }) => ({
        count:
          live.thread &&
          where.id === fixture.threadId &&
          where.historyCompactionGeneration === live.threadGeneration
            ? 1
            : 0,
      }),
      findUniqueOrThrow: async () => ({ historyCompactionGeneration: live.threadGeneration }),
    },
    spaceMember: { findUnique: async () => (live.member ? { id: "member" } : null) },
    bot: { findFirst: async () => (live.bot ? { id: fixture.botId } : null) },
    task: {
      create: async ({ data }: { data: Row }) => {
        const row = { id: `task-${tasks.length + 1}`, ...data };
        tasks.push(row);
        return row;
      },
    },
    run: {
      findFirst: async ({ where }: { where: Row }) =>
        runs.find((row) => matches(row, where)) ?? null,
      create: async ({ data }: { data: Row }) => {
        const row = { id: `run-${runs.length + 1}`, ...data };
        runs.push(row);
        return row;
      },
    },
  };
  const prisma = {
    ...tx,
    $transaction: async <T>(fn: (client: typeof tx) => Promise<T>) => fn(tx),
  } as unknown as PrismaClient;
  return { prisma, purchases, runs, tasks, live, spending: spending.state };
}

export function fakeJobs() {
  const enqueued: BackgroundJob[] = [];
  const jobs: JobPublisher = {
    enqueue: async (job) => {
      enqueued.push(job);
    },
    enqueueIn: async (_tx, job) => {
      enqueued.push(job);
    },
    cancelIn: async () => {},
    cancel: async () => {},
    close: async () => {},
  };
  return { enqueued, jobs };
}
