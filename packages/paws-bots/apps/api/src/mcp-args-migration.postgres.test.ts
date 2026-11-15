import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EncryptedSecretStore, FakeSandboxProvider, withSecretPersistence } from "@rakazo/adapters";
import type { PrismaClient } from "@rakazo/db";
import { createDb, runAsSystem } from "@rakazo/db";
import { createLogger, createTestSink, installLogger } from "@rakazo/logging";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import { moveMcpArgsIntoSecrets } from "./mcp-args-migration.js";

const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);

describe.skipIf(!enabled)("moving MCP server arguments into secrets (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let prisma: PrismaClient;
  const suffix = randomUUID();
  const userId = `mcp-args-user-${suffix}`;
  const spaceId = `mcp-args-space-${suffix}`;
  const organizationId = `mcp-args-org-${suffix}`;
  const encryptionKey = "fake-mcp-args-test-encryption-key";
  const secrets = new EncryptedSecretStore(encryptionKey);
  const context = {
    operationId: "test",
    traceId: "test",
    spaceId,
    userId,
    signal: new AbortController().signal,
  };
  const server = (slug: string, data: Record<string, unknown> = {}) =>
    prisma.mcpServer.create({
      data: { spaceId, userId, slug, name: slug, transport: "stdio", command: "npx", ...data },
    });
  const materialOf = async (secretId: string | null) => {
    const secret = await prisma.secret.findUniqueOrThrow({ where: { id: secretId ?? "" } });
    return JSON.parse(await secrets.load(secret.ciphertext, secret.id));
  };

  beforeAll(() =>
    runAsSystem("mcp args migration fixture", async () => {
      db = createDb(process.env.DATABASE_URL!);
      prisma = withSecretPersistence(db.prisma, secrets);
      await prisma.user.create({
        data: { id: userId, name: "Args", email: `${userId}@example.test`, emailVerified: false },
      });
      await prisma.organization.create({
        data: { id: organizationId, name: "Args", slug: organizationId, createdAt: new Date() },
      });
      await prisma.space.create({
        data: {
          id: spaceId,
          organizationId,
          name: "General",
          isDefault: true,
          createdByUserId: userId,
        },
      });
    }),
  );
  afterAll(() =>
    runAsSystem("mcp args migration fixture", async () => {
      if (prisma) {
        await prisma.organization.deleteMany({ where: { id: organizationId } });
        await prisma.user.deleteMany({ where: { id: userId } });
        await prisma.$disconnect();
        await db.pool.end();
      }
      await secrets.close();
    }),
  );

  it("encrypts plaintext arguments, keeps other credentials, and leaves the column empty", () =>
    runAsSystem("mcp args migration", async () => {
      const bare = await server("bare", { args: ["--api-key", "fake-key"] });
      const existing = await secrets.put(JSON.stringify({ env: { API_KEY: "fake-env" } }), context);
      await prisma.secret.create({
        data: { id: existing.id, userId, spaceId, kind: "mcp", ciphertext: existing.ciphertext },
      });
      const withSecret = await server("with-secret", { args: ["serve"], secretId: existing.id });
      const current = await server("current", { hasArgs: false });

      // Other suites share the database, so this checks rows rather than counts.
      await moveMcpArgsIntoSecrets(prisma, secrets, { dryRun: true });
      expect(await prisma.mcpServer.findUniqueOrThrow({ where: { id: bare.id } })).toMatchObject({
        args: ["--api-key", "fake-key"],
        secretId: null,
      });
      await moveMcpArgsIntoSecrets(prisma, secrets);

      const bareRow = await prisma.mcpServer.findUniqueOrThrow({ where: { id: bare.id } });
      expect(bareRow).toMatchObject({ args: [], hasArgs: true });
      expect(await materialOf(bareRow.secretId)).toEqual({ args: ["--api-key", "fake-key"] });
      const secretRow = await prisma.mcpServer.findUniqueOrThrow({
        where: { id: withSecret.id },
      });
      expect(secretRow).toMatchObject({ args: [], hasArgs: true });
      expect(await materialOf(secretRow.secretId)).toEqual({
        env: { API_KEY: "fake-env" },
        args: ["serve"],
      });
      expect(await prisma.secret.findUnique({ where: { id: existing.id } })).toBeNull();
      expect(await prisma.mcpServer.findUniqueOrThrow({ where: { id: current.id } })).toMatchObject(
        { secretId: null, hasArgs: false },
      );
    }));

  it("moves arguments once when runs overlap or repeat", () =>
    runAsSystem("mcp args migration", async () => {
      const row = await server("overlap", { args: ["--token", "fake-token"] });

      await Promise.all([
        moveMcpArgsIntoSecrets(prisma, secrets),
        moveMcpArgsIntoSecrets(prisma, secrets),
      ]);
      const moved = await prisma.mcpServer.findUniqueOrThrow({ where: { id: row.id } });
      expect(await moveMcpArgsIntoSecrets(prisma, secrets)).toMatchObject({ moved: 0 });

      expect(await prisma.mcpServer.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({
        args: [],
        hasArgs: true,
        secretId: moved.secretId,
      });
      expect(await materialOf(moved.secretId)).toEqual({ args: ["--token", "fake-token"] });
      const referenced = await prisma.mcpServer.findMany({
        where: { spaceId },
        select: { secretId: true },
      });
      expect(
        await prisma.secret.count({
          where: {
            userId,
            kind: "mcp",
            id: { notIn: referenced.flatMap((server) => server.secretId ?? []) },
          },
        }),
      ).toBe(0);
    }));

  it("skips a server it cannot move and keeps going", () =>
    runAsSystem("mcp args migration", async () => {
      const sink = createTestSink();
      installLogger(createLogger({ service: "rakazo-api", sinks: [sink] }));
      await prisma.secret.create({
        data: { id: `unreadable-${suffix}`, userId, spaceId, kind: "mcp", ciphertext: "fake" },
      });
      const notJson = await secrets.put("leak1 is not json", context);
      await prisma.secret.create({
        data: { id: notJson.id, userId, spaceId, kind: "mcp", ciphertext: notJson.ciphertext },
      });
      const broken = await server("a-broken", {
        args: ["--broken"],
        secretId: `unreadable-${suffix}`,
      });
      await server("b-not-json", { args: ["--not-json"], secretId: notJson.id });
      const notObject = await secrets.put(JSON.stringify("leak2"), context);
      await prisma.secret.create({
        data: {
          id: notObject.id,
          userId,
          spaceId,
          kind: "mcp",
          ciphertext: notObject.ciphertext,
        },
      });
      await server("c-not-object", { args: ["--not-object"], secretId: notObject.id });
      const healthy = await server("z-healthy", { args: ["--healthy"] });

      try {
        const counts = await moveMcpArgsIntoSecrets(prisma, secrets);

        expect(counts.failed).toBeGreaterThanOrEqual(3);
        expect(JSON.stringify(sink.events)).not.toMatch(/leak1|leak2/);
      } finally {
        installLogger(createLogger({ service: "rakazo-api", level: "off", sinks: [] }));
      }
      expect(await prisma.mcpServer.findUniqueOrThrow({ where: { id: broken.id } })).toMatchObject({
        args: ["--broken"],
        secretId: `unreadable-${suffix}`,
      });
      const healthyRow = await prisma.mcpServer.findUniqueOrThrow({ where: { id: healthy.id } });
      expect(healthyRow).toMatchObject({ args: [], hasArgs: true });
      expect(await materialOf(healthyRow.secretId)).toEqual({ args: ["--healthy"] });
    }));

  it("moves arguments in the background when the API starts", async () => {
    const row = await runAsSystem("mcp args migration", () =>
      server("startup", { args: ["--startup", "fake-startup"] }),
    );
    const dataDir = await mkdtemp(join(tmpdir(), "rakazo-mcp-args-"));
    const handles = await createApp({
      databaseUrl: process.env.DATABASE_URL!,
      encryptionKey,
      dataDir,
      sandboxProvider: "fake",
      sandbox: new FakeSandboxProvider(),
      agentRuntime: "scripted",
      wakeupDriver: "memory",
    });
    try {
      const moved = await vi.waitFor(
        () =>
          runAsSystem("mcp args migration", async () => {
            const current = await prisma.mcpServer.findUniqueOrThrow({ where: { id: row.id } });
            expect(current).toMatchObject({ args: [], hasArgs: true });
            return current;
          }),
        { timeout: 15_000 },
      );
      await runAsSystem("mcp args migration", async () =>
        expect(await materialOf(moved.secretId)).toEqual({
          args: ["--startup", "fake-startup"],
        }),
      );
    } finally {
      await handles.stop();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
