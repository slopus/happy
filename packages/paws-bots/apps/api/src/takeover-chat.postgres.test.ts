import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { RPCHandler } from "@orpc/server/fetch";
import type { AgentRunRequest, JobPublisher } from "@rakazo/adapter-kit";
import { computerControlExpireJobKey, runJobKey } from "@rakazo/adapter-kit";
import {
  acquireComputerExecutionLease,
  ComputerBusyError,
  cancelComputerRunWorkArgv,
  createRunExecutor,
  EncryptedSecretStore,
  FakeBrowserProvider,
  FakeSandboxProvider,
  LocalAgentHomeStore,
  ScriptedAgentRuntime,
  screenLeaseIdForRun,
  updateFleetGroup,
} from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import {
  stuckWorkStatusMessage,
  TAKEOVER_COMPUTER_PENDING_STATE,
  TAKEOVER_WAIT_EXPIRE_AFTER_MS,
} from "@rakazo/core";
import type { Prisma, PrismaClient } from "@rakazo/db";
import {
  asSystem,
  createDb,
  createThreadEvents,
  endTakeoverWaits,
  expireStuckRun,
  runAsSystem,
  runAsTenant,
} from "@rakazo/db";
import { MarkdownMemoryStore } from "@rakazo/memory";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

const describePostgres =
  process.env.VERIFY_DATABASE === "1" && process.env.DATABASE_URL ? describe : describe.skip;

describePostgres("chat replies during screen takeover (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let prisma: PrismaClient;
  let system: PrismaClient;
  let dataDir: string;
  const organizations: string[] = [];

  beforeAll(async () => {
    db = createDb(process.env.DATABASE_URL!);
    prisma = db.prisma;
    system = asSystem(prisma);
    dataDir = await mkdtemp(join(process.cwd(), ".takeover-chat-test-"));
    await system.deploymentSettings.upsert({
      where: { id: "default" },
      create: {
        id: "default",
        defaultModelProvider: "openrouter",
        defaultModelId: "openai/gpt-4o",
      },
      update: { defaultModelProvider: "openrouter", defaultModelId: "openai/gpt-4o" },
    });
  });

  afterAll(async () => {
    if (prisma) {
      await system.organization.deleteMany({ where: { id: { in: organizations } } });
      await system.user.deleteMany({ where: { id: { in: organizations } } });
      await prisma.$disconnect();
      await db.pool.end();
    }
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });

  const endWaits = (runIds: string[]) =>
    runAsSystem("test takeover wait", () => endTakeoverWaits(prisma, runIds));

  async function setup(mode: "opened" | "unopened" = "opened", trigger = "user") {
    const id = randomUUID();
    organizations.push(id);
    await system.user.create({
      data: { id, name: "Takeover fixture", email: `${id}@example.test`, emailVerified: true },
    });
    await system.organization.create({
      data: { id, name: "Takeover fixture", slug: id, createdAt: new Date() },
    });
    await system.space.create({ data: { id, organizationId: id, name: "Fixture" } });
    await system.member.create({
      data: { id, organizationId: id, userId: id, role: "owner", createdAt: new Date() },
    });
    await system.spaceMember.create({
      data: {
        id,
        spaceId: id,
        organizationId: id,
        userId: id,
        role: "owner",
        createdAt: new Date(),
      },
    });
    const computer = await system.computer.create({
      data: { spaceId: id, userId: id, scopeKey: id, homeKey: id, kind: "fake", state: "running" },
    });
    const bot = await system.bot.create({
      data: { spaceId: id, userId: id, name: "Fixture", color: "test", computerId: computer.id },
    });
    const thread = await system.thread.create({ data: { spaceId: id, userId: id, botId: bot.id } });
    const task = await system.task.create({
      data: {
        spaceId: id,
        userId: id,
        botId: bot.id,
        threadId: thread.id,
        prompt: "Enter the provided code on the fixture page.",
        status: "running",
      },
    });
    const run = await system.run.create({
      data: {
        spaceId: id,
        userId: id,
        botId: bot.id,
        threadId: thread.id,
        taskId: task.id,
        status: "waiting_takeover",
        trigger,
      },
    });
    // The run asked for help with a card, as a paused run always has.
    const cardSeq = await system.thread.update({
      where: { id: thread.id },
      data: { nextMessageSeq: { increment: 1 } },
      select: { nextMessageSeq: true },
    });
    await system.message.create({
      data: {
        threadId: thread.id,
        botId: bot.id,
        runId: run.id,
        seq: cardSeq.nextMessageSeq - 1,
        role: "bot",
        blocks: [{ kind: "computer", state: TAKEOVER_COMPUTER_PENDING_STATE, text: "Sign in." }],
      },
    });
    await system.computerExecutionLease.create({
      data: {
        computerId: computer.id,
        botId: bot.id,
        runId: run.id,
        fence: 1,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    const actor: Actor = {
      spaceId: id,
      userId: id,
      email: `${id}@example.test`,
      isDeploymentOwner: false,
    };
    const sandbox = new FakeSandboxProvider();
    const ref = await sandbox.provision(
      { botId: computer.id, homePath: dataDir },
      {
        ...actor,
        operationId: "fixture",
        traceId: "fixture",
        signal: new AbortController().signal,
      },
    );
    const events = createThreadEvents(prisma);
    await system.computer.update({
      where: { id: computer.id },
      data: { providerRef: ref.id },
    });
    let leaseId: string | null = null;
    if (mode === "opened") {
      leaseId = randomUUID();
      await system.computer.update({
        where: { id: computer.id },
        data: {
          controlHolder: "user",
          controlBotId: bot.id,
          controlLeaseId: leaseId,
          controlLeaseExpiresAt: new Date(Date.now() + 60_000),
        },
      });
    } else {
      const attempt = await system.attempt.create({
        data: { runId: run.id, fence: 1, status: "running" },
      });
      await system.run.update({
        where: { id: run.id },
        data: {
          status: "running",
          leaseOwner: "fixture-worker",
          leaseFence: 1,
          leaseExpiresAt: new Date(Date.now() + 60_000),
        },
      });
      await runAsSystem("test fixture", () =>
        events.pauseRunForTakeover({
          spaceId: id,
          threadId: thread.id,
          botId: bot.id,
          runId: run.id,
          attemptId: attempt.id,
          leaseOwner: "fixture-worker",
          leaseFence: 1,
          reason: "Enter the fixture code",
        }),
      );
    }
    const queuedStates: Array<{ status: string; checkpoint: string | null }> = [];
    const enqueue = vi.fn<JobPublisher["enqueue"]>(async (job) => {
      if (job.name === "run.continue") {
        queuedStates.push(await system.run.findUniqueOrThrow({ where: { id: job.payload.runId } }));
      }
    });
    const jobs: JobPublisher = {
      enqueue,
      enqueueIn: vi.fn(async () => undefined),
      cancelIn: vi.fn(async () => undefined),
      cancel: vi.fn(async () => undefined),
      close: async () => undefined,
    };
    const deps = {
      prisma,
      events,
      jobs,
      sandbox,
      env: { agentRuntime: "scripted" },
    } as unknown as RouterDeps;
    const handler = new RPCHandler(createRouter(deps));
    const send = async (input: Record<string, unknown> = {}) => {
      const { response } = await handler.handle(
        new Request("http://127.0.0.1/rpc/threads/send", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            json: { botId: bot.id, text: "The fixture code is 1234.", ...input },
          }),
        }),
        { prefix: "/rpc", context: { actor } },
      );
      return response!;
    };
    const control = () => system.computer.findUniqueOrThrow({ where: { id: computer.id } });
    const call = async (path: string, as: Actor = actor) => {
      const { response } = await handler.handle(
        new Request(`http://127.0.0.1/rpc/computer/${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ json: { botId: bot.id } }),
        }),
        { prefix: "/rpc", context: { actor: as } },
      );
      return response!;
    };
    const release = async (reason: "done" | "skipped", as: Actor = actor, runId = run.id) => {
      const { response } = await handler.handle(
        new Request("http://127.0.0.1/rpc/computer/release", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ json: { botId: bot.id, reason, runId } }),
        }),
        { prefix: "/rpc", context: { actor: as } },
      );
      return response!;
    };
    return {
      actor,
      bot,
      thread,
      run,
      computer,
      sandbox,
      events,
      deps,
      jobs,
      enqueue,
      queuedStates,
      send,
      release,
      call,
      control,
      leaseId,
    };
  }

  it("hands this person's screen to another bot without answering the waiting run", async () => {
    const fixture = await setup();
    const other = await system.bot.create({
      data: {
        spaceId: fixture.actor.spaceId,
        userId: fixture.actor.userId,
        name: "Other fixture",
        color: "test",
        computerId: fixture.computer.id,
      },
    });
    const { response } = await new RPCHandler(createRouter(fixture.deps)).handle(
      new Request("http://127.0.0.1/rpc/computer/takeover", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: { botId: other.id } }),
      }),
      { prefix: "/rpc", context: { actor: fixture.actor } },
    );
    expect(response?.status).toBe(200);
    expect(await fixture.control()).toMatchObject({
      controlHolder: "user",
      controlBotId: other.id,
      controlUserId: fixture.actor.userId,
    });
    expect((await fixture.control()).controlLeaseId).not.toBe(fixture.leaseId);
    expect(fixture.jobs.cancel).toHaveBeenCalledWith(
      computerControlExpireJobKey(fixture.computer.id, fixture.leaseId!),
    );
    // Only Done or Skip answers the bot; handing its screen on does not.
    expect(await system.run.findUniqueOrThrow({ where: { id: fixture.run.id } })).toMatchObject({
      status: "waiting_takeover",
      checkpoint: null,
    });
    expect(fixture.queuedStates).toEqual([]);
  });

  it("lets one person at a time control the screen, renewed while their page checks in", async () => {
    const fixture = await setup("unopened");
    // The bot working on its computer does not keep a person off it.
    await system.run.update({ where: { id: fixture.run.id }, data: { status: "running" } });
    const fenceBefore = (await fixture.control()).controlFence;
    expect((await fixture.call("takeover")).status).toBe(200);
    const granted = await fixture.control();
    expect(granted).toMatchObject({
      controlHolder: "user",
      controlBotId: fixture.bot.id,
      controlUserId: fixture.actor.userId,
      controlFence: fenceBefore + 1,
    });
    expect(granted.controlLeaseExpiresAt!.getTime() - Date.now()).toBeLessThanOrEqual(90_000);

    const otherId = randomUUID();
    organizations.push(otherId);
    await system.user.create({
      data: { id: otherId, name: "Other", email: `${otherId}@example.test`, emailVerified: true },
    });
    await system.member.create({
      data: {
        id: otherId,
        organizationId: fixture.actor.spaceId,
        userId: otherId,
        role: "member",
        createdAt: new Date(),
      },
    });
    await system.spaceMember.create({
      data: {
        id: otherId,
        spaceId: fixture.actor.spaceId,
        organizationId: fixture.actor.spaceId,
        userId: otherId,
        role: "member",
        createdAt: new Date(),
      },
    });
    const other = { ...fixture.actor, userId: otherId, email: `${otherId}@example.test` };
    const busy = await fixture.call("takeover", other);
    expect(busy.status).toBe(409);
    expect(JSON.stringify(await busy.json())).toContain("Someone else is using this computer");
    expect(await fixture.control()).toEqual(granted);

    await system.computer.update({
      where: { id: fixture.computer.id },
      data: { controlLeaseExpiresAt: new Date(Date.now() + 5_000) },
    });
    expect((await fixture.call("heartbeat")).status).toBe(200);
    const renewed = await fixture.control();
    expect(renewed.controlLeaseId).toBe(granted.controlLeaseId);
    expect(renewed.controlLeaseExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 30_000);

    expect((await fixture.call("release")).status).toBe(200);
    expect(await fixture.control()).toMatchObject({
      controlHolder: "none",
      controlLeaseId: null,
      controlBotId: null,
      controlUserId: null,
    });
    // Handing back ends control but answers nothing.
    expect(await system.run.findUniqueOrThrow({ where: { id: fixture.run.id } })).toMatchObject({
      status: "running",
      checkpoint: null,
    });
  });

  it("releases the screen before either continuation is queued and executes the steering once", async () => {
    const fixture = await setup();
    const revoke = vi.spyOn(fixture.sandbox, "setScreenControl");
    const response = await fixture.send({ clientNonce: "takeover-reply" });
    expect(response.status).toBe(200);
    const { json: sent } = await response.json();
    const message = await system.message.findUniqueOrThrow({
      where: {
        threadId_clientNonce: { threadId: fixture.thread.id, clientNonce: "takeover-reply" },
      },
    });
    expect(sent.runId).toBe(fixture.run.id);
    expect(await fixture.control()).toMatchObject({
      controlHolder: "none",
      controlBotId: null,
      controlLeaseId: null,
      controlLeaseExpiresAt: null,
    });
    expect(revoke).toHaveBeenCalledWith(
      expect.anything(),
      false,
      expect.anything(),
      fixture.leaseId,
    );
    expect(
      await system.event.findMany({
        where: { threadId: fixture.thread.id, type: "computer.takeover.released" },
        orderBy: { seq: "asc" },
      }),
    ).toMatchObject([
      { runId: null, payload: { holder: "none", reason: "done", leaseId: fixture.leaseId } },
      {
        runId: fixture.run.id,
        payload: { holder: "none", reason: "done", leaseId: null, answered: true },
      },
    ]);
    expect(fixture.queuedStates).toEqual([
      expect.objectContaining({ status: "queued", checkpoint: "takeover" }),
      expect.objectContaining({ status: "queued", checkpoint: "takeover" }),
    ]);

    const requests: AgentRunRequest[] = [];
    const runtime = {
      describe: () => ({
        ...new ScriptedAgentRuntime().describe(),
        capabilities: { streaming: true, compaction: false, tools: true, scripted: false },
      }),
      abort: async () => undefined,
      async *run(request: AgentRunRequest) {
        requests.push(request);
        expect(request.resumeFromCheckpoint).toBe("takeover");
        expect(request.instructions).not.toContain("The user has the screen");
        expect(request.tools.map((tool) => tool.name)).toEqual(
          expect.arrayContaining(["computer_act", "browser_navigate"]),
        );
        const steering = await request.claimSteering!([]);
        expect(steering).toMatchObject([
          { messageId: message.id, text: "The fixture code is 1234." },
        ]);
        expect(await request.claimSteering!(steering.map((item) => item.id))).toEqual([]);
        await request.executeTool!(
          "computer_act",
          { actions: [{ kind: "type", text: "1234" }], observe: false, settle_ms: 0 },
          "reply-action",
        );
        await request.executeTool!(
          "browser_navigate",
          { url: "https://fixture.test" },
          "reply-browser",
        );
        yield { type: "done" as const, text: "Fixture completed." };
      },
    };
    const act = vi.spyOn(fixture.sandbox, "act");
    const browser = new FakeBrowserProvider({
      pages: { "https://fixture.test": { html: "<p>Fixture</p>" } },
    });
    const navigate = vi.spyOn(browser, "navigate");
    const executor = createRunExecutor({
      prisma,
      events: fixture.events,
      jobs: fixture.jobs,
      sandbox: fixture.sandbox,
      browser,
      runtime,
      home: new LocalAgentHomeStore(dataDir),
      memory: new MarkdownMemoryStore(prisma),
      memoryProviders: { resolve: async () => null },
      secretStore: new EncryptedSecretStore("fake-fixture-encryption-key"),
      secrets: [],
      deploymentModelKey: "fake-fixture-model-key",
      deploymentModelConfigured: true,
      dataDir,
    });
    // Run jobs act for the run's owner, as the background job handlers scope them.
    await runAsTenant(fixture.actor, () =>
      Promise.all([
        executor.continueRun(fixture.run.id, "steering-worker"),
        executor.continueRun(fixture.run.id, "release-worker"),
      ]),
    );
    expect(await system.run.findUniqueOrThrow({ where: { id: fixture.run.id } })).toMatchObject({
      status: "completed",
      error: null,
    });
    expect(requests).toHaveLength(1);
    expect(act).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(await system.attempt.count({ where: { runId: fixture.run.id } })).toBe(1);
    expect(await system.steeringMessage.count({ where: { messageId: message.id } })).toBe(0);
    await runAsTenant(fixture.actor, () => executor.continueRun(fixture.run.id, "late-worker"));
    expect(requests).toHaveLength(1);
  });

  it("releases an unopened takeover and restores tools for the steered continuation", async () => {
    const fixture = await setup("unopened");
    expect(await fixture.control()).toMatchObject({
      controlHolder: "none",
      controlBotId: null,
      controlLeaseId: null,
    });
    const response = await fixture.send({ clientNonce: "unopened-reply" });
    expect(response.status).toBe(200);
    const { json: sent } = await response.json();
    const message = await system.message.findUniqueOrThrow({
      where: {
        threadId_clientNonce: { threadId: fixture.thread.id, clientNonce: "unopened-reply" },
      },
    });
    expect(sent.runId).toBe(fixture.run.id);
    expect(await fixture.control()).toMatchObject({
      controlHolder: "none",
      controlBotId: null,
      controlLeaseId: null,
    });
    expect(
      await system.event.findMany({
        where: { runId: fixture.run.id, type: "computer.takeover.released" },
      }),
    ).toMatchObject([
      { payload: { holder: "none", reason: "done", leaseId: null, answered: true } },
    ]);
    expect(await system.run.findUniqueOrThrow({ where: { id: fixture.run.id } })).toMatchObject({
      status: "queued",
      checkpoint: "takeover",
    });

    const requests: AgentRunRequest[] = [];
    const runtime = {
      describe: () => ({
        ...new ScriptedAgentRuntime().describe(),
        capabilities: { streaming: true, compaction: false, tools: true, scripted: false },
      }),
      abort: async () => undefined,
      async *run(request: AgentRunRequest) {
        requests.push(request);
        expect(request.resumeFromCheckpoint).toBe("takeover");
        expect(request.instructions).not.toContain("The user has the screen");
        expect(request.tools.map((tool) => tool.name)).toEqual(
          expect.arrayContaining(["computer_act", "browser_navigate"]),
        );
        expect(await request.claimSteering!([])).toMatchObject([
          { messageId: message.id, text: "The fixture code is 1234." },
        ]);
        yield { type: "done" as const, text: "Fixture completed." };
      },
    };
    const executor = createRunExecutor({
      prisma,
      events: fixture.events,
      jobs: fixture.jobs,
      sandbox: fixture.sandbox,
      browser: new FakeBrowserProvider(),
      runtime,
      home: new LocalAgentHomeStore(dataDir),
      memory: new MarkdownMemoryStore(prisma),
      memoryProviders: { resolve: async () => null },
      secretStore: new EncryptedSecretStore("fake-fixture-encryption-key"),
      secrets: [],
      deploymentModelKey: "fake-fixture-model-key",
      deploymentModelConfigured: true,
      dataDir,
    });
    // Run jobs act for the run's owner, as the background job handlers scope them.
    await runAsTenant(fixture.actor, () =>
      Promise.all([
        executor.continueRun(fixture.run.id, "steering-worker"),
        executor.continueRun(fixture.run.id, "release-worker"),
      ]),
    );
    expect(await system.run.findUniqueOrThrow({ where: { id: fixture.run.id } })).toMatchObject({
      status: "completed",
      error: null,
    });
    expect(requests).toHaveLength(1);
    expect(await system.steeringMessage.count({ where: { messageId: message.id } })).toBe(0);
  });

  it("lets the person the run waits on skip an unopened takeover from the chat card", async () => {
    const fixture = await setup("unopened");
    expect((await fixture.release("skipped")).status).toBe(200);
    expect(await fixture.control()).toMatchObject({ controlHolder: "none", controlLeaseId: null });
    expect(
      await system.event.findMany({
        where: { runId: fixture.run.id, type: "computer.takeover.released" },
      }),
    ).toMatchObject([
      { payload: { holder: "none", reason: "skipped", leaseId: null, answered: true } },
    ]);
    expect(await system.run.findUniqueOrThrow({ where: { id: fixture.run.id } })).toMatchObject({
      status: "queued",
      checkpoint: "takeover-skipped",
    });
  });

  it("shows the screen preview to the Space and to no one outside it", async () => {
    const fixture = await setup("unopened");
    const outsider = await setup("unopened");
    const preview = async (actor: Actor, runId?: string) => {
      const { response } = await new RPCHandler(createRouter(fixture.deps)).handle(
        new Request("http://127.0.0.1/rpc/computer/preview", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ json: { botId: fixture.bot.id, runId } }),
        }),
        { prefix: "/rpc", context: { actor } },
      );
      return response!;
    };
    const own = await preview(fixture.actor);
    expect(own.status).toBe(200);
    const { json } = await own.json();
    expect(json.image).toMatch(/^data:image\/(png|jpeg);base64,/);
    const other = await preview(outsider.actor);
    expect(other.status).not.toBe(200);
    expect(JSON.stringify(await other.json())).not.toContain("data:image");
    // A card whose run no longer waits shows no screen.
    const stale = await preview(fixture.actor, randomUUID());
    expect((await stale.json()).json).toEqual({ image: null });
    const current = await preview(fixture.actor, fixture.run.id);
    expect((await current.json()).json.image).toMatch(/^data:image/);
  });

  it("does not let an older card answer the takeover a newer run is waiting on", async () => {
    const fixture = await setup("unopened");
    const before = await fixture.control();
    const response = await fixture.release("skipped", fixture.actor, randomUUID());
    expect(response.status).toBe(409);
    expect(await fixture.control()).toEqual(before);
    expect(await system.run.findUniqueOrThrow({ where: { id: fixture.run.id } })).toMatchObject({
      status: "waiting_takeover",
    });
  });

  it("does not let another member answer a takeover that waits on someone else", async () => {
    const fixture = await setup("unopened");
    const otherId = randomUUID();
    await system.user.create({
      data: { id: otherId, name: "Other", email: `${otherId}@example.test`, emailVerified: true },
    });
    organizations.push(otherId);
    await system.member.create({
      data: {
        id: otherId,
        organizationId: fixture.actor.spaceId,
        userId: otherId,
        role: "member",
        createdAt: new Date(),
      },
    });
    await system.spaceMember.create({
      data: {
        id: otherId,
        spaceId: fixture.actor.spaceId,
        organizationId: fixture.actor.spaceId,
        userId: otherId,
        role: "member",
        createdAt: new Date(),
      },
    });
    const before = await fixture.control();
    const response = await fixture.release("done", {
      ...fixture.actor,
      userId: otherId,
      email: `${otherId}@example.test`,
    });
    expect(response.status).toBe(409);
    expect(await fixture.control()).toEqual(before);
    expect(await system.run.findUniqueOrThrow({ where: { id: fixture.run.id } })).toMatchObject({
      status: "waiting_takeover",
    });
  });

  it("does not let another member answer someone else's request by taking the screen", async () => {
    const fixture = await setup("unopened");
    const otherId = randomUUID();
    organizations.push(otherId);
    await system.user.create({
      data: { id: otherId, name: "Other", email: `${otherId}@example.test`, emailVerified: true },
    });
    const membership = {
      id: otherId,
      organizationId: fixture.actor.spaceId,
      userId: otherId,
      role: "member",
      createdAt: new Date(),
    };
    await system.member.create({ data: membership });
    await system.spaceMember.create({ data: { ...membership, spaceId: fixture.actor.spaceId } });
    const other = { ...fixture.actor, userId: otherId, email: `${otherId}@example.test` };
    // Anyone in the Space may take the screen…
    expect((await fixture.call("takeover", other)).status).toBe(200);
    expect(await fixture.control()).toMatchObject({ controlUserId: otherId });
    // …but holding it never answers the request the bot made to someone else.
    for (const reason of ["done", "skipped"] as const) {
      expect((await fixture.release(reason, other)).status).toBe(409);
    }
    expect(await system.run.findUniqueOrThrow({ where: { id: fixture.run.id } })).toMatchObject({
      status: "waiting_takeover",
      checkpoint: null,
    });
  });

  it("answers the request from a reply but keeps another bot's screen control", async () => {
    const fixture = await setup();
    await system.computer.update({
      where: { id: fixture.computer.id },
      data: { controlBotId: "different-bot" },
    });
    const before = await fixture.control();
    const revoke = vi.spyOn(fixture.sandbox, "setScreenControl");
    expect((await fixture.send()).status).toBe(200);
    expect(await fixture.control()).toEqual(before);
    expect(revoke).not.toHaveBeenCalled();
    expect(await system.run.findUniqueOrThrow({ where: { id: fixture.run.id } })).toMatchObject({
      status: "queued",
      checkpoint: "takeover",
    });
  });

  it("does not release a bot's takeover when the user sends to a group", async () => {
    const fixture = await setup();
    const otherBot = await system.bot.create({
      data: {
        spaceId: fixture.actor.spaceId,
        userId: fixture.actor.userId,
        name: "Other",
        color: "test",
      },
    });
    const group = await system.chatGroup.create({
      data: {
        spaceId: fixture.actor.spaceId,
        userId: fixture.actor.userId,
        name: "Fixture group",
        members: { create: [{ botId: fixture.bot.id }, { botId: otherBot.id }] },
        thread: { create: { spaceId: fixture.actor.spaceId, userId: fixture.actor.userId } },
      },
    });
    const before = await fixture.control();
    const revoke = vi.spyOn(fixture.sandbox, "setScreenControl");
    expect((await fixture.send({ botId: undefined, groupId: group.id })).status).toBe(200);
    expect(await fixture.control()).toEqual(before);
    expect(revoke).not.toHaveBeenCalled();
    expect(
      await system.event.count({
        where: { threadId: fixture.thread.id, type: "computer.takeover.released" },
      }),
    ).toBe(0);
  });

  describe("in a group chat", () => {
    /** The waiting run belongs to the second member; the first member has nothing to do with it. */
    async function setupGroup() {
      const fixture = await setup();
      const first = await system.bot.create({
        data: {
          spaceId: fixture.actor.spaceId,
          userId: fixture.actor.userId,
          name: "Bystander",
          color: "test",
        },
      });
      const group = await system.chatGroup.create({
        data: {
          spaceId: fixture.actor.spaceId,
          userId: fixture.actor.userId,
          name: "Fixture group",
          members: { create: [{ botId: first.id }, { botId: fixture.bot.id }] },
          thread: { create: { spaceId: fixture.actor.spaceId, userId: fixture.actor.userId } },
        },
        include: { thread: true },
      });
      const threadId = group.thread!.id;
      await system.task.updateMany({ where: { id: fixture.run.taskId }, data: { threadId } });
      await system.run.update({ where: { id: fixture.run.id }, data: { threadId } });
      const card = await system.message.create({
        data: {
          threadId,
          botId: fixture.bot.id,
          runId: fixture.run.id,
          seq: 1,
          role: "bot",
          blocks: [
            { kind: "text", text: "Please enter the code on the screen." },
            { kind: "computer", state: TAKEOVER_COMPUTER_PENDING_STATE, text: "Enter the code." },
          ],
        },
      });
      const call = async (path: "send" | "react", json: Record<string, unknown>) => {
        const { response } = await new RPCHandler(createRouter(fixture.deps)).handle(
          new Request(`http://127.0.0.1/rpc/threads/${path}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ json: { groupId: group.id, ...json } }),
          }),
          { prefix: "/rpc", context: { actor: fixture.actor } },
        );
        return response!;
      };
      return { ...fixture, first, threadId, card, call };
    }

    it.each(["send", "react"] as const)(
      "hands the screen back to the member that asked for it on a group %s",
      async (path) => {
        const group = await setupGroup();
        const revoke = vi.spyOn(group.sandbox, "setScreenControl");
        const response = await group.call(
          path,
          path === "send"
            ? { text: "@Fixture the code is 1234.", clientNonce: "group-reply" }
            : { messageId: group.card.id, reaction: "👍", clientNonce: "group-thumb" },
        );
        expect(response.status).toBe(200);
        expect(await group.control()).toMatchObject({
          controlHolder: "none",
          controlBotId: null,
          controlLeaseId: null,
        });
        expect(revoke).toHaveBeenCalledWith(
          expect.anything(),
          false,
          expect.anything(),
          group.leaseId,
        );
        expect(
          await system.event.findMany({
            where: { runId: group.run.id, type: "computer.takeover.released" },
          }),
        ).toMatchObject([{ payload: { reason: "done", leaseId: null, answered: true } }]);
        expect(await system.run.findUniqueOrThrow({ where: { id: group.run.id } })).toMatchObject({
          status: "queued",
          checkpoint: "takeover",
        });
      },
    );

    it("keeps the screen when the reply is for a member that is not waiting", async () => {
      const group = await setupGroup();
      const before = await group.control();
      const revoke = vi.spyOn(group.sandbox, "setScreenControl");
      const response = await group.call("send", {
        text: "@Bystander how are you?",
        clientNonce: "group-other-member",
      });
      expect(response.status).toBe(200);
      expect(await group.control()).toEqual(before);
      expect(revoke).not.toHaveBeenCalled();
    });
  });

  it("does not release the takeover of a routine run that the reply does not steer", async () => {
    const fixture = await setup("opened", "routine");
    const before = await fixture.control();
    const revoke = vi.spyOn(fixture.sandbox, "setScreenControl");
    const response = await fixture.send({ clientNonce: "routine-reply" });
    expect(response.status).toBe(200);
    const { json: sent } = await response.json();
    expect(await fixture.control()).toEqual(before);
    expect(revoke).not.toHaveBeenCalled();
    // The reply gets its own run rather than waiting on the routine's takeover request.
    expect(sent.runId).not.toBe(fixture.run.id);
    expect(await system.run.findUniqueOrThrow({ where: { id: sent.runId } })).toMatchObject({
      status: "queued",
      trigger: "user",
    });
    expect(await system.steeringMessage.count({ where: { botId: fixture.bot.id } })).toBe(0);
    expect(
      await system.event.count({
        where: { runId: fixture.run.id, type: "computer.takeover.released" },
      }),
    ).toBe(0);
  });

  it("ends an unopened takeover wait that a reply would otherwise queue behind", async () => {
    const fixture = await setup("unopened", "routine");
    const response = await fixture.send({ clientNonce: "moved-on" });
    expect(response.status).toBe(200);
    const { json: sent } = await response.json();
    expect(sent.runId).not.toBe(fixture.run.id);

    expect(await endWaits([fixture.run.id])).toBe(1);

    expect(await system.run.findUniqueOrThrow({ where: { id: fixture.run.id } })).toMatchObject({
      status: "cancelled",
      error: stuckWorkStatusMessage("waiting_takeover"),
    });
    expect(
      await system.message.findFirstOrThrow({
        where: { threadId: fixture.thread.id, clientNonce: `stuck-expired:${fixture.run.id}` },
      }),
    ).toMatchObject({
      role: "system",
      blocks: [{ kind: "meta", text: stuckWorkStatusMessage("waiting_takeover") }],
    });
    expect(await fixture.control()).toMatchObject({ controlHolder: "none", controlLeaseId: null });
    const lease = await system.computerExecutionLease.findFirstOrThrow({
      where: { computerId: fixture.computer.id, botId: fixture.bot.id },
    });
    expect(lease.expiresAt.getTime()).toBeLessThanOrEqual(Date.now());
    expect(await system.run.findUniqueOrThrow({ where: { id: sent.runId } })).toMatchObject({
      status: "queued",
    });
  });

  it("keeps a takeover wait the user is on the screen for, even past the timeout", async () => {
    const fixture = await setup("opened", "routine");
    await system.computer.update({
      where: { id: fixture.computer.id },
      data: { controlLeaseExpiresAt: new Date(Date.now() + 2 * TAKEOVER_WAIT_EXPIRE_AFTER_MS) },
    });
    const before = await fixture.control();
    expect(await endWaits([fixture.run.id])).toBe(0);
    const run = await system.run.findUniqueOrThrow({ where: { id: fixture.run.id } });
    const expired = await runAsSystem("test expiry", () =>
      prisma.$transaction((tx) =>
        expireStuckRun(tx, {
          runId: run.id,
          threadId: run.threadId,
          status: "waiting_takeover",
          updatedAt: run.updatedAt,
          now: new Date(run.updatedAt.getTime() + TAKEOVER_WAIT_EXPIRE_AFTER_MS),
        }),
      ),
    );
    expect(expired).toBeNull();
    expect(await system.run.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({
      status: "waiting_takeover",
    });
    expect(await fixture.control()).toEqual(before);
  });

  it("keeps a taken wait while its lapsed screen lease is still being released", async () => {
    const fixture = await setup("opened", "routine");
    await system.computer.update({
      where: { id: fixture.computer.id },
      data: { controlLeaseExpiresAt: new Date(Date.now() - 1_000) },
    });
    expect(await endWaits([fixture.run.id])).toBe(0);
    // The expiry job is midway: input denied, provider revocation still pending.
    await system.computer.update({
      where: { id: fixture.computer.id },
      data: { controlHolder: "none" },
    });
    expect(await endWaits([fixture.run.id])).toBe(0);
    expect(await system.run.findUniqueOrThrow({ where: { id: fixture.run.id } })).toMatchObject({
      status: "waiting_takeover",
    });
  });

  it("does not end a wait once the user's takeover grant lands first", async () => {
    const fixture = await setup("unopened");
    expect((await fixture.call("takeover")).status).toBe(200);
    expect(await fixture.control()).toMatchObject({
      controlHolder: "user",
      controlBotId: fixture.bot.id,
    });
    expect(await endWaits([fixture.run.id])).toBe(0);
    expect(await system.run.findUniqueOrThrow({ where: { id: fixture.run.id } })).toMatchObject({
      status: "waiting_takeover",
    });
  });

  it("retries a failed screen revocation without losing or duplicating the steering message", async () => {
    const fixture = await setup();
    const revoke = vi
      .spyOn(fixture.sandbox, "setScreenControl")
      .mockRejectedValueOnce(new Error("Fixture revocation failed"));
    expect((await fixture.send({ clientNonce: "retry-reply" })).status).toBe(500);
    expect(await fixture.control()).toMatchObject({
      controlHolder: "user",
      controlLeaseId: fixture.leaseId,
    });
    expect(fixture.queuedStates).toEqual([]);
    expect((await fixture.send({ clientNonce: "retry-reply" })).status).toBe(200);
    expect(revoke).toHaveBeenCalledTimes(2);
    expect(await fixture.control()).toMatchObject({ controlHolder: "none", controlLeaseId: null });
    expect(
      await system.message.count({
        where: { threadId: fixture.thread.id, clientNonce: "retry-reply" },
      }),
    ).toBe(1);
    expect(await system.steeringMessage.count({ where: { runId: fixture.run.id } })).toBe(1);
    expect(
      await system.event.count({
        where: { runId: fixture.run.id, type: "computer.takeover.released" },
      }),
    ).toBe(1);
    expect(fixture.queuedStates).toEqual([
      expect.objectContaining({ status: "queued", checkpoint: "takeover" }),
      expect.objectContaining({ status: "queued", checkpoint: "takeover" }),
    ]);
  });

  it("keeps a later takeover when an already delivered reply is retried", async () => {
    const fixture = await setup();
    expect((await fixture.send({ clientNonce: "delivered-reply" })).status).toBe(200);
    await system.steeringMessage.updateMany({
      where: { runId: fixture.run.id },
      data: { claimedAt: new Date() },
    });
    await system.run.update({
      where: { id: fixture.run.id },
      data: { status: "waiting_takeover", checkpoint: null },
    });
    await system.computer.update({
      where: { id: fixture.computer.id },
      data: {
        controlHolder: "user",
        controlBotId: fixture.bot.id,
        controlLeaseId: randomUUID(),
        controlLeaseExpiresAt: new Date(Date.now() + 60_000),
      },
    });
    const before = await fixture.control();
    const revoke = vi.spyOn(fixture.sandbox, "setScreenControl");
    expect((await fixture.send({ clientNonce: "delivered-reply" })).status).toBe(200);
    expect(await fixture.control()).toEqual(before);
    expect(revoke).not.toHaveBeenCalled();
    expect(
      await system.event.count({
        where: { runId: fixture.run.id, type: "computer.takeover.released" },
      }),
    ).toBe(1);
  });

  /** Ada's takeover wait from setup() moves into a group where Ben works too. */
  async function groupWithWaitingRun() {
    const { actor, bot: ada, run, computer, sandbox, jobs, deps, control } = await setup();
    const { spaceId, userId } = actor;
    const bot = (name: string) =>
      system.bot.create({
        data: { spaceId, userId, name, color: "test", computerId: computer.id },
      });
    const [ben, cy] = [await bot("Ben"), await bot("Cy")];
    const group = await system.chatGroup.create({
      data: {
        spaceId,
        userId,
        name: "Crew",
        members: { create: [{ botId: ada.id }, { botId: ben.id }, { botId: cy.id }] },
        thread: { create: { spaceId, userId } },
      },
      include: { thread: true },
    });
    const threadId = group.thread!.id;
    await system.task.update({ where: { id: run.taskId }, data: { threadId } });
    await system.run.update({ where: { id: run.id }, data: { threadId } });
    const benTask = await system.task.create({
      data: { spaceId, userId, botId: ben.id, threadId, prompt: "Sign in.", status: "running" },
    });
    const benRun = await system.run.create({
      data: {
        spaceId,
        userId,
        botId: ben.id,
        threadId,
        taskId: benTask.id,
        status: "running",
        trigger: "user",
      },
    });
    const leaseOf = (botId: string) =>
      system.computerExecutionLease.findUniqueOrThrow({
        where: { computerId_botId: { computerId: computer.id, botId } },
      });
    const adaLease = await leaseOf(ada.id);
    const benLease = await system.computerExecutionLease.create({
      data: {
        computerId: computer.id,
        botId: ben.id,
        runId: benRun.id,
        fence: 1,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    const removeAda = { groupId: group.id, botIds: [ben.id, cy.id] };
    const saveFromSettings = async (prismaClient = prisma, route = "update") => {
      const { response } = await new RPCHandler(
        createRouter({ ...deps, prisma: prismaClient }),
      ).handle(
        new Request(`http://127.0.0.1/rpc/groups/${route}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ json: route === "update" ? removeAda : { groupId: group.id } }),
        }),
        { prefix: "/rpc", context: { actor } },
      );
      expect(response?.status).toBe(200);
    };
    const saveFromManager = (prismaClient = prisma) =>
      runAsTenant(actor, () =>
        updateFleetGroup(
          { prisma: prismaClient, events: createThreadEvents(prisma), jobs, sandbox },
          {
            spaceId,
            userId,
            botId: cy.id,
            groupId: null,
            threadId: randomUUID(),
            runId: randomUUID(),
          },
          { ...removeAda, expectedBotIds: [ada.id, ben.id, cy.id] },
        ),
      );
    /** The removed bot's next chat gets the computer now, not when the takeover hold ends. */
    const expectComputerFreed = async () => {
      await expect(
        runAsSystem("test lease", () =>
          acquireComputerExecutionLease(prisma, {
            computerId: computer.id,
            runId: randomUUID(),
            botId: ada.id,
          }),
        ),
      ).resolves.toMatchObject({ fence: 2 });
      // Ben stays in the group, so his run keeps its computer.
      expect(await leaseOf(ben.id)).toEqual(benLease);
    };
    const groupUpdates = () => system.event.count({ where: { threadId, type: "group.updated" } });
    return {
      providerRef: (await control()).providerRef,
      computer,
      ada,
      run,
      adaLease,
      jobs,
      sandbox,
      saveFromSettings,
      saveFromManager,
      expectComputerFreed,
      groupUpdates,
    };
  }

  it.each(["the group settings", "a manager bot"])(
    "stops and frees the computer of a bot %s removes while it waits for takeover",
    async (path) => {
      const fixture = await groupWithWaitingRun();
      const { ada, run } = fixture;
      const execute = vi.spyOn(fixture.sandbox, "execute");
      const releaseScreen = vi.spyOn(fixture.sandbox, "releaseScreen");

      if (path === "the group settings") {
        // Two saves of the same removal race; only the one that cancels the run tears it down.
        await Promise.all([fixture.saveFromSettings(), fixture.saveFromSettings()]);
      } else {
        await expect(fixture.saveFromManager()).resolves.toMatchObject({ ok: true });
      }

      expect(vi.mocked(fixture.jobs.cancel).mock.calls).toEqual([[runJobKey(run.id)]]);
      expect(execute).toHaveBeenCalledWith(
        expect.objectContaining({ providerRef: fixture.providerRef }),
        expect.objectContaining({ argv: cancelComputerRunWorkArgv(fixture.computer.id, run.id) }),
        expect.anything(),
      );
      expect(releaseScreen).toHaveBeenCalledTimes(1);
      expect(releaseScreen).toHaveBeenCalledWith(
        expect.objectContaining({ providerRef: fixture.providerRef }),
        expect.objectContaining({
          spaceId: ada.spaceId,
          botId: ada.id,
          runId: run.id,
          screenLeaseId: screenLeaseIdForRun(fixture.adaLease, run.id),
          cancelRunWork: true,
        }),
      );
      await fixture.expectComputerFreed();
    },
  );

  it("frees the removed bot's computer even when releasing its screen fails", async () => {
    const fixture = await groupWithWaitingRun();
    vi.spyOn(fixture.sandbox, "releaseScreen").mockRejectedValue(new Error("provider unavailable"));

    await fixture.saveFromSettings();
    await fixture.expectComputerFreed();
  });

  it.each(["update", "archive"])(
    "tears down a group run that takes its computer while groups/%s is saving",
    async (route) => {
      const fixture = await groupWithWaitingRun();
      const { ada, run, computer } = fixture;
      // Ada's run is executing and has not taken its computer yet.
      await system.computerExecutionLease.delete({ where: { id: fixture.adaLease.id } });
      await system.run.update({
        where: { id: run.id },
        data: {
          status: "running",
          leaseOwner: "worker",
          leaseFence: 1,
          leaseExpiresAt: new Date(Date.now() + 60_000),
        },
      });
      const releaseScreen = vi.spyOn(fixture.sandbox, "releaseScreen");
      let executorAcquire: unknown;

      await fixture.saveFromSettings(
        afterFirstRead(prisma, "computerExecutionLease", async () => {
          executorAcquire = await runAsSystem("test lease", () =>
            acquireComputerExecutionLease(prisma, {
              computerId: computer.id,
              runId: run.id,
              botId: ada.id,
              workerId: "worker",
              runFence: 1,
            }),
          ).catch((error: unknown) => error);
        }),
        route,
      );

      // Either the save kept the run off the computer, or it tore that computer down.
      const tornDown = releaseScreen.mock.calls.some(([, context]) => context.runId === run.id);
      expect(executorAcquire instanceof ComputerBusyError || tornDown).toBe(true);
    },
  );

  it.each(["update", "archive"])(
    "keeps the failure of a group run that ends while groups/%s is saving",
    async (route) => {
      const fixture = await groupWithWaitingRun();
      const attempt = await system.attempt.create({
        data: { runId: fixture.run.id, fence: 1, status: "running" },
      });
      const run = await system.run.update({
        where: { id: fixture.run.id },
        data: { status: "running", leaseOwner: "worker", leaseFence: 1 },
      });
      const releaseScreen = vi.spyOn(fixture.sandbox, "releaseScreen");

      // The run fails after the save read it as active and before the save cancels it.
      await fixture.saveFromSettings(
        afterFirstRead(prisma, "run", () =>
          runAsSystem("test worker", () =>
            createThreadEvents(prisma).finalizeRun({
              spaceId: run.spaceId,
              threadId: run.threadId,
              botId: run.botId,
              runId: run.id,
              taskId: run.taskId,
              attemptId: attempt.id,
              leaseOwner: "worker",
              leaseFence: 1,
              outcome: "failed",
              error: "The model provider is unavailable.",
            }),
          ),
        ),
        route,
      );

      expect(await system.run.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({
        status: "failed",
        error: "The model provider is unavailable.",
      });
      expect(await system.task.findUniqueOrThrow({ where: { id: run.taskId } })).toMatchObject({
        status: "failed",
      });
      expect(vi.mocked(fixture.jobs.cancel).mock.calls).not.toContainEqual([runJobKey(run.id)]);
      expect(releaseScreen.mock.calls.some(([, context]) => context.runId === run.id)).toBe(false);
    },
  );

  it("still announces a manager bot's group change when freeing the computer fails", async () => {
    const fixture = await groupWithWaitingRun();
    const leaseWriteFails = new Proxy(prisma, {
      get(client, key) {
        if (key === "computerExecutionLease") {
          return {
            updateMany: async () => {
              throw new Error("database unavailable");
            },
          };
        }
        const value = Reflect.get(client, key, client);
        return typeof value === "function" ? value.bind(client) : value;
      },
    });

    await fixture.saveFromManager(leaseWriteFails).catch(() => undefined);
    expect(await fixture.groupUpdates()).toBe(1);
  });
});

/** Runs `after` once, right after the first transaction reads `model`. */
function afterFirstRead(
  prisma: PrismaClient,
  model: "computerExecutionLease" | "run",
  after: () => Promise<unknown>,
): PrismaClient {
  let pending = true;
  const hooked = (tx: Prisma.TransactionClient) => {
    const reads = new Proxy(tx[model], {
      get(delegate, key) {
        const value = Reflect.get(delegate, key, delegate);
        if (key !== "findMany") return typeof value === "function" ? value.bind(delegate) : value;
        return async (args: unknown) => {
          const rows = await value.call(delegate, args);
          if (pending) {
            pending = false;
            await after();
          }
          return rows;
        };
      },
    });
    return new Proxy(tx, {
      get(client, key) {
        if (key === model) return reads;
        const value = Reflect.get(client, key, client);
        return typeof value === "function" ? value.bind(client) : value;
      },
    });
  };
  return new Proxy(prisma, {
    get(client, key) {
      const value = Reflect.get(client, key, client);
      if (key !== "$transaction") return typeof value === "function" ? value.bind(client) : value;
      const transaction = value as (input: unknown, options?: unknown) => Promise<unknown>;
      return (input: unknown, options?: unknown) =>
        transaction.call(
          client,
          typeof input === "function" ? (tx: Prisma.TransactionClient) => input(hooked(tx)) : input,
          options,
        );
    },
  });
}
