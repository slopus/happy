import type { Actor, Bot } from "@rakazo/contracts";
import { AgentImportCreateInput } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import type { AgentImportServices } from "./agent-import.js";
import { agentImportSetupState, createImportedBot, requestDigest } from "./agent-import.js";

const actor: Actor = {
  userId: "user-1",
  spaceId: "space-1",
  email: "user@example.test",
  isDeploymentOwner: false,
};

/**
 * A Prisma stand-in: writes echo their data with an id and are kept; `findFirst` by id finds
 * a kept row, other reads find nothing.
 */
function fakeDb(): never {
  let next = 0;
  const rows = new Map<string, Record<string, unknown>>();
  const model = (name: string) =>
    new Proxy(
      {},
      {
        get:
          (_, method: string) =>
          async (args?: { data?: Record<string, unknown>; where?: { id?: unknown } }) => {
            if (method === "findMany") return [];
            if (method === "findFirst" && typeof args?.where?.id === "string") {
              return rows.get(args.where.id) ?? null;
            }
            if (method.startsWith("find")) {
              return method === "findFirstOrThrow" ? { id: `${name}-thread` } : null;
            }
            next += 1;
            const row = {
              id: `${name}-${next}`,
              revision: 1,
              content: "",
              updatedAt: new Date(0),
              ...args?.data,
            };
            rows.set(row.id, row);
            return row;
          },
      },
    );
  // Raw statements (marking a chat unread for the Space's members) find nothing.
  return new Proxy(
    {},
    { get: (_, name: string) => (name.startsWith("$") ? async () => [] : model(name)) },
  ) as never;
}

const bot = { id: "bot-1", threadId: "thread-1", name: "Imported" } as Bot;

function services(overrides: Partial<AgentImportServices>): AgentImportServices {
  const db = fakeDb();
  return {
    prisma: db,
    createBot: async (_actor, input) => {
      await input.seed(db, bot.id);
      return bot;
    },
    hasModelConnection: async () => false,
    connectedProviders: async () => new Set(),
    mcpCredentialValues: async () => null,
    validateBotModel: async () => "Connect that model provider first",
    stdioAllowed: async () => () => false,
    prepareModelKey: async () => ({}),
    writeModelKey: async () => ({ id: "cred-1", secretId: "secret-1", provider: "openrouter" }),
    afterModelKey: () => undefined,
    prepareMcpServer: async () => null,
    insertMcpServer: async () => {
      throw new Error("not used");
    },
    findBot: async () => bot,
    assertRoutineSchedule: () => undefined,
    routineNextRunAt: () => null,
    routineRowData: (_actor, input) => ({ ...input }) as never,
    announceRoutine: async () => undefined,
    notifyThread: async () => undefined,
    ...overrides,
  };
}

const input = AgentImportCreateInput.parse({
  files: [
    { path: ".hermes/SOUL.md", content: "Direct.\n" },
    { path: ".hermes/.env", content: "OPENROUTER_API_KEY=placeholder-openrouter-key\n" },
    {
      path: ".hermes/cron/jobs.json",
      content: JSON.stringify({
        jobs: [
          {
            id: "a",
            name: "morning",
            prompt: "Summarise my day",
            schedule: { kind: "cron", expr: "0 9 * * *" },
          },
        ],
      }),
    },
  ],
  name: "Imported",
  includeSecrets: true,
  selection: {
    instructions: ["instructions:SOUL.md"],
    memory: [],
    skills: [],
    routines: ["routine:a"],
    apiKeys: ["key:openrouter"],
  },
});

describe("after the import commits", () => {
  it("reports success even when a notice or refresh fails", async () => {
    const announceRoutine = vi.fn(async () => {
      throw new Error("events are down");
    });
    const afterModelKey = vi.fn(() => {
      throw new Error("catalog is down");
    });
    await expect(
      createImportedBot(services({ announceRoutine, afterModelKey }), actor, input),
    ).resolves.toBe(bot);
    expect(announceRoutine).toHaveBeenCalledTimes(1);
    expect(afterModelKey).toHaveBeenCalledWith("openrouter");
  });

  it("records only keys it created, leaving a connection made meanwhile alone", async () => {
    const afterModelKey = vi.fn();
    const writeModelKey = vi.fn(async () => null);
    await expect(
      createImportedBot(services({ afterModelKey, writeModelKey }), actor, input),
    ).resolves.toBe(bot);
    expect(writeModelKey).toHaveBeenCalledTimes(1);
    expect(afterModelKey).not.toHaveBeenCalled();
  });
});

describe("the request digest", () => {
  it("is the same for the same import in another order, and differs for other choices", () => {
    const reordered = {
      ...input,
      files: [...input.files].reverse(),
      selection: {
        ...input.selection,
        instructions: [...input.selection.instructions, "x"].reverse(),
      },
    };
    const extended = {
      ...input,
      selection: { ...input.selection, instructions: [...input.selection.instructions, "x"] },
    };
    expect(requestDigest(reordered)).toBe(requestDigest(extended));
    expect(requestDigest({ ...input, selection: { ...input.selection, routines: [] } })).not.toBe(
      requestDigest(input),
    );
  });
});

describe("reading an import's setup state", () => {
  it("reads each provider once, in one read of the actor's connections", async () => {
    const connectedProviders = vi.fn(async () => new Set(["openrouter"]));
    const hasModelConnection = vi.fn(async () => true);
    const state = await agentImportSetupState(
      services({ connectedProviders, hasModelConnection }),
      actor,
      {
        botId: "bot-1",
        providers: ["openrouter", "openrouter", "deepseek", "openrouter"],
        serverIds: [],
        routineIds: [],
      },
    );
    expect(state.providers).toEqual({ openrouter: true, deepseek: false });
    expect(connectedProviders).toHaveBeenCalledTimes(1);
    expect(connectedProviders).toHaveBeenCalledWith(actor, ["openrouter", "deepseek"]);
    expect(hasModelConnection).not.toHaveBeenCalled();
  });
});

describe("an imported stdio server's setup state", () => {
  it("cannot be verified when it needs a program, so it is never reported done", async () => {
    const created = {
      mcpServers: [
        { id: "files", credentials: [], env: [], unverifiable: true },
        { id: "docs", credentials: [], env: [] },
      ],
    };
    const prisma = {
      mcpServer: {
        findMany: async () => [
          { id: "files", secretId: null },
          { id: "docs", secretId: null },
        ],
      },
      botMcpServer: { findMany: async () => [{ serverId: "files" }, { serverId: "docs" }] },
      routine: { findMany: async () => [] },
      agentImport: { findMany: async () => [{ created }] },
    };
    const state = await agentImportSetupState(services({ prisma: prisma as never }), actor, {
      botId: "bot-1",
      providers: [],
      serverIds: ["files", "docs"],
      routineIds: [],
    });
    expect(state.serverIds).toEqual({ files: "unverifiable", docs: true });
  });
});

describe("an imported server asked for twice", () => {
  it("is decrypted once", async () => {
    const created = {
      mcpServers: [{ id: "docs", credentials: ["Authorization"], env: [] }],
    };
    const prisma = {
      mcpServer: { findMany: async () => [{ id: "docs", secretId: "secret-docs" }] },
      botMcpServer: { findMany: async () => [{ serverId: "docs" }] },
      routine: { findMany: async () => [] },
      agentImport: { findMany: async () => [{ created }] },
    };
    const mcpCredentialValues = vi.fn(async () => ({
      headers: { Authorization: "Bearer placeholder" },
      env: {},
    }));
    const state = await agentImportSetupState(
      services({ prisma: prisma as never, mcpCredentialValues }),
      actor,
      { botId: "bot-1", providers: [], serverIds: ["docs", "docs", "docs"], routineIds: [] },
    );
    expect(state.serverIds).toEqual({ docs: true });
    expect(mcpCredentialValues).toHaveBeenCalledTimes(1);
  });
});

describe("portable avatar appearance on import", () => {
  it.each([undefined, "organic", "rakazo"] as const)(
    "preserves explicit sets and leaves the rest to the owner's default (set=%s)",
    async (avatarSet) => {
      const createBot = vi.fn<AgentImportServices["createBot"]>(async (_actor, request) => {
        await request.seed(fakeDb(), bot.id);
        return bot;
      });
      await createImportedBot(services({ createBot }), actor, {
        ...input,
        color: "#8B5CF6::shape_3",
        avatarSet,
      });
      expect(createBot.mock.calls[0]![1]).toMatchObject({ color: "#8B5CF6::shape_3" });
      expect(createBot.mock.calls[0]![1].avatarSet).toBe(avatarSet);
    },
  );
});
