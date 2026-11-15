import type { PrismaClient } from "@rakazo/db";
import { installAuditEventStore } from "@rakazo/db";
import { vi } from "vitest";

/**
 * An audit log that keeps the rows written to it. space-1 belongs to org-1, where the person a
 * vault event is about is a member, or only a guest whose own organization is org-own. A failing
 * one refuses every write. Callers uninstall it with `installAuditEventStore(undefined)`.
 */
export function fakeAuditLog(role: "member" | "guest" = "member", failing = false) {
  const rows: Array<Record<string, unknown>> = [];
  installAuditEventStore({
    auditEvent: {
      createMany: async ({ data }: { data: Array<Record<string, unknown>> }) => {
        if (failing) throw new Error("the audit log is down");
        // The time the table gives a row written without one.
        rows.push(...data.map((row) => ({ createdAt: new Date(), ...row })));
        return { count: data.length };
      },
    },
    space: { findUnique: async () => ({ organizationId: "org-1", name: "Home" }) },
    member: {
      findUnique: async () => ({ role }),
      findMany: async () => [{ organizationId: "org-own", role: "owner" }],
    },
  } as never);
  return rows;
}

// No database is available offline, so these run against an in-memory stand-in for the
// vault_credentials table. Encryption, validation, and redaction are the real implementations.
type Row = {
  id: string;
  userId: string;
  /** Null in the account vault. */
  spaceId: string | null;
  name: string;
  origin: string;
  auth: unknown;
  ciphertext: string;
  title?: string;
  note?: string;
  policy?: string;
  alsoOn?: string[];
  codesStoppedAt?: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
};
type Where = Record<string, unknown>;
/** A bot an item is limited to, in the bot's Space. */
type Assignment = { credentialId: string; botId: string; userId: string; spaceId: string };
/** A Space in which an item is limited to its chosen bots. */
type Limit = { credentialId: string; userId: string; spaceId: string };
type Scoping = { chosen: Assignment[]; limited: Limit[] };

function matches<T extends object>(
  row: T,
  where: Where,
  scoping: Scoping = { chosen: [], limited: [] },
): boolean {
  const id = (row as { id?: string }).id;
  return Object.entries(where).every(([key, value]) => {
    if (key === "OR") return (value as Where[]).some((branch) => matches(row, branch, scoping));
    if (key === "AND") return (value as Where[]).every((branch) => matches(row, branch, scoping));
    if (key === "bots") {
      const { botId } = (value as { some: { botId: string } }).some;
      return scoping.chosen.some((entry) => entry.credentialId === id && entry.botId === botId);
    }
    if (key === "limits") {
      const { spaceId } = (value as { none: { spaceId: string } }).none;
      return !scoping.limited.some(
        (entry) => entry.credentialId === id && entry.spaceId === spaceId,
      );
    }
    const field = row[key as keyof T] as unknown;
    if (field instanceof Date && value instanceof Date) return field.getTime() === value.getTime();
    if (value && typeof value === "object" && "gt" in value)
      return String(field) > String(value.gt);
    if (value && typeof value === "object" && "in" in value)
      return (value.in as unknown[]).includes(field);
    if (value && typeof value === "object" && "notIn" in value)
      return !(value.notIn as unknown[]).includes(field);
    if (value && typeof value === "object" && "not" in value) return field !== value.not;
    if (value && typeof value === "object" && "has" in value)
      return ((field as string[] | undefined) ?? []).includes(String(value.has));
    if (value && typeof value === "object" && "startsWith" in value)
      return String(field).startsWith(String(value.startsWith));
    if (value && typeof value === "object" && "path" in value) {
      const filter = value as { path: string[]; equals: unknown };
      return (field as Record<string, unknown> | null)?.[filter.path[0]!] === filter.equals;
    }
    return field === value;
  });
}

/** A row in the member's account vault, which every Space without its own vault uses. */
export const accountVault = { userId: "user-1", spaceId: null };

export function fakeDatabase() {
  let rows: Row[] = [];
  let assignments: Assignment[] = [];
  let limits: Limit[] = [];
  const scoping = () => ({ chosen: assignments, limited: limits });
  // The member's bots, by Space.
  const bots = [
    { id: "bot-1", userId: "user-1", spaceId: "space-1" },
    { id: "bot-2", userId: "user-1", spaceId: "space-1" },
    { id: "bot-other-space", userId: "user-1", spaceId: "space-2" },
    { id: "bot-of-another-member", userId: "user-2", spaceId: "space-1" },
  ];
  // A clock that moves on every write, as updatedAt does, so a changed row is told apart.
  let tick = Date.parse("2026-09-01T00:00:00.000Z");
  const now = () => {
    tick += 1000;
    return new Date(tick);
  };
  let secrets: Array<Record<string, unknown>> = [];
  const secretMatches = (row: Record<string, unknown>, where: Where) =>
    Object.entries(where).every(([key, value]) =>
      value && typeof value === "object" && "in" in value
        ? (value.in as unknown[]).includes(row[key])
        : row[key] === value,
    );
  // Spaces that customized "credentials" and so use their own vault.
  const ownVaults = new Set<string>();
  const vaultCredential = {
    findFirst: vi.fn(
      // A copy, as Prisma returns: a later write never changes what an earlier read saw.
      async ({ where }: { where: Where }) => {
        const row = rows.find((r) => matches(r, where, scoping()));
        return row ? { ...row } : null;
      },
    ),
    findMany: vi.fn(
      async ({
        where,
        take,
        orderBy,
      }: {
        where: Where;
        take?: number;
        orderBy?: { id?: "asc"; name?: "asc" };
      }) =>
        rows
          .filter((row) => matches(row, where, scoping()))
          .sort((left, right) =>
            orderBy?.id
              ? Number(left.id > right.id) - Number(left.id < right.id)
              : left.name.localeCompare(right.name),
          )
          .slice(0, take ?? rows.length)
          .map((row) => ({ ...row })),
    ),
    count: vi.fn(
      async ({ where }: { where: Where }) =>
        rows.filter((r) => matches(r, where, scoping())).length,
    ),
    create: vi.fn(async ({ data }: { data: Row }) => {
      const at = now();
      rows.push({ policy: "allow", createdAt: at, updatedAt: at, ...data });
    }),
    update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
      // An explicit updatedAt is kept, as Prisma keeps it.
      Object.assign(rows.find((row) => row.id === where.id)!, { updatedAt: now() }, data);
    }),
    updateMany: vi.fn(async ({ where, data }: { where: Where; data: Partial<Row> }) => {
      const matched = rows.filter((row) => matches(row, where, scoping()));
      for (const row of matched) Object.assign(row, { updatedAt: now() }, data);
      return { count: matched.length };
    }),
    deleteMany: vi.fn(async ({ where }: { where: Where }) => {
      const before = rows.length;
      rows = rows.filter((row) => !matches(row, where, scoping()));
      // Its bots go with it, as the foreign key cascades.
      assignments = assignments.filter((entry) =>
        rows.some((row) => row.id === entry.credentialId),
      );
      limits = limits.filter((entry) => rows.some((row) => row.id === entry.credentialId));
      return { count: before - rows.length };
    }),
  };
  const vaultCredentialLimit = {
    findMany: vi.fn(async ({ where }: { where: Where }) =>
      limits.filter((entry) => matches(entry, where)),
    ),
    deleteMany: vi.fn(async ({ where }: { where: Where }) => {
      const before = limits.length;
      limits = limits.filter((entry) => !matches(entry, where));
      return { count: before - limits.length };
    }),
    createMany: vi.fn(async ({ data }: { data: Limit[] }) => {
      const fresh = data.filter(
        (entry) =>
          !limits.some(
            (saved) => saved.credentialId === entry.credentialId && saved.spaceId === entry.spaceId,
          ),
      );
      limits.push(...fresh);
      return { count: fresh.length };
    }),
  };
  const vaultCredentialBot = {
    findMany: vi.fn(async ({ where }: { where: Where }) =>
      assignments.filter((entry) => matches(entry, where)),
    ),
    deleteMany: vi.fn(async ({ where }: { where: Where }) => {
      const before = assignments.length;
      assignments = assignments.filter((entry) => !matches(entry, where));
      return { count: before - assignments.length };
    }),
    createMany: vi.fn(async ({ data }: { data: Assignment[] }) => {
      const fresh = data.filter(
        (entry) =>
          !assignments.some(
            (saved) => saved.credentialId === entry.credentialId && saved.botId === entry.botId,
          ),
      );
      assignments.push(...fresh);
      return { count: fresh.length };
    }),
  };
  const client: Record<string, unknown> = {
    vaultCredential,
    vaultCredentialBot,
    vaultCredentialLimit,
    bot: {
      count: vi.fn(
        async ({ where }: { where: Where }) => bots.filter((b) => matches(b, where)).length,
      ),
    },
    spaceSettingOverride: {
      findUnique: vi.fn(
        async ({ where }: { where: { spaceId_userId_setting: { spaceId: string } } }) =>
          ownVaults.has(where.spaceId_userId_setting.spaceId) ? { setting: "credentials" } : null,
      ),
    },
    // Run-scoped rows, such as codes a run typed; ids are unique as in Postgres.
    secret: {
      count: vi.fn(async () => 0),
      findFirst: vi.fn(async () => null),
      findUnique: vi.fn(
        async ({ where }: { where: { id: string } }) =>
          secrets.find((row) => row.id === where.id) ?? null,
      ),
      findMany: vi.fn(async ({ where }: { where: Where }) =>
        secrets.filter((row) => secretMatches(row, where)),
      ),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        if (secrets.some((row) => row.id === data.id))
          throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
        secrets.push({ ...data });
      }),
      deleteMany: vi.fn(async ({ where }: { where: Where }) => {
        const before = secrets.length;
        secrets = secrets.filter((row) => !secretMatches(row, where));
        return { count: before - secrets.length };
      }),
    },
    // The previous release's table, still counted before a stored value is deleted.
    botSecret: { count: vi.fn(async () => 0) },
    integrationProviderConfig: { count: vi.fn(async () => 0) },
    // The member's settings lock always finds the membership row.
    $queryRaw: vi.fn(async () => [{ locked: 1 }]),
  };
  // One transaction at a time, as the bot row lock serializes them in Postgres, and a failed
  // one leaves the rows as they were.
  let queue: Promise<unknown> = Promise.resolve();
  client.$transaction = (fn: (tx: unknown) => Promise<unknown>) => {
    const next = queue.then(async () => {
      const before = rows.map((row) => ({ ...row }));
      const chosenBefore = [...assignments];
      const limitsBefore = [...limits];
      try {
        return await fn(client);
      } catch (error) {
        rows = before;
        assignments = chosenBefore;
        limits = limitsBefore;
        throw error;
      }
    });
    queue = next.catch(() => undefined);
    return next;
  };
  return {
    rows: () => rows,
    assignments: () => assignments,
    limits: () => limits,
    secrets: () => secrets,
    useOwnVault: (spaceId: string) => ownVaults.add(spaceId),
    prisma: client as unknown as PrismaClient,
  };
}
