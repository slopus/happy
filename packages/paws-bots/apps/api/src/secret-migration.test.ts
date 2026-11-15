import { randomBytes } from "node:crypto";
import { EncryptedSecretStore, InfisicalSecretStore, migrateSecrets } from "@rakazo/adapters";
import type { PrismaClient, SpaceKeyRecord } from "@rakazo/db";
import { ContentKeyRing, encryptText, LocalKeyProvider } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { infisicalFake } from "../../../packages/adapters/src/secret-store-fake.js";
import { createSecretMigrationRepository } from "./secret-migration.js";

function fixture() {
  const tables = {
    secret: Array.from({ length: 101 }, (_, i) => ({
      id: `row-${String(i).padStart(3, "0")}`,
      ciphertext: `fake-ref-${i}`,
      kind:
        ["run-secret:run", "run-login:run:site", "run-code:run", "run-code-spent:run"][i] ??
        "model",
    })),
    botSecret: [{ id: "bot-row", ciphertext: "fake-bot-ref" }],
    vaultCredential: [
      { id: "vault-row", ciphertext: "fake-vault-ref", updatedAt: new Date("2026-09-01") },
    ],
    integrationProviderConfig: [{ id: "composio", ciphertext: "fake-config-ref" }],
  };
  const client = Object.fromEntries(
    Object.entries(tables).map(([name, rows]) => [
      name,
      {
        findMany: vi.fn(
          async (args: {
            where?: { id: { gt: string } };
            take: number;
            orderBy: { id: string };
          }) => {
            expect(args.orderBy).toEqual({ id: "asc" });
            return rows
              .filter((row) => !args.where || row.id > args.where.id.gt)
              .slice(0, args.take);
          },
        ),
        updateMany: vi.fn(
          async (args: {
            where: { id: string; ciphertext: string };
            data: { ciphertext: string };
          }) => {
            const row = rows.find(
              (row) => row.id === args.where.id && row.ciphertext === args.where.ciphertext,
            );
            if (!row) return { count: 0 };
            row.ciphertext = args.data.ciphertext;
            return { count: 1 };
          },
        ),
        count: vi.fn(
          async (args: { where: { ciphertext: string } }) =>
            rows.filter((row) => row.ciphertext === args.where.ciphertext).length,
        ),
      },
    ]),
  );
  return {
    tables,
    client,
    updateMany: (table: keyof typeof tables) =>
      (client[table] as { updateMany: ReturnType<typeof vi.fn> }).updateMany,
    repository: createSecretMigrationRepository(client as unknown as PrismaClient),
  };
}
describe("migration persistence", () => {
  it("paginates every credential table, binds config ids, and marks short-lived rows", async () => {
    const f = fixture();
    const rows = [];
    for await (const row of f.repository.rows()) rows.push(row);
    expect(rows).toHaveLength(104);
    expect(rows[0]).toMatchObject({ ephemeral: true, id: "row-000", label: "secret" });
    // A run's login and codes are short-lived too, and stay in local encryption.
    expect(rows.slice(0, 4).map((row) => row.ephemeral)).toEqual([true, true, true, true]);
    expect(rows[4]?.ephemeral).toBeFalsy();
    expect(rows.at(-1)).toMatchObject({
      id: "composio",
      recordId: "integration-provider:composio",
      ref: "fake-config-ref",
    });
    expect(rows.find((row) => row.id === "bot-row")?.recordId).toBe("bot-row");
    expect(rows.find((row) => row.id === "vault-row")?.recordId).toBe("vault-row");
  });
  it("compares the original ref so a concurrent update or delete wins", async () => {
    const f = fixture();
    const row = (await f.repository.rows()[Symbol.asyncIterator]().next()).value!;
    expect(await f.repository.replace(row, "fake-next")).toBe(true);
    expect(await f.repository.replace(row, "fake-stale")).toBe(false);
    f.tables.secret.splice(0, 1);
    expect(await f.repository.replace(row, "fake-deleted")).toBe(false);
    expect(await f.repository.referenced("fake-bot-ref")).toBe(true);
    expect(await f.repository.referenced("fake-config-ref")).toBe(true);
    expect(await f.repository.referenced("fake-missing")).toBe(false);
  });
  it("moves a vault value under its vault key to Infisical through the vault's reader", async () => {
    const f = fixture();
    for (const rows of [f.tables.secret, f.tables.botSecret, f.tables.integrationProviderConfig])
      rows.length = 0;
    const keys: SpaceKeyRecord[] = [];
    const provider = new LocalKeyProvider([{ id: "test", key: randomBytes(32) }]);
    const store = {
      forSpace: async (spaceId: string) => keys.filter((key) => key.spaceId === spaceId),
      byId: async (id: string) => keys.find((key) => key.id === id),
      insert: async (record: SpaceKeyRecord) => {
        keys.push(record);
        return record;
      },
      rowContext: async () => undefined,
      sampleByMasterKey: async () => [],
    };
    const ring = new ContentKeyRing(provider, store);
    const location = { table: "vault_credentials", column: "ciphertext", owner: "user-1" };
    Object.assign(f.tables.vaultCredential[0]!, {
      userId: "user-1",
      spaceId: null,
      ciphertext: encryptText(
        await ring.current("user:user-1"),
        { ...location, rowId: "vault-row" },
        "fake vault value",
      ),
    });
    Object.assign(f.client, { $contentEncryption: () => ({ ring }) });
    const fake = infisicalFake();
    const remote = new InfisicalSecretStore(fake.options);
    await remote.start();
    try {
      const context = {
        operationId: "test",
        traceId: "test",
        userId: "test",
        spaceId: "test",
        signal: new AbortController().signal,
      };
      // The key manager takes the unwrap and never answers; the command stops at its
      // interruption instead of waiting (its exit code says so), and the next run moves the value.
      ring.clear();
      const controller = new AbortController();
      const stalled = vi.spyOn(provider, "unwrap").mockImplementation(() => {
        controller.abort(new Error("interrupted"));
        return new Promise(() => {});
      });
      expect(
        await migrateSecrets(
          f.repository,
          new EncryptedSecretStore("key"),
          remote,
          { ...context, signal: controller.signal },
          { direction: "forward" },
        ),
      ).toMatchObject({ migrated: 0 });
      expect(f.tables.vaultCredential[0]!.ciphertext).toMatch(/^rkz1:/);
      stalled.mockRestore();
      Object.assign(f.client, {
        $contentEncryption: () => ({ ring: new ContentKeyRing(provider, store) }),
      });
      expect(
        await migrateSecrets(f.repository, new EncryptedSecretStore("key"), remote, context, {
          direction: "forward",
        }),
      ).toMatchObject({ migrated: 1, failed: 0 });
      const moved = f.tables.vaultCredential[0]!.ciphertext;
      expect(moved).toMatch(/^infisical:/);
      expect(await remote.load(moved, "vault-row")).toBe("fake vault value");
    } finally {
      await remote.close();
    }
  }, 2_000);

  it("keeps a vault item's date, which a pending card approval checks", async () => {
    const f = fixture();
    const rows = [];
    for await (const row of f.repository.rows()) rows.push(row);
    const vault = rows.find((row) => row.id === "vault-row")!;
    // The row carries its date, so the scan keeps nothing per row beyond its batch.
    const other = createSecretMigrationRepository(f.client as unknown as PrismaClient);
    expect(await other.replace(vault, "fake-moved")).toBe(true);
    const updatedAt = new Date("2026-09-01");
    expect(f.updateMany("vaultCredential")).toHaveBeenCalledWith({
      where: { id: "vault-row", ciphertext: "fake-vault-ref", updatedAt },
      data: { ciphertext: "fake-moved", updatedAt },
    });
  });
});
