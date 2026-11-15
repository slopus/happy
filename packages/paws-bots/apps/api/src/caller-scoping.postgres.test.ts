import { randomUUID } from "node:crypto";
import { RPCHandler } from "@orpc/server/fetch";
import type { SecretStore } from "@rakazo/adapter-kit";
import type { Actor, MessageBlock } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import {
  asSystem,
  createDb,
  createOrganizationForUser,
  runAsSystem,
  runAsTenant,
} from "@rakazo/db";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { queueMcpConnectedRun } from "./mcp-approval.js";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";
import { assertThreadImageInput } from "./thread-image-admission.js";
import type { WebhookDeps } from "./webhook.js";
import { mountWebhookHttpRoutes, WEBHOOK_SECRET_KIND } from "./webhook.js";

const describePostgres =
  process.env.VERIFY_DATABASE === "1" && process.env.DATABASE_URL ? describe : describe.skip;

const image: MessageBlock[] = [
  { kind: "image", artifactId: "image-1", name: "picture.png", mimeType: "image/png" },
];
const TEXT_ONLY = { modelProvider: "openrouter", modelId: "deepseek/deepseek-v4-pro" };
const CUSTOM_MODEL = "custom-vision-model";
const WEBHOOK_TOKEN = "caller-scoping-webhook-token";

describePostgres("caller and tenant scoping (PostgreSQL)", () => {
  // The runtime login enforces row-level security; the owner login bypasses it, as an
  // install that still connects the app as the table owner does.
  let runtime: ReturnType<typeof createDb>;
  let owner: ReturnType<typeof createDb>;
  let system: PrismaClient;
  const id = (label: string) => `${label}-${randomUUID()}`;
  const organizationId = id("org");
  const shared = id("space-shared");
  const other = id("space-other");
  const userA = id("user-a");
  const userB = id("user-b");
  const actorA: Actor = {
    userId: userA,
    spaceId: shared,
    email: `${userA}@rakazo.test`,
    isDeploymentOwner: false,
  };

  beforeAll(async () => {
    runtime = createDb(process.env.DATABASE_URL!);
    const ownerUrl = process.env.DATABASE_MIGRATION_URL;
    if (!ownerUrl || ownerUrl === process.env.DATABASE_URL)
      throw new Error("DATABASE_MIGRATION_URL must name the table owner login");
    owner = createDb(ownerUrl);
    system = asSystem(runtime.prisma);
    for (const user of [userA, userB])
      await system.user.create({
        data: { id: user, name: user, email: `${user}@rakazo.test`, emailVerified: true },
      });
    await system.organization.create({
      data: { id: organizationId, name: "Scoping", slug: organizationId, createdAt: new Date() },
    });
    for (const space of [shared, other])
      await system.space.create({ data: { id: space, organizationId, name: space } });
  });

  afterAll(async () => {
    await system.organization.deleteMany({
      where: { OR: [{ id: organizationId }, { members: { some: { userId: userA } } }] },
    });
    await system.user.deleteMany({ where: { id: { in: [userA, userB] } } });
    for (const db of [runtime, owner]) {
      await db?.prisma.$disconnect();
      await db?.pool.end();
    }
  });

  const bot = (spaceId: string, userId: string, data: Record<string, unknown> = {}) =>
    system.bot.create({
      data: {
        spaceId,
        userId,
        name: "Scoped",
        color: "ink",
        thread: { create: { spaceId, userId } },
        ...data,
      },
    });
  const secret = (userId: string, spaceId: string | null) =>
    system.secret.create({
      data: { userId, spaceId, kind: spaceId ? "mcp" : "model", ciphertext: randomUUID() },
    });

  describe.each([
    ["the runtime login", () => runtime.prisma],
    ["the owner login, without row-level security", () => owner.prisma],
  ])("image admission through %s", (_role, prismaFor) => {
    const admit = (botId: string, configuration: Parameters<typeof assertThreadImageInput>[5]) =>
      runAsTenant(actorA, () =>
        assertThreadImageInput(prismaFor(), actorA, botId, image, undefined, configuration),
      );
    const hosted = () => ({
      secrets: { load: vi.fn(async () => "unused") },
      deployment: null,
      hostedProvider: TEXT_ONLY.modelProvider,
    });

    it("reads the space's bots, whoever created them, and none elsewhere", async () => {
      const own = await bot(shared, userA, TEXT_ONLY);
      const neighbors = await bot(shared, userB, TEXT_ONLY);
      const elsewhere = await bot(other, userA, TEXT_ONLY);

      await expect(admit(own.id, hosted())).rejects.toMatchObject({ code: "CONFLICT" });
      // Everyone in a space shares its bots, and a run uses the bot's own model.
      await expect(admit(neighbors.id, hosted())).rejects.toMatchObject({ code: "CONFLICT" });
      await expect(admit(elsewhere.id, hosted())).resolves.toBeUndefined();
    });

    it.each([
      ["openai-compatible", CUSTOM_MODEL],
      ["openai-codex", "gpt-5.5"],
    ])("decrypts only the caller's account secret for %s", async (provider, modelId) => {
      const target = await bot(shared, userA, { modelProvider: provider, modelId });
      const credential = await system.userModelCredential.create({
        data: {
          userId: userA,
          provider,
          label: "Scoped",
          secretId: (await secret(userA, null)).id,
        },
      });
      const configured = () => {
        const load = vi.fn(async (_ciphertext: string, _ref?: string) =>
          JSON.stringify({
            kind: "openai_compatible",
            baseUrl: "http://127.0.0.1:9/v1",
            visionModelIds: [CUSTOM_MODEL],
          }),
        );
        return {
          load,
          configuration: {
            secrets: { load } as Pick<SecretStore, "load">,
            deployment: null,
            codexCatalog: { read: vi.fn(async () => undefined) },
          },
        };
      };
      const decryptedWith = async (secretId: string) => {
        await system.userModelCredential.update({
          where: { id: credential.id },
          data: { secretId },
        });
        const { load, configuration } = configured();
        const outcome = await admit(target.id, configuration).then(
          () => "admitted",
          () => "refused",
        );
        return { outcome, refs: load.mock.calls.map((call) => call[1]) };
      };

      const ownSecret = credential.secretId;
      const own = await decryptedWith(ownSecret);
      expect(own.refs).toContain(ownSecret);
      if (provider === "openai-compatible") expect(own.outcome).toBe("admitted");

      for (const foreign of [
        await secret(userB, null),
        await secret(userB, shared),
        await secret(userA, shared),
      ]) {
        const read = await decryptedWith(foreign.id);
        expect(read.refs).not.toContain(foreign.id);
        if (provider === "openai-compatible") expect(read.outcome).toBe("refused");
      }
    });
  });

  it("starts only the target bot's webhook routines in its own space", async () => {
    const target = await bot(shared, userA);
    const webhookSecret = await system.secret.create({
      data: { userId: userA, spaceId: shared, kind: WEBHOOK_SECRET_KIND, ciphertext: "sealed" },
    });
    await system.bot.update({
      where: { id: target.id },
      data: { webhookSecretId: webhookSecret.id },
    });
    const neighbor = await bot(shared, userB);
    const routine = (botId: string, spaceId: string, userId: string, prompt: string) =>
      system.routine.create({
        data: {
          botId,
          spaceId,
          userId,
          name: prompt,
          prompt,
          crons: [],
          active: true,
          webhookEnabled: true,
        },
      });
    await routine(target.id, shared, userA, "routine-of-target");
    await routine(neighbor.id, shared, userB, "routine-of-neighbor");
    await routine(target.id, other, userA, "routine-in-other-space");

    const sendUserMessage = vi.fn(async () => ({ messageId: "message", runId: null, seq: 1 }));
    const app = new Hono();
    app.use("/api/v1/bots/*", (_c, next) => runAsSystem("bot webhook", next));
    mountWebhookHttpRoutes(app, {
      prisma: runtime.prisma,
      secrets: { load: async () => WEBHOOK_TOKEN } as unknown as SecretStore,
      events: { sendUserMessage } as unknown as WebhookDeps["events"],
      jobs: { enqueue: vi.fn() },
    });

    const response = await app.request(`/api/v1/bots/${target.id}/webhook`, {
      method: "POST",
      headers: { authorization: `Bearer ${WEBHOOK_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ event: "ping" }),
    });

    expect(response.status).toBe(200);
    const sent = sendUserMessage.mock.calls[0] as unknown as [{ prompt: string }];
    expect(sent[0].prompt).toContain("routine-of-target");
    expect(sent[0].prompt).not.toContain("routine-of-neighbor");
    expect(sent[0].prompt).not.toContain("routine-in-other-space");
  });

  it("does not continue an MCP approval in an archived group chat", async () => {
    const member = await bot(shared, userA);
    const server = await system.mcpServer.create({
      data: {
        spaceId: shared,
        userId: userA,
        slug: id("mcp"),
        name: "Scoped MCP",
        transport: "http",
        endpoint: "http://127.0.0.1:9/mcp",
      },
    });
    const groupThread = async (archivedAt: Date | null) => {
      const group = await system.chatGroup.create({
        data: {
          spaceId: shared,
          userId: userA,
          name: "Group",
          archivedAt,
          members: { create: { botId: member.id } },
        },
      });
      return system.thread.create({ data: { spaceId: shared, userId: userA, groupId: group.id } });
    };
    const queue = (threadId: string) =>
      runAsTenant(actorA, () =>
        runtime.prisma.$transaction((tx) =>
          queueMcpConnectedRun(tx, actorA, { botId: member.id, serverId: server.id, threadId }),
        ),
      );

    const archived = await groupThread(new Date());
    const active = await groupThread(null);

    await expect(queue(archived.id)).resolves.toBeNull();
    await expect(queue(active.id)).resolves.toEqual(expect.any(String));
  });

  it("runs authenticated procedures inside the caller's tenant", async () => {
    const own = await bot(shared, userA, { name: "Own" });
    const elsewhere = await bot(other, userA, { name: "Elsewhere" });
    const router = createRouter({
      prisma: runtime.prisma,
      env: { ticketBoardEnabled: true },
    } as unknown as RouterDeps);
    const call = async (procedure: string) => {
      const { response } = await new RPCHandler(router).handle(
        new Request(`https://api.example.test/rpc/${procedure}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ json: {} }),
        }),
        { prefix: "/rpc", context: { actor: actorA } },
      );
      expect(response?.status).toBe(200);
      return ((await response!.json()) as { json: Array<{ id: string; spaceId?: string }> }).json;
    };

    const listed = (await call("bots/list")).map((row) => row.id);
    expect(listed).toContain(own.id);
    expect(listed).not.toContain(elsewhere.id);
    expect(await call("boards/list")).toEqual([expect.objectContaining({ spaceId: shared })]);
  });

  it("scopes a person with two organizations to the one their Space is in", async () => {
    const work = await createOrganizationForUser(system, { userId: userA, name: "Work" });
    const inWork: Actor = { ...actorA, spaceId: work.defaultSpaceId };
    const workBot = await bot(work.defaultSpaceId, userA, { name: "Work" });
    const sharedBot = await bot(shared, userA, { name: "Shared" });
    const router = createRouter({ prisma: runtime.prisma, env: {} } as unknown as RouterDeps);
    const listed = async (actor: Actor) => {
      const { response } = await new RPCHandler(router).handle(
        new Request("https://api.example.test/rpc/bots/list", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ json: {} }),
        }),
        { prefix: "/rpc", context: { actor } },
      );
      return ((await response!.json()) as { json: Array<{ id: string }> }).json.map(
        (row) => row.id,
      );
    };

    expect(await listed(inWork)).toEqual([workBot.id]);
    expect(await listed(actorA)).toContain(sharedBot.id);
    expect(await listed(actorA)).not.toContain(workBot.id);
  });
});
