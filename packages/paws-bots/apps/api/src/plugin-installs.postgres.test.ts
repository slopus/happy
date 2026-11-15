import { randomUUID } from "node:crypto";
import { createRouterClient } from "@orpc/server";
import {
  EncryptedSecretStore,
  previewPluginInstall,
  withSecretPersistence,
} from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { createDb, runAsSystem, runAsTenant } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createAgentSkillsService } from "./agent-skills.js";
import { installPlugin } from "./plugin-installs.js";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const sha = "a".repeat(40);
const fetcher = async () => ({
  resolvedSha: sha,
  files: [
    { path: ".grok-plugin/plugin.json", content: JSON.stringify({ name: "example-plugin" }) },
    {
      path: "skills/example/SKILL.md",
      content: "---\nname: plugin-test-skill\ndescription: Example\n---\n\nFollow these steps.\n",
    },
    {
      path: ".mcp.json",
      content: JSON.stringify({
        mcpServers: {
          example: {
            type: "http",
            url: "https://tools.example.test/mcp",
            headers: { "X-Tenant": "fake-package-tenant" },
          },
        },
      }),
    },
  ],
});

describe.skipIf(!enabled)("plugin install lifecycle (PostgreSQL, offline providers)", () => {
  let db: ReturnType<typeof createDb>;
  let prisma: PrismaClient;
  let actor: Actor;
  const suffix = randomUUID();
  const organizationId = `plugin-org-${suffix}`;
  const secrets = new EncryptedSecretStore("fake-plugin-test-encryption-key");
  const endpoint = vi.fn().mockResolvedValue(undefined);
  const deps = () => ({ prisma, secrets, fetcher, assertEndpoint: endpoint });
  const client = (asActor = actor) =>
    createRouterClient(
      createRouter({
        prisma,
        secrets,
        pluginRepoFetcher: fetcher,
        remoteConnectors: {
          resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }],
        },
        events: { notify: vi.fn() },
        env: {
          webOrigin: "http://localhost:5173",
          defaultProvider: "fake",
          defaultModel: "fake",
        },
        dataDir: "/tmp/plugin-db-test",
      } as unknown as RouterDeps),
      { context: { actor: asActor } },
    );
  const source = "https://github.com/example/plugin";
  const asActor = (fn: () => Promise<void>) => () => runAsTenant(actor, fn);
  async function input() {
    return {
      source,
      name: "Example",
      config: {},
      pluginDigest: (await previewPluginInstall({ source, fetcher })).digest,
    };
  }
  beforeAll(() =>
    runAsSystem("plugin install fixture", async () => {
      db = createDb(process.env.DATABASE_URL!);
      prisma = withSecretPersistence(db.prisma, secrets);
      const userId = `plugin-user-${suffix}`;
      const spaceId = `plugin-space-${suffix}`;
      await prisma.user.create({
        data: {
          id: userId,
          name: "Plugin Test",
          email: `${userId}@example.test`,
          emailVerified: false,
        },
      });
      await prisma.organization.create({
        data: {
          id: organizationId,
          name: "Plugin Test",
          slug: organizationId,
          createdAt: new Date(),
        },
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
      actor = { spaceId, userId, email: `${userId}@example.test`, isDeploymentOwner: false };
    }),
  );
  afterAll(() =>
    runAsSystem("plugin install fixture", async () => {
      if (prisma) {
        await prisma.organization.deleteMany({ where: { id: organizationId } });
        await prisma.user.deleteMany({ where: { id: actor?.userId } });
        await prisma.$disconnect();
        await db.pool.end();
      }
      await secrets.close();
    }),
  );

  it(
    "installs immutable read-only skills and encrypted native MCP rows, then fully uninstalls",
    asActor(async () => {
      const rpc = client();
      const preview = await rpc.capabilities.pluginPreview({ source });
      const install = await rpc.capabilities.install({
        kind: "plugin",
        source,
        name: "Example",
        config: {},
        pluginDigest: preview.digest,
      });
      const skill = await prisma.agentSkill.findFirstOrThrow({
        where: { installId: install.id },
      });
      const server = await prisma.mcpServer.findFirstOrThrow({
        where: { installId: install.id },
      });
      expect(install.version).toBe(sha);
      expect(skill.source).toBe("plugin");
      const service = createAgentSkillsService(prisma);
      expect((await service.get(actor, { skillId: skill.id })).readOnly).toBe(true);
      await expect(service.remove(actor, skill.id)).rejects.toThrow();
      expect(await prisma.botMcpServer.count({ where: { serverId: server.id } })).toBe(0);
      const secret = await prisma.secret.findUniqueOrThrow({ where: { id: server.secretId! } });
      expect(secret.ciphertext).not.toContain("fake-package-tenant");
      expect(JSON.parse(await secrets.load(secret.ciphertext, secret.id)).headers).toEqual({
        "X-Tenant": "fake-package-tenant",
      });
      expect(JSON.stringify(install.config)).not.toContain("fake-package-tenant");
      expect(server.headers).toEqual({ "X-Tenant": true });
      expect(await rpc.mcp.servers.list()).toContainEqual(
        expect.objectContaining({ id: server.id, oauthStatus: "none", hasSecret: true }),
      );

      // OAuth state and per-bot assignments must not survive uninstall either.
      await prisma.mcpOAuthSession.create({
        data: {
          id: randomUUID(),
          spaceId: actor.spaceId,
          userId: actor.userId,
          serverId: server.id,
          endpoint: server.endpoint!,
          redirectUri: "http://localhost:5173/mcp/oauth/callback",
          oauthCiphertext: "encrypted-pending-state",
        },
      });
      const bot = await prisma.bot.create({
        data: { spaceId: actor.spaceId, userId: actor.userId, name: "Test", color: "blue" },
      });
      await prisma.botMcpServer.create({
        data: {
          spaceId: actor.spaceId,
          userId: actor.userId,
          botId: bot.id,
          serverId: server.id,
        },
      });
      expect(await client().capabilities.remove({ id: install.id })).toEqual({ ok: true });
      expect(await prisma.capabilityInstall.findUnique({ where: { id: install.id } })).toBeNull();
      expect(await prisma.agentSkill.count({ where: { installId: install.id } })).toBe(0);
      expect(await prisma.mcpServer.count({ where: { installId: install.id } })).toBe(0);
      expect(await prisma.secret.findUnique({ where: { id: secret.id } })).toBeNull();
      expect(await prisma.mcpOAuthSession.count({ where: { serverId: server.id } })).toBe(0);
      expect(await prisma.botMcpServer.count({ where: { serverId: server.id } })).toBe(0);
    }),
  );

  it(
    "rolls back parent, skill and encrypted secret rows if a child write fails",
    asActor(async () => {
      const before = await prisma.secret.count({ where: { userId: actor.userId } });
      const fault = new Proxy(prisma, {
        get(target, key) {
          if (key === "$transaction")
            return (run: (tx: unknown) => Promise<unknown>) =>
              target.$transaction((tx) =>
                run(
                  new Proxy(tx, {
                    get(t, k) {
                      if (k === "mcpServer")
                        return {
                          create: async () => {
                            throw new Error("injected child failure");
                          },
                        };
                      return Reflect.get(t, k);
                    },
                  }),
                ),
              );
          return Reflect.get(target, key);
        },
      });
      await expect(
        installPlugin({ ...deps(), prisma: fault }, actor, await input()),
      ).rejects.toThrow("injected child failure");
      expect(
        await prisma.capabilityInstall.count({ where: { userId: actor.userId, kind: "plugin" } }),
      ).toBe(0);
      expect(
        await prisma.agentSkill.count({ where: { userId: actor.userId, source: "plugin" } }),
      ).toBe(0);
      expect(await prisma.secret.count({ where: { userId: actor.userId } })).toBe(before);
    }),
  );

  it(
    "serializes concurrent installs and does not let another actor remove them",
    asActor(async () => {
      const args = await input();
      const results = await Promise.allSettled([
        installPlugin(deps(), actor, args),
        installPlugin(deps(), actor, args),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
      const install = await prisma.capabilityInstall.findFirstOrThrow({
        where: { userId: actor.userId, kind: "plugin" },
      });
      await client({ ...actor, userId: "other-user" }).capabilities.remove({ id: install.id });
      expect(
        await prisma.capabilityInstall.findUnique({ where: { id: install.id } }),
      ).not.toBeNull();
      await client().capabilities.remove({ id: install.id });
    }),
  );

  it(
    "adds and removes a plugin's connector and skills as separate parts",
    asActor(async () => {
      const rpc = client();
      const preview = await rpc.capabilities.pluginPreview({ source });
      const install = await rpc.capabilities.install({
        kind: "plugin",
        source,
        name: "Example",
        config: {},
        pluginDigest: preview.digest,
        pluginParts: ["skills"],
      });
      expect(await prisma.mcpServer.count({ where: { installId: install.id } })).toBe(0);
      expect(await prisma.agentSkill.count({ where: { installId: install.id } })).toBe(1);

      const both = await rpc.capabilities.pluginParts({
        id: install.id,
        parts: ["skills", "connector"],
      });
      expect(both.install?.config).toMatchObject({ parts: ["skills", "connector"] });
      const server = await prisma.mcpServer.findFirstOrThrow({
        where: { installId: install.id },
      });
      expect(server.secretId).not.toBeNull();

      const connectorOnly = await rpc.capabilities.pluginParts({
        id: install.id,
        parts: ["connector"],
      });
      expect(connectorOnly.install?.config).toMatchObject({ parts: ["connector"] });
      expect(await prisma.agentSkill.count({ where: { installId: install.id } })).toBe(0);
      expect(await prisma.mcpServer.count({ where: { installId: install.id } })).toBe(1);

      expect(await rpc.capabilities.pluginParts({ id: install.id, parts: [] })).toEqual({
        install: null,
      });
      expect(await prisma.capabilityInstall.findUnique({ where: { id: install.id } })).toBeNull();
      expect(await prisma.mcpServer.count({ where: { installId: install.id } })).toBe(0);
      expect(await prisma.secret.findUnique({ where: { id: server.secretId! } })).toBeNull();
    }),
  );
});
