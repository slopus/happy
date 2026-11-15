import { randomUUID } from "node:crypto";
import { asSystem, createDb, runAsTenant } from "@rakazo/db";
import { afterAll, describe, expect, it } from "vitest";
import type { OAuthMaterial } from "./mcp-oauth.js";
import { McpOAuthBroker } from "./mcp-oauth.js";
import { PostgresRealtimeFanout } from "./realtime.js";
import { withSecretPersistence } from "./secret-persistence.js";
import { ComposedSecretStore } from "./secret-store-factory.js";
import { EncryptedSecretStore } from "./secrets.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE && databaseUrl ? describe : describe.skip;

const ISSUER = "https://auth.example.test";

describePostgres("MCP OAuth refresh (PostgreSQL contract)", () => {
  const databases: Array<ReturnType<typeof createDb>> = [];
  const users: string[] = [];
  const secrets = new EncryptedSecretStore("test-only-encryption-key");

  function openDb(poolMax?: number) {
    const db = createDb(databaseUrl!, poolMax ? { poolMax } : {});
    databases.push(db);
    return db;
  }

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

  async function seed(material: OAuthMaterial) {
    const prisma = asSystem(openDb().prisma);
    const id = randomUUID();
    users.push(id);
    await prisma.user.create({
      data: { id, name: "OAuth test", email: `${id}@example.test`, emailVerified: true },
    });
    await prisma.organization.create({
      data: { id, name: "OAuth test", slug: id, createdAt: new Date() },
    });
    await prisma.space.create({
      data: { id, organizationId: id, name: "OAuth test", isDefault: true },
    });
    const stored = await secrets.put(JSON.stringify(material), {
      operationId: "test",
      traceId: "test",
      spaceId: id,
      userId: id,
      signal: new AbortController().signal,
    });
    await prisma.secret.create({
      data: { id: stored.id, userId: id, spaceId: id, kind: "mcp", ciphertext: stored.ciphertext },
    });
    const server = await prisma.mcpServer.create({
      data: {
        spaceId: id,
        userId: id,
        slug: "oauth",
        name: "OAuth",
        transport: "streamable_http",
        endpoint: "https://mcp.example.test/mcp",
        secretId: stored.id,
      },
    });
    return { server, context: { spaceId: id, userId: id } };
  }

  function expiredMaterial(): OAuthMaterial {
    return {
      oauth: {
        tokens: {
          access_token: "access-0",
          refresh_token: "refresh-0",
          token_type: "Bearer",
          expires_in: 3600,
        },
        obtainedAt: Date.now() - 2 * 60 * 60 * 1000,
        clientInformation: { client_id: "client-1" },
        discoveryState: {
          authorizationServerUrl: ISSUER,
          authorizationServerMetadata: {
            issuer: ISSUER,
            authorization_endpoint: `${ISSUER}/authorize`,
            token_endpoint: `${ISSUER}/token`,
            response_types_supported: ["code"],
          },
        },
      },
    };
  }

  it("refreshes more servers at once than the API pool has connections", async () => {
    // Production-shaped API process: secret change notifications go out on the Prisma pool.
    const db = openDb(2);
    const notified: string[] = [];
    const publisher = {
      query: async (sql: string, values: unknown[]) => {
        const result = await db.pool.query(sql, values);
        notified.push(JSON.parse(JSON.parse(String(values[1])).payload).ref);
        return result;
      },
    };
    const store = new ComposedSecretStore(
      new EncryptedSecretStore("test-only-encryption-key"),
      undefined,
      new PostgresRealtimeFanout({ connectionString: databaseUrl!, publisher }),
    );
    const broker = new McpOAuthBroker(withSecretPersistence(db.prisma, store), store, {
      resolveHostname: async () => [{ address: "203.0.113.10", family: 4 as const }],
      fetch: async () =>
        Response.json({
          access_token: "access-1",
          refresh_token: "refresh-1",
          token_type: "Bearer",
          expires_in: 3600,
        }),
    });
    const seeded = await Promise.all([1, 2, 3].map(() => seed(expiredMaterial())));
    const providers = await Promise.all(
      seeded.map(({ server, context }) =>
        runAsTenant(context, () => broker.providerFor(server, context)),
      ),
    );

    const started = Date.now();
    const tokens = await Promise.all(
      providers.map((provider, index) =>
        runAsTenant(seeded[index]!.context, () => provider?.tokens()),
      ),
    );

    expect(tokens.map((token) => token?.access_token)).toEqual([
      "access-1",
      "access-1",
      "access-1",
    ]);
    expect(Date.now() - started).toBeLessThan(5_000);
    for (const { server } of seeded) {
      const row = await asSystem(db.prisma).secret.findFirstOrThrow({
        where: { mcpServers: { some: { id: server.id } } },
      });
      expect(
        JSON.parse(await secrets.load(row.ciphertext, row.id)).oauth.tokens.refresh_token,
      ).toBe("refresh-1");
      expect(notified).toContain(row.ciphertext);
    }
  }, 30_000);
});
