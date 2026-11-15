import { randomUUID } from "node:crypto";
import type { Credential, OAuthCredential } from "@earendil-works/pi-ai";
import type { PrismaClient } from "@rakazo/db";
import { asSystem, createDb, runAsTenant } from "@rakazo/db";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { PostgresRealtimeFanout } from "./realtime.js";
import { EncryptedSecretStore } from "./secrets.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE && databaseUrl ? describe : describe.skip;

describePostgres("model OAuth refresh (PostgreSQL contract)", () => {
  const databases: Array<ReturnType<typeof createDb>> = [];
  const users: string[] = [];
  const secrets = new EncryptedSecretStore("test-only-encryption-key");

  afterAll(async () => {
    const [first] = databases;
    if (first) {
      const prisma = asSystem(first.prisma);
      await prisma.organization.deleteMany({ where: { id: { in: users } } });
      await prisma.user.deleteMany({ where: { id: { in: users } } });
    }
    for (const db of databases) {
      await db.prisma.$disconnect();
      await db.pool.end();
    }
  });

  // One API or worker process: its own module state and a one-connection pool, so a
  // refresh that needs a second connection while it holds the lock cannot finish.
  async function instance() {
    const db = createDb(databaseUrl!, { poolMax: 1 });
    databases.push(db);
    vi.resetModules();
    return {
      prisma: db.prisma,
      pool: db.pool,
      oauth: await import("./pi-oauth.js"),
      modelSecret: await import("./model-secret.js"),
      refresh: await import("./model-credential-refresh.js"),
      credentials: await import("./pi-credentials.js"),
      secretStores: await import("./secret-store-factory.js"),
    };
  }

  // A user, space and stored ChatGPT sign-in whose token is due for a refresh.
  async function seed(owner: Awaited<ReturnType<typeof instance>>) {
    const id = randomUUID();
    users.push(id);
    const scope = { userId: id, spaceId: id };
    const credential: OAuthCredential = {
      type: "oauth",
      access: "acc-0",
      refresh: "rt-0",
      expires: Date.now() - 1,
      accountId: "acct",
    };
    const fixture = asSystem(owner.prisma);
    await fixture.user.create({
      data: { id, name: "OAuth test", email: `${id}@example.test`, emailVerified: true },
    });
    await fixture.organization.create({
      data: { id, name: "OAuth test", slug: id, createdAt: new Date() },
    });
    await fixture.space.create({
      data: { id, organizationId: id, name: "OAuth test", isDefault: true },
    });
    const plaintext = owner.modelSecret.serializeModelSecret({ kind: "oauth", credential });
    const stored = await secrets.put(plaintext, {
      operationId: "test",
      traceId: "test",
      spaceId: id,
      userId: id,
      signal: new AbortController().signal,
    });
    await fixture.secret.create({
      data: { id: stored.id, userId: id, kind: "model", ciphertext: stored.ciphertext },
    });
    const connection = await fixture.userModelCredential.create({
      data: { userId: id, provider: "openai-codex", label: "Codex", secretId: stored.id },
    });
    return { scope, credential, plaintext, stored, connection };
  }

  it("spends a rotating refresh token once when the kick, a run start and a running run race across processes", async () => {
    const a = await instance();
    const b = await instance();
    const c = await instance();
    // Separate module graphs: no in-process lock is shared, only the database lock.
    expect(new Set([a, b, c].map((p) => p.refresh.withModelCredentialLock)).size).toBe(3);
    const { scope, credential, plaintext, stored, connection } = await seed(a);
    const fixture = asSystem(a.prisma);

    // The provider rotates refresh tokens and rejects a spent one.
    const sent: string[] = [];
    const oauth = {
      refresh: vi.fn(async (held: OAuthCredential) => {
        sent.push(held.refresh);
        await new Promise((resolve) => setTimeout(resolve, 50));
        if (held.refresh !== "rt-0") throw new Error("invalid_grant: refresh token reused");
        return { ...credential, access: "acc-1", refresh: "rt-1", expires: Date.now() + 3_600_000 };
      }),
      toAuth: vi.fn(async (held: OAuthCredential) => ({ apiKey: held.access })),
    };
    const model = { id: connection.id, secretId: stored.id };
    const runner = new c.credentials.PiRuntimeCredentialStore(
      "openai-codex",
      credential,
      undefined,
      undefined,
      c.refresh.refreshStoredModelCredential(c.prisma, secrets, scope, model, "openai-codex", {
        oauth,
      }),
    );

    const [, started, running] = await Promise.all([
      runAsTenant(scope, () =>
        a.refresh.refreshExpiredModelCredential(
          a.prisma,
          secrets,
          scope,
          stored.id,
          "openai-codex",
          {
            oauth,
          },
        ),
      ),
      runAsTenant(scope, () =>
        b.refresh.resolveStoredModelAuth(
          b.prisma,
          secrets,
          scope,
          model,
          plaintext,
          "openai-codex",
          {
            oauth,
          },
        ),
      ),
      runAsTenant(scope, () =>
        runner.modify("openai-codex", async (current) =>
          current?.type === "oauth" && current.expires - Date.now() < 300_000
            ? oauth.refresh(current)
            : undefined,
        ),
      ),
    ]);

    expect(sent).toEqual(["rt-0"]);
    expect(started.apiKey).toBe("acc-1");
    expect(running).toMatchObject({ access: "acc-1", refresh: "rt-1" });
    const row = await fixture.secret.findUniqueOrThrow({ where: { id: stored.id } });
    expect(
      a.modelSecret.parseModelSecret(await secrets.load(row.ciphertext, stored.id)),
    ).toMatchObject({
      credential: { refresh: "rt-1" },
    });
  });

  it("commits a reconnect marker when the provider rejects the stored token", async () => {
    const owner = await instance();
    const { scope, plaintext, stored, connection } = await seed(owner);
    const oauth = {
      refresh: vi.fn(async () => {
        throw new Error('OpenAI Codex token refresh failed (400): {"error":"invalid_grant"}');
      }),
      toAuth: vi.fn(async (held: OAuthCredential) => ({ apiKey: held.access })),
    };

    await expect(
      runAsTenant(scope, () =>
        owner.refresh.resolveStoredModelAuth(
          owner.prisma,
          secrets,
          scope,
          { id: connection.id, secretId: stored.id },
          plaintext,
          "openai-codex",
          { oauth },
        ),
      ),
    ).rejects.toThrow(owner.oauth.OAUTH_RECONNECT_REQUIRED_ERROR);
    const row = await asSystem(owner.prisma).secret.findUniqueOrThrow({ where: { id: stored.id } });
    expect(
      owner.modelSecret.parseModelSecret(await secrets.load(row.ciphertext, stored.id)),
    ).toMatchObject({
      reconnectRequired: true,
    });
  });

  it("keeps a rotated token when the refreshed sign-in yields no usable key", async () => {
    const owner = await instance();
    const { scope, credential, plaintext, stored, connection } = await seed(owner);
    const oauth = {
      refresh: vi.fn(async () => ({
        ...credential,
        access: "acc-1",
        refresh: "rt-1",
        expires: Date.now() + 3_600_000,
      })),
      toAuth: vi.fn(async () => ({ apiKey: "" })),
    };

    await expect(
      runAsTenant(scope, () =>
        owner.refresh.resolveStoredModelAuth(
          owner.prisma,
          secrets,
          scope,
          { id: connection.id, secretId: stored.id },
          plaintext,
          "openai-codex",
          { oauth },
        ),
      ),
    ).rejects.toThrow("did not produce a usable token");
    // The provider already spent rt-0, so the rotated token must survive the failure.
    const row = await asSystem(owner.prisma).secret.findUniqueOrThrow({ where: { id: stored.id } });
    expect(
      owner.modelSecret.parseModelSecret(await secrets.load(row.ciphertext, stored.id)),
    ).toMatchObject({
      credential: { refresh: "rt-1" },
    });
  });

  it("announces a refreshed token after the lock's connection is released", async () => {
    const owner = await instance();
    const { scope, credential, plaintext, stored, connection } = await seed(owner);
    // The app's store announces each write on the same one-connection pool.
    const notified: string[] = [];
    const store = new owner.secretStores.ComposedSecretStore(
      new EncryptedSecretStore("test-only-encryption-key"),
      undefined,
      new PostgresRealtimeFanout({
        connectionString: databaseUrl!,
        publisher: {
          query: async (sql: string, values: unknown[]) => {
            const result = await owner.pool.query(sql, values);
            notified.push(JSON.parse(JSON.parse(String(values[1])).payload).ref);
            return result;
          },
        },
      }),
    );
    const oauth = {
      refresh: vi.fn(async () => ({
        ...credential,
        access: "acc-1",
        refresh: "rt-1",
        expires: Date.now() + 3_600_000,
      })),
      toAuth: vi.fn(async (held: OAuthCredential) => ({ apiKey: held.access })),
    };

    const started = Date.now();
    const resolved = await runAsTenant(scope, () =>
      owner.refresh.resolveStoredModelAuth(
        owner.prisma,
        store,
        scope,
        { id: connection.id, secretId: stored.id },
        plaintext,
        "openai-codex",
        { oauth },
      ),
    );

    expect(resolved.apiKey).toBe("acc-1");
    // Announcing inside the lock would wait out the 10 s pool checkout.
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(notified).toHaveLength(1);
  });
});

describePostgres("model sign-in across API processes (PostgreSQL contract)", () => {
  const databases: Array<ReturnType<typeof createDb>> = [];
  const users: string[] = [];
  const secrets = new EncryptedSecretStore("test-only-encryption-key");
  type Saved = { id: string; label: string };

  const oauthCredential: OAuthCredential = {
    type: "oauth",
    access: "device-access",
    refresh: "rt",
    expires: Date.now() + 3_600_000,
  };

  afterEach(() => {
    vi.useRealTimers();
  });

  let cleanup: PrismaClient | undefined;

  afterAll(async () => {
    if (cleanup) {
      const prisma = cleanup;
      await prisma.organization.deleteMany({ where: { id: { in: users } } });
      await prisma.user.deleteMany({ where: { id: { in: users } } });
    }
    for (const db of databases) {
      await db.prisma.$disconnect();
      await db.pool.end();
    }
  });

  /** One API process: its own module state and sign-ins, the shared database. */
  async function apiProcess() {
    vi.resetModules();
    // The client comes from the process's own module graph, so it sees that graph's tenant scope.
    const dbModule = await import("@rakazo/db");
    const db = dbModule.createDb(databaseUrl!);
    databases.push(db);
    cleanup ??= dbModule.asSystem(db.prisma);
    const oauth = await import("./pi-oauth.js");
    let answer!: (credential: Credential) => void;
    const answered = new Promise<Credential>((resolve) => {
      answer = resolve;
    });
    let signal: AbortSignal | undefined;
    const logins = new oauth.PiOAuthLogins<Saved>(
      async (provider, _type, interaction) => {
        signal = interaction.signal;
        if (provider === "anthropic") {
          interaction.notify({ type: "auth_url", url: "https://claude.ai/oauth/authorize" });
          const code = await interaction.prompt({ type: "manual_code", message: "paste" });
          return { ...oauthCredential, access: `exchanged-${code}` };
        }
        interaction.notify({
          type: "device_code",
          userCode: "CODE",
          verificationUri: "https://auth.openai.com/codex/device",
        });
        return new Promise<Credential>((resolve, reject) => {
          void answered.then(resolve);
          interaction.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        });
      },
      { prisma: db.prisma, secrets },
    );
    return {
      system: dbModule.asSystem(db.prisma),
      oauth,
      logins,
      answer: () => answer(oauthCredential),
      get stopped() {
        return signal?.aborted === true;
      },
    };
  }

  /** Stands in for saving the connection; only the process holding the exchange runs it. */
  const saveAs =
    (saver: string, saved: string[] = []) =>
    async (login: { credential: OAuthCredential }): Promise<Saved> => {
      saved.push(saver);
      return { id: `connection-${saver}`, label: login.credential.access };
    };

  async function member(fixture: Awaited<ReturnType<typeof apiProcess>>) {
    const id = randomUUID();
    users.push(id);
    const prisma = fixture.system;
    await prisma.user.create({
      data: { id, name: "Sign-in test", email: `${id}@example.test`, emailVerified: true },
    });
    await prisma.organization.create({
      data: { id, name: "Sign-in test", slug: id, createdAt: new Date() },
    });
    await prisma.space.create({
      data: { id, organizationId: id, name: "Sign-in test", isDefault: true },
    });
    return { userId: id, spaceId: id };
  }

  it("reports and finishes a device-code sign-in on a process that did not start it", async () => {
    const a = await apiProcess();
    const b = await apiProcess();
    const actor = await member(a);
    const saved: string[] = [];
    const started = await a.logins.begin({
      ...actor,
      provider: "openai-codex",
      persist: saveAs("a", saved),
    });

    await expect(b.logins.complete(started.loginId, actor)).resolves.toEqual({
      status: "pending",
    });
    a.answer();
    await vi.waitFor(async () =>
      expect(await b.logins.complete(started.loginId, actor)).toEqual({
        status: "connected",
        provider: "openai-codex",
      }),
    );
    await expect(b.logins.finish(started.loginId, actor)).resolves.toEqual({
      status: "connected",
      value: { id: "connection-a", label: "device-access" },
      provider: "openai-codex",
    });
    expect(saved).toEqual(["a"]);
    await expect(a.logins.complete(started.loginId, actor)).resolves.toMatchObject({
      status: "error",
    });
    await a.logins.abortAll();
  });

  it("stops the starting process's provider wait when another process cancels", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const a = await apiProcess();
    const b = await apiProcess();
    const actor = await member(a);
    const saved: string[] = [];
    const started = await a.logins.begin({
      ...actor,
      provider: "github-copilot",
      persist: saveAs("a", saved),
    });

    await b.logins.cancel(started.loginId, actor);
    expect(a.stopped).toBe(false);
    await vi.advanceTimersByTimeAsync(a.oauth.SIGN_IN_LEASE_RENEW_MS);
    await vi.waitFor(() => expect(a.stopped).toBe(true));
    a.answer();
    expect(saved).toEqual([]);
    await expect(b.logins.complete(started.loginId, actor)).resolves.toMatchObject({
      status: "error",
    });
  });

  it("fails a sign-in whose process went away instead of leaving it pending", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const b = await apiProcess();
    const actor = await member(b);

    // Drained by a deploy: it fails at once.
    const drained = await apiProcess();
    const first = await drained.logins.begin({
      ...actor,
      provider: "openai-codex",
      persist: saveAs("drained"),
    });
    await drained.logins.abortAll();
    await expect(b.logins.complete(first.loginId, actor)).resolves.toEqual({
      status: "error",
      error: "Sign-in was interrupted. Start sign-in again.",
      provider: "openai-codex",
    });

    // Gone without a word: its lease is no longer renewed and lapses.
    const crashed = await apiProcess();
    const second = await crashed.logins.begin({
      ...actor,
      provider: "xai",
      persist: saveAs("crashed"),
    });
    await expect(b.logins.complete(second.loginId, actor)).resolves.toEqual({
      status: "pending",
    });
    await b.system.modelOAuthSession.update({
      where: { id: second.loginId },
      data: { leaseExpiresAt: new Date(Date.now() - 1_000) },
    });
    await expect(b.logins.complete(second.loginId, actor)).resolves.toEqual({
      status: "error",
      error: "Sign-in was interrupted. Start sign-in again.",
      provider: "xai",
    });
    await crashed.logins.abortAll();
  });

  it("reports a pasted code exchanged elsewhere to the process that started the sign-in", async () => {
    const a = await apiProcess();
    const b = await apiProcess();
    const actor = await member(a);
    const saved: string[] = [];
    const started = await a.logins.begin({
      ...actor,
      provider: "anthropic",
      persist: saveAs("a", saved),
    });

    await expect(
      b.logins.submit(started.loginId, actor, "the-code", saveAs("b", saved)),
    ).resolves.toEqual({ ok: true });
    // The starting process still holds its own prompt, so it must read the stored outcome.
    await vi.waitFor(async () =>
      expect(await a.logins.complete(started.loginId, actor)).toEqual({
        status: "connected",
        provider: "anthropic",
      }),
    );
    // The code is exchanged by one process only.
    await expect(
      a.logins.submit(started.loginId, actor, "the-code", saveAs("a", saved)),
    ).resolves.toEqual({ ok: true });
    await expect(a.logins.finish(started.loginId, actor)).resolves.toMatchObject({
      status: "connected",
      value: { id: "connection-b", label: "exchanged-the-code" },
    });
    expect(saved).toEqual(["b"]);
    await a.logins.abortAll();
    await b.logins.abortAll();
  });
});
