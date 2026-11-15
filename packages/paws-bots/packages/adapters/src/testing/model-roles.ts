import { usableModelId } from "@rakazo/contracts";
import { vi } from "vitest";

type RoleRow = {
  userId: string;
  role: string;
  position: number;
  provider: string;
  modelId: string;
  thinkingLevel: string | null;
};
type RoleWhere = { userId?: string; role?: string };
type Preference = {
  isDefault?: boolean;
  modelId?: string | null;
  thinkingLevel?: string | null;
  credential?: { provider: string };
};
type MockClient = {
  userModelPreference?: {
    findFirst?: (args: unknown) => Promise<unknown>;
    findMany?: (args: unknown) => Promise<unknown>;
  };
  userModelRoleChoice?: unknown;
  spaceModelRoleChoice?: unknown;
  spaceSettingOverride?: unknown;
  $transaction?: ((...args: unknown[]) => Promise<unknown>) & { modelRoles?: true };
};

/** One account main-model row, as `withModelRoles` seeds it. */
export function mainRole(
  scope: { userId: string; spaceId?: string },
  provider: string,
  modelId: string,
  thinkingLevel: string | null = null,
): RoleRow {
  return { userId: scope.userId, role: "main", position: 0, provider, modelId, thinkingLevel };
}

/**
 * Gives a mocked client an in-memory account role table seeded with `rows`, and Spaces that
 * follow the account unless the test says otherwise. A test's own role table keeps answering
 * its pin lookups; role lists come from memory. Without seeded rows, a mocked preference
 * marked `isDefault` stands in for the main model.
 */
export function withModelRoles<T>(prisma: T, rows: RoleRow[] = []): T {
  const client = prisma as MockClient | null;
  if (!client || typeof client !== "object") return prisma;
  const written = new Map<string, RoleRow[]>();
  const key = (where: RoleWhere) => JSON.stringify([where.userId, where.role]);
  for (const row of rows) written.set(key(row), [...(written.get(key(row)) ?? []), row]);
  const preferences = client.userModelPreference;
  const fromPreference = async (where: RoleWhere): Promise<RoleRow[]> => {
    if (where.role !== "main" || !where.userId || !preferences) return [];
    const scope = { userId: where.userId };
    const found = preferences.findFirst
      ? await preferences.findFirst({
          where: { ...scope, isDefault: true },
          include: { credential: true },
          orderBy: [{ updatedAt: "desc" }, { credentialId: "desc" }],
        })
      : (
          (await preferences.findMany?.({ where: scope, include: { credential: true } })) as
            | Preference[]
            | undefined
        )?.find((row) => row.isDefault);
    const preference = found as Preference | null | undefined;
    const modelId = usableModelId(preference?.modelId);
    return preference?.credential && preference.isDefault && modelId
      ? [mainRole(scope, preference.credential.provider, modelId, preference.thinkingLevel ?? null)]
      : [];
  };
  const roleTable = {
    modelRoles: true as const,
    findMany: vi.fn(async ({ where }: { where: RoleWhere }) =>
      written.has(key(where)) ? written.get(key(where))! : fromPreference(where),
    ),
    deleteMany: vi.fn(async ({ where }: { where: RoleWhere }) => {
      written.set(key(where), []);
      return { count: 0 };
    }),
    createMany: vi.fn(async ({ data }: { data: RoleRow[] }) => {
      for (const row of data) written.set(key(row), [...(written.get(key(row)) ?? []), row]);
      return { count: data.length };
    }),
  };
  const augment = (target: MockClient) => {
    const own = target.userModelRoleChoice as
      | { findMany?: (args: { where: RoleWhere }) => Promise<unknown>; modelRoles?: true }
      | undefined;
    target.userModelRoleChoice =
      own && !own.modelRoles
        ? {
            ...roleTable,
            ...own,
            modelRoles: true,
            findMany: vi.fn((args: { where: RoleWhere }) =>
              args.where.role || !own.findMany ? roleTable.findMany(args) : own.findMany(args),
            ),
          }
        : (own ?? roleTable);
    target.spaceSettingOverride ??= {
      findUnique: vi.fn(async () => null),
      findMany: vi.fn(async () => []),
    };
    target.spaceModelRoleChoice ??= {
      findMany: vi.fn(async () => []),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    };
    return target;
  };
  augment(client);
  const transaction = client.$transaction;
  if (typeof transaction === "function" && !transaction.modelRoles) {
    client.$transaction = Object.assign(
      vi.fn((work: unknown, ...rest: unknown[]) =>
        transaction(
          typeof work === "function"
            ? (tx: MockClient) => (work as (tx: MockClient) => unknown)(augment(tx))
            : work,
          ...rest,
        ),
      ),
      { modelRoles: true as const },
    );
  }
  return prisma;
}
