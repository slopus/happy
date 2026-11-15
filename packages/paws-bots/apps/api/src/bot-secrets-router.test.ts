import { RPCHandler } from "@orpc/server/fetch";
import { SecretStoreUnavailableError } from "@rakazo/adapter-kit";
import type { Actor, BotSecretMetadata } from "@rakazo/contracts";
import { encodeLoginSecret, newVaultImportRows, parseVaultCsv } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

// RFC 6238's test key, written in pieces so it never reads as a saved secret.
const TEST_KEY = ("GEZDGNBV" + "GY3TQOJQ").repeat(2);

const events = vi.hoisted(() => ({ record: vi.fn() }));
vi.mock("@rakazo/db", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  recordSecurityEvent: events.record,
}));

// Offline boundary: a fake Prisma client and secret store drive the real router handlers,
// the real repos.getBot ownership check, and the real storeBotSecret validation.

type Row = Record<string, unknown>;

const actor = {
  spaceId: "space-1",
  userId: "user-1",
  email: "user@rakazo.test",
  isDeploymentOwner: true,
} satisfies Actor;

const FAKE_VALUE = "fake-value-SENTINEL-1";

function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([key, value]) =>
    key === "OR"
      ? (value as Row[]).some((branch) => matches(row, branch))
      : value && typeof value === "object" && "has" in value
        ? ((row[key] as unknown[] | undefined) ?? []).includes(value.has)
        : value && typeof value === "object" && "startsWith" in value
          ? String(row[key]).startsWith(String(value.startsWith))
          : row[key] === value,
  );
}

function pick(row: Row, select?: Record<string, boolean>) {
  if (!select) return { ...row };
  return Object.fromEntries(Object.keys(select).map((key) => [key, row[key]]));
}

function botSecretDeps(seed: Row[] = []) {
  const now = new Date("2026-09-01T00:00:00.000Z");
  const bots: Row[] = [
    { id: "bot-1", userId: "user-1", spaceId: "space-1", archivedAt: null },
    { id: "bot-other", userId: "user-2", spaceId: "space-2", archivedAt: null },
  ];
  const rows: Row[] = seed.map((row) => ({ ...row }));
  const botSecret = {
    findMany: vi.fn(async (args: { where: Row; select?: Record<string, boolean> }) =>
      rows
        .filter((row) => matches(row, args.where))
        .sort((a, b) => String(a.name).localeCompare(String(b.name)))
        .map((row) => pick(row, args.select)),
    ),
    findFirst: vi.fn(async (args: { where: Row; select?: Record<string, boolean> }) => {
      const row = rows.find((entry) => matches(entry, args.where));
      return row ? pick(row, args.select) : null;
    }),
    count: vi.fn(
      async (args: { where: Row }) => rows.filter((row) => matches(row, args.where)).length,
    ),
    create: vi.fn(async (args: { data: Row }) => {
      rows.push({ ...args.data, createdAt: now, updatedAt: now });
      return {};
    }),
    update: vi.fn(async (args: { where: { id: string }; data: Row }) => {
      const row = rows.find((entry) => entry.id === args.where.id);
      Object.assign(row ?? {}, args.data, { updatedAt: now });
      return {};
    }),
    updateMany: vi.fn(async (args: { where: Row; data: Row }) => {
      // As Prisma does, an unknown column fails the update.
      const unknown = Object.keys(args.data).filter((key) => !["title", "note"].includes(key));
      if (unknown.length) throw new Error(`Unknown argument ${unknown.join(", ")}`);
      const matched = rows.filter((row) => matches(row, args.where));
      for (const row of matched) Object.assign(row, args.data, { updatedAt: now });
      return { count: matched.length };
    }),
    deleteMany: vi.fn(async (args: { where: Row }) => {
      const before = rows.length;
      for (let index = rows.length - 1; index >= 0; index -= 1) {
        if (matches(rows[index] ?? {}, args.where)) rows.splice(index, 1);
      }
      return { count: before - rows.length };
    }),
  };
  const prisma = {
    bot: {
      findFirst: vi.fn(async (args: { where: Row }) => {
        const bot = bots.find((entry) => matches(entry, args.where));
        return bot ? { ...bot, thread: null, computer: null } : null;
      }),
    },
    vaultCredential: botSecret,
    // No item here is limited to chosen bots.
    vaultCredentialBot: { findMany: vi.fn(async () => []) },
    vaultCredentialLimit: { findMany: vi.fn(async () => []) },
    // Counted before a prepared value that was never committed is deleted from the store.
    secret: { count: vi.fn(async () => 0) },
    botSecret: { count: vi.fn(async () => 0) },
    integrationProviderConfig: { count: vi.fn(async () => 0) },
    spaceSettingOverride: {
      findUnique: vi.fn<() => Promise<{ setting: string } | null>>(async () => null),
    },
    // The member's settings lock always finds the membership row.
    $queryRaw: vi.fn(async () => [{ locked: 1 }]),
    $transaction: vi.fn(),
  };
  prisma.$transaction.mockImplementation(async (fn: (tx: typeof prisma) => unknown) => fn(prisma));
  const secrets = {
    put: vi.fn(async (_plaintext: string, _context: unknown, options: { recordId: string }) => ({
      id: options.recordId,
      ref: `enc:${options.recordId}`,
      ciphertext: `enc:${options.recordId}`,
    })),
    // The fake store's ciphertext is "enc:<id>"; reading it back returns what put saved.
    load: vi.fn(async (ciphertext: string) => saved.get(ciphertext) ?? ""),
    delete: vi.fn(async () => undefined),
  };
  const saved = new Map<string, string>();
  secrets.put.mockImplementation(async (plaintext, _context, options) => {
    saved.set(`enc:${options.recordId}`, plaintext);
    return {
      id: options.recordId,
      ref: `enc:${options.recordId}`,
      ciphertext: `enc:${options.recordId}`,
    };
  });
  const auth = { hasRecentIdentityConfirmation: vi.fn(async () => false) };
  const deps = {
    auth,
    prisma: prisma as unknown as PrismaClient,
    secrets,
    env: {
      defaultProvider: "fake",
      defaultModel: "fake-model",
      webOrigin: "http://127.0.0.1:5173",
      screenProxySecret: "fake-test-secret",
      sandboxProvider: "fake",
    },
    dataDir: "/tmp/rakazo-router-test",
  } as unknown as RouterDeps;
  const handler = new RPCHandler(createRouter(deps));
  async function call(path: string, input: unknown) {
    const { response } = await handler.handle(
      new Request(`http://127.0.0.1/rpc/${path.includes("/") ? path : `botSecrets/${path}`}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: input }),
      }),
      { prefix: "/rpc", context: { actor, sessionId: "session-1" } },
    );
    if (!response) throw new Error("Procedure did not match");
    const text = await response.text();
    return { status: response.status, text, body: JSON.parse(text) as { json: unknown } };
  }
  return { prisma, secrets, rows, call, auth };
}

function putInput(origin: string, botId = "bot-1") {
  return {
    botId,
    destination: { name: "router", origin, auth: { type: "bearer" } },
    value: FAKE_VALUE,
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("botSecrets router", () => {
  it("prepares a slow credential before opening the five-second transaction", async () => {
    const { prisma, secrets, call } = botSecretDeps();
    let clock = 0;
    let active = false;
    prisma.$transaction.mockImplementation(async (fn: (tx: typeof prisma) => unknown) => {
      const start = clock;
      active = true;
      try {
        const result = await fn(prisma);
        if (clock - start > 5000) throw new Error("Transaction expired");
        return result;
      } finally {
        active = false;
      }
    });
    const put = secrets.put.getMockImplementation()!;
    secrets.put.mockImplementation(async (...args) => {
      expect(active).toBe(false);
      clock += 15000;
      return put(...args);
    });
    expect((await call("put", putInput("https://api.example.test"))).status).toBe(200);
    expect(secrets.put).toHaveBeenCalledOnce();
    expect(prisma.vaultCredential.create).toHaveBeenCalledOnce();
  });

  it("rejects another space's bot and a missing bot before any secret access", async () => {
    vi.stubEnv("RAKAZO_SECRETS_ALLOW_PRIVATE_HTTP", "1");
    const { prisma, secrets, call } = botSecretDeps();
    for (const botId of ["bot-other", "missing-bot"]) {
      const results = [
        await call("list", { botId }),
        await call("put", putInput("https://api.example.com", botId)),
        await call("remove", { botId, name: "router" }),
      ];
      for (const result of results) {
        expect(result.status).toBeGreaterThanOrEqual(400);
        expect(result.text).not.toContain(FAKE_VALUE);
      }
    }
    expect(prisma.bot.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ spaceId: "space-1", archivedAt: null }),
      }),
    );
    expect(secrets.put).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.vaultCredential.findMany).not.toHaveBeenCalled();
    expect(prisma.vaultCredential.create).not.toHaveBeenCalled();
    expect(prisma.vaultCredential.update).not.toHaveBeenCalled();
    expect(prisma.vaultCredential.deleteMany).not.toHaveBeenCalled();
  });

  it("lists metadata only, never returning the ciphertext or the row id", async () => {
    const created = new Date("2026-08-01T00:00:00.000Z");
    const { call } = botSecretDeps([
      {
        id: "row-1",
        userId: "user-1",
        spaceId: null,
        name: "github",
        origin: "https://api.github.com",
        auth: { type: "basic", username: "octocat" },
        ciphertext: "enc:row-1",
        createdAt: created,
        updatedAt: created,
      },
    ]);
    const result = await call("list", { botId: "bot-1" });
    expect(result.status).toBe(200);
    expect(result.body.json).toEqual([
      {
        name: "github",
        origin: "https://api.github.com",
        auth: { type: "basic", username: "octocat" },
        title: "api.github.com",
        note: "",
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-01T00:00:00.000Z",
        policy: "allow",
        allBots: true,
        botIds: [],
      },
    ]);
    expect(result.text).not.toContain("enc:");
    expect(result.text).not.toContain("ciphertext");
    expect(result.text).not.toContain("row-1");
  });

  it("stores a LAN http origin only with the private-HTTP opt-in", async () => {
    vi.stubEnv("RAKAZO_SECRETS_ALLOW_PRIVATE_HTTP", "1");
    const allowed = botSecretDeps();
    const saved = await allowed.call("put", putInput("http://192.168.1.20:8080"));
    expect(saved.status).toBe(200);
    expect(saved.body.json).toEqual({
      name: "router",
      origin: "http://192.168.1.20:8080",
      auth: { type: "bearer" },
      title: "192.168.1.20:8080",
      note: "",
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
      policy: "allow",
      allBots: true,
      botIds: [],
    });
    expect(saved.text).not.toContain(FAKE_VALUE);
    expect(allowed.secrets.put).toHaveBeenCalledWith(
      FAKE_VALUE,
      expect.anything(),
      expect.objectContaining({ recordId: expect.any(String) }),
    );
    expect(allowed.rows).toHaveLength(1);
    expect(allowed.rows[0]).toMatchObject({ userId: "user-1", spaceId: null });

    vi.stubEnv("RAKAZO_SECRETS_ALLOW_PRIVATE_HTTP", "");
    const denied = botSecretDeps();
    const rejected = await denied.call("put", putInput("http://192.168.1.20:8080"));
    expect(rejected.status).toBe(400);
    expect(rejected.text).toContain("Invalid credential destination");
    expect(rejected.text).not.toContain(FAKE_VALUE);
    expect(denied.secrets.put).not.toHaveBeenCalled();
    expect(denied.rows).toHaveLength(0);
  });

  it("rejects public plain http and cloud-metadata hosts in both modes", async () => {
    for (const flag of ["1", ""]) {
      vi.stubEnv("RAKAZO_SECRETS_ALLOW_PRIVATE_HTTP", flag);
      for (const origin of [
        "http://example.com",
        "http://100.100.100.200",
        "https://169.254.169.254",
        "https://metadata.google.internal",
        "http://example.com/login",
        "http://100.100.100.200/latest",
        "https://169.254.169.254/latest/meta-data",
        "https://metadata.google.internal/computeMetadata/v1",
        `https://example.com/${"a".repeat(2048)}`,
      ]) {
        const { secrets, rows, call } = botSecretDeps();
        const result = await call("put", putInput(origin));
        expect({ flag, origin, status: result.status }).toEqual({ flag, origin, status: 400 });
        expect(result.text).not.toContain(FAKE_VALUE);
        expect(secrets.put).not.toHaveBeenCalled();
        expect(rows).toHaveLength(0);
      }
    }
  });

  it("saves a pasted page URL under its site", async () => {
    const { rows, call } = botSecretDeps();
    const saved = await call("put", {
      botId: "bot-1",
      destination: {
        name: "portal",
        origin: "https://portal.example.test/account/sign-in?next=/",
        auth: { type: "login" },
      },
      value: JSON.stringify({ username: "fake-user", password: FAKE_VALUE }),
    });
    expect(saved.status).toBe(200);
    expect(saved.body.json).toMatchObject({
      name: "portal",
      origin: "https://portal.example.test",
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.origin).toBe("https://portal.example.test");
    const listed = await call("list", { botId: "bot-1" });
    expect(listed.body.json).toMatchObject([{ origin: "https://portal.example.test" }]);
    expect(listed.text).not.toContain("sign-in");
  });

  it("turns down a pasted URL with a username or password in it", async () => {
    const { secrets, rows, call } = botSecretDeps();
    const result = await call("put", {
      botId: "bot-1",
      destination: {
        name: "portal",
        origin: `https://fake-user:${FAKE_VALUE}@portal.example.test/login`,
        auth: { type: "login" },
      },
      value: JSON.stringify({ username: "fake-user", password: "fake-password-2" }),
    });
    expect(result.status).toBe(400);
    expect(result.text).toContain("Invalid credential destination");
    expect(result.text).not.toContain(FAKE_VALUE);
    expect(secrets.put).not.toHaveBeenCalled();
    expect(rows).toHaveLength(0);
  });

  it("maps malformed website login values to a bad request without echoing them", async () => {
    for (const value of [`not-json-${FAKE_VALUE}`, JSON.stringify({ password: FAKE_VALUE })]) {
      const { secrets, call } = botSecretDeps();
      const result = await call("put", {
        botId: "bot-1",
        destination: {
          name: "portal",
          origin: "https://portal.example.com",
          auth: { type: "login" },
        },
        value,
      });
      expect(result.status).toBe(400);
      expect(result.text).toContain("A website login needs a label and a value for every field");
      expect(result.text).not.toContain(FAKE_VALUE);
      expect(secrets.put).not.toHaveBeenCalled();
    }
  });

  it("lists every row when one name and one auth no longer pass the schema", async () => {
    const created = new Date("2026-08-01T00:00:00.000Z");
    const row = (name: string, auth: unknown) => ({
      id: `row-${name}`,
      userId: "user-1",
      spaceId: null,
      name,
      origin: "https://api.example.com",
      auth,
      ciphertext: `enc:${name}`,
      createdAt: created,
      updatedAt: created,
    });
    const { call } = botSecretDeps([
      row("alpha", { type: "bearer" }),
      row("Bad Name", { type: "bearer" }),
      row("middle", { type: "cookie" }),
      row("omega", { type: "header", name: "X-Api-Key" }),
    ]);
    const result = await call("list", { botId: "bot-1" });
    expect(result.status).toBe(200);
    const byName = new Map(
      (result.body.json as { name: string; auth: unknown }[]).map((entry) => [entry.name, entry]),
    );
    expect([...byName.keys()].sort()).toEqual(["Bad Name", "alpha", "middle", "omega"]);
    expect(byName.get("alpha")?.auth).toEqual({ type: "bearer" });
    // Invalid stored names stay listable/removable but are not replaceable.
    expect(byName.get("Bad Name")?.auth).toBeNull();
    expect(byName.get("middle")?.auth).toBeNull();
    expect(byName.get("omega")?.auth).toEqual({ type: "header", name: "X-Api-Key" });
    expect(result.text).not.toContain("cookie");
    expect(result.text).not.toContain("ciphertext");
  });

  it("lists a private-HTTP origin as remove-only when the opt-in is off", async () => {
    vi.stubEnv("RAKAZO_SECRETS_ALLOW_PRIVATE_HTTP", "");
    const created = new Date("2026-08-01T00:00:00.000Z");
    const { call } = botSecretDeps([
      {
        id: "row-lan",
        userId: "user-1",
        spaceId: null,
        name: "router",
        origin: "http://192.168.1.20:8080",
        auth: { type: "bearer" },
        ciphertext: "enc:lan",
        createdAt: created,
        updatedAt: created,
      },
    ]);
    const result = await call("list", { botId: "bot-1" });
    expect(result.status).toBe(200);
    expect(result.body.json).toEqual([
      {
        name: "router",
        origin: "http://192.168.1.20:8080",
        auth: null,
        title: "192.168.1.20:8080",
        note: "",
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-01T00:00:00.000Z",
        policy: "allow",
        allBots: true,
        botIds: [],
      },
    ]);
  });

  it("removes a non-regex stored name for the owned bot and rejects another space's bot", async () => {
    const owned = botSecretDeps();
    const removed = await owned.call("remove", { botId: "bot-1", name: "Legacy Name" });
    expect(removed.status).toBe(200);
    expect(removed.body.json).toEqual({ ok: true });
    expect(owned.prisma.vaultCredential.deleteMany).toHaveBeenCalledWith({
      where: { userId: "user-1", spaceId: null, name: "Legacy Name" },
    });

    const foreign = botSecretDeps();
    const denied = await foreign.call("remove", { botId: "bot-other", name: "Legacy Name" });
    expect(denied.status).toBeGreaterThanOrEqual(400);
    expect(foreign.prisma.vaultCredential.deleteMany).not.toHaveBeenCalled();
  });

  it("removes a credential by name from the vault the bot's Space uses", async () => {
    const { prisma, call } = botSecretDeps();
    const result = await call("remove", { botId: "bot-1", name: "router" });
    expect(result.status).toBe(200);
    expect(result.body.json).toEqual({ ok: true });
    expect(prisma.vaultCredential.deleteMany).toHaveBeenCalledWith({
      where: { userId: "user-1", spaceId: null, name: "router" },
    });
  });
  it("stores a command variable with no origin and lists it with its type", async () => {
    const { secrets, rows, call } = botSecretDeps();
    const result = await call("put", {
      botId: "bot-1",
      destination: { name: "netbird-setup-key", auth: { type: "command" } },
      value: FAKE_VALUE,
    });
    expect(result.status).toBe(200);
    expect(result.body.json).toMatchObject({
      name: "netbird-setup-key",
      origin: "",
      auth: { type: "command" },
    });
    expect(result.text).not.toContain(FAKE_VALUE);
    expect(secrets.put).toHaveBeenCalledOnce();
    expect(rows[0]).toMatchObject({ origin: "", auth: { type: "command" } });
    const listed = await call("list", { botId: "bot-1" });
    expect(listed.body.json).toEqual([expect.objectContaining({ auth: { type: "command" } })]);
  });

  it("rejects a reserved command variable name with a clear bad request", async () => {
    const { secrets, rows, call } = botSecretDeps();
    const result = await call("put", {
      botId: "bot-1",
      destination: { name: "ld_preload", auth: { type: "command" } },
      value: FAKE_VALUE,
    });
    expect(result.status).toBe(400);
    expect(result.text).toContain("$LD_PRELOAD is reserved");
    expect(result.text).not.toContain(FAKE_VALUE);
    expect(secrets.put).not.toHaveBeenCalled();
    expect(rows).toHaveLength(0);
  });

  it("still requires a site for every other credential type", async () => {
    const { secrets, call } = botSecretDeps();
    const result = await call("put", {
      botId: "bot-1",
      destination: { name: "api", auth: { type: "bearer" } },
      value: FAKE_VALUE,
    });
    expect(result.status).toBe(400);
    expect(secrets.put).not.toHaveBeenCalled();
  });
});

describe("vault router", () => {
  const destination = {
    name: "portal",
    origin: "https://portal.example.test",
    auth: { type: "bearer" },
  };

  it("names a new item from its title and never replaces one saved under that name", async () => {
    const { rows, prisma, call } = botSecretDeps();
    const home = (city: string) => ({
      destination: { auth: { type: "contact" } },
      value: JSON.stringify({ city }),
      title: "Home",
    });
    const first = await call("vault/put", home("Springfield"));
    expect(first.body.json).toMatchObject({ name: "home", title: "Home" });
    // Another save took "home" after this one looked: it is created under the next free name.
    prisma.vaultCredential.findMany.mockResolvedValueOnce([]);
    const second = await call("vault/put", home("Shelbyville"));
    expect(second.status).toBe(200);
    expect(second.body.json).toMatchObject({ name: "home-2", title: "Home" });
    expect(rows.map((row) => row.name)).toEqual(["home", "home-2"]);
    const listed = (await call("vault/list", {})).body.json as { preview?: unknown }[];
    expect(listed.map((item) => item.preview)).toEqual([
      { contact: { city: "Springfield" } },
      { contact: { city: "Shelbyville" } },
    ]);
  });

  it("lists a login that asks first, and keeps it through a save without a policy", async () => {
    const { rows, call } = botSecretDeps();
    const login = { name: "work", origin: "https://login.example.test", auth: { type: "login" } };
    const value = JSON.stringify({
      fields: [{ label: "Password", value: FAKE_VALUE, hidden: true }],
    });
    const saved = await call("vault/put", {
      destination: login,
      value,
      policy: "ask",
    });
    expect(saved.body.json).toMatchObject({ policy: "ask" });
    const listed = (await call("vault/list", {})).body.json as { policy?: string }[];
    expect(listed.map((item) => item.policy)).toEqual(["ask"]);
    // A save without a policy keeps it asking.
    const relabeled = await call("vault/put", { destination: login, title: "Work" });
    expect(relabeled.body.json).toMatchObject({ policy: "ask" });
    expect(rows[0]).toMatchObject({ title: "Work", policy: "ask" });
    // Only a login asks first.
    const key = await call("vault/put", { destination, value: FAKE_VALUE, policy: "ask" });
    expect(key.status).toBe(400);
  });

  it.each(["before the save lock", "between rows"])(
    "stops a default-vault import when its selection changes %s",
    async (when) => {
      const { prisma, secrets, rows, call } = botSecretDeps();
      const changeVault = () =>
        prisma.spaceSettingOverride.findUnique.mockResolvedValue({ setting: "credentials" });
      if (when === "before the save lock") {
        const put = secrets.put.getMockImplementation()!;
        secrets.put.mockImplementationOnce(async (...args) => {
          const value = await put(...args);
          changeVault();
          return value;
        });
      } else {
        const create = prisma.vaultCredential.create.getMockImplementation()!;
        prisma.vaultCredential.create.mockImplementationOnce(async (...args) => {
          const value = await create(...args);
          changeVault();
          return value;
        });
      }
      events.record.mockClear();
      const result = await call("vault/import", {
        rows: ["alice", "bob"].map((username) => ({
          title: username,
          origin: "https://shop.example.test",
          username,
          password: FAKE_VALUE,
        })),
      });
      expect(result.status).toBe(409);
      expect(rows).toHaveLength(when === "before the save lock" ? 0 : 1);
      expect(events.record).toHaveBeenCalledTimes(rows.length);
      if (rows.length) {
        expect(rows[0]?.spaceId).toBeNull();
        expect(events.record).toHaveBeenCalledWith(
          expect.objectContaining({ metadata: expect.objectContaining({ scope: "account" }) }),
        );
      }
    },
  );

  it("lets an explicitly selected account vault import while the Space uses its own", async () => {
    const { prisma, rows, call } = botSecretDeps();
    prisma.spaceSettingOverride.findUnique.mockResolvedValue({ setting: "credentials" });
    const result = await call("vault/import", {
      scope: "account",
      rows: [
        { title: "Shop", origin: "https://shop.example.test", username: "", password: FAKE_VALUE },
      ],
    });
    expect(result.body.json).toMatchObject({ added: 1 });
    expect(rows[0]?.spaceId).toBeNull();
  });

  it("imports new logins one by one and counts every row it skips", async () => {
    const { prisma, rows, call } = botSecretDeps();
    const origin = "https://shop.example.test";
    const row = { title: "", origin, username: "alice", password: FAKE_VALUE };
    await call("vault/put", {
      destination: { origin, auth: { type: "login" } },
      value: encodeLoginSecret({
        fields: [
          { label: "Email", value: "alice", hidden: false },
          { label: "Password", value: "fake-old", hidden: true },
        ],
      }),
    });
    events.record.mockClear();
    const imported = await call("vault/import", {
      rows: [
        row,
        { ...row, username: "bob", title: "Shop" },
        { ...row, username: "bob", title: "Shop again" },
        { ...row, origin: "http://shop.example.test", username: "carol" },
        { ...row, username: "dave", password: "" },
        { ...row, origin: `${origin}/login`, username: "erin" },
      ],
    });
    expect(imported.body.json).toEqual({
      added: 2,
      skipped: { notHttps: 1, noPassword: 1, duplicate: 2, invalid: 0, limit: 0 },
      // Each by its place in the rows sent, so the app can say which rows they were.
      notSaved: [
        { index: 0, reason: "duplicate" },
        { index: 2, reason: "duplicate" },
        { index: 3, reason: "notHttps" },
        { index: 4, reason: "noPassword" },
      ],
    });
    // A page address is saved under its site, as when saving a login by hand.
    expect(rows.map((saved) => [saved.name, saved.origin])).toEqual([
      ["shop-example-test", origin],
      ["shop", origin],
      ["shop-example-test-2", origin],
    ]);
    expect(rows[1]).toMatchObject({ title: "Shop", origin, auth: { type: "login" } });
    // One event for each login saved, without its name: a guest's would reach the host's audit log.
    expect(events.record.mock.calls).toEqual(
      Array(2).fill([
        expect.objectContaining({
          type: "credential.created",
          metadata: { procedure: "vault.import", kind: "vault_credential", scope: "account" },
        }),
      ]),
    );
    expect(imported.text).not.toContain(FAKE_VALUE);
    // A login also on a site is already saved there.
    await call("vault/put", {
      destination: { name: "shop", origin, auth: { type: "login" } },
      alsoOn: ["https://www.shop.example.test"],
    });
    const elsewhere = await call("vault/import", {
      rows: [{ ...row, origin: "https://www.shop.example.test", username: "bob" }],
    });
    expect(elsewhere.body.json).toMatchObject({ added: 0, skipped: { duplicate: 1 } });
    // An address written another way is the same site, as when saving one by hand.
    const shouted = await call("vault/import", {
      rows: ["https://SHOP.example.test", `${origin}/sign-in`, "https://shop.example.test./"].map(
        (site) => ({
          ...row,
          origin: site,
          username: "bob",
        }),
      ),
    });
    // The trailing dot too, as the app's reading of an export drops it.
    expect(shouted.body.json).toMatchObject({ added: 0, skipped: { duplicate: 3 } });
    // Past the vault's limit a new login is counted as not fitting, and one already saved as
    // already saved, as a retry after a lost reply sends it. Once one doesn't fit, the rest are
    // counted without reading the vault again.
    for (let index = rows.length; index < 99; index++)
      rows.push({ ...rows[0], id: `filler-${index}`, name: `filler-${index}` });
    prisma.vaultCredential.findMany.mockClear();
    const full = await call("vault/import", {
      rows: ["bob", "frank", "grace", "heidi"].map((username) => ({ ...row, username })),
    });
    expect(full.body.json).toMatchObject({
      added: 1,
      skipped: { limit: 2, duplicate: 1 },
      notSaved: [
        { index: 0, reason: "duplicate" },
        { index: 2, reason: "limit" },
        { index: 3, reason: "limit" },
      ],
    });
    // A new name is looked for once for each row up to the first that didn't fit.
    const named = prisma.vaultCredential.findMany.mock.calls.filter(
      ([args]) => (args.where.name as { startsWith?: string } | undefined)?.startsWith,
    );
    expect(named).toHaveLength(3);
    const tooMany = await call("vault/import", { rows: Array(101).fill(row) });
    expect(tooMany.status).toBe(400);
  });

  it("adds nothing when a login already saved there can't be read for now, and says so on retry", async () => {
    const { rows, secrets, call } = botSecretDeps();
    const origin = "https://shop.example.test";
    const row = { title: "", origin, username: "alice", password: FAKE_VALUE };
    expect((await call("vault/import", { rows: [row] })).body.json).toMatchObject({ added: 1 });
    events.record.mockClear();
    // The new value is written, but the saved login it may repeat can't be read for now.
    const load = secrets.load.getMockImplementation()!;
    secrets.load.mockRejectedValue(new SecretStoreUnavailableError());
    const failed = await call("vault/import", { rows: [row] });
    expect(failed.status).toBe(409);
    expect(failed.text).toContain("The saved login could not be read. Try again.");
    expect(failed.text).not.toContain(FAKE_VALUE);
    expect(rows).toHaveLength(1);
    expect(events.record).not.toHaveBeenCalled();
    secrets.load.mockImplementation(load);
    expect((await call("vault/import", { rows: [row] })).body.json).toMatchObject({
      added: 0,
      skipped: { duplicate: 1 },
    });
  });

  it("saves a good login after rows it would refuse, with one place left in the Vault", async () => {
    const { rows, call } = botSecretDeps();
    for (let index = 0; index < 99; index++)
      rows.push({
        id: `filler-${index}`,
        userId: "user-1",
        spaceId: null,
        name: `filler-${index}`,
      });
    const parsed = parseVaultCsv(
      [
        "url,username,password",
        "https://169.254.169.254,alice,fake-password",
        `https://a.example.test,alice,${"\u0001".repeat(4096)}`,
        "https://good.example.test,bob,fake-password",
      ].join("\n"),
    );
    if (!("rows" in parsed)) throw new Error("not parsed");
    // The app's list of those 99 items.
    const listed = rows.map(
      ({ name }) => ({ name, origin: "", auth: { type: "command" } }) as BotSecretMetadata,
    );
    const plan = newVaultImportRows(parsed.rows, listed, parsed.lines);
    expect((await call("vault/import", { rows: plan.rows })).body.json).toMatchObject({
      added: 1,
      skipped: { limit: 0 },
    });
    expect(rows.at(-1)).toMatchObject({ origin: "https://good.example.test" });
  });

  it("never gives bots an export's notes", async () => {
    const { rows, call } = botSecretDeps();
    const parsed = parseVaultCsv(
      "name,url,username,password,notes\nBank,https://bank.example.test,alice,fake-pass,Security answer: Fluffy",
    );
    if (!("rows" in parsed)) throw new Error("not parsed");
    expect((await call("vault/import", { rows: parsed.rows })).body.json).toMatchObject({
      added: 1,
    });
    // list_secrets shows a bot each item's note, so the item keeps none.
    expect(rows[0]?.note ?? "").toBe("");
    const listed = await call("list", { botId: "bot-1" });
    expect(listed.text).toContain("bank");
    expect(listed.text).not.toContain("Fluffy");
    // An app that still sends a note is refused, so none is saved.
    const noted = await call("vault/import", {
      rows: [{ ...parsed.rows[0], username: "bob", note: "Security answer: Fluffy" }],
    });
    expect(noted.status).toBe(400);
  });

  it("saves a login's other sites as HTTPS origins and keeps them through an older app's save", async () => {
    const { call } = botSecretDeps();
    const value = encodeLoginSecret({
      fields: [{ label: "Password", value: FAKE_VALUE, hidden: true }],
    });
    const login = { name: "shop", origin: "https://shop.example.test", auth: { type: "login" } };
    const saved = await call("vault/put", {
      destination: login,
      value,
      alsoOn: ["https://www.shop.example.test/sign-in", "https://shop.example.test"],
    });
    expect(saved.body.json).toMatchObject({ alsoOn: ["https://www.shop.example.test"] });
    // An app from before other sites sends none, so they stay.
    await call("vault/put", { destination: login, value });
    const relabeled = await call("vault/put", { destination: login, title: "Shop" });
    expect(relabeled.body.json).toMatchObject({ alsoOn: ["https://www.shop.example.test"] });
    expect((await call("vault/put", { destination: login, alsoOn: [] })).body.json).toMatchObject({
      alsoOn: [],
    });
    // A cloud metadata host too, as no login may be saved for one.
    for (const alsoOn of [
      ["http://www.shop.example.test"],
      ["https://u:p@shop.example.test"],
      ["https://*.shop.example.test"],
      ["https://169.254.169.254"],
    ])
      expect((await call("vault/put", { destination: login, alsoOn })).status).toBe(400);
    const key = { destination, value: FAKE_VALUE, alsoOn: ["https://www.portal.example.test"] };
    expect((await call("vault/put", key)).status).toBe(400);
  });

  it("keeps a login's authenticator key until a save removes it, and imports none", async () => {
    const { auth, call, secrets } = botSecretDeps();
    const otp = TEST_KEY;
    const fields = [{ label: "Password", value: FAKE_VALUE, hidden: true }];
    const login = { name: "shop", origin: "https://shop.example.test", auth: { type: "login" } };
    const put = (value: Record<string, unknown>) =>
      call("vault/put", { destination: login, value: JSON.stringify(value) });
    expect((await put({ fields, otp })).body.json).toMatchObject({ preview: { otp: true } });
    const invalid = await put({ fields, otp: "not a key" });
    expect(invalid.status).toBe(400);
    expect(invalid.text).toContain("This authenticator key can't be read.");
    expect(invalid.text).not.toContain("not a key");
    // An app from before authenticator keys, or a login card answer, sends none: it stays.
    await put({ fields });
    auth.hasRecentIdentityConfirmation.mockResolvedValue(true);
    expect((await call("vault/reveal", { name: "shop" })).body.json).toEqual({ fields, otp });
    // A saved key that can't be read for now: the save waits, and the owner is told to retry.
    const load = secrets.load.getMockImplementation()!;
    secrets.load.mockRejectedValue(new SecretStoreUnavailableError());
    const unread = await put({ fields: [{ ...fields[0]!, value: "fake-other" }] });
    expect(unread.status).toBe(409);
    expect(unread.text).toContain("The saved login could not be read. Try again.");
    secrets.load.mockImplementation(load);
    const removed = await put({ fields, otp: "" });
    expect(removed.body.json).not.toMatchObject({ preview: { otp: true } });
    expect((await call("vault/reveal", { name: "shop" })).body.json).toEqual({ fields });
    const row = { title: "", origin: "https://mail.example.test", username: "a" };
    // Keys are added by hand, one login at a time: an import that sends one is refused.
    const imported = await call("vault/import", { rows: [{ ...row, password: FAKE_VALUE, otp }] });
    expect(imported.status).toBe(400);
    expect(imported.text).not.toContain(otp);
  });

  it("changes only the title or note of a saved item when no value is sent", async () => {
    const { call } = botSecretDeps();
    await call("vault/put", { destination, value: FAKE_VALUE });
    const relabeled = await call("vault/put", { destination, title: "Portal", note: "For work" });
    expect(relabeled.body.json).toMatchObject({
      name: "portal",
      title: "Portal",
      note: "For work",
    });
    expect((await call("vault/reveal", { name: "portal" })).status).not.toBe(200);
    const missing = await call("vault/put", {
      destination: { ...destination, name: "missing" },
      title: "Missing",
    });
    expect(missing.status).toBe(404);
    const unnamed = await call("vault/put", {
      destination: { auth: { type: "contact" } },
      title: "Home",
    });
    expect(unnamed.status).toBe(400);
  });

  it("saves, lists and removes in the account vault by default", async () => {
    const { rows, call } = botSecretDeps();
    expect((await call("vault/put", { destination, value: FAKE_VALUE })).status).toBe(200);
    expect(rows).toEqual([
      expect.objectContaining({ userId: "user-1", spaceId: null, name: "portal" }),
    ]);
    const listed = await call("vault/list", {});
    expect(listed.body.json).toEqual([expect.objectContaining({ name: "portal" })]);
    expect(listed.text).not.toContain(FAKE_VALUE);
    expect((await call("vault/remove", { name: "portal" })).status).toBe(200);
    expect(rows).toEqual([]);
  });

  it("keeps a Space's own vault apart from the account vault", async () => {
    const { prisma, rows, call } = botSecretDeps();
    prisma.spaceSettingOverride.findUnique.mockResolvedValue({ setting: "credentials" });
    await call("vault/put", { scope: "space", destination, value: FAKE_VALUE });
    expect(rows).toEqual([expect.objectContaining({ spaceId: "space-1", name: "portal" })]);
    expect((await call("vault/list", { scope: "account" })).body.json).toEqual([]);
    expect((await call("vault/list", { scope: "space" })).body.json).toEqual([
      expect.objectContaining({ name: "portal" }),
    ]);
  });

  it("reveals a value only after this session confirmed it's the owner", async () => {
    const { secrets, auth, call } = botSecretDeps();
    await call("vault/put", { destination, value: FAKE_VALUE });
    const refused = await call("vault/reveal", { name: "portal" });
    expect(refused.status).toBe(403);
    expect(refused.text).toContain("IDENTITY_CONFIRMATION_REQUIRED");
    expect(refused.text).not.toContain(FAKE_VALUE);
    expect(secrets.load).not.toHaveBeenCalled();

    auth.hasRecentIdentityConfirmation.mockResolvedValue(true);
    events.record.mockClear();
    const shown = await call("vault/reveal", { name: "portal" });
    expect(shown.body.json).toEqual({ value: FAKE_VALUE });
    // The event names the vault that was read, though the call left scope to the Space.
    expect(events.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "credential.revealed",
        metadata: expect.objectContaining({ scope: "account", name: "portal" }),
      }),
    );
    expect(JSON.stringify(events.record.mock.calls)).not.toContain(FAKE_VALUE);
    expect(auth.hasRecentIdentityConfirmation).toHaveBeenLastCalledWith({
      sessionId: "session-1",
      userId: "user-1",
    });
    expect((await call("vault/reveal", { name: "missing" })).status).toBe(404);
  });

  it("reveals a bot's webhook key only to its creator after they confirm it's them", async () => {
    const { prisma, secrets, auth, call } = botSecretDeps();
    const bot = {
      id: "bot-1",
      userId: "user-1",
      spaceId: "space-1",
      archivedAt: null,
      webhookSecretId: "whsec-1",
      thread: null,
      computer: null,
    };
    prisma.bot.findFirst.mockResolvedValue(bot as never);
    const findSecret = vi.fn(async () => ({ id: "whsec-1", ciphertext: "enc:whsec-1" }));
    Object.assign(prisma.secret, { findFirst: findSecret });
    const currentKey = vi.fn(async () => ({ webhookSecretId: "whsec-1" }));
    Object.assign(prisma.bot, { findUnique: currentKey });
    secrets.load.mockResolvedValue(FAKE_VALUE);

    const refused = await call("bots/revealWebhookSecret", { botId: "bot-1" });
    expect(refused.status).toBe(403);
    expect(refused.text).toContain("IDENTITY_CONFIRMATION_REQUIRED");
    expect(secrets.load).not.toHaveBeenCalled();

    auth.hasRecentIdentityConfirmation.mockResolvedValue(true);
    events.record.mockClear();
    const shown = await call("bots/revealWebhookSecret", { botId: "bot-1" });
    expect(shown.body.json).toEqual({ secret: FAKE_VALUE });
    expect(findSecret).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "whsec-1", userId: "user-1", spaceId: "space-1", kind: "webhook" },
      }),
    );
    expect(events.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "credential.revealed",
        metadata: expect.objectContaining({ kind: "webhook", botId: "bot-1" }),
      }),
    );
    expect(JSON.stringify(events.record.mock.calls)).not.toContain(FAKE_VALUE);

    // A rotation that commits while the key decrypts wins; the revoked key is never returned.
    currentKey.mockResolvedValueOnce({ webhookSecretId: "whsec-2" });
    const rotated = await call("bots/revealWebhookSecret", { botId: "bot-1" });
    expect(rotated.status).toBe(409);
    expect(rotated.text).not.toContain(FAKE_VALUE);

    // A space member who did not create the bot never reads its key, and is refused before
    // being asked to confirm it's them.
    prisma.bot.findFirst.mockResolvedValue({ ...bot, userId: "user-2" } as never);
    auth.hasRecentIdentityConfirmation.mockResolvedValue(false);
    secrets.load.mockClear();
    const forbidden = await call("bots/revealWebhookSecret", { botId: "bot-1" });
    expect(forbidden.status).toBe(403);
    expect(forbidden.text).toContain("FORBIDDEN");
    expect(forbidden.text).not.toContain("IDENTITY_CONFIRMATION_REQUIRED");
    expect(forbidden.text).not.toContain(FAKE_VALUE);
    expect(secrets.load).not.toHaveBeenCalled();
  });

  it("saves an older app's username and password as fields and reveals them", async () => {
    const { auth, call } = botSecretDeps();
    auth.hasRecentIdentityConfirmation.mockResolvedValue(true);
    await call("vault/put", {
      destination: { name: "site", origin: "https://login.example.test", auth: { type: "login" } },
      value: JSON.stringify({ username: "person@example.test", password: FAKE_VALUE }),
    });
    expect((await call("vault/reveal", { name: "site" })).body.json).toEqual({
      fields: [
        { label: "Username", value: "person@example.test", hidden: false },
        { label: "Password", value: FAKE_VALUE, hidden: true },
      ],
    });
  });

  it("reveals a website login's fields in order", async () => {
    const { auth, call } = botSecretDeps();
    auth.hasRecentIdentityConfirmation.mockResolvedValue(true);
    const fields = [
      { label: "Account number", value: "12345678", hidden: false },
      { label: "Date of birth", value: FAKE_VALUE, hidden: true },
    ];
    await call("vault/put", {
      destination: { name: "site", origin: "https://login.example.test", auth: { type: "login" } },
      value: encodeLoginSecret({ fields }),
    });
    expect((await call("vault/reveal", { name: "site" })).body.json).toEqual({ fields });
  });

  it("refuses a save the Space stops customizing while it is being prepared", async () => {
    const { prisma, secrets, rows, call } = botSecretDeps();
    // Customized when the save is prepared, back on the account vault by the time it stores.
    prisma.spaceSettingOverride.findUnique.mockResolvedValueOnce({ setting: "credentials" });
    const refused = await call("vault/put", { scope: "space", destination, value: FAKE_VALUE });
    expect(refused.status).toBe(400);
    expect(refused.text).toContain("This Space uses the account vault");
    expect(rows).toEqual([]);
    expect(secrets.put).toHaveBeenCalledOnce();
    const prepared = await secrets.put.mock.results[0]!.value;
    expect(secrets.delete).toHaveBeenCalledWith(prepared.ciphertext, expect.anything());
  });

  it("keeps a saved login on its site when saved again for another one", async () => {
    const login = {
      name: "portal",
      origin: "https://www.portal.example.test",
      auth: { type: "login" },
    };
    const saved = {
      id: "login-1",
      userId: "user-1",
      spaceId: null,
      ...login,
      ciphertext: "enc:login-1",
    };
    const { rows, call } = botSecretDeps([saved]);
    const value = JSON.stringify({ username: "fake-user", password: FAKE_VALUE });
    for (const path of ["vault/put", "put"]) {
      const refused = await call(path, {
        ...(path === "put" ? { botId: "bot-1" } : {}),
        destination: { ...login, origin: "https://login.portal.example.test" },
        value,
      });
      expect(refused.status).toBe(400);
      expect(refused.text).toContain(
        "Remove the existing credential before changing its destination",
      );
      expect(refused.text).not.toContain(FAKE_VALUE);
    }
    expect(rows).toEqual([saved]);
  });

  it("refuses to save into a Space's own vault the Space no longer uses", async () => {
    const { rows, call } = botSecretDeps();
    const refused = await call("vault/put", { scope: "space", destination, value: FAKE_VALUE });
    expect(refused.status).toBe(400);
    expect(refused.text).toContain("This Space uses the account vault");
    expect(refused.text).not.toContain(FAKE_VALUE);
    expect(rows).toEqual([]);
  });
});
