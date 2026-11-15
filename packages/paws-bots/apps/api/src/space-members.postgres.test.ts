import { createHash, randomUUID } from "node:crypto";
import { onError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { finishRoutineHandover, listVaultItems } from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import {
  asSystem,
  claimSpacesLeavingWithAccount,
  computerHomeKey,
  createDb,
  createThreadEvents,
  ensureComputerRecord,
  installAuditEventStore,
  leaveInvitedSpaces,
  MAX_OPEN_SPACE_INVITES,
  organizationForMember,
  organizationSeatCount,
  personalOrganizationIds,
  recordAuditEvent,
  runAsTenant,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";
import { handleRpcError } from "./rpc-errors.js";

const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe : describe.skip;

const webOrigin = "https://app.example.test";

describePostgres("shared spaces: invites and membership (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let prisma: PrismaClient;
  let system: PrismaClient;
  let handler: RPCHandler<Record<string, unknown>>;
  const syncSeats = vi.fn(async (_organizationId: string) => undefined);
  const cancelJob = vi.fn(async (_key: string) => undefined);
  const enqueueJob = vi.fn(async (_job: { name: string; payload: unknown }) => undefined);
  const notify = vi.fn(async (_threadId: string, _seq: number) => undefined);
  const users: string[] = [];
  const organizations: string[] = [];

  type Person = { id: string; organizationId: string; spaceId: string; actor: Actor };

  async function person(name: string): Promise<Person> {
    const id = `shared-${name}-${randomUUID()}`;
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
      data: { id: `m-${id}`, organizationId: id, userId: id, role: "owner", createdAt },
    });
    await system.space.create({
      data: { id, organizationId: id, name: "Personal", isDefault: true, createdByUserId: id },
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
      id,
      organizationId: id,
      spaceId: id,
      actor: { userId: id, spaceId: id, email: `${id}@example.test`, isDeploymentOwner: false },
    };
  }

  async function sharedSpace(owner: Person, name: string): Promise<string> {
    const spaceId = randomUUID();
    await system.space.create({
      data: { id: spaceId, organizationId: owner.organizationId, name, createdByUserId: owner.id },
    });
    await system.spaceMember.create({
      data: {
        id: randomUUID(),
        spaceId,
        organizationId: owner.organizationId,
        userId: owner.id,
        role: "owner",
        createdAt: new Date(),
      },
    });
    return spaceId;
  }

  async function call(actor: Actor, path: string, input: unknown) {
    const { response } = await handler.handle(
      new Request(`http://127.0.0.1/rpc/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: input }),
      }),
      { prefix: "/rpc", context: { actor } },
    );
    const body = (await response!.json()) as { json: Record<string, unknown> };
    return { status: response!.status, json: body.json };
  }

  async function invite(owner: Person, spaceId: string): Promise<string> {
    const created = await call(owner.actor, "spaces/invites/create", { spaceId });
    expect(created.status).toBe(200);
    return new URL(created.json.url as string).pathname.split("/").at(-1)!;
  }

  function inSpace(actor: Actor, spaceId: string): Actor {
    return { ...actor, spaceId };
  }

  beforeAll(async () => {
    db = createDb(process.env.DATABASE_URL!);
    prisma = db.prisma;
    system = asSystem(prisma);
    installAuditEventStore(prisma);
    const deps = {
      prisma,
      billing: { syncSeats },
      jobs: { cancel: cancelJob, enqueue: enqueueJob },
      events: { ...createThreadEvents(prisma), notify },
      env: {
        agentRuntime: "scripted",
        defaultProvider: "fake",
        defaultModel: "fake-model",
        webOrigin,
        screenProxySecret: "fake-test-secret",
        sandboxProvider: "fake",
      },
      dataDir: "/tmp/rakazo-shared-spaces-test",
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
    await system.organization.deleteMany({ where: { id: { in: organizations } } });
    await system.user.deleteMany({ where: { id: { in: users } } });
    await prisma.$disconnect();
    await db.pool.end();
  });

  it("joins a shared space through a single-use link", async () => {
    const owner = await person("owner");
    const invitee = await person("invitee");
    const stranger = await person("stranger");
    const home = await sharedSpace(owner, "Home");

    const created = await call(owner.actor, "spaces/invites/create", { spaceId: home });
    expect(created.status).toBe(200);
    const url = new URL(created.json.url as string);
    expect(url.origin).toBe(webOrigin);
    expect(url.pathname).toMatch(/^\/invite\/[A-Za-z0-9_-]{43}$/);
    const token = url.pathname.split("/").at(-1)!;
    const stored = await system.spaceInvite.findFirstOrThrow({ where: { spaceId: home } });
    expect(stored.tokenHash).toBe(createHash("sha256").update(token).digest("hex"));
    expect(stored.tokenHash).not.toContain(token);
    const expiresIn = new Date(created.json.expiresAt as string).getTime() - Date.now();
    expect(expiresIn).toBeGreaterThan(6.9 * 24 * 3600_000);
    expect(expiresIn).toBeLessThanOrEqual(7 * 24 * 3600_000);

    const preview = await call(invitee.actor, "spaces/invites/preview", { token });
    expect(preview.json).toEqual({
      spaceId: home,
      spaceName: "Home",
      inviterName: "owner",
      alreadyMember: false,
    });

    const accepted = await call(invitee.actor, "spaces/invites/accept", { token });
    expect(accepted).toEqual({ status: 200, json: { spaceId: home } });
    // A guest adds no seat to the owner's subscription.
    expect(syncSeats).not.toHaveBeenCalled();
    await expect(
      system.spaceMember.findUnique({
        where: { spaceId_userId: { spaceId: home, userId: invitee.id } },
      }),
    ).resolves.toMatchObject({ role: "member", organizationId: owner.organizationId });
    await expect(
      system.member.findUnique({
        where: {
          organizationId_userId: { organizationId: owner.organizationId, userId: invitee.id },
        },
      }),
    ).resolves.toMatchObject({ role: "guest" });
    // Joining one Space never opens the owner's personal default Space.
    await expect(
      system.spaceMember.findUnique({
        where: { spaceId_userId: { spaceId: owner.spaceId, userId: invitee.id } },
      }),
    ).resolves.toBeNull();

    // Reopening the used link is harmless for the person who used it.
    await expect(call(invitee.actor, "spaces/invites/accept", { token })).resolves.toEqual({
      status: 200,
      json: { spaceId: home },
    });
    await expect(call(invitee.actor, "spaces/invites/preview", { token })).resolves.toMatchObject({
      json: { alreadyMember: true },
    });
    // Anyone else gets the same answer as for an unknown link.
    expect((await call(stranger.actor, "spaces/invites/accept", { token })).status).toBe(404);
    expect((await call(stranger.actor, "spaces/invites/preview", { token })).status).toBe(404);
    expect(
      (await call(stranger.actor, "spaces/invites/preview", { token: "not-a-real-token" })).status,
    ).toBe(404);
    await expect(
      system.spaceMember.findUnique({
        where: { spaceId_userId: { spaceId: home, userId: stranger.id } },
      }),
    ).resolves.toBeNull();

    const events = await system.auditEvent.findMany({
      where: { spaceId: home },
      select: { action: true, metadata: true },
    });
    expect(events.map((event) => event.action).sort()).toEqual([
      "space.invite.created",
      "space.member.joined",
    ]);
    expect(JSON.stringify(events)).not.toContain(token);

    const list = await call(inSpace(invitee.actor, home), "spaces/members/list", {
      spaceId: home,
    });
    expect(list.json).toMatchObject({
      canManage: false,
      members: [
        { userId: owner.id, role: "owner", name: "owner" },
        { userId: invitee.id, role: "member", name: "invitee" },
      ],
    });
    expect((await call(stranger.actor, "spaces/members/list", { spaceId: home })).status).toBe(404);
  });

  it("rejects expired links", async () => {
    const owner = await person("owner");
    const invitee = await person("invitee");
    const home = await sharedSpace(owner, "Home");
    const token = await invite(owner, home);
    await system.spaceInvite.updateMany({
      where: { spaceId: home },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect((await call(invitee.actor, "spaces/invites/preview", { token })).status).toBe(404);
    expect((await call(invitee.actor, "spaces/invites/accept", { token })).status).toBe(404);
  });

  it("keeps inviting, removing and leaving to the right people", async () => {
    const owner = await person("owner");
    const invitee = await person("invitee");
    const third = await person("third");
    const home = await sharedSpace(owner, "Home");
    await call(invitee.actor, "spaces/invites/accept", { token: await invite(owner, home) });
    await call(third.actor, "spaces/invites/accept", { token: await invite(owner, home) });

    const member = inSpace(invitee.actor, home);
    expect((await call(member, "spaces/invites/create", { spaceId: home })).status).toBe(403);
    expect(
      (await call(member, "spaces/members/remove", { spaceId: home, userId: third.id })).status,
    ).toBe(403);
    expect(
      (await call(member, "spaces/members/remove", { spaceId: home, userId: owner.id })).status,
    ).toBe(403);
    // Not a member at all: the Space does not exist for them.
    expect(
      (await call(third.actor, "spaces/invites/create", { spaceId: owner.spaceId })).status,
    ).toBe(404);

    const ownerInHome = inSpace(owner.actor, home);
    expect((await call(ownerInHome, "spaces/members/leave", { spaceId: home })).status).toBe(400);
    expect(
      (await call(ownerInHome, "spaces/members/remove", { spaceId: home, userId: owner.id }))
        .status,
    ).toBe(400);
    expect((await call(ownerInHome, "spaces/members/list", { spaceId: home })).json).toMatchObject({
      canManage: true,
    });

    const left = await call(member, "spaces/members/leave", { spaceId: home });
    expect(left).toEqual({ status: 200, json: { ok: true, activeSpaceId: invitee.spaceId } });
    await expect(
      system.member.findUnique({
        where: {
          organizationId_userId: { organizationId: owner.organizationId, userId: invitee.id },
        },
      }),
    ).resolves.toBeNull();
    // Leaving a Space other than the open one keeps the open one.
    const fromElsewhere = await call(third.actor, "spaces/members/leave", { spaceId: home });
    expect(fromElsewhere.json).toEqual({ ok: true, activeSpaceId: third.spaceId });
  });

  it("hands a removed member's bots and routines to the owner and deletes what was theirs", async () => {
    const owner = await person("owner");
    const invitee = await person("invitee");
    const home = await sharedSpace(owner, "Home");
    await call(invitee.actor, "spaces/invites/accept", { token: await invite(owner, home) });

    const ownerSection = await system.botSection.create({
      data: { spaceId: home, userId: owner.id, name: "Family", position: 0 },
    });
    const mergedSection = await system.botSection.create({
      data: { spaceId: home, userId: invitee.id, name: "Family" },
    });
    const movedSection = await system.botSection.create({
      data: { spaceId: home, userId: invitee.id, name: "Trips" },
    });
    const computer = await system.computer.create({
      data: {
        spaceId: home,
        userId: invitee.id,
        scopeKey: `team:${home}:${invitee.id}`,
        homeKey: computerHomeKey({ mode: "team", spaceId: home, userId: invitee.id }),
        kind: "docker",
      },
    });
    const dedicated = await system.computer.create({
      data: {
        spaceId: home,
        userId: invitee.id,
        scope: "dedicated",
        scopeKey: `bot:dedicated-${invitee.id}`,
        homeKey: `dedicated-${invitee.id}`,
        kind: "docker",
      },
    });
    const bot = await system.bot.create({
      data: {
        spaceId: home,
        userId: invitee.id,
        name: "Planner",
        color: "test",
        sectionId: mergedSection.id,
        computerId: computer.id,
      },
    });
    const group = await system.chatGroup.create({
      data: { spaceId: home, userId: invitee.id, name: "Weekend", sectionId: movedSection.id },
    });
    const routine = await system.routine.create({
      data: {
        spaceId: home,
        botId: bot.id,
        userId: invitee.id,
        name: "Groceries",
        prompt: "List groceries",
        crons: ["0 9 * * 1"],
        watchState: { fingerprint: "invitee-account" },
        accountFailures: 3,
      },
    });
    const secret = await system.secret.create({
      data: { userId: invitee.id, spaceId: home, kind: "connection", ciphertext: "fake" },
    });
    await system.connection.create({
      data: {
        spaceId: home,
        userId: invitee.id,
        provider: "gmail",
        displayName: "Gmail",
        status: "connected",
        secretId: secret.id,
      },
    });
    await system.botSecret.create({
      data: {
        id: randomUUID(),
        userId: invitee.id,
        spaceId: home,
        botId: bot.id,
        name: "API_KEY",
        origin: "https://api.example.test",
        auth: {},
        ciphertext: "fake",
      },
    });
    const server = await system.mcpServer.create({
      data: { spaceId: home, userId: invitee.id, slug: "notes", name: "Notes", transport: "http" },
    });
    await system.botMcpServer.create({
      data: { spaceId: home, botId: bot.id, serverId: server.id, userId: invitee.id },
    });
    await system.actionApprovalRule.create({
      data: {
        spaceId: home,
        createdByUserId: invitee.id,
        effect: "allow",
        matchKind: "tool",
        matchValue: "send_email",
      },
    });
    await system.notificationPreference.create({ data: { spaceId: home, userId: invitee.id } });
    // An item of their account vault limited here to a bot; the item stays theirs.
    const item = await system.vaultCredential.create({
      data: {
        id: randomUUID(),
        userId: invitee.id,
        spaceId: null,
        name: "pantry-api",
        origin: "https://pantry.example.test",
        auth: { type: "bearer" },
        ciphertext: "fake-ciphertext",
      },
    });
    const limited = { credentialId: item.id, spaceId: home, userId: invitee.id };
    await system.vaultCredentialLimit.create({ data: limited });
    await system.vaultCredentialBot.create({ data: { ...limited, botId: bot.id } });
    // Their own Space is not touched.
    const ownConnection = await system.connection.create({
      data: {
        spaceId: invitee.spaceId,
        userId: invitee.id,
        provider: "gmail",
        displayName: "Gmail",
        status: "connected",
      },
    });

    const removed = await call(inSpace(owner.actor, home), "spaces/members/remove", {
      spaceId: home,
      userId: invitee.id,
    });
    expect(removed).toEqual({ status: 200, json: { ok: true } });

    await expect(system.bot.findUniqueOrThrow({ where: { id: bot.id } })).resolves.toMatchObject({
      userId: owner.id,
      sectionId: ownerSection.id,
    });
    await expect(
      system.chatGroup.findUniqueOrThrow({ where: { id: group.id } }),
    ).resolves.toMatchObject({ userId: owner.id, sectionId: movedSection.id });
    await expect(
      system.routine.findUniqueOrThrow({ where: { id: routine.id } }),
    ).resolves.toMatchObject({
      userId: owner.id,
      active: false,
      nextRunAt: null,
      watchState: null,
      accountFailures: 0,
    });
    await expect(
      system.botSection.findUnique({ where: { id: mergedSection.id } }),
    ).resolves.toBeNull();
    await expect(
      system.botSection.findUniqueOrThrow({ where: { id: movedSection.id } }),
    ).resolves.toMatchObject({ userId: owner.id, position: 1 });

    const leftover = { spaceId: home, userId: invitee.id };
    // The computer goes with the bot, so it no longer counts toward the member's limit.
    await expect(
      system.computer.findUniqueOrThrow({ where: { id: computer.id } }),
    ).resolves.toMatchObject({
      userId: owner.id,
      homeKey: computer.homeKey,
      scopeKey: `transferred:${computer.id}`,
    });
    // A dedicated computer is found by its bot, so only its owner changes.
    await expect(
      system.computer.findUniqueOrThrow({ where: { id: dedicated.id } }),
    ).resolves.toMatchObject({ userId: owner.id, scopeKey: dedicated.scopeKey });
    // Coming back later gives the person a computer of their own, counted for them.
    const returning = await ensureComputerRecord(system, {
      mode: "team",
      spaceId: home,
      userId: invitee.id,
      kind: "docker",
    });
    expect(returning.id).not.toBe(computer.id);
    expect(returning.userId).toBe(invitee.id);
    // The handed-over computer keeps its home, so theirs is a new one.
    expect(returning.homeKey).not.toBe(computer.homeKey);
    await expect(system.connection.count({ where: leftover })).resolves.toBe(0);
    await expect(system.secret.count({ where: leftover })).resolves.toBe(0);
    await expect(system.botSecret.count({ where: leftover })).resolves.toBe(0);
    await expect(system.mcpServer.count({ where: leftover })).resolves.toBe(0);
    await expect(system.botMcpServer.count({ where: leftover })).resolves.toBe(0);
    await expect(system.notificationPreference.count({ where: leftover })).resolves.toBe(0);
    // The bots they chose here go with the bots, but the item stays limited here.
    await expect(system.vaultCredentialLimit.count({ where: leftover })).resolves.toBe(1);
    await expect(system.vaultCredentialBot.count({ where: leftover })).resolves.toBe(0);
    await expect(
      system.vaultCredential.findUnique({ where: { id: item.id } }),
    ).resolves.not.toBeNull();
    await expect(
      system.actionApprovalRule.count({ where: { spaceId: home, createdByUserId: invitee.id } }),
    ).resolves.toBe(0);
    await expect(
      system.spaceMember.count({ where: { spaceId: home, userId: invitee.id } }),
    ).resolves.toBe(0);
    await expect(
      system.connection.findUnique({ where: { id: ownConnection.id } }),
    ).resolves.not.toBeNull();
    await expect(
      system.auditEvent.count({ where: { spaceId: home, action: "space.member.removed" } }),
    ).resolves.toBe(1);

    // Rejoining doesn't open the item to every bot: it stays limited here, to none of them.
    await call(invitee.actor, "spaces/invites/accept", { token: await invite(owner, home) });
    const fresh = await system.bot.create({
      data: { spaceId: home, userId: invitee.id, name: "Shopper", color: "test" },
    });
    const items = (botId?: string) =>
      runAsTenant({ userId: invitee.id, spaceId: home }, () =>
        listVaultItems(
          prisma,
          { load: async () => "" },
          { userId: invitee.id, spaceId: home, ...(botId && { botId }) },
          undefined,
          false,
        ),
      );
    expect(await items()).toEqual([
      expect.objectContaining({ name: "pantry-api", allBots: false, botIds: [] }),
    ]);
    expect(await items(fresh.id)).toEqual([]);
  });

  it("cancels a removed member's unfinished runs so nothing keeps running as them", async () => {
    const owner = await person("owner");
    const invitee = await person("invitee");
    const home = await sharedSpace(owner, "Home");
    await call(invitee.actor, "spaces/invites/accept", { token: await invite(owner, home) });

    const bot = await system.bot.create({
      data: { spaceId: home, userId: owner.id, name: "Helper", color: "test" },
    });
    const thread = await system.thread.create({
      data: { spaceId: home, botId: bot.id, userId: owner.id },
    });
    async function runAs(userId: string, status: string) {
      const task = await system.task.create({
        data: { spaceId: home, botId: bot.id, threadId: thread.id, userId, prompt: "Hi", status },
      });
      return system.run.create({
        data: {
          spaceId: home,
          botId: bot.id,
          threadId: thread.id,
          taskId: task.id,
          userId,
          status,
          trigger: "user",
          ...(status === "running"
            ? { leaseOwner: "worker-1", leaseExpiresAt: new Date(Date.now() + 60_000) }
            : {}),
        },
      });
    }
    const queued = await runAs(invitee.id, "queued");
    const running = await runAs(invitee.id, "running");
    const ownersRun = await runAs(owner.id, "queued");

    const removed = await call(inSpace(owner.actor, home), "spaces/members/remove", {
      spaceId: home,
      userId: invitee.id,
    });
    expect(removed).toEqual({ status: 200, json: { ok: true } });

    for (const run of [queued, running]) {
      await expect(system.run.findUniqueOrThrow({ where: { id: run.id } })).resolves.toMatchObject({
        status: "cancelled",
        leaseOwner: null,
      });
      await expect(
        system.task.findUniqueOrThrow({ where: { id: run.taskId } }),
      ).resolves.toMatchObject({ status: "cancelled" });
      expect(cancelJob).toHaveBeenCalledWith(expect.stringContaining(run.id));
    }
    await expect(
      system.run.findUniqueOrThrow({ where: { id: ownersRun.id } }),
    ).resolves.toMatchObject({ status: "queued" });
    await expect(
      system.event.count({ where: { threadId: thread.id, type: "run.cancelled" } }),
    ).resolves.toBe(2);
    expect(notify).toHaveBeenCalledWith(thread.id, expect.any(Number));
  });

  it("answers another member's waiting message once the busy member is removed", async () => {
    const owner = await person("owner");
    const busy = await person("busy");
    const waiting = await person("waiting");
    const home = await sharedSpace(owner, "Home");
    await call(busy.actor, "spaces/invites/accept", { token: await invite(owner, home) });
    await call(waiting.actor, "spaces/invites/accept", { token: await invite(owner, home) });

    const bot = await system.bot.create({
      data: { spaceId: home, userId: owner.id, name: "Helper", color: "test" },
    });
    const thread = await system.thread.create({
      data: { spaceId: home, botId: bot.id, userId: owner.id },
    });
    const task = await system.task.create({
      data: {
        spaceId: home,
        botId: bot.id,
        threadId: thread.id,
        userId: busy.id,
        prompt: "Hi",
        status: "running",
      },
    });
    const running = await system.run.create({
      data: {
        spaceId: home,
        botId: bot.id,
        threadId: thread.id,
        taskId: task.id,
        userId: busy.id,
        status: "running",
        trigger: "user",
        leaseOwner: "worker-1",
        leaseExpiresAt: new Date(Date.now() + 60_000),
      },
    });
    async function pendingMessage(userId: string, seq: number) {
      const message = await system.message.create({
        data: {
          threadId: thread.id,
          seq,
          role: "user",
          authorUserId: userId,
          blocks: [{ kind: "text", text: "Also this" }],
        },
      });
      await system.steeringMessage.create({
        data: { messageId: message.id, botId: bot.id, userId },
      });
      return message;
    }
    await pendingMessage(busy.id, 1);
    const waitingMessage = await pendingMessage(waiting.id, 2);

    const removed = await call(inSpace(owner.actor, home), "spaces/members/remove", {
      spaceId: home,
      userId: busy.id,
    });
    expect(removed).toEqual({ status: 200, json: { ok: true } });

    await expect(
      system.run.findUniqueOrThrow({ where: { id: running.id } }),
    ).resolves.toMatchObject({ status: "cancelled" });
    const continuation = await system.run.findFirstOrThrow({
      where: { threadId: thread.id, status: "queued" },
    });
    expect(continuation).toMatchObject({
      userId: waiting.id,
      sourceMessageId: waitingMessage.id,
    });
    await expect(
      system.steeringMessage.findMany({
        where: { message: { threadId: thread.id } },
        select: { userId: true, runId: true },
      }),
    ).resolves.toEqual([{ userId: waiting.id, runId: continuation.id }]);
    expect(enqueueJob).toHaveBeenCalledWith(
      expect.objectContaining({ name: "run.continue", payload: { runId: continuation.id } }),
    );
  });

  it("lists shared spaces across organizations and creates new spaces in the member's own", async () => {
    const owner = await person("owner");
    const invitee = await person("invitee");
    const home = await sharedSpace(owner, "Home");
    await call(invitee.actor, "spaces/invites/accept", { token: await invite(owner, home) });

    const listed = await call(invitee.actor, "spaces/list", {});
    expect(listed.status).toBe(200);
    const spaces = listed.json.spaces as Array<Record<string, unknown>>;
    expect(spaces.find((space) => space.id === invitee.spaceId)).toMatchObject({
      shared: false,
      isDefault: true,
      canRename: true,
    });
    expect(spaces.find((space) => space.id === home)).toMatchObject({
      name: "Home",
      shared: true,
      isDefault: false,
      canRename: false,
      canDelete: false,
    });
    // From inside the shared Space, the member still sees their own Spaces around it, and the
    // owner's organization stays out of their switcher.
    const fromShared = await call(inSpace(invitee.actor, home), "spaces/list", {});
    expect(
      (fromShared.json.spaces as Array<{ id: string }>).map((space) => space.id).sort(),
    ).toEqual([home, invitee.spaceId].sort());
    const organizationList = await call(inSpace(invitee.actor, home), "organizations/list", {});
    expect(organizationList.json).toMatchObject({
      activeOrganizationId: invitee.organizationId,
      organizations: [expect.objectContaining({ id: invitee.organizationId })],
    });
    expect(organizationList.json.organizations).toHaveLength(1);
    // The shared Space counts as one of theirs, so losing a request's session never drops it.
    expect(
      (organizationList.json.organizations as Array<{ spaceIds: string[] }>)[0]!.spaceIds,
    ).toContain(home);
    const ownerList = await call(owner.actor, "spaces/list", {});
    expect(
      (ownerList.json.spaces as Array<Record<string, unknown>>).find((space) => space.id === home),
    ).toMatchObject({ shared: true, canRename: true, canDelete: true });

    // Creating while the shared Space is open still lands in the member's own organization.
    const created = await call(inSpace(invitee.actor, home), "spaces/create", { name: "Work" });
    expect(created.status).toBe(200);
    await expect(
      system.space.findUniqueOrThrow({ where: { id: created.json.id as string } }),
    ).resolves.toMatchObject({ organizationId: invitee.organizationId });
  });

  it("deletes an owner's shared spaces with the account and hands a leaving member's bots over", async () => {
    const owner = await person("owner");
    const invitee = await person("invitee");
    const home = await sharedSpace(owner, "Home");
    await call(invitee.actor, "spaces/invites/accept", { token: await invite(owner, home) });
    const bot = await system.bot.create({
      data: { spaceId: home, userId: invitee.id, name: "Planner", color: "test" },
    });

    // An account that is active again (reactivated while it was leaving) stays.
    await expect(
      leaveInvitedSpaces(prisma, invitee.id, async () => undefined, { deactivated: true }),
    ).resolves.toEqual([]);
    expect(await system.spaceMember.count({ where: { spaceId: home, userId: invitee.id } })).toBe(
      1,
    );

    // The invitee deletes their account first: their bot stays in the shared Space.
    await expect(personalOrganizationIds(prisma, invitee.id)).resolves.toEqual([
      invitee.organizationId,
    ]);
    await expect(leaveInvitedSpaces(prisma, invitee.id, async () => undefined)).resolves.toEqual([
      expect.objectContaining({ spaceId: home }),
    ]);
    await expect(system.bot.findUniqueOrThrow({ where: { id: bot.id } })).resolves.toMatchObject({
      userId: owner.id,
    });

    const other = await person("other");
    await call(other.actor, "spaces/invites/accept", { token: await invite(owner, home) });
    await expect(leaveInvitedSpaces(prisma, owner.id, async () => undefined)).resolves.toEqual([]);
    const ownedOrganizationIds = await personalOrganizationIds(prisma, owner.id);
    expect(ownedOrganizationIds).toEqual([owner.organizationId]);
    await system.organization.deleteMany({ where: { id: { in: ownedOrganizationIds } } });
    await expect(system.space.findUnique({ where: { id: home } })).resolves.toBeNull();
    await expect(
      system.member.count({ where: { organizationId: owner.organizationId } }),
    ).resolves.toBe(0);
    // The other member keeps their own Space.
    await expect(system.space.findUnique({ where: { id: other.spaceId } })).resolves.not.toBeNull();
  });

  it("hands a co-owner's content over when the organization outlives their account", async () => {
    const owner = await person("owner");
    const coOwner = await person("co-owner");
    const home = await sharedSpace(owner, "Home");
    await call(coOwner.actor, "spaces/invites/accept", { token: await invite(owner, home) });
    // An owner of the organization, but only a member of this Space.
    await system.member.updateMany({
      where: { organizationId: owner.organizationId, userId: coOwner.id },
      data: { role: "owner" },
    });
    const bot = await system.bot.create({
      data: { spaceId: home, userId: coOwner.id, name: "Planner", color: "test" },
    });

    const departures = await leaveInvitedSpaces(prisma, coOwner.id, async () => undefined);

    await expect(personalOrganizationIds(prisma, coOwner.id)).resolves.not.toContain(
      owner.organizationId,
    );
    expect(departures.map((departure) => departure.spaceId)).toEqual([home]);
    await expect(system.bot.findUniqueOrThrow({ where: { id: bot.id } })).resolves.toMatchObject({
      userId: owner.id,
    });
  });
  it("bills, seats and audits a guest under their own organization", async () => {
    const owner = await person("owner");
    const invitee = await person("invitee");
    const home = await sharedSpace(owner, "Home");
    await call(invitee.actor, "spaces/invites/accept", { token: await invite(owner, home) });

    await expect(
      organizationForMember(system, { spaceId: home, userId: invitee.id }),
    ).resolves.toEqual({ organizationId: invitee.organizationId, isOwner: true });
    await expect(
      organizationForMember(system, { spaceId: home, userId: owner.id }),
    ).resolves.toEqual({ organizationId: owner.organizationId, isOwner: true });
    await expect(organizationSeatCount(system, owner.organizationId)).resolves.toBe(1);

    await recordAuditEvent({ action: "auth.sign_in", actor: { type: "user", id: invitee.id } });
    await expect(
      system.auditEvent.count({
        where: {
          actorId: invitee.id,
          action: "auth.sign_in",
          organizationId: owner.organizationId,
        },
      }),
    ).resolves.toBe(0);
    await expect(
      system.auditEvent.count({
        where: {
          actorId: invitee.id,
          action: "auth.sign_in",
          organizationId: invitee.organizationId,
        },
      }),
    ).resolves.toBe(1);
  });

  it("cancels unused invite links, and only the owner can", async () => {
    const owner = await person("owner");
    const invitee = await person("invitee");
    const stranger = await person("stranger");
    const home = await sharedSpace(owner, "Home");
    const used = await invite(owner, home);
    await call(invitee.actor, "spaces/invites/accept", { token: used });
    const leaked = await invite(owner, home);
    await expect(
      call(invitee.actor, "spaces/members/list", { spaceId: home }),
    ).resolves.toMatchObject({ json: { openInvites: 0 } });
    await expect(
      call(owner.actor, "spaces/members/list", { spaceId: home }),
    ).resolves.toMatchObject({
      json: { openInvites: 1 },
    });

    await expect(
      call(inSpace(invitee.actor, home), "spaces/invites/cancel", { spaceId: home }),
    ).resolves.toMatchObject({ status: 403 });
    await expect(call(owner.actor, "spaces/invites/cancel", { spaceId: home })).resolves.toEqual({
      status: 200,
      json: { ok: true },
    });
    await expect(
      call(stranger.actor, "spaces/invites/accept", { token: leaked }),
    ).resolves.toMatchObject({ status: 404 });
    // A link someone already used still lets them back into what they joined.
    await expect(
      call(invitee.actor, "spaces/invites/preview", { token: used }),
    ).resolves.toMatchObject({ json: { alreadyMember: true } });
  });

  it("caps open invite links per space", async () => {
    const owner = await person("owner");
    const home = await sharedSpace(owner, "Home");
    for (let index = 0; index < MAX_OPEN_SPACE_INVITES; index += 1) await invite(owner, home);
    await expect(
      call(owner.actor, "spaces/invites/create", { spaceId: home }),
    ).resolves.toMatchObject({ status: 400 });
    // Nor does a Space being deleted hand out a link that cannot be opened.
    const leaving = await sharedSpace(owner, "Leaving");
    await system.space.update({ where: { id: leaving }, data: { deletingAt: new Date() } });
    await expect(
      call(owner.actor, "spaces/invites/create", { spaceId: leaving }),
    ).resolves.toMatchObject({ status: 404 });
  });

  it("never hands one member's computer control to another", async () => {
    const owner = await person("owner");
    const invitee = await person("invitee");
    const home = await sharedSpace(owner, "Home");
    await call(invitee.actor, "spaces/invites/accept", { token: await invite(owner, home) });
    const computer = await system.computer.create({
      data: {
        spaceId: home,
        userId: owner.id,
        scopeKey: `team:${home}:${owner.id}`,
        homeKey: computerHomeKey({ mode: "team", spaceId: home, userId: owner.id }),
        kind: "docker",
        state: "running",
        providerRef: "fake-ref",
      },
    });
    const bot = await system.bot.create({
      data: {
        spaceId: home,
        userId: owner.id,
        name: "Shopper",
        color: "test",
        computerId: computer.id,
      },
    });
    await system.computer.update({
      where: { id: computer.id },
      data: {
        controlHolder: "user",
        controlLeaseId: randomUUID(),
        controlLeaseExpiresAt: new Date(Date.now() + 60_000),
        controlBotId: bot.id,
        controlUserId: owner.id,
      },
    });
    const asInvitee = inSpace(invitee.actor, home);

    // The invitee is told someone else has control; the holder is not.
    await expect(call(asInvitee, "computer/status", { botId: bot.id })).resolves.toMatchObject({
      status: 200,
      json: { controlHolder: "user", controlledByOther: true },
    });
    const ownerStatus = await call(inSpace(owner.actor, home), "computer/status", {
      botId: bot.id,
    });
    expect(ownerStatus.json).not.toHaveProperty("controlledByOther");
    await expect(call(asInvitee, "computer/takeover", { botId: bot.id })).resolves.toMatchObject({
      status: 409,
    });
    // Handing back a screen someone else holds changes nothing.
    await expect(call(asInvitee, "computer/release", { botId: bot.id })).resolves.toMatchObject({
      status: 200,
    });
    // Nor can stopping or resetting the computer under them.
    for (const procedure of ["computer/stop", "computer/reset"]) {
      await expect(call(asInvitee, procedure, { botId: bot.id })).resolves.toMatchObject({
        status: 409,
      });
    }
    // Teaching cannot take the owner's screen either.
    await expect(
      call(asInvitee, "skills/start", { botId: bot.id, goal: "Book a table" }),
    ).resolves.toMatchObject({ status: 409 });
    // Watching is shared; typing into the owner's session is not.
    await expect(
      call(asInvitee, "computer/input", { botId: bot.id, kind: "key", payload: { key: "a" } }),
    ).resolves.toMatchObject({ status: 403 });
    await expect(
      system.computer.findUniqueOrThrow({ where: { id: computer.id } }),
    ).resolves.toMatchObject({ controlHolder: "user", controlUserId: owner.id });
    // A lease from before holders were recorded belongs to the person the computer is kept for.
    await system.computer.update({ where: { id: computer.id }, data: { controlUserId: null } });
    await expect(
      call(asInvitee, "computer/input", { botId: bot.id, kind: "key", payload: { key: "a" } }),
    ).resolves.toMatchObject({ status: 403 });

    // With the screen free, the owner's run on one bot still keeps teaching on another bot of
    // the same computer away.
    await system.computer.update({
      where: { id: computer.id },
      data: {
        controlHolder: "none",
        controlLeaseId: null,
        controlLeaseExpiresAt: null,
        controlBotId: null,
      },
    });
    const thread = await system.thread.create({
      data: { spaceId: home, botId: bot.id, userId: owner.id },
    });
    const task = await system.task.create({
      data: {
        spaceId: home,
        botId: bot.id,
        threadId: thread.id,
        userId: owner.id,
        prompt: "Shop",
        status: "running",
      },
    });
    await system.run.create({
      data: {
        spaceId: home,
        botId: bot.id,
        threadId: thread.id,
        taskId: task.id,
        userId: owner.id,
        status: "running",
        trigger: "user",
        leaseOwner: "worker-1",
        leaseExpiresAt: new Date(Date.now() + 60_000),
      },
    });
    const otherBot = await system.bot.create({
      data: {
        spaceId: home,
        userId: invitee.id,
        name: "Planner",
        color: "test",
        computerId: computer.id,
      },
    });
    await expect(
      call(asInvitee, "skills/start", { botId: otherBot.id, goal: "Book a table" }),
    ).resolves.toMatchObject({ status: 409 });
    // A background helper never uses the computer, so it doesn't keep teaching away, and the
    // teacher's own helper keeps working through the lesson.
    await system.run.updateMany({
      where: { botId: bot.id, status: "running" },
      data: { trigger: "helper" },
    });
    const helperThread = await system.thread.create({
      data: { spaceId: home, helperBotId: otherBot.id, userId: invitee.id },
    });
    const helperTask = await system.task.create({
      data: {
        spaceId: home,
        botId: otherBot.id,
        threadId: helperThread.id,
        userId: invitee.id,
        prompt: "Compare menus",
        status: "running",
      },
    });
    const ownHelper = await system.run.create({
      data: {
        spaceId: home,
        botId: otherBot.id,
        threadId: helperThread.id,
        taskId: helperTask.id,
        userId: invitee.id,
        status: "running",
        trigger: "helper",
      },
    });
    expect(
      JSON.stringify(
        await call(asInvitee, "skills/start", { botId: otherBot.id, goal: "Book a table" }),
      ),
    ).not.toContain("working for someone else");
    await expect(
      system.run.findUniqueOrThrow({ where: { id: ownHelper.id } }),
    ).resolves.toMatchObject({ status: "running" });

    // A member removed while holding the screen frees it at once, not when the lease runs out.
    await system.computer.update({
      where: { id: computer.id },
      data: {
        controlHolder: "user",
        controlLeaseId: randomUUID(),
        controlLeaseExpiresAt: new Date(Date.now() + 60_000),
        controlBotId: otherBot.id,
        controlUserId: invitee.id,
      },
    });
    await expect(
      call(inSpace(owner.actor, home), "spaces/members/remove", {
        spaceId: home,
        userId: invitee.id,
      }),
    ).resolves.toMatchObject({ status: 200 });
    await expect(
      system.computer.findUniqueOrThrow({ where: { id: computer.id } }),
    ).resolves.toMatchObject({ controlHolder: "none", controlUserId: null, controlLeaseId: null });
  });

  it("runs a taken-over routine's queued occurrence with the new owner's accounts", async () => {
    const owner = await person("owner");
    const invitee = await person("invitee");
    const home = await sharedSpace(owner, "Home");
    await call(invitee.actor, "spaces/invites/accept", { token: await invite(owner, home) });
    const bot = await system.bot.create({
      data: { spaceId: home, userId: owner.id, name: "Shopper", color: "test" },
    });
    const thread = await system.thread.create({
      data: { spaceId: home, botId: bot.id, userId: owner.id },
    });
    const routine = await system.routine.create({
      data: {
        spaceId: home,
        botId: bot.id,
        userId: invitee.id,
        name: "Groceries",
        prompt: "List groceries",
        crons: ["0 9 * * 1"],
      },
    });
    const queued = async (status: string) => {
      const task = await system.task.create({
        data: {
          spaceId: home,
          botId: bot.id,
          threadId: thread.id,
          userId: invitee.id,
          prompt: "Go",
          status,
        },
      });
      return system.run.create({
        data: {
          spaceId: home,
          botId: bot.id,
          threadId: thread.id,
          taskId: task.id,
          userId: invitee.id,
          routineId: routine.id,
          status,
          trigger: "routine",
        },
      });
    };
    const waiting = await queued("queued");
    const started = await queued("running");
    // The owner edits it, which makes it theirs, and then the queued occurrence follows.
    await system.routine.update({ where: { id: routine.id }, data: { userId: owner.id } });

    await runAsTenant({ spaceId: home, userId: owner.id }, () =>
      finishRoutineHandover(
        { prisma, jobs: { enqueue: enqueueJob, cancel: cancelJob } as never },
        { id: routine.id, previousUserId: invitee.id, userId: owner.id },
      ),
    );

    await expect(
      system.run.findUniqueOrThrow({ where: { id: waiting.id }, include: { task: true } }),
    ).resolves.toMatchObject({ userId: owner.id, task: { userId: owner.id } });
    // One already under way finishes as the person who started it.
    await expect(
      system.run.findUniqueOrThrow({ where: { id: started.id } }),
    ).resolves.toMatchObject({ userId: invitee.id });
  });

  it("frees a removed member's screen held from before holders were recorded", async () => {
    const owner = await person("owner");
    const invitee = await person("invitee");
    const home = await sharedSpace(owner, "Home");
    await call(invitee.actor, "spaces/invites/accept", { token: await invite(owner, home) });
    const computer = await system.computer.create({
      data: {
        spaceId: home,
        userId: invitee.id,
        scopeKey: `bot:legacy-${invitee.id}`,
        homeKey: `legacy-${invitee.id}`,
        kind: "docker",
        state: "running",
        providerRef: "fake-ref",
      },
    });
    const bot = await system.bot.create({
      data: {
        spaceId: home,
        userId: invitee.id,
        name: "Helper",
        color: "test",
        computerId: computer.id,
      },
    });
    await system.computer.update({
      where: { id: computer.id },
      data: {
        controlHolder: "user",
        controlLeaseId: randomUUID(),
        controlLeaseExpiresAt: new Date(Date.now() + 60_000),
        controlBotId: bot.id,
        controlUserId: null,
      },
    });

    await expect(
      call(inSpace(owner.actor, home), "spaces/members/remove", {
        spaceId: home,
        userId: invitee.id,
      }),
    ).resolves.toMatchObject({ status: 200 });
    // The computer is the owner's now, but the screen the member held is not.
    await expect(
      system.computer.findUniqueOrThrow({ where: { id: computer.id } }),
    ).resolves.toMatchObject({ userId: owner.id, controlHolder: "none", controlLeaseId: null });
  });

  it("gives a shared space one team computer, whoever creates the bot", async () => {
    const owner = await person("owner");
    const invitee = await person("invitee");
    const home = await sharedSpace(owner, "Home");
    await call(invitee.actor, "spaces/invites/accept", { token: await invite(owner, home) });

    const ownerBot = await call(inSpace(owner.actor, home), "bots/create", { name: "Planner" });
    const inviteeBot = await call(inSpace(invitee.actor, home), "bots/create", { name: "Shopper" });
    expect([ownerBot.status, inviteeBot.status]).toEqual([200, 200]);
    const bots = await system.bot.findMany({
      where: { id: { in: [ownerBot.json.id as string, inviteeBot.json.id as string] } },
      select: { computer: { select: { id: true, userId: true, scope: true } } },
    });
    expect(new Set(bots.map((bot) => bot.computer?.id)).size).toBe(1);
    expect(bots[0]?.computer).toMatchObject({ userId: owner.id, scope: "team" });
  });

  it("keeps what a leaving member made available elsewhere and hands their threads over", async () => {
    const owner = await person("owner");
    const invitee = await person("invitee");
    const home = await sharedSpace(owner, "Home");
    await call(invitee.actor, "spaces/invites/accept", { token: await invite(owner, home) });
    const everywhere = await system.mcpServer.create({
      data: {
        spaceId: home,
        userId: invitee.id,
        slug: "notes",
        name: "Notes",
        transport: "http",
        endpoint: "https://mcp.example.test",
        allSpaces: true,
      },
    });
    const work = await sharedSpace(invitee, "Work");
    const chosen = await system.mcpServer.create({
      data: {
        spaceId: home,
        userId: invitee.id,
        slug: "work-tracker",
        name: "Work tracker",
        transport: "http",
        endpoint: "https://mcp.example.test/work",
        availableIn: { create: { spaceId: work, userId: invitee.id } },
      },
    });
    const onlyHere = await system.mcpServer.create({
      data: {
        spaceId: home,
        userId: invitee.id,
        slug: "home-only",
        name: "Home only",
        transport: "http",
        endpoint: "https://mcp.example.test/home",
      },
    });
    // A plugin whose server is already in their own Space under that name goes whole.
    await system.mcpServer.create({
      data: {
        spaceId: invitee.spaceId,
        userId: invitee.id,
        slug: "calendar",
        name: "Calendar",
        transport: "http",
        endpoint: "https://mcp.example.test/mine",
      },
    });
    const plugin = await system.capabilityInstall.create({
      data: {
        spaceId: home,
        userId: invitee.id,
        kind: "plugin",
        name: "Calendar",
        source: "test",
        allSpaces: true,
        mcpServers: {
          create: {
            spaceId: home,
            userId: invitee.id,
            slug: "calendar",
            name: "Calendar",
            transport: "http",
            endpoint: "https://mcp.example.test/calendar",
            allSpaces: true,
          },
        },
      },
    });
    const bot = await system.bot.create({
      data: { spaceId: home, userId: invitee.id, name: "Planner", color: "test" },
    });
    const thread = await system.thread.create({
      data: { spaceId: home, userId: invitee.id, botId: bot.id },
    });

    await expect(
      call(inSpace(invitee.actor, home), "spaces/members/leave", { spaceId: home }),
    ).resolves.toMatchObject({ status: 200 });
    await expect(
      system.capabilityInstall.findUnique({ where: { id: plugin.id } }),
    ).resolves.toBeNull();

    await expect(
      system.mcpServer.findUniqueOrThrow({ where: { id: everywhere.id } }),
    ).resolves.toMatchObject({ spaceId: invitee.spaceId, userId: invitee.id });
    // One chosen for another Space moves there, not to a Space it was never available in.
    await expect(
      system.mcpServer.findUniqueOrThrow({ where: { id: chosen.id } }),
    ).resolves.toMatchObject({ spaceId: work });
    await expect(system.mcpServer.findUnique({ where: { id: onlyHere.id } })).resolves.toBeNull();
    await expect(
      system.thread.findUniqueOrThrow({ where: { id: thread.id } }),
    ).resolves.toMatchObject({ userId: owner.id });
    // A guest who no longer belongs to any of its Spaces leaves the organization too.
    await expect(
      system.member.findUnique({
        where: {
          organizationId_userId: { organizationId: owner.organizationId, userId: invitee.id },
        },
      }),
    ).resolves.toBeNull();
  });
  it("keeps a guest's tools for their other spaces when the owner deletes the shared space", async () => {
    const owner = await person("owner");
    const invitee = await person("invitee");
    const home = await sharedSpace(owner, "Home");
    await call(invitee.actor, "spaces/invites/accept", { token: await invite(owner, home) });
    const everywhere = await system.mcpServer.create({
      data: {
        spaceId: home,
        userId: invitee.id,
        slug: "notes",
        name: "Notes",
        transport: "http",
        endpoint: "https://mcp.example.test",
        allSpaces: true,
      },
    });

    await expect(
      call(inSpace(owner.actor, home), "spaces/remove", { spaceId: home }),
    ).resolves.toMatchObject({ status: 200 });

    await expect(system.space.findUnique({ where: { id: home } })).resolves.toBeNull();
    await expect(
      system.mcpServer.findUniqueOrThrow({ where: { id: everywhere.id } }),
    ).resolves.toMatchObject({ spaceId: invitee.spaceId, userId: invitee.id });
  });
  it("ends control without a draft card when a live recording is removed", async () => {
    const owner = await person("owner");
    const computer = await system.computer.create({
      data: {
        spaceId: owner.spaceId,
        userId: owner.id,
        scopeKey: `team:${owner.spaceId}:${owner.id}`,
        homeKey: computerHomeKey({ mode: "team", spaceId: owner.spaceId, userId: owner.id }),
        kind: "docker",
        state: "running",
      },
    });
    const bot = await system.bot.create({
      data: {
        spaceId: owner.spaceId,
        userId: owner.id,
        name: "Shopper",
        color: "test",
        computerId: computer.id,
      },
    });
    const thread = await system.thread.create({
      data: { spaceId: owner.spaceId, botId: bot.id, userId: owner.id },
    });
    const controlLeaseId = randomUUID();
    await system.computer.update({
      where: { id: computer.id },
      data: {
        controlHolder: "user",
        controlLeaseId,
        controlLeaseExpiresAt: new Date(Date.now() + 60_000),
        controlBotId: bot.id,
        controlUserId: owner.id,
      },
    });
    const skill = await system.taughtSkill.create({
      data: {
        spaceId: owner.spaceId,
        botId: bot.id,
        userId: owner.id,
        goal: "Book a table",
        status: "recording",
        recording: { events: [], snapshots: [], controlLeaseId },
      },
    });

    await expect(call(owner.actor, "skills/remove", { skillId: skill.id })).resolves.toMatchObject({
      status: 200,
    });

    await expect(
      system.computer.findUniqueOrThrow({ where: { id: computer.id } }),
    ).resolves.toMatchObject({ controlHolder: "none", controlLeaseId: null });
    await expect(system.taughtSkill.findUnique({ where: { id: skill.id } })).resolves.toBeNull();
    const messages = await system.message.findMany({ where: { threadId: thread.id } });
    expect(
      messages.flatMap((message) => message.blocks as Array<{ kind: string }>),
    ).not.toContainEqual(expect.objectContaining({ kind: "skill_draft" }));
  });

  it("leaves a live recording to its teacher and an organization member in their organization", async () => {
    const owner = await person("owner");
    const invitee = await person("invitee");
    const colleague = await person("colleague");
    const home = await sharedSpace(owner, "Home");
    await call(invitee.actor, "spaces/invites/accept", { token: await invite(owner, home) });
    const bot = await system.bot.create({
      data: { spaceId: home, userId: owner.id, name: "Shopper", color: "test" },
    });
    const typed = {
      events: [{ kind: "key", at: "2026-11-05T12:00:00.000Z", text: "my-password" }],
      snapshots: [],
    };
    const recording = await system.taughtSkill.create({
      data: {
        spaceId: home,
        botId: bot.id,
        userId: owner.id,
        goal: "Book",
        status: "recording",
        recording: typed,
      },
    });
    const asInvitee = inSpace(invitee.actor, home);
    // The skill is shared, but what its teacher typed is not.
    const listed = await call(asInvitee, "skills/list", { botId: bot.id });
    expect(listed.status).toBe(200);
    expect((listed.json as unknown as Array<{ recording: unknown }>)[0]?.recording).toEqual({
      events: [],
      snapshots: [],
    });
    const own = await call(inSpace(owner.actor, home), "skills/get", { skillId: recording.id });
    expect((own.json as { recording: { events: unknown[] } }).recording.events).toHaveLength(1);
    // Taking a drafted skill over by editing it keeps the playbook but not its teacher's input.
    const draft = await system.taughtSkill.create({
      data: {
        spaceId: home,
        botId: bot.id,
        userId: owner.id,
        goal: "Order groceries",
        status: "draft",
        recording: typed,
      },
    });
    const playbook = {
      whenToUse: "Weekly shop",
      inputs: [],
      steps: ["Open the store"],
      howToCheck: "Order placed",
      whatToReturn: "Total",
      approvalBoundaries: "Ask before paying",
      failureHandling: "Stop and report",
    };
    const edited = await call(asInvitee, "skills/updateDraft", { skillId: draft.id, playbook });
    expect(edited.status).toBe(200);
    expect((edited.json as { recording: { events: unknown[] } }).recording.events).toEqual([]);
    await expect(
      system.taughtSkill.findUniqueOrThrow({ where: { id: draft.id } }),
    ).resolves.toMatchObject({ userId: invitee.id, recording: { events: [], snapshots: [] } });
    await expect(call(asInvitee, "skills/stop", { skillId: recording.id })).resolves.toMatchObject({
      status: 404,
    });
    await expect(
      call(asInvitee, "skills/remove", { skillId: recording.id }),
    ).resolves.toMatchObject({ status: 409 });
    await expect(
      system.taughtSkill.findUniqueOrThrow({ where: { id: recording.id } }),
    ).resolves.toMatchObject({ status: "recording" });

    // A full member of the owner's organization, not a guest, keeps it when removed from a Space.
    const createdAt = new Date();
    await system.member.create({
      data: {
        id: `m-${colleague.id}-org`,
        organizationId: owner.organizationId,
        userId: colleague.id,
        role: "member",
        createdAt,
      },
    });
    await system.spaceMember.upsert({
      where: { spaceId_userId: { spaceId: home, userId: colleague.id } },
      create: {
        id: randomUUID(),
        spaceId: home,
        organizationId: owner.organizationId,
        userId: colleague.id,
        role: "member",
        createdAt,
      },
      update: {},
    });
    await system.spaceMember.deleteMany({
      where: { userId: colleague.id, organizationId: owner.organizationId, spaceId: { not: home } },
    });
    await expect(
      call(owner.actor, "spaces/members/remove", { spaceId: home, userId: colleague.id }),
    ).resolves.toMatchObject({ status: 200 });
    await expect(
      system.member.findUnique({
        where: {
          organizationId_userId: { organizationId: owner.organizationId, userId: colleague.id },
        },
      }),
    ).resolves.not.toBeNull();
  });
  it("hands a deleted account's space in a lasting organization over, or deletes it with only guests", async () => {
    const lead = await person("lead");
    const teammate = await person("teammate");
    const leaver = await person("leaver");
    const guest = await person("guest");
    const createdAt = new Date();
    // The leader's organization stays when the leaver goes: both are full members of it.
    for (const member of [teammate, leaver]) {
      await system.member.create({
        data: {
          id: `m-${member.id}-team`,
          organizationId: lead.organizationId,
          userId: member.id,
          role: "member",
          createdAt,
        },
      });
    }
    const join = async (spaceId: string, userId: string, role: string) =>
      system.spaceMember.upsert({
        where: { spaceId_userId: { spaceId, userId } },
        create: {
          id: randomUUID(),
          spaceId,
          organizationId: lead.organizationId,
          userId,
          role,
          createdAt,
        },
        update: { role },
      });
    const shared = await sharedSpace(lead, "Shared");
    await join(shared, leaver.id, "owner");
    await system.spaceMember.deleteMany({ where: { spaceId: shared, userId: lead.id } });
    await join(shared, teammate.id, "member");
    const guestsOnly = await sharedSpace(lead, "Guests only");
    await join(guestsOnly, leaver.id, "owner");
    await system.spaceMember.deleteMany({ where: { spaceId: guestsOnly, userId: lead.id } });
    await call(guest.actor, "spaces/invites/accept", {
      token: await invite({ ...leaver, actor: inSpace(leaver.actor, guestsOnly) }, guestsOnly),
    });

    const before = await call(inSpace(leaver.actor, shared), "bots/create", { name: "Planner" });
    expect(before.status).toBe(200);

    await leaveInvitedSpaces(prisma, leaver.id, async () => undefined);
    await expect(
      system.spaceMember.findUnique({
        where: { spaceId_userId: { spaceId: shared, userId: teammate.id } },
      }),
    ).resolves.toMatchObject({ role: "owner" });
    // The new owner's bots keep using the Space's one Team Computer.
    const after = await call(inSpace(teammate.actor, shared), "bots/create", { name: "Shopper" });
    expect(after.status).toBe(200);
    const computers = await system.bot.findMany({
      where: { id: { in: [before.json.id as string, after.json.id as string] } },
      select: { computerId: true },
    });
    expect(new Set(computers.map((bot) => bot.computerId)).size).toBe(1);
    const { spaceIds } = await claimSpacesLeavingWithAccount(prisma, leaver.id);
    expect(spaceIds).toContain(guestsOnly);
    expect(spaceIds).not.toContain(shared);
  });

  it.each([
    { name: "hands over and departs in one go", failFirst: false, coOwner: false },
    {
      name: "a retry after a failed departure still departs",
      failFirst: true,
      coOwner: false,
    },
    { name: "an owner beside another owner stays", failFirst: false, coOwner: true },
  ])("leaving a Space it owns elsewhere: $name", async ({ failFirst, coOwner }) => {
    const lead = await person("lead");
    const teammate = await person("teammate");
    const leaver = await person("leaver");
    const createdAt = new Date();
    for (const member of [teammate, leaver]) {
      await system.member.create({
        data: {
          id: `m-${member.id}-team`,
          organizationId: lead.organizationId,
          userId: member.id,
          role: "member",
          createdAt,
        },
      });
    }
    const shared = await sharedSpace(lead, "Shared");
    await system.spaceMember.deleteMany({ where: { spaceId: shared, userId: lead.id } });
    for (const [member, role] of [
      [leaver, "owner"],
      [teammate, coOwner ? "owner" : "member"],
    ] as const) {
      await system.spaceMember.create({
        data: {
          id: randomUUID(),
          spaceId: shared,
          organizationId: lead.organizationId,
          userId: member.id,
          role,
          createdAt,
        },
      });
    }
    const bot = await system.bot.create({
      data: { spaceId: shared, userId: leaver.id, name: "Planner", color: "test" },
    });
    const onDeparture = vi.fn(async (_departure: { spaceId: string }) => undefined);

    if (failFirst) {
      // A transient database error as the departure takes the leaver out of the Space.
      const ownerDb = createDb(process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL!);
      await ownerDb.prisma.$executeRawUnsafe(`
        CREATE OR REPLACE FUNCTION space_departure_test_fail() RETURNS trigger AS $$
        BEGIN RAISE EXCEPTION 'injected failure'; END $$ LANGUAGE plpgsql`);
      await ownerDb.prisma.$executeRawUnsafe(
        `CREATE TRIGGER space_departure_test_fail BEFORE DELETE ON space_members
         FOR EACH ROW WHEN (OLD."userId" = '${leaver.id}' AND OLD."spaceId" = '${shared}')
         EXECUTE FUNCTION space_departure_test_fail()`,
      );
      try {
        await expect(leaveInvitedSpaces(prisma, leaver.id, onDeparture)).rejects.toThrow(
          "injected failure",
        );
      } finally {
        await ownerDb.prisma.$executeRawUnsafe(
          "DROP TRIGGER space_departure_test_fail ON space_members",
        );
        await ownerDb.prisma.$executeRawUnsafe("DROP FUNCTION space_departure_test_fail()");
        await ownerDb.prisma.$disconnect();
        await ownerDb.pool.end();
      }
    }

    const departures = await leaveInvitedSpaces(prisma, leaver.id, onDeparture);

    const left = !coOwner;
    // Both also joined the organization's default Space, which they leave either way.
    const fromShared = (spaceIds: string[]) => spaceIds.filter((spaceId) => spaceId === shared);
    expect(fromShared(departures.map((departure) => departure.spaceId))).toEqual(
      left ? [shared] : [],
    );
    expect(fromShared(onDeparture.mock.calls.map(([departure]) => departure.spaceId))).toEqual(
      left ? [shared] : [],
    );
    await expect(
      system.spaceMember.findMany({
        where: { spaceId: shared },
        select: { userId: true, role: true },
        orderBy: { userId: "asc" },
      }),
    ).resolves.toEqual(
      [
        ...(left ? [] : [{ userId: leaver.id, role: "owner" }]),
        { userId: teammate.id, role: "owner" },
      ].sort((a, b) => a.userId.localeCompare(b.userId)),
    );
    await expect(system.bot.findUniqueOrThrow({ where: { id: bot.id } })).resolves.toMatchObject({
      userId: left ? teammate.id : leaver.id,
    });
  });
});
