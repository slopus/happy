import { randomBytes } from "node:crypto";
import type { AdapterContext, SecretStore } from "@rakazo/adapter-kit";
import type { BotSecretDestination } from "@rakazo/contracts";
import type { PrismaClient, SpaceKeyRecord, SpaceKeyStore } from "@rakazo/db";
import {
  ContentKeyRing,
  ciphertextKeyId,
  LocalKeyProvider,
  VaultKeyOwnerGoneError,
} from "@rakazo/db";
import type { Mock } from "vitest";
import { describe, expect, it, vi } from "vitest";
import {
  listVaultItems,
  loadCommandVariables,
  loadLoginPasswordRedactions,
  relabelVaultItem,
  requestWithBotSecret,
  resolveLoginFill,
  resolveVaultCardFill,
  revealBotSecret,
  storeBotSecret,
} from "./bot-secrets.js";
import { fakeDatabase } from "./bot-secrets.test-support.js";
import { InfisicalSecretStore } from "./infisical-secret-store.js";
import { computerTools } from "./run-tools-computer.js";
import { ComposedSecretStore } from "./secret-store-factory.js";
import { infisicalFake } from "./secret-store-fake.js";
import { EncryptedSecretStore } from "./secrets.js";
import {
  migrateVaultValues,
  openVaultValue,
  rotateVaultKeys,
  vaultItemsUnderOlderKeys,
} from "./vault-values.js";

const scope = { userId: "user-1", spaceId: "space-1" };
// The same store the previous release reads vault values with.
const secretStore = new EncryptedSecretStore("test-only-encryption-key");
const login = {
  name: "site",
  origin: "https://login.example.test",
  auth: { type: "login" },
} as BotSecretDestination;
const card = { name: "visa", origin: "", auth: { type: "card" } } as BotSecretDestination;
const loginValue = (password = "fake-password-1") =>
  JSON.stringify({
    fields: [
      { label: "Email", value: "alex@example.test", hidden: false },
      { label: "Password", value: password, hidden: true },
    ],
  });
const fakeCard = { number: "4242424242424242", expMonth: 8, expYear: 2030, cvc: "123", name: "A" };
const context: AdapterContext = {
  operationId: "test",
  traceId: "test",
  userId: "user-1",
  spaceId: "space-1",
  signal: new AbortController().signal,
};

/** The fake database with content encryption on, keys kept in memory as space_keys would. */
function encryptedDatabase(encryptWrites = true) {
  const db = fakeDatabase();
  const keys: SpaceKeyRecord[] = [];
  // Vault scopes whose member or Space was deleted: their keys are shredded and none is created.
  const gone = new Set<string>();
  const deleteOwner = (scope: string) => {
    gone.add(scope);
    keys.splice(0, keys.length, ...keys.filter((key) => key.spaceId !== scope));
  };
  const provider = new LocalKeyProvider([{ id: "test", key: randomBytes(32) }]);
  const store: SpaceKeyStore = {
    forSpace: async (spaceId) => keys.filter((key) => key.spaceId === spaceId),
    byId: async (id) => keys.find((key) => key.id === id),
    insert: async (record) => {
      if (gone.has(record.spaceId)) throw new VaultKeyOwnerGoneError();
      keys.push(record);
      return record;
    },
    rowContext: async () => undefined,
    sampleByMasterKey: async () => [],
  };
  const ring = new ContentKeyRing(provider, store, { encryptWrites });
  Object.assign(db.prisma, {
    $contentEncryption: () => ({ ring }),
    // Each vault key's scope once, after the cursor, as GROUP BY returns them.
    spaceKey: {
      groupBy: async ({
        where,
        take,
      }: {
        where: { spaceId: { gt?: string; in?: string[] } };
        take?: number;
      }) =>
        [...new Set(keys.map((key) => key.spaceId))]
          .filter(
            (spaceId) =>
              /^(user|vault):/.test(spaceId) &&
              (where.spaceId.in
                ? where.spaceId.in.includes(spaceId)
                : spaceId > (where.spaceId.gt ?? "")),
          )
          .sort()
          .slice(0, take)
          .map((spaceId) => ({
            spaceId,
            _max: {
              version: Math.max(
                ...keys.filter((key) => key.spaceId === spaceId).map((key) => key.version),
              ),
            },
          })),
      findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
        keys
          .filter((key) => where.id.in.includes(key.id))
          .map(({ id, spaceId, version }) => ({ id, spaceId, version })),
      findFirst: async ({ where }: { where: { spaceId: string } }) =>
        [...keys]
          .filter((key) => key.spaceId === where.spaceId)
          .sort((a, b) => b.version - a.version)[0] ?? null,
      findUnique: async ({ where }: { where: { id: string } }) => {
        const key = keys.find((stored) => stored.id === where.id);
        return key ? { id: key.id, spaceId: key.spaceId, version: key.version } : null;
      },
    },
  });
  const reports: string[] = [];
  const reasons = new Map<string, string | undefined>();
  const migrate = (
    mode: "encrypt" | "reencrypt" | "decrypt" = "encrypt",
    dryRun = false,
    signal = context.signal,
  ) =>
    migrateVaultValues(
      db.prisma,
      secretStore,
      { ...context, signal },
      {
        mode,
        dryRun,
        report: (row, status, reason) => {
          reports.push(`${row.id} ${status}`);
          if (status === "failed") reasons.set(row.id, reason);
        },
      },
    );
  /** Another process on the same rows and keys, with its own key cache. */
  const otherProcess = () => {
    const other = new ContentKeyRing(provider, store, { encryptWrites });
    const prisma = { ...db.prisma, $contentEncryption: () => ({ ring: other }) } as PrismaClient;
    const reports = new Map<string, string>();
    const migrate = (mode: "encrypt" | "reencrypt") =>
      migrateVaultValues(prisma, secretStore, context, {
        mode,
        report: (row, status) => reports.set(row.id, status),
      });
    return { ring: other, prisma, migrate, reports };
  };
  return { ...db, keys, deleteOwner, otherProcess, provider, ring, migrate, reports, reasons };
}

type Db = ReturnType<typeof encryptedDatabase>;

function save(db: Db, destination: BotSecretDestination, plaintext: string, store?: SecretStore) {
  return storeBotSecret({
    prisma: db.prisma,
    secretStore: store ?? secretStore,
    scope,
    destination,
    plaintext,
  });
}

const row = (db: Db, name: string) => db.rows().find((stored) => stored.name === name)!;

const reveal = (db: Db, name: string, userId = scope.userId) =>
  revealBotSecret({ prisma: db.prisma, secretStore, scope: { ...scope, userId }, name });

const fillPassword = (db: Db) =>
  resolveLoginFill({
    prisma: db.prisma,
    secretStore,
    scope,
    runId: "run-1",
    name: "site",
    field: "password",
  });

describe("vault values under the envelope keys", () => {
  it("saves with the newest key when an unused historical key cannot unwrap", async () => {
    const db = encryptedDatabase();
    await save(db, login, loginValue());
    await db.migrate();
    const old = db.keys[0]!;
    const newest = await db.ring.rotate("user:user-1");
    db.ring.clear();
    const unwrap = db.provider.unwrap.bind(db.provider);
    const calls = vi.spyOn(db.provider, "unwrap").mockImplementation((record, context) => {
      if (record.wrappedKey === old.wrappedKey) throw new Error("retired key");
      return unwrap(record, context);
    });

    await save(db, card, JSON.stringify(fakeCard));

    expect(ciphertextKeyId(row(db, "visa").ciphertext)).toBe(newest.id);
    expect(calls).toHaveBeenCalledTimes(1);
    expect(await openVaultValue(db.prisma, secretStore, row(db, "visa"))).toBe(
      JSON.stringify(fakeCard),
    );
  });

  it("keeps the previous release's format until migrate creates the vault's key", async () => {
    const db = encryptedDatabase();
    await save(db, login, loginValue());
    expect(row(db, "site").ciphertext).toMatch(/^v2:/);
    expect(await secretStore.load(row(db, "site").ciphertext, row(db, "site").id)).toBe(
      loginValue(),
    );
    expect(db.keys).toEqual([]);

    await db.migrate();
    expect(db.keys.map((key) => key.spaceId)).toEqual(["user:user-1"]);
    await save(db, card, JSON.stringify(fakeCard));
    await save(db, { name: "token", origin: "", auth: { type: "command" } }, "fake-command-value");
    expect(db.rows().every((stored) => stored.ciphertext.startsWith("rkz1:"))).toBe(true);
    expect(JSON.stringify(db.rows())).not.toContain("fake-password-1");

    expect(await fillPassword(db)).toMatchObject({ text: "fake-password-1", hidden: true });
    expect(await reveal(db, "site")).toMatchObject({ fields: expect.any(Array) });
    expect(
      await resolveVaultCardFill({
        prisma: db.prisma,
        secretStore,
        scope,
        name: "visa",
        field: "number",
        site: "https://shop.example.test",
        savedAt: row(db, "visa").updatedAt!.toISOString(),
      }),
    ).toMatchObject({ text: "4242424242424242" });
    expect((await loadCommandVariables(db.prisma, secretStore, scope)).env).toEqual({
      TOKEN: "fake-command-value",
    });
    expect((await listVaultItems(db.prisma, secretStore, scope))[0]).toMatchObject({
      preview: { username: "alex@example.test" },
    });

    // A Space's own vault gets its key from migrate too, not from the Space's content key.
    db.useOwnVault("space-1");
    await save(db, login, loginValue());
    expect(db.rows().find((stored) => stored.spaceId)!.ciphertext).toMatch(/^v2:/);
    await db.migrate();
    expect(db.keys.map((key) => key.spaceId)).toEqual(["user:user-1", "vault:space-1"]);
    await save(db, login, loginValue("fake-password-2"));
    expect(db.rows().find((stored) => stored.spaceId)!.ciphertext).toMatch(/^rkz1:/);
    expect(await fillPassword(db)).toMatchObject({ text: "fake-password-2" });
  });

  it("hides envelope logins and cards in every run, beside an older item", async () => {
    const db = encryptedDatabase();
    await save(db, login, loginValue());
    await save(db, card, JSON.stringify(fakeCard));
    await db.migrate();
    const legacy = await secretStore.put(loginValue("fake-password-old"), context, {
      recordId: "legacy",
    });
    db.rows().push({
      ...row(db, "site"),
      id: "legacy",
      name: "legacy",
      ciphertext: legacy.ciphertext,
    });
    expect(row(db, "site").ciphertext).toMatch(/^rkz1:/);
    expect(await loadLoginPasswordRedactions(db.prisma, secretStore, scope)).toEqual(
      expect.arrayContaining(["fake-password-1", "4242424242424242", "fake-password-old"]),
    );
  });

  it("stops a run whose saved logins can't be hidden while the key manager is down", async () => {
    const db = encryptedDatabase();
    await save(db, login, loginValue());
    await save(db, card, JSON.stringify(fakeCard));
    await db.migrate();
    db.ring.clear();
    const unwrap = vi.spyOn(db.provider, "unwrap").mockRejectedValue(new Error("fake outage"));
    await expect(loadLoginPasswordRedactions(db.prisma, secretStore, scope)).rejects.toThrow(
      "key manager",
    );
    unwrap.mockRestore();
    // One item's own damaged data is skipped, as before.
    const visa = row(db, "visa");
    visa.ciphertext = `${visa.ciphertext.slice(0, -4)}AAAA`;
    const forms = await loadLoginPasswordRedactions(db.prisma, secretStore, scope);
    expect(forms).toContain("fake-password-1");
    expect(forms).not.toContain("4242424242424242");
  });

  it("stops a run whose command variables can't be loaded while the key manager is down", async () => {
    const db = encryptedDatabase();
    const command = (name: string) =>
      ({ name, origin: "", auth: { type: "command" } }) as BotSecretDestination;
    await save(db, command("gh_token"), "fake-gh-token");
    await save(db, command("other_token"), "fake-other-token");
    await db.migrate();
    db.ring.clear();
    const unwrap = vi.spyOn(db.provider, "unwrap").mockRejectedValue(new Error("fake outage"));
    await expect(loadCommandVariables(db.prisma, secretStore, scope)).rejects.toThrow(
      "key manager",
    );
    // A running run's later commands go on without the variable.
    const unset = new Set<string>();
    expect((await loadCommandVariables(db.prisma, secretStore, scope, unset, "unset")).env).toEqual(
      {},
    );
    expect([...unset].sort()).toEqual(["GH_TOKEN", "OTHER_TOKEN"]);
    unwrap.mockRestore();
    // One item's own damaged data is left unset, as before.
    const other = row(db, "other_token");
    other.ciphertext = `${other.ciphertext.slice(0, -4)}AAAA`;
    expect((await loadCommandVariables(db.prisma, secretStore, scope)).env).toEqual({
      GH_TOKEN: "fake-gh-token",
    });
  });

  it("runs a shell command mid-run without a variable it can't load while the key manager is down", async () => {
    const db = encryptedDatabase();
    await save(
      db,
      { name: "gh_token", origin: "", auth: { type: "command" } } as BotSecretDestination,
      "fake-gh-token",
    );
    await db.migrate();
    db.ring.clear();
    vi.spyOn(db.provider, "unwrap").mockRejectedValue(new Error("fake outage"));
    const execute = vi.fn(async function* () {
      yield { type: "stdout" as const, data: "ok" };
      yield { type: "exit" as const, code: 0 };
    });
    const ctx = {
      deps: {
        prisma: db.prisma,
        secretStore,
        sandbox: { execute },
        events: { append: async () => {} },
      },
      run: { ...scope, id: "run-1", botId: "bot-1" },
      runId: "run-1",
      bot: { id: "bot-1" },
      thread: { id: "thread-1" },
      context,
      computer: {
        mode: "private",
        checkpoint: { markDirty: () => {} },
        get: async () => ({ id: "c1", botId: "bot-1", kind: "fake", providerRef: "c1" }),
        stored: { id: "c1" },
      },
      secrets: [] as string[],
      state: {},
    };
    const call = {
      name: "shell",
      args: { command: "gh pr list" },
      executionId: "e1",
      finish: async (result: unknown) => result,
    };
    expect(await computerTools.shell!(ctx as never, call as never)).toMatchObject({
      stdout: "ok",
      code: 0,
    });
    expect(execute).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ env: undefined, unsetEnv: ["GH_TOKEN"] }),
      context,
    );
  });

  it("skips an item whose key record is gone, like other damaged items", async () => {
    const db = encryptedDatabase();
    const command = (name: string) =>
      ({ name, origin: "", auth: { type: "command" } }) as BotSecretDestination;
    await save(db, login, loginValue());
    await save(db, command("old_token"), "fake-old-token");
    await db.migrate();
    await db.ring.rotate("user:user-1");
    await save(db, command("new_token"), "fake-new-token");
    // The first key's record is gone, while the key manager itself works.
    db.keys.splice(
      db.keys.findIndex((key) => key.version === 1),
      1,
    );
    db.ring.clear();
    expect((await loadCommandVariables(db.prisma, secretStore, scope)).env).toEqual({
      NEW_TOKEN: "fake-new-token",
    });
    expect(await loadLoginPasswordRedactions(db.prisma, secretStore, scope)).not.toContain(
      "fake-password-1",
    );
  });

  it("sends a migrated API key only in its header, and hides it", async () => {
    const db = encryptedDatabase();
    const api = {
      name: "example_api",
      origin: "https://api.example.test",
      auth: { type: "bearer" },
    };
    await save(db, api as BotSecretDestination, "fake-api-key-1");
    await db.migrate();
    expect(row(db, "example_api").ciphertext).toMatch(/^rkz1:/);
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ ok: true }));
    const registerRedactions = vi.fn();
    await requestWithBotSecret({
      prisma: db.prisma,
      secretStore,
      scope,
      request: { name: "example_api", url: "https://api.example.test/v1/items" },
      signal: new AbortController().signal,
      remote: { fetch, resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }] },
      registerRedactions,
    });
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get("Authorization")).toBe(
      "Bearer fake-api-key-1",
    );
    expect(registerRedactions).toHaveBeenCalledWith(
      expect.arrayContaining(["fake-api-key-1", "Bearer fake-api-key-1"]),
    );
  });

  it("gives up a key read that stalls once the request's deadline passes", async () => {
    const db = encryptedDatabase();
    const api = {
      name: "example_api",
      origin: "https://api.example.test",
      auth: { type: "bearer" },
    };
    await save(db, api as BotSecretDestination, "fake-api-key-1");
    await db.migrate();
    // The key manager takes the unwrap and never answers; nothing is cached.
    vi.spyOn(db.provider, "unwrap").mockImplementation(() => new Promise(() => {}));
    db.ring.clear();
    await expect(
      openVaultValue(db.prisma, secretStore, row(db, "example_api"), AbortSignal.timeout(20)),
    ).rejects.toMatchObject({ name: "TimeoutError" });
    const fetch = vi.fn<typeof globalThis.fetch>();
    await expect(
      requestWithBotSecret({
        prisma: db.prisma,
        secretStore,
        scope,
        request: { name: "example_api", url: "https://api.example.test/v1/items" },
        signal: AbortSignal.timeout(20),
        remote: { fetch, resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }] },
      }),
    ).rejects.toMatchObject({ name: "TimeoutError" });
    expect(fetch).not.toHaveBeenCalled();
  }, 2_000);

  it("fills a migrated card's postal code from its migrated billing contact", async () => {
    const db = encryptedDatabase();
    const home = { name: "Alex", line1: "12 Elm St", city: "Springfield", postalCode: "12345" };
    await save(
      db,
      { name: "home", origin: "", auth: { type: "contact" } } as BotSecretDestination,
      JSON.stringify(home),
    );
    await save(db, card, JSON.stringify({ ...fakeCard, billing: "home" }));
    await db.migrate();
    expect(row(db, "home").ciphertext).toMatch(/^rkz1:/);
    expect(
      await resolveVaultCardFill({
        prisma: db.prisma,
        secretStore,
        scope,
        name: "visa",
        field: "postal_code",
        site: "https://shop.example.test",
        savedAt: row(db, "visa").updatedAt!.toISOString(),
      }),
    ).toMatchObject({ text: "12345" });
  });

  it("refuses a value moved to another item, member or vault", async () => {
    const db = encryptedDatabase();
    await save(db, login, loginValue());
    await save(db, { ...login, name: "other" } as BotSecretDestination, loginValue());
    await db.migrate();
    row(db, "other").ciphertext = row(db, "site").ciphertext;
    await expect(reveal(db, "other")).rejects.toThrow();

    const site = row(db, "site");
    site.userId = "user-2";
    await expect(reveal(db, "site", "user-2")).rejects.toThrow();
    // Same member, row id and table: only the vault's key scope tells the vaults apart.
    site.userId = "user-1";
    site.spaceId = "space-1";
    db.useOwnVault("space-1");
    await expect(reveal(db, "site")).rejects.toThrow("another vault's key");

    // A Space's own vault is shared by its members, so one key: the owner alone binds the value.
    const shared = encryptedDatabase();
    shared.useOwnVault("space-1");
    await save(shared, login, loginValue());
    await shared.migrate();
    expect(await reveal(shared, "site")).toMatchObject({
      fields: expect.arrayContaining([expect.objectContaining({ value: "fake-password-1" })]),
    });
    row(shared, "site").userId = "user-2";
    await expect(reveal(shared, "site", "user-2")).rejects.toThrow();
  });

  it("keeps today's format with content encryption off or an external store", async () => {
    const off = encryptedDatabase(false);
    await save(off, login, loginValue());
    await off.migrate();
    await save(off, card, JSON.stringify(fakeCard));
    expect(row(off, "visa").ciphertext).toMatch(/^v2:/);

    const fake = infisicalFake();
    const external = new ComposedSecretStore(
      new EncryptedSecretStore("test-only-encryption-key"),
      new InfisicalSecretStore(fake.options),
    );
    await external.start();
    try {
      const db = encryptedDatabase();
      await save(db, card, JSON.stringify(fakeCard));
      await db.migrate();
      await save(db, login, loginValue(), external);
      expect(row(db, "site").ciphertext).toMatch(/^infisical:/);
      expect(
        await revealBotSecret({ prisma: db.prisma, secretStore: external, scope, name: "site" }),
      ).toMatchObject({ fields: expect.any(Array) });
    } finally {
      await external.close();
    }
  });
});

describe("moving vault values to the envelope keys", () => {
  async function mixedVault() {
    const db = encryptedDatabase();
    await save(db, login, loginValue());
    await save(db, card, JSON.stringify(fakeCard));
    await save(db, { ...login, name: "broken" } as BotSecretDestination, loginValue());
    row(db, "broken").ciphertext = `v2:${Buffer.alloc(64).toString("base64")}`;
    db.rows().push({
      ...row(db, "broken"),
      id: "remote",
      name: "remote",
      ciphertext: "infisical:v1:remote-ref",
    });
    return db;
  }

  it("previews without creating a key or writing a row", async () => {
    const db = await mixedVault();
    const wrap = vi.spyOn(db.provider, "wrap");
    const before = structuredClone(db.rows());
    expect(await db.migrate("encrypt", true)).toMatchObject({ planned: 2, migrated: 0, failed: 1 });
    expect(db.rows()).toEqual(before);
    expect(db.keys).toEqual([]);
    expect(wrap).not.toHaveBeenCalled();
  });

  it("reports an item already under a vault key that does not open", async () => {
    const db = await mixedVault();
    await db.migrate();
    const site = row(db, "site");
    site.ciphertext = `${site.ciphertext.slice(0, -4)}AAAA`;
    // Copied into the Space's own vault: its header names the member's key.
    row(db, "visa").spaceId = "space-1";
    const before = structuredClone(db.rows());
    const keys = db.keys.length;
    db.reports.length = 0;
    expect(await db.migrate("encrypt", true)).toMatchObject({ verified: 1, failed: 3 });
    expect(await db.migrate()).toMatchObject({ migrated: 0, verified: 1, failed: 3 });
    expect(db.rows()).toEqual(before);
    expect(db.keys).toHaveLength(keys);
    expect(db.reports).toEqual(
      expect.arrayContaining([`${site.id} failed`, `${row(db, "visa").id} failed`]),
    );
    expect(db.reasons.get(row(db, "visa").id)).toBe(
      "read: ContentDecryptionError: Vault item names another vault's key",
    );
  });

  it("says why each item failed, without its value or any key", async () => {
    const db = await mixedVault();
    const site = row(db, "site");
    const keyMaterial = randomBytes(32).toString("hex");
    // Errors from a store or a key manager can quote what they were given.
    const load = secretStore.load.bind(secretStore);
    vi.spyOn(secretStore, "load").mockImplementation(async (ref, record) =>
      (typeof record === "string" ? record : record.recordId) === site.id
        ? Promise.reject(new Error(`cannot read fake-password-1 from ${ref}`))
        : load(ref, record),
    );
    vi.spyOn(db.provider, "wrap").mockRejectedValueOnce(
      Object.assign(new Error(`key manager refused ${keyMaterial}`), { code: "KeyUnavailable" }),
    );
    try {
      expect(await db.migrate()).toMatchObject({ migrated: 0, failed: 3 });
    } finally {
      vi.mocked(secretStore.load).mockRestore();
    }
    expect(Object.fromEntries(db.reasons)).toEqual({
      [site.id]: "read: Error",
      [row(db, "visa").id]: "write: Error (KeyUnavailable)",
      [row(db, "broken").id]: "read: Error",
    });
    const reported = JSON.stringify([...db.reasons]);
    for (const secret of ["fake-password-1", site.ciphertext, keyMaterial])
      expect(reported).not.toContain(secret);
  });

  it("rewrites old rows once, keeps their dates, and leaves a failed row as it was", async () => {
    const db = await mixedVault();
    const before = structuredClone(db.rows());
    expect(await db.migrate()).toMatchObject({ migrated: 2, verified: 1, failed: 1 });
    expect(row(db, "site").ciphertext).toMatch(/^rkz1:/);
    expect(row(db, "site").updatedAt).toEqual(before.find((r) => r.name === "site")!.updatedAt);
    expect(row(db, "broken").ciphertext).toBe(before.find((r) => r.name === "broken")!.ciphertext);
    expect(row(db, "remote").ciphertext).toBe("infisical:v1:remote-ref");
    expect(db.reports).toContain(`${row(db, "broken").id} failed`);
    expect(JSON.stringify(db.reports)).not.toContain("fake-password-1");
    expect(await fillPassword(db)).toMatchObject({ text: "fake-password-1" });

    const after = structuredClone(db.rows());
    expect(await db.migrate()).toMatchObject({ migrated: 0, verified: 3, failed: 1 });
    expect(db.rows()).toEqual(after);
  });

  /** Runs `change` after migrate has read its batch and before it writes. */
  function between(db: Db, change: () => Promise<unknown>) {
    const findMany = db.prisma.vaultCredential.findMany as unknown as Mock;
    const read = findMany.getMockImplementation()!;
    findMany.mockImplementationOnce(async (args) => {
      const batch = await read(args);
      await change();
      return batch;
    });
  }

  it("lets a save made during migrate win", async () => {
    const db = await mixedVault();
    between(db, () => save(db, login, loginValue("fake-password-2")));
    expect(await db.migrate()).toMatchObject({ migrated: 1, concurrent: 1 });
    expect(await fillPassword(db)).toMatchObject({ text: "fake-password-2" });
  });

  it("saves again under the vault key when migrate moves the item during a save", async () => {
    const db = encryptedDatabase();
    await save(db, login, loginValue());
    // The save seals its value before migrate creates the vault's key, and commits after.
    const transaction = db.prisma.$transaction.bind(db.prisma);
    vi.spyOn(db.prisma, "$transaction").mockImplementationOnce((async (run: never) => {
      await db.migrate();
      return transaction(run);
    }) as never);
    await save(db, login, loginValue("fake-password-2"));
    expect(row(db, "site").ciphertext).toMatch(/^rkz1:/);
    expect(await fillPassword(db)).toMatchObject({ text: "fake-password-2" });
  });

  it("saves again under the newest version its process knows when reencrypt moves the item during a save", async () => {
    const db = encryptedDatabase();
    await save(db, login, loginValue());
    await db.migrate();
    // The save seals under version 1; another process rotates and moves the item to version 2,
    // and the saving process has read version 2 by the time it commits.
    const other = db.otherProcess();
    const transaction = db.prisma.$transaction.bind(db.prisma);
    vi.spyOn(db.prisma, "$transaction").mockImplementationOnce((async (run: never) => {
      await other.ring.rotate("user:user-1");
      await other.migrate("reencrypt");
      await db.ring.allFresh("user:user-1");
      return transaction(run);
    }) as never);
    await save(db, login, loginValue("fake-password-2"));
    expect(await vaultItemsUnderOlderKeys(db.prisma)).toEqual({ older: 0, damaged: 0 });
    expect(await fillPassword(db)).toMatchObject({ text: "fake-password-2" });
  });

  it("lets a label edit made during migrate keep its date", async () => {
    const db = await mixedVault();
    const saved = row(db, "site").updatedAt!;
    between(db, () => relabelVaultItem(db.prisma, scope, "site", { title: "Work" }));
    expect(await db.migrate()).toMatchObject({ migrated: 1, concurrent: 1 });
    expect(row(db, "site")).toMatchObject({
      title: "Work",
      ciphertext: expect.stringMatching(/^v2:/),
    });
    expect(row(db, "site").updatedAt!.getTime()).toBeGreaterThan(saved.getTime());
  });

  it("lets a value moved to Infisical during migrate stay there", async () => {
    const db = await mixedVault();
    const site = row(db, "site");
    // secrets-infisical migrate keeps the item's date, so only the value tells the change apart.
    between(db, () =>
      db.prisma.vaultCredential.updateMany({
        where: { id: site.id },
        data: { ciphertext: "infisical:v1:moved", updatedAt: site.updatedAt },
      }),
    );
    expect(await db.migrate()).toMatchObject({ migrated: 1, concurrent: 1 });
    expect(row(db, "site").ciphertext).toBe("infisical:v1:moved");
  });

  it("visits every row once across batches, in both directions", async () => {
    const db = encryptedDatabase();
    // A store without scrypt keeps 250 rows fast; it binds the value to its row like the real one.
    const store = {
      describe: () => ({ id: "app-encrypted" }),
      put: async (value: string, _context: unknown, options: { recordId: string }) => {
        const ref = `v2:${options.recordId}:${value}`;
        return { id: options.recordId, ref, ciphertext: ref };
      },
      load: async (ref: string, context: string | { recordId: string }) => {
        const prefix = `v2:${typeof context === "string" ? context : context.recordId}:`;
        if (!ref.startsWith(prefix)) throw new Error("bound to another row");
        return ref.slice(prefix.length);
      },
    } as unknown as SecretStore;
    const total = 250;
    // Inserted in neither id nor name order; names sort opposite to ids; three owners, two vaults.
    for (let n = 0; n < total; n++) {
      const i = (n * 7) % total;
      const id = `id-${String(i).padStart(3, "0")}`;
      db.rows().push({
        id,
        userId: `user-${i % 3}`,
        spaceId: i % 2 ? null : `space-${i % 3}`,
        name: `item-${String(total - i).padStart(3, "0")}`,
        origin: "",
        auth: { type: "command" },
        ciphertext: (await store.put(`value-${i}`, context, { recordId: id })).ciphertext,
        updatedAt: new Date(Date.parse("2026-09-01") + i),
      });
    }
    const findMany = db.prisma.vaultCredential.findMany as unknown as Mock;
    const read = findMany.getMockImplementation()!;
    const cursors: string[] = [];
    findMany.mockImplementation(async (args) => {
      // A cursor that never advances would read the first page forever.
      if (cursors.length > 10) throw new Error("migrate did not reach its last page");
      cursors.push(args.where.id.gt);
      return read(args);
    });
    const migrate = async (mode: "encrypt" | "decrypt") => {
      cursors.length = 0;
      const visited: string[] = [];
      const counts = await migrateVaultValues(db.prisma, store, context, {
        mode,
        report: (row, status) => visited.push(`${row.id} ${status}`),
      });
      return { counts, visited, cursors: [...cursors] };
    };
    const ids = db
      .rows()
      .map((stored) => `${stored.id} migrated`)
      .sort();

    for (const mode of ["encrypt", "decrypt"] as const) {
      const first = await migrate(mode);
      expect(first.counts).toMatchObject({ migrated: total, failed: 0, concurrent: 0 });
      expect(first.visited.sort()).toEqual(ids);
      // Two pages: the first full, the second short and last.
      expect(first.cursors).toEqual(["", "id-199"]);
      const again = await migrate(mode);
      expect(again.counts).toMatchObject({ migrated: 0, verified: total, failed: 0 });
      expect(again.visited).toEqual([]);
      for (const stored of db.rows())
        expect(stored.ciphertext.startsWith("rkz1:")).toBe(mode === "encrypt");
    }
    expect(new Set(db.keys.map((key) => key.spaceId))).toEqual(
      new Set([
        "user:user-0",
        "user:user-1",
        "user:user-2",
        "vault:space-0",
        "vault:space-1",
        "vault:space-2",
      ]),
    );
    for (const stored of db.rows())
      expect(await store.load(stored.ciphertext, stored.id)).toBe(
        `value-${Number(stored.id.slice(3))}`,
      );
  });

  it("writes them back in today's format for a rollback", async () => {
    const db = await mixedVault();
    await db.migrate();
    expect(await db.migrate("decrypt")).toMatchObject({ migrated: 2, failed: 0 });
    for (const stored of db.rows().filter((r) => ["site", "visa"].includes(r.name))) {
      expect(stored.ciphertext).toMatch(/^v2:/);
      await expect(secretStore.load(stored.ciphertext, stored.id)).resolves.toBeTruthy();
    }
    expect(await db.migrate("decrypt")).toMatchObject({ migrated: 0 });
  });

  /** Migrated items, then a new version of their vault's key. */
  async function rotatedVault() {
    const db = await mixedVault();
    await db.migrate();
    const [first] = db.keys;
    expect(await rotateVaultKeys(db.prisma)).toEqual({ rotated: 1, ownerGone: 0, failed: 0 });
    const newest = db.keys.at(-1)!;
    expect(newest).toMatchObject({ spaceId: first!.spaceId, version: 2 });
    const keyOf = (name: string) => ciphertextKeyId(row(db, name).ciphertext);
    return { db, old: first!.id, newest: newest.id, keyOf };
  }

  it("moves vault items to a new key version, reading both until each has moved", async () => {
    const { db, old, newest, keyOf } = await rotatedVault();
    // Saves use the new version at once; items not moved yet still open under the old one.
    await save(db, { ...login, name: "later" } as BotSecretDestination, loginValue("fake-later"));
    expect([keyOf("site"), keyOf("visa"), keyOf("later")]).toEqual([old, old, newest]);
    expect(await fillPassword(db)).toMatchObject({ text: "fake-password-1" });

    const before = structuredClone(db.rows());
    expect(await db.migrate("reencrypt", true)).toMatchObject({ planned: 2, migrated: 0 });
    expect(db.rows()).toEqual(before);
    expect(await db.migrate("reencrypt")).toMatchObject({
      migrated: 2,
      verified: 2,
      // The damaged item in the previous format waits for migrate, unread.
      notMigrated: 1,
      failed: 0,
    });
    expect([keyOf("site"), keyOf("visa"), keyOf("later")]).toEqual([newest, newest, newest]);
    expect(row(db, "site").updatedAt).toEqual(before.find((r) => r.name === "site")!.updatedAt);
    expect(await fillPassword(db)).toMatchObject({ text: "fake-password-1" });
    expect(await reveal(db, "later")).toMatchObject({ fields: [{}, { value: "fake-later" }] });
    // The old version stays, for backups taken before the rotation.
    expect(db.keys.map((key) => key.version)).toEqual([1, 2]);
    expect(await db.migrate("reencrypt")).toMatchObject({ migrated: 0, verified: 4 });
  });

  it("lets a save made during the rewrite win", async () => {
    const { db, newest, keyOf } = await rotatedVault();
    between(db, () => save(db, login, loginValue("fake-password-2")));
    expect(await db.migrate("reencrypt")).toMatchObject({ migrated: 1, concurrent: 1 });
    expect(await fillPassword(db)).toMatchObject({ text: "fake-password-2" });
    expect(await db.migrate("reencrypt")).toMatchObject({ migrated: 0, concurrent: 0 });
    expect([keyOf("site"), keyOf("visa")]).toEqual([newest, newest]);
  });

  it("finishes the rewrite when run again after an interruption", async () => {
    const { db, old, newest, keyOf } = await rotatedVault();
    const stop = new AbortController();
    const interrupted = migrateVaultValues(
      db.prisma,
      secretStore,
      { ...context, signal: stop.signal },
      { mode: "reencrypt", report: (_, status) => status === "migrated" && stop.abort() },
    );
    await expect(interrupted).rejects.toThrow();
    // One item moved, the other not yet: both still open.
    expect([keyOf("site"), keyOf("visa")].sort()).toEqual([newest, old].sort());
    expect(await fillPassword(db)).toMatchObject({ text: "fake-password-1" });
    await expect(reveal(db, "visa")).resolves.toBeTruthy();
    expect(await db.migrate("reencrypt")).toMatchObject({ migrated: 1, notMigrated: 1, failed: 0 });
    expect([keyOf("site"), keyOf("visa")]).toEqual([newest, newest]);
  });

  /** Three vault keys, listed in this order, and what rotating them reported. */
  async function threeVaults() {
    const db = encryptedDatabase();
    for (const scope of ["user:user-1", "user:user-2", "vault:space-1"])
      await db.ring.current(scope);
    const reports: string[] = [];
    const rotate = () =>
      rotateVaultKeys(db.prisma, {
        report: (scope, status, reason) => reports.push(`${scope} ${status} (${reason})`),
      });
    const versions = () => db.keys.map((key) => `${key.spaceId} ${key.version}`).sort();
    return { db, reports, rotate, versions };
  }

  it("keeps rotating vault keys past a member deleted after they were listed", async () => {
    const { db, reports, rotate, versions } = await threeVaults();
    const ringRotate = db.ring.rotate.bind(db.ring);
    vi.spyOn(db.ring, "rotate").mockImplementationOnce(async (scope) => {
      db.deleteOwner(scope);
      return ringRotate(scope);
    });
    expect(await rotate()).toEqual({ rotated: 2, ownerGone: 1, failed: 0 });
    expect(reports).toEqual(["user:user-1 owner gone (undefined)"]);
    expect(versions()).toEqual([
      "user:user-2 1",
      "user:user-2 2",
      "vault:space-1 1",
      "vault:space-1 2",
    ]);
  });

  it("reports a vault key that cannot rotate, without key material, and rotates the rest", async () => {
    const { db, reports, rotate, versions } = await threeVaults();
    const keyMaterial = randomBytes(32).toString("hex");
    vi.spyOn(db.provider, "wrap").mockRejectedValueOnce(
      new Error(`key manager refused ${keyMaterial}`),
    );
    expect(await rotate()).toEqual({ rotated: 2, ownerGone: 0, failed: 1 });
    expect(reports).toEqual(["user:user-1 failed (rotate: Error)"]);
    expect(versions()).toEqual([
      "user:user-1 1",
      "user:user-2 1",
      "user:user-2 2",
      "vault:space-1 1",
      "vault:space-1 2",
    ]);
  });

  it("counts items deleted with their member during migrate as changed, not failed", async () => {
    const db = await mixedVault();
    const broken = row(db, "broken").id;
    between(db, async () => {
      db.deleteOwner("user:user-1");
      await db.prisma.vaultCredential.deleteMany({ where: { userId: "user-1" } });
    });
    // The damaged item went with them too, so there is nothing left to report.
    expect(await db.migrate()).toMatchObject({ migrated: 0, concurrent: 3, failed: 0 });
    expect(db.reasons.has(broken)).toBe(false);
    expect(db.keys).toEqual([]);
  });

  it("counts items under their key deleted with their member during migrate as changed", async () => {
    const db = encryptedDatabase();
    await save(db, login, loginValue());
    await save(db, card, JSON.stringify(fakeCard));
    await db.migrate();
    // Another run, in its own process: the keys it needs to read the items are shredded with
    // the member before it reaches them.
    db.ring.clear();
    between(db, async () => {
      db.deleteOwner("user:user-1");
      await db.prisma.vaultCredential.deleteMany({ where: { userId: "user-1" } });
    });
    expect(await db.migrate()).toMatchObject({ verified: 0, concurrent: 2, failed: 0 });
    expect(db.reasons.size).toBe(0);
  });

  it("still reports an unreadable item when it cannot tell whether the item is gone", async () => {
    const db = await mixedVault();
    const broken = row(db, "broken").id;
    vi.spyOn(db.prisma.vaultCredential, "count").mockRejectedValue(new Error("connection lost"));
    expect(await db.migrate()).toMatchObject({ migrated: 2, concurrent: 0, failed: 1 });
    expect([...db.reasons.keys()]).toEqual([broken]);
  });

  // Each command's calls to the key manager, by the state of the member's vault that reaches
  // them; the key manager takes the call and answers late or never.
  const keyManagerCalls = {
    "migrate creating the vault's key": {
      mode: "encrypt",
      call: "wrap",
      prepare: async () => {},
    },
    "migrate listing the vault's keys": {
      mode: "encrypt",
      call: "unwrap",
      prepare: async (db: Db) => {
        await db.migrate();
        const { ciphertext } = await secretStore.put(loginValue(), context, { recordId: "old" });
        db.rows().push({ ...row(db, "site"), id: "old", name: "old", ciphertext });
      },
    },
    "migrate reading an item under its key": {
      mode: "encrypt",
      call: "unwrap",
      prepare: (db: Db) => db.migrate(),
    },
    "decrypt reading an item": {
      mode: "decrypt",
      call: "unwrap",
      prepare: (db: Db) => db.migrate(),
    },
    "reencrypt listing the vault's keys": {
      mode: "reencrypt",
      call: "unwrap",
      prepare: async (db: Db) => {
        await db.migrate();
        await db.ring.rotate("user:user-1");
      },
    },
    "rotate listing the vault's keys": {
      mode: "rotate",
      call: "unwrap",
      prepare: (db: Db) => db.migrate(),
    },
    "rotate creating the new version": {
      mode: "rotate",
      call: "wrap",
      prepare: (db: Db) => db.migrate(),
    },
  } as const;
  it.each(
    Object.keys(keyManagerCalls).flatMap((site) =>
      (["never answers", "answers after the interruption"] as const).map((answer) => [
        site,
        answer,
      ]),
    ),
  )(
    "stops at an interruption while %s and the key manager %s, storing no key afterwards",
    async (site, answer) => {
      const { mode, call, prepare } = keyManagerCalls[site as keyof typeof keyManagerCalls];
      const db = encryptedDatabase();
      await save(db, login, loginValue());
      await prepare(db);
      db.ring.clear();
      const before = db.keys.map((key) => key.id);
      const controller = new AbortController();
      // The key manager answers when the test lets it, which is after the command has stopped.
      let answerNow = () => {};
      const answered = new Promise<void>((resolve) => {
        answerNow = resolve;
      });
      const real = db.provider[call].bind(db.provider) as (...args: unknown[]) => Promise<never>;
      const stalled = vi.spyOn(db.provider, call).mockImplementation(((...args: unknown[]) => {
        controller.abort(new Error("interrupted"));
        if (answer === "never answers") return new Promise<never>(() => {});
        return answered.then(() => real(...args));
      }) as never);
      // Every key ring call the command makes, to wait for the ones it gave up on.
      const ringCalls: Promise<unknown>[] = [];
      for (const method of ["all", "byId", "current", "rotate"] as const) {
        const made = db.ring[method].bind(db.ring) as (...args: unknown[]) => Promise<unknown>;
        vi.spyOn(db.ring, method).mockImplementation(((...args: unknown[]) => {
          const ringCall = made(...args);
          ringCalls.push(ringCall);
          return ringCall;
        }) as never);
      }
      const run =
        mode === "rotate"
          ? rotateVaultKeys(db.prisma, { signal: controller.signal })
          : db.migrate(mode, false, controller.signal);
      await expect(run).rejects.toThrow("interrupted");
      expect(stalled).toHaveBeenCalled();
      // A key manager that never answers leaves nothing to wait for; a late answer is waited out.
      if (answer === "answers after the interruption") {
        answerNow();
        await Promise.allSettled(ringCalls);
      }
      expect(db.keys.map((key) => key.id)).toEqual(before);
      // The next run, in a new process, is not interrupted and finishes the work.
      stalled.mockRestore();
      const next = db.otherProcess();
      if (mode === "rotate")
        expect(await rotateVaultKeys(next.prisma)).toMatchObject({ rotated: 1, failed: 0 });
      else
        expect(await migrateVaultValues(next.prisma, secretStore, context, { mode })).toMatchObject(
          {
            failed: 0,
          },
        );
      expect(db.keys.length).toBeGreaterThanOrEqual(before.length);
    },
    2_000,
  );

  it.each(["reencrypt", "rotate --reencrypt"])(
    "leaves items in the previous format to migrate on %s, creating no vault key",
    async (command) => {
      const db = encryptedDatabase();
      await save(db, login, loginValue());
      await db.migrate();
      const keyed = row(db, "site").ciphertext;
      // One beside the keyed item in the member's vault, one in a Space vault that has no key.
      for (const [name, spaceId] of [
        ["old-account", null],
        ["old-space", "space-1"],
      ] as const) {
        const { ciphertext } = await secretStore.put(loginValue(), context, { recordId: name });
        db.rows().push({ ...row(db, "site"), id: name, name, spaceId, ciphertext });
      }
      const before = structuredClone(db.rows());
      if (command === "rotate --reencrypt")
        expect(await rotateVaultKeys(db.prisma)).toEqual({ rotated: 1, ownerGone: 0, failed: 0 });
      expect(await db.migrate("reencrypt")).toMatchObject({
        notMigrated: 2,
        migrated: command === "reencrypt" ? 0 : 1,
        failed: 0,
      });
      expect([row(db, "old-account"), row(db, "old-space")]).toEqual(before.slice(1));
      expect(db.keys.map((key) => key.spaceId)).toEqual(
        command === "reencrypt" ? ["user:user-1"] : ["user:user-1", "user:user-1"],
      );
      expect(row(db, "site").ciphertext === keyed).toBe(command === "reencrypt");
    },
  );

  /** Two items under the member's first vault key, and a second process that has it cached. */
  async function cachedElsewhere() {
    const db = encryptedDatabase();
    await save(db, login, loginValue());
    await save(db, card, JSON.stringify(fakeCard));
    await db.migrate();
    const other = db.otherProcess();
    expect(await other.migrate("reencrypt")).toMatchObject({ verified: 2, migrated: 0 });
    await other.ring.all("user:user-1"); // a normal save warms the current-version cache
    const keyOf = (name: string) => ciphertextKeyId(row(db, name).ciphertext);
    const versionOf = (name: string) => db.keys.find((key) => key.id === keyOf(name))?.version;
    return { db, other, versionOf };
  }

  it("moves items to a version another process rotated to while this one had the old one cached", async () => {
    const { db, other, versionOf } = await cachedElsewhere();
    expect(await rotateVaultKeys(db.prisma)).toMatchObject({ rotated: 1 });
    expect(await other.migrate("reencrypt")).toMatchObject({ migrated: 2, verified: 0 });
    expect([versionOf("site"), versionOf("visa")]).toEqual([2, 2]);
    expect([...other.reports.values()]).toEqual(["migrated", "migrated"]);
  });

  it("does not move items back to its own rotation when another process rotated after it", async () => {
    const { db, other, versionOf } = await cachedElsewhere();
    // rotate --reencrypt in this process adds version 2; the other process adds 3 and moves both.
    expect(await rotateVaultKeys(other.prisma)).toMatchObject({ rotated: 1 });
    expect(await rotateVaultKeys(db.prisma)).toMatchObject({ rotated: 1 });
    expect(await db.migrate("reencrypt")).toMatchObject({ migrated: 2 });
    expect([versionOf("site"), versionOf("visa")]).toEqual([3, 3]);
    expect(await other.migrate("reencrypt")).toMatchObject({ migrated: 0, verified: 2 });
    expect([versionOf("site"), versionOf("visa")]).toEqual([3, 3]);
  });

  it("migrates items under a version another process rotated to while this one had the old one cached", async () => {
    const { db, other, versionOf } = await cachedElsewhere();
    await rotateVaultKeys(db.prisma);
    const { ciphertext } = await secretStore.put(loginValue(), context, { recordId: "old" });
    db.rows().push({ ...row(db, "site"), id: "old", name: "old", ciphertext });
    expect(await other.migrate("encrypt")).toMatchObject({ migrated: 1 });
    expect(versionOf("old")).toBe(2);
  });

  /** Both items of a vault, in the previous format to encrypt or under an older version to reencrypt. */
  async function twoItems(mode: "encrypt" | "reencrypt") {
    const db = encryptedDatabase();
    await save(db, login, loginValue());
    await save(db, card, JSON.stringify(fakeCard));
    if (mode === "reencrypt") {
      await db.migrate();
      await db.ring.rotate("user:user-1");
    }
    const versions = () =>
      ["site", "visa"]
        .map((name) => ciphertextKeyId(row(db, name).ciphertext))
        .map((id) => db.keys.find((key) => key.id === id)?.version)
        .sort();
    return { db, versions };
  }

  it.each([
    ["encrypt", [1, 2]],
    ["reencrypt", [2, 3]],
  ] as const)(
    "%s moves a later item to a version another process rotated to during the run",
    async (mode, expected) => {
      const { db, versions } = await twoItems(mode);
      const other = db.otherProcess();
      const write = db.prisma.vaultCredential.updateMany as unknown as Mock;
      const real = write.getMockImplementation()!;
      write.mockImplementationOnce(async (args) => {
        const result = await real(args);
        await other.ring.rotate("user:user-1");
        return result;
      });
      expect(await db.migrate(mode)).toMatchObject({ migrated: 2 });
      expect(versions()).toEqual(expected);
    },
  );

  it.each(["encrypt", "reencrypt"] as const)(
    "%s fails only the item whose vault keys could not be read once",
    async (mode) => {
      const { db } = await twoItems(mode);
      vi.spyOn(db.prisma.spaceKey, "findFirst").mockRejectedValueOnce(
        new Error("database unavailable"),
      );
      expect(await db.migrate(mode)).toMatchObject({ migrated: 1, failed: 1 });
    },
  );

  it("migrates using only the newest key even when an unused historical key cannot unwrap", async () => {
    const db = encryptedDatabase();
    await save(db, login, loginValue());
    await db.migrate();
    const old = db.keys[0]!;
    await db.ring.rotate("user:user-1");
    const { ciphertext } = await secretStore.put(loginValue(), context, { recordId: "legacy" });
    db.rows().push({ ...row(db, "site"), id: "legacy", name: "legacy", ciphertext });
    // The existing sealed item still needs the old key, so remove it from this migration.
    db.rows().splice(db.rows().indexOf(row(db, "site")), 1);
    db.ring.clear();
    const unwrap = db.provider.unwrap.bind(db.provider);
    const calls = vi.spyOn(db.provider, "unwrap").mockImplementation((record, context) => {
      if (record === old || record.wrappedKey === old.wrappedKey) throw new Error("retired key");
      return unwrap(record, context);
    });
    expect(await db.migrate()).toMatchObject({ migrated: 1, failed: 0 });
    expect(calls).toHaveBeenCalledTimes(1);
    expect(ciphertextKeyId(row(db, "legacy").ciphertext)).toBe(db.keys[1]!.id);
  });

  it("bounds status metadata queries to each item batch", async () => {
    const db = encryptedDatabase();
    await save(db, login, loginValue());
    await db.migrate();
    const source = row(db, "site");
    for (let i = 0; i < 1001; i++)
      db.rows().push({
        ...source,
        id: `batch-${i.toString().padStart(4, "0")}`,
        userId: `member-${i}`,
      });
    const records = vi.spyOn(db.prisma.spaceKey, "findMany");
    const groups = vi.spyOn(db.prisma.spaceKey, "groupBy");
    expect(await vaultItemsUnderOlderKeys(db.prisma)).toEqual({ older: 0, damaged: 1001 });
    expect(records).toHaveBeenCalledTimes(2);
    expect(groups).toHaveBeenCalledTimes(2);
    for (const [args] of records.mock.calls) expect(args?.where?.id).toHaveProperty("in");
    for (const [args] of groups.mock.calls)
      expect((args.where!.spaceId as { in: string[] }).in.length).toBeLessThanOrEqual(1000);
  });

  it("reports a key manager outage, not a missing key, for a version another process created", async () => {
    const { db, other } = await cachedElsewhere();
    await rotateVaultKeys(db.prisma);
    await db.migrate("reencrypt");
    vi.spyOn(db.provider, "unwrap").mockRejectedValue(new Error("key manager unavailable"));
    await expect(openVaultValue(other.prisma, secretStore, row(db, "site"))).rejects.toThrow(
      "key manager unavailable",
    );
  });

  it("counts older and damaged items while new saves observe rotation across processes", async () => {
    const { db, other, versionOf } = await cachedElsewhere();
    // Neither the previous format nor Infisical has a key version to count.
    const { ciphertext } = await secretStore.put(loginValue(), context, { recordId: "old" });
    db.rows().push({ ...row(db, "site"), id: "old", name: "old", ciphertext });
    db.rows().push({
      ...row(db, "site"),
      id: "remote",
      name: "remote",
      ciphertext: "infisical:v1:ref",
    });
    await save(db, card, JSON.stringify(fakeCard)); // warms this process's cache too
    expect(await vaultItemsUnderOlderKeys(db.prisma)).toEqual({ older: 0, damaged: 0 });

    await rotateVaultKeys(db.prisma);
    expect(await vaultItemsUnderOlderKeys(db.prisma)).toEqual({ older: 2, damaged: 0 });
    // Items naming a key that no longer exists, none at all, or another vault's are counted
    // apart, since reencrypt cannot move them.
    const site = row(db, "site");
    const spaceKey = await db.ring.current("vault:space-1");
    const damaged = [
      ["missing", site.ciphertext.replace(ciphertextKeyId(site.ciphertext)!, "gone-key")],
      ["unnamed", "rkz1:"],
      ["other-vault", site.ciphertext.replace(ciphertextKeyId(site.ciphertext)!, spaceKey.id)],
    ] as const;
    for (const [name, ciphertext] of damaged)
      db.rows().push({ ...site, id: name, name, ciphertext });
    expect(await vaultItemsUnderOlderKeys(db.prisma)).toEqual({ older: 2, damaged: 3 });
    // reencrypt cannot move them and reports each; only the old-format row is left to migrate.
    expect(await db.migrate("reencrypt")).toMatchObject({ migrated: 2, failed: 3, notMigrated: 1 });
    expect(await vaultItemsUnderOlderKeys(db.prisma)).toEqual({ older: 0, damaged: 3 });
    for (const [name] of damaged) db.rows().splice(db.rows().indexOf(row(db, name)), 1);
    expect(await vaultItemsUnderOlderKeys(db.prisma)).toEqual({ older: 0, damaged: 0 });
    // A process with cached old keys still selects the newest stored version for new saves.
    const later = { ...login, name: "later" } as BotSecretDestination;
    await save({ ...db, prisma: other.prisma }, later, loginValue("fake-later"));
    expect(versionOf("later")).toBe(2);
    expect(await vaultItemsUnderOlderKeys(db.prisma)).toEqual({ older: 0, damaged: 0 });
    expect(await db.migrate("reencrypt")).toMatchObject({ migrated: 0 });
    expect(versionOf("later")).toBe(2);
    expect(await vaultItemsUnderOlderKeys(db.prisma)).toEqual({ older: 0, damaged: 0 });
  });

  // Read key metadata after the item batch so keys created before those items are visible.
  it.each([
    [
      "migrate creates a vault's first key",
      (db: Db) => db.migrate(),
      { older: 0, damaged: 0 },
      "before migrate",
    ],
    [
      "rotate adds a version and reencrypt moves the items",
      async (db: Db) => {
        await db.ring.rotate("user:user-1");
        await db.migrate("reencrypt");
      },
      { older: 0, damaged: 0 },
      "after migrate",
    ],
    [
      "rotate adds a version and a save goes under it",
      async (db: Db) => {
        await db.ring.rotate("user:user-1");
        await save(db, { ...login, name: "later" } as BotSecretDestination, loginValue("fake-2"));
      },
      { older: 1, damaged: 0 },
      "after migrate",
    ],
    [
      "an item's key is really gone",
      async (db: Db) => {
        const site = row(db, "site");
        site.ciphertext = site.ciphertext.replace(ciphertextKeyId(site.ciphertext)!, "gone-key");
      },
      { older: 0, damaged: 1 },
      "after migrate",
    ],
  ] as const)(
    "counts items under a key created while status runs: %s",
    async (_name, change, expected, when) => {
      const db = encryptedDatabase();
      await save(db, login, loginValue());
      if (when === "after migrate") await db.migrate();
      const listing = db.prisma.vaultCredential.findMany;
      vi.spyOn(db.prisma.vaultCredential, "findMany").mockImplementationOnce((async (
        ...args: unknown[]
      ) => {
        await change(db);
        return Reflect.apply(listing, db.prisma.vaultCredential, args);
      }) as never);
      expect(await vaultItemsUnderOlderKeys(db.prisma)).toEqual(expected);
    },
  );

  it("does what each command must to each kind of item", async () => {
    const modes = ["migrate", "decrypt", "reencrypt", "rotate"] as const;
    type Mode = (typeof modes)[number];
    const vault = "user:user-1";
    const toCurrentKey = (db: Db) => db.migrate();
    const states: Record<string, (db: Db) => Promise<unknown>> = {
      "old format": async () => {},
      "current key": toCurrentKey,
      "older key": async (db) => {
        await toCurrentKey(db);
        await db.ring.rotate(vault);
      },
      infisical: async (db) => {
        row(db, "site").ciphertext = "infisical:v1:remote-ref";
      },
      unreadable: async (db) => {
        await toCurrentKey(db);
        row(db, "site").ciphertext = `${row(db, "site").ciphertext.slice(0, -4)}AAAA`;
      },
      // Damaged values: sealed, but naming no key, a key that is gone, or another vault's.
      "sealed, no key named": async (db) => {
        await toCurrentKey(db);
        row(db, "site").ciphertext = "rkz1:";
      },
      "key gone": async (db) => {
        await toCurrentKey(db);
        const site = row(db, "site");
        site.ciphertext = site.ciphertext.replace(ciphertextKeyId(site.ciphertext)!, "gone-key");
      },
      "another vault's key": async (db) => {
        await toCurrentKey(db);
        const site = row(db, "site");
        const other = await db.ring.current("vault:space-1");
        site.ciphertext = site.ciphertext.replace(ciphertextKeyId(site.ciphertext)!, other.id);
      },
    };
    // A deletion or a save races the item each command rewrites.
    const rewrites: Record<Mode, string> = {
      migrate: "old format",
      decrypt: "current key",
      reencrypt: "older key",
      rotate: "current key",
    };
    const races: Record<string, (db: Db) => Promise<unknown>> = {
      "owner deleted mid-run": async (db) => {
        db.deleteOwner(vault);
        await db.prisma.vaultCredential.deleteMany({ where: { userId: "user-1" } });
      },
      // The command runs in its own process, which has no key cached.
      "owner deleted mid-run, key not cached": async (db) => {
        db.ring.clear();
        db.deleteOwner(vault);
        await db.prisma.vaultCredential.deleteMany({ where: { userId: "user-1" } });
      },
      "saved concurrently": (db) => save(db, login, loginValue("fake-password-2")),
    };

    const outcome = async (mode: Mode, state: string) => {
      const db = encryptedDatabase();
      await save(db, login, loginValue());
      await states[races[state] ? rewrites[mode] : state]!(db);
      if (races[state]) between(db, () => races[state]!(db));
      const { id, ciphertext } = row(db, "site");
      const hadKey = db.keys.some((key) => key.spaceId === vault);
      if (mode === "rotate") await rotateVaultKeys(db.prisma);
      const counts = await db.migrate(
        mode === "migrate" ? "encrypt" : mode === "rotate" ? "reencrypt" : mode,
      );
      const status = Object.entries(counts).find(([, count]) => count === 1)?.[0];
      const after = db.rows().find((stored) => stored.id === id);
      let stored = "unchanged";
      if (!after) stored = "deleted";
      else if (after.ciphertext !== ciphertext) {
        const keyId = ciphertextKeyId(after.ciphertext);
        const newest = db.keys.filter((key) => key.spaceId === vault).at(-1)?.id;
        stored = !keyId ? "old format" : keyId === newest ? "newest key" : "older key";
        if ((await openVaultValue(db.prisma, secretStore, after)) !== loginValue())
          stored += ", the save";
      }
      const firstKey = !hadKey && db.keys.some((key) => key.spaceId === vault);
      return `${status}: ${stored}${firstKey ? ", first key created" : ""}`;
    };

    const table: Record<string, Record<Mode, string>> = {};
    for (const state of [...Object.keys(states), ...Object.keys(races)]) {
      const cells = {} as Record<Mode, string>;
      for (const mode of modes) cells[mode] = await outcome(mode, state);
      table[state] = cells;
    }

    const all = (cell: string) => ({ migrate: cell, decrypt: cell, reencrypt: cell, rotate: cell });
    expect(table).toEqual({
      "old format": {
        migrate: "migrated: newest key, first key created",
        decrypt: "verified: unchanged",
        reencrypt: "notMigrated: unchanged",
        rotate: "notMigrated: unchanged",
      },
      "current key": {
        migrate: "verified: unchanged",
        decrypt: "migrated: old format",
        reencrypt: "verified: unchanged",
        rotate: "migrated: newest key",
      },
      "older key": {
        migrate: "verified: unchanged",
        decrypt: "migrated: old format",
        reencrypt: "migrated: newest key",
        rotate: "migrated: newest key",
      },
      infisical: all("verified: unchanged"),
      unreadable: all("failed: unchanged"),
      "sealed, no key named": all("failed: unchanged"),
      "key gone": all("failed: unchanged"),
      "another vault's key": all("failed: unchanged"),
      "owner deleted mid-run": all("concurrent: deleted"),
      "owner deleted mid-run, key not cached": all("concurrent: deleted"),
      "saved concurrently": {
        // Migrate still creates the vault's key; its next run moves the item.
        migrate: "concurrent: old format, the save, first key created",
        decrypt: "concurrent: newest key, the save",
        reencrypt: "concurrent: newest key, the save",
        rotate: "concurrent: newest key, the save",
      },
    });
  });
});
