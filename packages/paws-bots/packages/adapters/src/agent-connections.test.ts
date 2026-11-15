import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { RunHistoryWriteError } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import type { AgentConnectionDeps } from "./agent-connections.js";
import {
  connectAgent,
  messageConnectedAgent,
  prepareAgentConnectionResponse,
  respondAgentConnection,
} from "./agent-connections.js";

const requesterIdentity = {
  id: "mi-1",
  provider: "sendblue",
  address: "+15551111111",
  dmThreadId: "sendblue:dm-1",
  userId: "user-1",
  spaceId: "ws-1",
  botId: "bot-1",
  outboundSinceInbound: 0,
};
const targetIdentity = {
  id: "mi-2",
  provider: "sendblue",
  address: "+15552222222",
  dmThreadId: "sendblue:dm-2",
  userId: "user-2",
  spaceId: "ws-2",
  botId: "bot-2",
  outboundSinceInbound: 0,
};

function createDeps(
  overrides: {
    blockedBot?: "bot-1" | "bot-2";
    disabledInsideTx?: boolean;
    connection?: Record<string, unknown> | null;
    pendingConnection?: Record<string, unknown> | null;
    sourceHop?: number;
    /** Simulates a revoke landing between the pre-check and the transaction. */
    connectionRevokedInsideTx?: boolean;
    /** Simulates a revoke landing after the in-transaction approval read. */
    connectionRevokedAfterReadInsideTx?: boolean;
    /** A newer claim of the sending run holds this lease. */
    runLease?: { leaseOwner: string; leaseFence: number };
  } = {},
) {
  const policyRows = () =>
    ["bot-1", "bot-2"].map((id) => ({
      id,
      spaceId: id === "bot-1" ? "ws-1" : "ws-2",
      crossSpaceCommunication: id !== overrides.blockedBot,
      archivedAt: null,
    }));
  const outboundRows: Array<Record<string, unknown>> = [];
  const txCalls = {
    messageCreate: [] as unknown[],
    runCreate: [] as unknown[],
    taskCreate: [] as unknown[],
  };
  const txMock = {
    message: {
      findUnique: vi.fn(async () => null),
      create: vi.fn(async ({ data }: { data: unknown }) => {
        txCalls.messageCreate.push(data);
        return { id: `msg-${txCalls.messageCreate.length}`, ...(data as object) };
      }),
      update: vi.fn(async () => ({})),
    },
    run: {
      findFirst: vi.fn(async () => ({ id: "run-1" })),
      create: vi.fn(async ({ data }: { data: unknown }) => {
        txCalls.runCreate.push(data);
        return { id: "run-wake", ...(data as object) };
      }),
      findUnique: vi.fn(async () => ({ id: "run-1", status: "running", ...overrides.runLease })),
    },
    task: {
      create: vi.fn(async ({ data }: { data: unknown }) => {
        txCalls.taskCreate.push(data);
        return { id: "task-1", ...(data as object) };
      }),
    },
    event: {
      create: vi.fn(async ({ data }: { data: object }) => ({ id: "evt-1", seq: 8, ...data })),
    },
    thread: { update: vi.fn(async () => ({ nextMessageSeq: 4, nextEventSeq: 9 })) },
    bot: { findFirst: vi.fn(async () => ({ id: "bot-2" })) },
    // What a `SELECT ... FOR UPDATE` on the connection row would see.
    $executeRaw: vi.fn(async () => 0),
    $queryRaw: vi.fn(async (query: TemplateStringsArray) => {
      if (query.join("").includes("FROM bots"))
        return policyRows().map((bot) => ({
          ...bot,
          crossSpaceCommunication: overrides.disabledInsideTx ? false : bot.crossSpaceCommunication,
        }));
      if (overrides.connectionRevokedInsideTx || overrides.connectionRevokedAfterReadInsideTx) {
        return [{ status: "revoked" }];
      }
      if (overrides.connection && typeof overrides.connection === "object") {
        return [{ status: (overrides.connection as { status: string }).status }];
      }
      return [{ status: "approved" }];
    }),
  };
  const connection = overrides.connection === undefined ? null : overrides.connection;
  const prisma = {
    messagingIdentity: {
      findUnique: vi.fn(
        async ({
          where,
        }: {
          where: {
            botId?: string;
            id?: string;
            provider_address?: { provider: string; address: string };
          };
        }) => {
          // Target lookups are provider-scoped: addresses are only unique
          // within a platform.
          if (where.provider_address) {
            if (where.provider_address.provider !== "sendblue") return null;
            if (where.provider_address.address === "+15552222222") return targetIdentity;
            if (where.provider_address.address === "+15551111111") return requesterIdentity;
            return null;
          }
          if (where.botId === "bot-2" || where.id === "mi-2") return targetIdentity;
          if (where.botId === "bot-1" || where.id === "mi-1") return requesterIdentity;
          return null;
        },
      ),
    },
    bot: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        where.id === "bot-2"
          ? {
              id: "bot-2",
              name: "Helper",
              spaceId: "ws-2",
              userId: "user-2",
              archivedAt: null,
              thread: { id: "thread-2" },
            }
          : { id: "bot-1", name: "Assistant", spaceId: "ws-1", userId: "user-1" },
      ),
    },
    agentConnection: {
      findUnique: vi.fn(async () => connection),
      findFirst: vi.fn(async ({ where }: { where?: { status?: string } }) => {
        if (where?.status === "approved") {
          return connection && (connection as { status?: string }).status === "approved"
            ? connection
            : null;
        }
        return overrides.pendingConnection === undefined ? null : overrides.pendingConnection;
      }),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: "ac-1",
        status: "pending",
        ...data,
      })),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: unknown }) => ({
        id: where.id,
        ...(data as object),
      })),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    messagingOutbound: {
      createMany: vi.fn(async ({ data }: { data: Array<Record<string, unknown>> }) => {
        outboundRows.push(...data);
        return { count: data.length };
      }),
      deleteMany: vi.fn(async ({ where }: { where: { idempotencyKey?: string } }) => {
        const before = outboundRows.length;
        for (let i = outboundRows.length - 1; i >= 0; i -= 1) {
          if (outboundRows[i]!.idempotencyKey === where.idempotencyKey) outboundRows.splice(i, 1);
        }
        return { count: before - outboundRows.length };
      }),
    },
    message: {
      findUnique: vi.fn(async () =>
        overrides.sourceHop != null
          ? { blocks: [{ kind: "bot_message_received", hop: overrides.sourceHop }] }
          : null,
      ),
    },
    user: { findUnique: vi.fn(async () => ({ id: "user-1", name: "Alice Owner" })) },
    thread: { findFirst: vi.fn(async () => ({ id: "thread-2" })) },
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(txMock)),
    $executeRaw: vi.fn(async () => 0),
    $queryRaw: vi.fn(async (query: TemplateStringsArray) =>
      query.join("").includes("FROM bots") ? policyRows() : txMock.$queryRaw(query),
    ),
  };
  // connectAgent claim+invite runs on the transaction client.
  Object.assign(txMock, {
    agentConnection: prisma.agentConnection,
    messagingOutbound: prisma.messagingOutbound,
  });
  const sendUserMessage = vi.fn(async () => ({ messageId: "m", runId: "r", seq: 1 }));
  const notify = vi.fn(async () => undefined);
  const enqueue = vi.fn(async () => undefined);
  // Records rows the way the delivery path does: a replaced key starts a fresh row.
  const messagingDelivery = {
    recordIn: vi.fn(
      async (
        tx: { messagingOutbound: typeof prisma.messagingOutbound },
        _lane: unknown,
        rows: Array<Record<string, unknown>>,
        options: { replace?: boolean } = {},
      ) => {
        for (const row of rows) {
          if (options.replace)
            await tx.messagingOutbound.deleteMany({
              where: { idempotencyKey: row.idempotencyKey as string },
            });
          await tx.messagingOutbound.createMany({ data: [row] });
        }
        return rows.map((_row, index) => `out-${index}`);
      },
    ),
    send: vi.fn(async () => undefined),
  };
  return {
    prisma: prisma as unknown as PrismaClient & typeof prisma,
    events: { sendUserMessage, notify } as unknown as Pick<
      ThreadEvents,
      "sendUserMessage" | "notify"
    >,
    jobs: { enqueue },
    messagingDelivery: messagingDelivery as typeof messagingDelivery &
      NonNullable<AgentConnectionDeps["messagingDelivery"]>,
    outboundRows,
    txCalls,
    notify,
    enqueue,
  };
}

const run = {
  id: "run-1",
  spaceId: "ws-1",
  threadId: "thread-1",
  botId: "bot-1",
  userId: "user-1",
  sourceMessageId: null,
};
const sender = { id: "bot-1", name: "Assistant" };

describe("connectAgent", () => {
  it("creates a pending connection and messages the target owner for approval", async () => {
    const deps = createDeps();
    const result = await connectAgent(deps, run, sender, { address: "+15552222222" });

    expect(result).toEqual({ ok: true, status: "pending" });
    expect(deps.prisma.agentConnection.create).toHaveBeenCalledWith({
      data: { requesterBotId: "bot-1", targetBotId: "bot-2", status: "pending" },
    });
    expect(deps.outboundRows).toEqual([
      expect.objectContaining({
        kind: "dm",
        identityId: "mi-2",
        body: expect.stringMatching(/YES/),
      }),
    ]);
    expect(deps.messagingDelivery.send).toHaveBeenCalledWith([{ identityId: "mi-2" }]);
  });

  it("treats a concurrent first-time create as pending when the unique key loses", async () => {
    const deps = createDeps();
    deps.prisma.agentConnection.create = vi.fn(async () => {
      throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
    }) as unknown as typeof deps.prisma.agentConnection.create;
    deps.prisma.agentConnection.findUnique = vi.fn().mockResolvedValueOnce(null).mockResolvedValue({
      id: "ac-1",
      requesterBotId: "bot-1",
      targetBotId: "bot-2",
      status: "pending",
    }) as unknown as typeof deps.prisma.agentConnection.findUnique;

    const result = await connectAgent(deps, run, sender, { address: "+15552222222" });

    expect(result).toEqual({ ok: true, status: "pending" });
    // Winner owns the invite write; the loser must not double-queue.
    expect(deps.outboundRows).toHaveLength(0);
  });

  it("rejects unknown addresses, self-connections, and repeat requests", async () => {
    const unknown = createDeps();
    expect(await connectAgent(unknown, run, sender, { address: "+15559999999" })).toEqual(
      expect.objectContaining({ ok: false }),
    );

    const self = createDeps();
    expect(await connectAgent(self, run, sender, { address: "+15551111111" })).toEqual(
      expect.objectContaining({ ok: false, error: expect.stringMatching(/itself|self/i) }),
    );

    const declined = createDeps({
      connection: { id: "ac-1", requesterBotId: "bot-1", targetBotId: "bot-2", status: "declined" },
    });
    const reinvite = await connectAgent(declined, run, sender, { address: "+15552222222" });
    expect(reinvite).toEqual(expect.objectContaining({ ok: true, status: "pending" }));
    expect(declined.prisma.agentConnection.update).toHaveBeenCalledWith({
      where: { id: "ac-1" },
      data: { status: "pending", requestVersion: { increment: 1 } },
    });
    expect(declined.outboundRows).toEqual([
      expect.objectContaining({ kind: "dm", identityId: "mi-2" }),
    ]);

    const approved = createDeps({
      connection: { id: "ac-1", requesterBotId: "bot-1", targetBotId: "bot-2", status: "approved" },
    });
    const result = await connectAgent(approved, run, sender, { address: "+15552222222" });
    expect(result).toEqual({ ok: true, status: "approved" });
    expect(approved.prisma.agentConnection.create).not.toHaveBeenCalled();
  });

  it("does not reopen a connection when the locked row is already revoked", async () => {
    const deps = createDeps({
      connection: { id: "ac-1", requesterBotId: "bot-1", targetBotId: "bot-2", status: "declined" },
      connectionRevokedInsideTx: true,
    });

    const result = await connectAgent(deps, run, sender, { address: "+15552222222" });

    expect(result).toEqual({ ok: false, error: "connection changed; try again" });
    expect(deps.outboundRows).toHaveLength(0);
    expect(deps.prisma.agentConnection.update).not.toHaveBeenCalled();
  });
});

describe("respondAgentConnection", () => {
  it("approves a pending connection addressed to the current bot", async () => {
    const deps = createDeps({
      pendingConnection: {
        id: "ac-1",
        requesterBotId: "bot-2",
        targetBotId: "bot-1",
        status: "pending",
      },
    });
    const result = await respondAgentConnection(deps, run, sender, {
      accept: true,
      connectionId: "ac-1",
      connectionVersion: 1,
    });

    expect(result).toEqual(expect.objectContaining({ ok: true, status: "approved" }));
    expect(deps.prisma.agentConnection.updateMany).toHaveBeenCalledWith({
      where: { id: "ac-1", status: "pending", requestVersion: 1 },
      data: { status: "approved" },
    });
  });

  it("fails when nothing is pending", async () => {
    const deps = createDeps();
    const result = await respondAgentConnection(deps, run, sender, {
      accept: false,
      connectionId: "ac-1",
      connectionVersion: 1,
    });
    expect(result).toEqual(expect.objectContaining({ ok: false }));
  });
});

describe("messageConnectedAgent", () => {
  it("delivers across workspaces over an approved connection", async () => {
    const deps = createDeps({
      connection: { id: "ac-1", requesterBotId: "bot-1", targetBotId: "bot-2", status: "approved" },
    });
    const result = await messageConnectedAgent(deps, run, sender, {
      address: "+15552222222",
      message: "results are in",
      deliveryKey: "exec-9",
    });

    expect(result).toEqual(expect.objectContaining({ ok: true, botId: "bot-2" }));
    const inbound = deps.txCalls.messageCreate[0] as Record<string, unknown>;
    expect(inbound.threadId).toBe("thread-2");
    expect(inbound.role).toBe("user");
    expect(inbound.blocks).toEqual([
      {
        kind: "bot_message_received",
        fromBotId: "bot-1",
        fromBotName: "Assistant",
        text: "results are in",
        hop: 1,
      },
    ]);
    const wake = deps.txCalls.runCreate[0] as Record<string, unknown>;
    expect(wake).toEqual(
      expect.objectContaining({
        spaceId: "ws-2",
        userId: "user-2",
        botId: "bot-2",
        trigger: "bot_message",
      }),
    );
    expect(deps.enqueue).toHaveBeenCalled();
    expect(deps.prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      timeout: 20_000,
    });
  });

  it("does not deliver from an attempt a newer claim superseded", async () => {
    const deps = createDeps({
      connection: { id: "ac-1", requesterBotId: "bot-1", targetBotId: "bot-2", status: "approved" },
      runLease: { leaseOwner: "worker-2", leaseFence: 2 },
    });
    await expect(
      messageConnectedAgent(
        { ...deps, runLease: { runId: run.id, owner: "worker-1", fence: 1 } },
        run,
        sender,
        { address: "+15552222222", message: "results are in" },
      ),
    ).rejects.toBeInstanceOf(RunHistoryWriteError);
    expect(deps.enqueue).not.toHaveBeenCalled();
  });

  it("delivers repeated messages when each call has a distinct deliveryKey", async () => {
    const deps = createDeps({
      connection: { id: "ac-1", requesterBotId: "bot-1", targetBotId: "bot-2", status: "approved" },
    });
    const first = await messageConnectedAgent(deps, run, sender, {
      address: "+15552222222",
      message: "one",
      deliveryKey: "run-1:message_agent:0",
    });
    const second = await messageConnectedAgent(deps, run, sender, {
      address: "+15552222222",
      message: "two",
      deliveryKey: "run-1:message_agent:1",
    });
    expect(first).toEqual(expect.objectContaining({ ok: true }));
    expect(second).toEqual(expect.objectContaining({ ok: true }));
    const inboundNonces = deps.txCalls.messageCreate
      .map((row) => row as { clientNonce?: string; role?: string })
      .filter((row) => row.clientNonce)
      .map((row) => row.clientNonce);
    expect(inboundNonces).toEqual([
      "agent-message:run-1:message_agent:0",
      "agent-message:run-1:message_agent:1",
    ]);
  });

  it("refuses without an approved connection", async () => {
    const deps = createDeps();
    const result = await messageConnectedAgent(deps, run, sender, {
      address: "+15552222222",
      message: "hello?",
    });
    expect(result).toEqual(
      expect.objectContaining({ ok: false, error: expect.stringMatching(/reached/i) }),
    );
    expect(deps.txCalls.messageCreate).toHaveLength(0);
  });

  it("refuses when the hop budget is exhausted", async () => {
    const deps = createDeps({
      connection: { id: "ac-1", requesterBotId: "bot-1", targetBotId: "bot-2", status: "approved" },
      sourceHop: 6,
    });
    const result = await messageConnectedAgent(
      deps,
      { ...run, sourceMessageId: "msg-src" },
      sender,
      { address: "+15552222222", message: "again" },
    );
    expect(result).toEqual(
      expect.objectContaining({ ok: false, error: expect.stringMatching(/limit/i) }),
    );
  });
});

describe("agent connection status races", () => {
  it("does not overwrite a concurrent revoke when the target responds", async () => {
    const deps = createDeps();
    const state = {
      id: "ac-1",
      requesterBotId: "bot-2",
      targetBotId: "bot-1",
      status: "pending",
    };
    const connectionModel = deps.prisma.agentConnection as unknown as Record<string, unknown>;
    connectionModel.findFirst = vi.fn(async ({ where }: { where?: { status?: string } }) => {
      if (where?.status === "pending" && state.status === "pending") {
        const snapshot = { ...state };
        // Interleaved: the owner revokes between the read and the write.
        state.status = "revoked";
        return snapshot;
      }
      return null;
    });
    connectionModel.updateMany = vi.fn(
      async ({ where, data }: { where: { status?: string }; data: Record<string, unknown> }) => {
        if (where.status && state.status !== where.status) return { count: 0 };
        Object.assign(state, data);
        return { count: 1 };
      },
    );
    const result = await respondAgentConnection(deps, run, sender, {
      accept: true,
      connectionId: "ac-1",
      connectionVersion: 1,
    });

    expect(result).toEqual(expect.objectContaining({ ok: false }));
    expect(state.status).toBe("revoked");
  });

  it("refuses delivery when the connection is revoked before the transaction commits", async () => {
    const deps = createDeps({
      connection: { id: "ac-1", requesterBotId: "bot-1", targetBotId: "bot-2", status: "approved" },
      connectionRevokedInsideTx: true,
    });
    const result = await messageConnectedAgent(deps, run, sender, {
      address: "+15552222222",
      message: "still there?",
    });

    expect(result).toEqual(
      expect.objectContaining({ ok: false, error: expect.stringMatching(/approved/i) }),
    );
    expect(deps.txCalls.messageCreate).toHaveLength(0);
    expect(deps.txCalls.taskCreate).toHaveLength(0);
    expect(deps.txCalls.runCreate).toHaveLength(0);
    expect(deps.enqueue).not.toHaveBeenCalled();
  });
});

describe("agent connection enumeration and sender gating", () => {
  it("gives one generic answer for unregistered and unconnected addresses", async () => {
    const unregistered = await messageConnectedAgent(createDeps(), run, sender, {
      address: "+15550000000",
      message: "hi",
    });
    const unconnected = await messageConnectedAgent(createDeps(), run, sender, {
      address: "+15552222222",
      message: "hi",
    });

    expect(unregistered.ok).toBe(false);
    expect(unconnected.ok).toBe(false);
    // A registered-but-unconnected address must be indistinguishable from an
    // unregistered one (mirrors connect_agent's anti-enumeration contract).
    expect((unregistered as { error: string }).error).toBe(
      (unconnected as { error: string }).error,
    );
  });

  it("refuses connection requests from bots without a messaging identity", async () => {
    const deps = createDeps();
    const result = await connectAgent(
      deps,
      run,
      { id: "bot-3", name: "Rogue" },
      {
        address: "+15552222222",
      },
    );

    expect(result).toEqual(expect.objectContaining({ ok: false }));
    expect(deps.outboundRows).toHaveLength(0);
    expect(deps.prisma.agentConnection.create).not.toHaveBeenCalled();
  });

  it("refuses connected messages from bots without a messaging identity", async () => {
    const deps = createDeps({
      connection: { id: "ac-1", requesterBotId: "bot-3", targetBotId: "bot-2", status: "approved" },
    });
    const result = await messageConnectedAgent(
      deps,
      { ...run, botId: "bot-3" },
      { id: "bot-3", name: "Rogue" },
      { address: "+15552222222", message: "hi" },
    );

    expect(result).toEqual(expect.objectContaining({ ok: false }));
    expect(deps.txCalls.messageCreate).toHaveLength(0);
  });
});

describe("messageConnectedAgent revocation locking", () => {
  it("aborts delivery when a revoke lands after the in-transaction approval read", async () => {
    const deps = createDeps({
      connection: { id: "ac-1", requesterBotId: "bot-1", targetBotId: "bot-2", status: "approved" },
      connectionRevokedAfterReadInsideTx: true,
    });
    const result = await messageConnectedAgent(deps, run, sender, {
      address: "+15552222222",
      message: "still there?",
    });

    // A plain re-read cannot serialize against the concurrent revoke; only a
    // row lock (or conditional claim) inside the transaction can.
    expect(result).toEqual(
      expect.objectContaining({ ok: false, error: expect.stringMatching(/approved/i) }),
    );
    expect(deps.txCalls.messageCreate).toHaveLength(0);
    expect(deps.txCalls.taskCreate).toHaveLength(0);
    expect(deps.txCalls.runCreate).toHaveLength(0);
    expect(deps.enqueue).not.toHaveBeenCalled();
  });
});

describe("cross-space communication permission", () => {
  it.each(["bot-1", "bot-2"] as const)(
    "blocks requests when %s has not opted in",
    async (blockedBot) => {
      const deps = createDeps({ blockedBot });
      expect(await connectAgent(deps, run, sender, { address: targetIdentity.address })).toEqual({
        ok: false,
        error: "no agent can be reached at that address",
      });
      expect(deps.prisma.agentConnection.create).not.toHaveBeenCalled();
      expect(deps.outboundRows).toHaveLength(0);
    },
  );
  it.each(["bot-1", "bot-2"] as const)(
    "blocks an approved connection when %s opts out",
    async (blockedBot) => {
      const deps = createDeps({ blockedBot, connection: { id: "ac-1", status: "approved" } });
      expect(
        await messageConnectedAgent(deps, run, sender, {
          address: targetIdentity.address,
          message: "Private text",
        }),
      ).toEqual({ ok: false, error: "no agent can be reached at that address" });
      expect(deps.txCalls.messageCreate).toHaveLength(0);
      expect(deps.txCalls.runCreate).toHaveLength(0);
    },
  );
  it("checks permission again inside the request transaction", async () => {
    const deps = createDeps({ disabledInsideTx: true });
    expect(
      await connectAgent(deps, run, sender, { address: targetIdentity.address }),
    ).toMatchObject({ ok: false });
    expect(deps.prisma.agentConnection.create).not.toHaveBeenCalled();
  });
  it("does not approve a connection after opt-out", async () => {
    const deps = createDeps({
      blockedBot: "bot-1",
      pendingConnection: {
        id: "ac-1",
        requesterBotId: "bot-2",
        targetBotId: "bot-1",
        status: "pending",
      },
    });
    expect(
      await respondAgentConnection(deps, run, sender, {
        accept: true,
        connectionId: "ac-1",
        connectionVersion: 1,
      }),
    ).toMatchObject({
      ok: false,
    });
    expect(deps.prisma.agentConnection.updateMany).not.toHaveBeenCalled();
  });
});

it("keeps a confirmed connection response bound to its original request", async () => {
  const deps = createDeps();
  deps.prisma.agentConnection.findFirst.mockResolvedValueOnce(null);
  expect(
    await respondAgentConnection(deps, run, sender, {
      accept: true,
      connectionId: "original-request",
      connectionVersion: 1,
    }),
  ).toMatchObject({ ok: false });
  expect(deps.prisma.agentConnection.findFirst).toHaveBeenCalledWith(
    expect.objectContaining({
      where: {
        targetBotId: sender.id,
        status: "pending",
        id: "original-request",
        requestVersion: 1,
      },
    }),
  );
  expect(deps.prisma.agentConnection.updateMany).not.toHaveBeenCalled();
});

it("rejects an approval when the same connection is reopened during the approval write", async () => {
  const deps = createDeps({
    pendingConnection: {
      id: "ac-1",
      requesterBotId: "bot-2",
      targetBotId: "bot-1",
      status: "pending",
      requestVersion: 1,
    },
  });
  // The pending read saw the original request; revoke + reconnect replaces it before the write.
  const replacement = { status: "pending", requestVersion: 2 };
  deps.prisma.agentConnection.updateMany = vi.fn(
    async ({ where }: { where: { requestVersion: number; status: string } }) => ({
      count:
        where.requestVersion === replacement.requestVersion && where.status === replacement.status
          ? 1
          : 0,
    }),
  ) as never;
  expect(
    await respondAgentConnection(deps, run, sender, {
      accept: true,
      connectionId: "ac-1",
      connectionVersion: 1,
    }),
  ).toMatchObject({ ok: false });
  expect(deps.prisma.agentConnection.updateMany).toHaveBeenCalledWith({
    where: { id: "ac-1", status: "pending", requestVersion: 1 },
    data: { status: "approved" },
  });
  expect(replacement.status).toBe("pending");
});

it("captures the requester and decision with the request version for approval", async () => {
  const deps = createDeps({
    pendingConnection: {
      id: "request-1",
      requestVersion: 3,
      requesterBotId: "bot-2",
      targetBotId: "bot-1",
      status: "pending",
    },
  });
  const captured = await prepareAgentConnectionResponse(deps.prisma, "bot-1", false);
  expect(captured).toEqual({
    accept: false,
    connection_id: "request-1",
    connection_version: 3,
    requester_name: "Helper",
    requester_address: targetIdentity.address,
    requester_provider: targetIdentity.provider,
  });
  deps.prisma.agentConnection.findFirst.mockResolvedValueOnce({
    id: "request-2",
    requestVersion: 1,
    requesterBotId: "bot-1",
  } as never);
  await prepareAgentConnectionResponse(deps.prisma, "bot-1", true);
  expect(captured).toMatchObject({
    connection_id: "request-1",
    connection_version: 3,
    requester_name: "Helper",
  });
});
