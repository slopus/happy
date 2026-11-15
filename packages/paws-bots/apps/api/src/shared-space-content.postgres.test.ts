import { randomUUID } from "node:crypto";
import { onError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { asSystem, createDb, createGroupRepos, createRepos, runAsTenant } from "@rakazo/db";
import { MarkdownMemoryStore } from "@rakazo/memory";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";
import { handleRpcError } from "./rpc-errors.js";
import { resolveThreadTarget, sendThreadMessage } from "./thread-target.js";

const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe : describe.skip;

describePostgres("shared space content (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let prisma: PrismaClient;
  let system: PrismaClient;
  let handler: RPCHandler<Record<string, unknown>>;
  const users: string[] = [];
  const organizations: string[] = [];

  async function person(name: string): Promise<Actor> {
    const id = `content-${name}-${randomUUID()}`;
    users.push(id);
    organizations.push(id);
    const createdAt = new Date();
    await system.user.create({
      data: { id, name, email: `${id}@example.test`, emailVerified: true },
    });
    await system.organization.create({
      data: { id, name: "Personal", slug: id, createdAt },
    });
    await system.member.create({
      data: {
        id: `m-${id}`,
        organizationId: id,
        userId: id,
        role: "owner",
        createdAt,
      },
    });
    await system.space.create({
      data: {
        id,
        organizationId: id,
        name: "Personal",
        isDefault: true,
        createdByUserId: id,
      },
    });
    await system.spaceMember.create({
      data: {
        id: `sm-${id}`,
        spaceId: id,
        organizationId: id,
        userId: id,
        role: "owner",
        createdAt,
      },
    });
    return {
      userId: id,
      spaceId: id,
      email: `${id}@example.test`,
      isDeploymentOwner: false,
    };
  }

  async function join(spaceId: string, organizationId: string, userId: string, role: string) {
    const createdAt = new Date();
    if (role !== "owner") {
      await system.member.create({
        data: {
          id: randomUUID(),
          organizationId,
          userId,
          role: "member",
          createdAt,
        },
      });
    }
    await system.spaceMember.create({
      data: {
        id: randomUUID(),
        spaceId,
        organizationId,
        userId,
        role,
        createdAt,
      },
    });
  }

  async function call(actor: Actor, path: string, input?: unknown) {
    const { response } = await handler.handle(
      new Request(`http://127.0.0.1/rpc/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: input }),
      }),
      { prefix: "/rpc", context: { actor } },
    );
    const body = (await response!.json()) as { json: unknown };
    return { status: response!.status, json: body.json };
  }

  beforeAll(() => {
    db = createDb(process.env.DATABASE_URL!);
    prisma = db.prisma;
    system = asSystem(prisma);
    const deps = {
      prisma,
      env: {
        agentRuntime: "scripted",
        defaultProvider: "fake",
        defaultModel: "fake-model",
        webOrigin: "https://app.example.test",
        screenProxySecret: "fake-test-secret",
        sandboxProvider: "fake",
      },
      dataDir: "/tmp/rakazo-shared-content-test",
    } as unknown as RouterDeps;
    // As the app does, so domain errors answer with their own status.
    handler = new RPCHandler(createRouter(deps), {
      clientInterceptors: [
        onError((error, { path, signal }) => handleRpcError(error, path, signal)),
      ],
    });
  });

  afterAll(async () => {
    if (!prisma) return;
    await system.organization.deleteMany({
      where: { id: { in: organizations } },
    });
    await system.user.deleteMany({ where: { id: { in: users } } });
    await prisma.$disconnect();
    await db.pool.end();
  });

  it("shows one member's bots, chats, memory and routines to another, but not their own things", async () => {
    const ownerHome = await person("owner");
    const partnerHome = await person("partner");
    const spaceId = randomUUID();
    await system.space.create({
      data: {
        id: spaceId,
        organizationId: ownerHome.spaceId,
        name: "Home",
        createdByUserId: ownerHome.userId,
      },
    });
    await join(spaceId, ownerHome.spaceId, ownerHome.userId, "owner");
    await join(spaceId, ownerHome.spaceId, partnerHome.userId, "member");
    const owner: Actor = { ...ownerHome, spaceId };
    const partner: Actor = { ...partnerHome, spaceId };

    const repos = createRepos(prisma);
    const newBot = (actor: Actor, name: string) =>
      runAsTenant(actor, () =>
        repos.createBot(actor, {
          name,
          description: "",
          instructions: "",
          notifyOnFinish: false,
        }),
      );
    const chef = await newBot(owner, "Chef");
    const planner = await newBot(owner, "Planner");
    const privateBot = await newBot(ownerHome, "Diary");
    const group = await runAsTenant(owner, () =>
      createGroupRepos(prisma).createGroup(owner, {
        name: "Kitchen",
        botIds: [chef.id, planner.id],
      }),
    );
    await runAsTenant(owner, () =>
      new MarkdownMemoryStore(prisma).commit(
        {
          scope: "bot",
          botId: chef.id,
          path: "pantry.md",
          content: "Out of basil",
        },
        {
          operationId: "fixture",
          traceId: "fixture",
          spaceId,
          userId: owner.userId,
          signal: new AbortController().signal,
        },
      ),
    );
    await system.routine.create({
      data: {
        spaceId,
        botId: chef.id,
        userId: owner.userId,
        name: "Meal plan",
        prompt: "Plan",
        crons: [],
      },
    });
    await system.connection.create({
      data: {
        spaceId,
        userId: owner.userId,
        provider: "gmail",
        displayName: "Owner mail",
        status: "connected",
      },
    });
    // The owner's account vault, which every Space they belong to uses.
    await system.vaultCredential.create({
      data: {
        id: randomUUID(),
        userId: owner.userId,
        spaceId: null,
        name: "pantry-api",
        origin: "https://pantry.example.test",
        auth: { type: "bearer" },
        ciphertext: "fake-ciphertext",
      },
    });

    const bots = await call(partner, "bots/list");
    expect(bots.status).toBe(200);
    expect((bots.json as Array<{ id: string }>).map((bot) => bot.id).sort()).toEqual(
      [chef.id, planner.id].sort(),
    );
    expect((await call(partner, "bots/get", { botId: chef.id })).status).toBe(200);
    const groups = await call(partner, "groups/list");
    expect((groups.json as Array<{ id: string }>).map((row) => row.id)).toEqual([group.id]);
    const memory = await call(partner, "memory/list", { botId: chef.id });
    expect((memory.json as Array<{ path: string }>).map((doc) => doc.path)).toContain("pantry.md");
    const routines = await call(partner, "routines/list", { botId: chef.id });
    expect((routines.json as Array<{ name: string }>).map((routine) => routine.name)).toEqual([
      "Meal plan",
    ]);

    // The partner's message runs as the partner, in the owner's bot's chat.
    const enqueue = vi.fn().mockResolvedValue(undefined);
    const notify = vi.fn().mockResolvedValue(undefined);
    await runAsTenant(partner, async () => {
      const target = await resolveThreadTarget(prisma, partner, {
        botId: chef.id,
      });
      await sendThreadMessage(
        {
          prisma,
          events: { notify } as never,
          jobs: { enqueue } as never,
          sandbox: {} as never,
        },
        partner,
        target,
        { text: "Buy basil", clientNonce: randomUUID() },
      );
    });
    const run = await system.run.findFirstOrThrow({
      where: { botId: chef.id },
    });
    expect(run.userId).toBe(partner.userId);
    expect(enqueue).toHaveBeenCalled();

    // Personal things stay with their person.
    expect((await call(partner, "connections/list")).json).toEqual([]);
    expect((await call(owner, "connections/list")).json).toHaveLength(1);
    expect((await call(partner, "botSecrets/list", { botId: chef.id })).json).toEqual([]);
    expect((await call(owner, "botSecrets/list", { botId: chef.id })).json).toHaveLength(1);

    // Another space's bots stay out of reach.
    expect((await call(partner, "bots/get", { botId: privateBot.id })).status).not.toBe(200);
    const partnerOwnBots = await call(partnerHome, "bots/list");
    expect(partnerOwnBots.json).toEqual([]);

    // A member can archive the owner's bot but not delete it for good.
    expect(
      (
        await call(partner, "bots/remove", {
          botId: chef.id,
          deleteMemories: false,
        })
      ).status,
    ).toBe(403);
  });
});
