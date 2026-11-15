import { ORPCError } from "@orpc/server";
import { EncryptedSecretStore } from "@rakazo/adapters";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { deleteAgentSecret, listAgentSecrets, putAgentSecret } from "./agent-secrets.js";

const actor = {
  userId: "user-1",
  spaceId: "space-1",
  email: "owner@example.com",
  isDeploymentOwner: true,
};

type Row = Record<string, unknown>;
const matches = (row: Row, where: Row = {}) =>
  Object.entries(where).every(([key, value]) => row[key] === value);

// An in-memory vault, so the routes run against the real vault storage and validation.
function fixture(role = "owner") {
  const rows: Row[] = [];
  const now = new Date("2026-01-01T00:00:00.000Z");
  const pick = (row: Row, select?: Record<string, boolean>) =>
    select ? Object.fromEntries(Object.keys(select).map((key) => [key, row[key]])) : { ...row };
  const prisma: Record<string, unknown> = {
    spaceMember: { findUnique: vi.fn(async () => ({ role })) },
    spaceSettingOverride: { findUnique: vi.fn(async () => null) },
    vaultCredential: {
      findMany: vi.fn(async ({ where, select }: { where: Row; select?: Record<string, boolean> }) =>
        rows.filter((row) => matches(row, where)).map((row) => pick(row, select)),
      ),
      findFirst: vi.fn(
        async ({ where, select }: { where: Row; select?: Record<string, boolean> }) => {
          const row = rows.find((entry) => matches(entry, where));
          return row ? pick(row, select) : null;
        },
      ),
      count: vi.fn(
        async ({ where }: { where: Row }) => rows.filter((row) => matches(row, where)).length,
      ),
      create: vi.fn(async ({ data }: { data: Row }) => {
        rows.push({ ...data, createdAt: now, updatedAt: now });
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Row }) => {
        Object.assign(rows.find((row) => row.id === where.id) ?? {}, data);
      }),
      deleteMany: vi.fn(async ({ where }: { where: Row }) => {
        const before = rows.length;
        rows.splice(0, rows.length, ...rows.filter((row) => !matches(row, where)));
        return { count: before - rows.length };
      }),
    },
    secret: { count: vi.fn(async () => 0) },
    botSecret: { count: vi.fn(async () => 0) },
    integrationProviderConfig: { count: vi.fn(async () => 0) },
    $queryRaw: vi.fn(async () => [{ locked: 1 }]),
  };
  prisma.$transaction = async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma);
  const deps = {
    prisma: prisma as unknown as PrismaClient,
    secrets: new EncryptedSecretStore("test-only-encryption-key"),
  };
  return { deps, rows };
}

describe("agent secrets on the vault", () => {
  it("saves a variable as a vault command variable that keeps its environment name", async () => {
    const { deps, rows } = fixture();
    await expect(
      putAgentSecret(deps, actor, { name: "ACME_TOKEN", value: "fake-acme" }),
    ).resolves.toEqual(expect.objectContaining({ id: "acme_token", name: "ACME_TOKEN" }));
    expect(rows).toEqual([
      expect.objectContaining({
        userId: "user-1",
        spaceId: null,
        name: "acme_token",
        auth: { type: "command" },
      }),
    ]);
    expect(JSON.stringify(rows)).not.toContain("fake-acme");
    expect(await listAgentSecrets(deps, actor)).toEqual([
      expect.objectContaining({ id: "acme_token", name: "ACME_TOKEN" }),
    ]);
  });

  it("lists only command variables and removes by id", async () => {
    const { deps, rows } = fixture();
    await putAgentSecret(deps, actor, { name: "ACME_TOKEN", value: "fake-acme" });
    rows.push({
      id: "login",
      userId: "user-1",
      spaceId: null,
      name: "site",
      origin: "https://login.example.test",
      auth: { type: "login" },
      ciphertext: "unused",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    expect((await listAgentSecrets(deps, actor)).map((row) => row.name)).toEqual(["ACME_TOKEN"]);
    await expect(deleteAgentSecret(deps, actor, "site")).rejects.toBeInstanceOf(ORPCError);
    await expect(deleteAgentSecret(deps, actor, "acme_token")).resolves.toEqual({ ok: true });
    expect(rows.map((row) => row.name)).toEqual(["site"]);
  });

  it("rejects non-owners", async () => {
    const { deps, rows } = fixture("member");
    rows.push({
      id: "acme",
      userId: "user-1",
      spaceId: null,
      name: "acme_token",
      origin: "",
      auth: { type: "command" },
      ciphertext: "unused",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await expect(listAgentSecrets(deps, actor)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      putAgentSecret(deps, actor, { name: "ACME_TOKEN", value: "fake" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(deleteAgentSecret(deps, actor, "acme_token")).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(rows).toHaveLength(1);
  });

  it("updates a variable through the vault name that exports it", async () => {
    const { deps, rows } = fixture();
    rows.push({
      id: "netbird",
      userId: "user-1",
      spaceId: null,
      name: "netbird-setup-key",
      origin: "",
      auth: { type: "command" },
      ciphertext: "unused",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await expect(
      putAgentSecret(deps, actor, { name: "NETBIRD_SETUP_KEY", value: "fake-rotated" }),
    ).resolves.toEqual(
      expect.objectContaining({ id: "netbird-setup-key", name: "NETBIRD_SETUP_KEY" }),
    );
    expect(rows.map((row) => row.name)).toEqual(["netbird-setup-key"]);
    expect(rows[0]!.ciphertext).not.toBe("unused");
  });

  it("refuses a variable named like a saved login, leaving the login as it was", async () => {
    const { deps, rows } = fixture();
    const login = {
      id: "login",
      userId: "user-1",
      spaceId: null,
      name: "acme_token",
      origin: "https://login.example.test",
      auth: { type: "login" },
      ciphertext: "unused",
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    rows.push({ ...login });
    await expect(
      putAgentSecret(deps, actor, { name: "ACME_TOKEN", value: "fake" }),
    ).rejects.toThrow("Remove the existing credential before changing its destination");
    expect(rows).toEqual([login]);
  });

  it("refuses a variable that starts with an underscore", async () => {
    const { deps, rows } = fixture();
    await expect(
      putAgentSecret(deps, actor, { name: "_API_TOKEN", value: "fake" }),
    ).rejects.toThrow("Variable names must start with a letter");
    expect(rows).toEqual([]);
  });
});
