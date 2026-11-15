import type { SpendingLimit } from "@rakazo/contracts";

type PaymentRow = {
  operationKey: string;
  userId: string;
  site: string;
  amount: number;
  currency: string;
  releasedAt: Date | null;
  createdAt: Date;
};
type Where = { operationKey?: string; userId?: string; currency?: string; releasedAt?: null };

/** In memory, just the spending limit and payment calls the ledger makes. One user, no timezone. */
export function fakeSpendingPrisma(initial: SpendingLimit | null = null) {
  const state = {
    limit: initial ? { ...initial, startsAt: new Date(0) } : null,
    payments: [] as PaymentRow[],
  };
  const matches = (row: PaymentRow, where: Where) =>
    (where.operationKey === undefined || row.operationKey === where.operationKey) &&
    (where.userId === undefined || row.userId === where.userId) &&
    (where.currency === undefined || row.currency === where.currency) &&
    (where.releasedAt !== null || row.releasedAt === null);
  const client = {
    spendingLimit: {
      findUnique: async ({ where }: { where: { userId: string } }) =>
        state.limit ? { userId: where.userId, updatedAt: new Date(0), ...state.limit } : null,
    },
    payment: {
      findUnique: async ({ where }: { where: { operationKey: string } }) =>
        state.payments.find((row) => row.operationKey === where.operationKey) ?? null,
      aggregate: async ({ where }: { where: Where }) => ({
        _sum: {
          amount: state.payments
            .filter((row) => matches(row, where))
            .reduce((sum, row) => sum + row.amount, 0),
        },
      }),
      upsert: async ({
        where,
        create,
        update,
      }: {
        where: { operationKey: string };
        create: Omit<PaymentRow, "releasedAt">;
        update: Partial<PaymentRow>;
      }) => {
        const existing = state.payments.find((row) => row.operationKey === where.operationKey);
        if (existing) return Object.assign(existing, update);
        const row = { ...create, releasedAt: null };
        state.payments.push(row);
        return row;
      },
      updateMany: async ({ where, data }: { where: Where; data: Partial<PaymentRow> }) => {
        const found = state.payments.filter((row) => matches(row, where));
        for (const row of found) Object.assign(row, data);
        return { count: found.length };
      },
    },
    user: { findUnique: async () => ({ timezone: null }) },
    $queryRaw: async () => [],
  };
  return { client, state };
}
