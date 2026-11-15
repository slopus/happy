import type { AdapterContext } from "@rakazo/adapter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as SerenityClientModule from "./serenity-client.js";
import {
  classifySerenityConnectionSettings,
  createSerenityProvider,
  MemoryProviderPrivateEndpointRequiredError,
  prepareSerenityConnection,
  SerenityMemoryProvider,
  sanitizeSerenityBrainLabel,
  serenityBotEntity,
  serenityRequiresPrivateEndpoint,
  serenitySpaceEntity,
} from "./serenity-memory-provider.js";

/** Stable digest suffix for "Personal Brain" (case-folded). */
const PERSONAL_BRAIN = "personal-brain-7a024bf3";

const context: AdapterContext = {
  operationId: "op-1",
  traceId: "trace-1",
  spaceId: "workspace-1",
  userId: "user-1",
  botId: "bot-1",
  signal: new AbortController().signal,
};

vi.mock("./serenity-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof SerenityClientModule>();
  return {
    ...actual,
    probeSerenity: vi.fn(),
    recallSerenity: vi.fn(),
    rememberSerenity: vi.fn(),
    forgetSerenity: vi.fn(),
  };
});

import {
  forgetSerenity,
  probeSerenity,
  recallSerenity,
  rememberSerenity,
} from "./serenity-client.js";

const probeSerenityMock = vi.mocked(probeSerenity);
const recallSerenityMock = vi.mocked(recallSerenity);
const rememberSerenityMock = vi.mocked(rememberSerenity);
const forgetSerenityMock = vi.mocked(forgetSerenity);

afterEach(() => {
  vi.clearAllMocks();
});

function provider(allowWrites = true, brainLabel = "") {
  return new SerenityMemoryProvider({
    endpoint: "http://127.0.0.1:8787/mcp",
    token: "serenity_test_token",
    brainLabel,
    allowWrites,
  });
}

describe("SerenityMemoryProvider", () => {
  it("keeps labeled entities to the single type/slug shape Serenity accepts", () => {
    for (const entity of [
      serenityBotEntity("bot-1", "Personal Brain"),
      serenitySpaceEntity("workspace-1", "Personal Brain"),
    ]) {
      expect(entity.split("/")).toHaveLength(2);
    }
  });

  it("keeps bot and space entity namespaces inside the adapter", () => {
    expect(serenityBotEntity("bot-1")).toBe("rakazo-bot/bot-1");
    expect(serenitySpaceEntity("workspace-1")).toBe("rakazo-space/workspace-1");
    expect(serenityBotEntity("bot-1", "Personal Brain")).toBe(
      `rakazo-bot/${PERSONAL_BRAIN}--bot-1`,
    );
    expect(serenitySpaceEntity("workspace-1", "Personal Brain")).toBe(
      `rakazo-space/${PERSONAL_BRAIN}--workspace-1`,
    );
  });

  it("isolates labels that sanitize to the same slug", () => {
    const spaced = sanitizeSerenityBrainLabel("prod brain");
    const hyphenated = sanitizeSerenityBrainLabel("prod-brain");
    expect(spaced).toBe("prod-brain-886a332f");
    expect(hyphenated).toBe("prod-brain-0691dd31");
    expect(spaced).not.toBe(hyphenated);
    expect(serenityBotEntity("bot-1", "prod brain")).not.toBe(
      serenityBotEntity("bot-1", "prod-brain"),
    );
  });

  it("requires deployment owner for loopback, private DNS, and classified LAN hosts", () => {
    expect(serenityRequiresPrivateEndpoint({ endpoint: "http://127.0.0.1:8787/mcp" })).toBe(true);
    expect(serenityRequiresPrivateEndpoint({ endpoint: "https://serenity.internal/mcp" })).toBe(
      true,
    );
    expect(serenityRequiresPrivateEndpoint({ endpoint: "https://serenity.example.test/mcp" })).toBe(
      false,
    );
    expect(
      serenityRequiresPrivateEndpoint({
        endpoint: "https://serenity.example.test/mcp",
        endpointTrust: "private",
      }),
    ).toBe(true);
  });

  it("requires an explicit endpoint and does not assume a hosted URL", async () => {
    await expect(
      prepareSerenityConnection({ allowWrites: "false" }, { token: "serenity_test_token" }),
    ).rejects.toThrow("endpoint is required");
    expect(probeSerenityMock).not.toHaveBeenCalled();
  });

  it("classifies private LAN DNS without probing", async () => {
    const classified = await classifySerenityConnectionSettings(
      { endpoint: "https://serenity.example.test/mcp", allowWrites: "false" },
      {
        resolveHostname: async () => [{ address: "10.8.0.2", family: 4 as const }],
      },
    );
    expect(classified.endpointTrust).toBe("private");
    expect(serenityRequiresPrivateEndpoint(classified)).toBe(true);
    expect(probeSerenityMock).not.toHaveBeenCalled();
  });

  it("refuses private endpoints before probing when allowPrivateEndpoint is false", async () => {
    await expect(
      prepareSerenityConnection(
        { endpoint: "https://serenity.example.test/mcp", allowWrites: "false" },
        { token: "serenity_test_token" },
        {
          resolveHostname: async () => [{ address: "10.8.0.2", family: 4 as const }],
        },
        { allowPrivateEndpoint: false },
      ),
    ).rejects.toBeInstanceOf(MemoryProviderPrivateEndpointRequiredError);
    expect(probeSerenityMock).not.toHaveBeenCalled();
  });

  it("stores private endpointTrust when HTTPS LAN DNS resolves privately", async () => {
    probeSerenityMock.mockResolvedValue({ ok: true, value: undefined });
    const prepared = await prepareSerenityConnection(
      { endpoint: "https://serenity.example.test/mcp", allowWrites: "false" },
      { token: "serenity_test_token" },
      {
        resolveHostname: async () => [{ address: "10.8.0.2", family: 4 as const }],
      },
    );
    expect(prepared.settings.endpointTrust).toBe("private");
    expect(serenityRequiresPrivateEndpoint(prepared.settings)).toBe(true);
  });

  it("probes before accepting a connection", async () => {
    probeSerenityMock.mockResolvedValue({ ok: true, value: undefined });
    const prepared = await prepareSerenityConnection(
      { endpoint: "http://127.0.0.1:8787", allowWrites: "false", brainLabel: "personal" },
      { token: "serenity_test_token" },
    );
    expect(prepared.settings.endpoint).toBe("http://127.0.0.1:8787/mcp");
    expect(prepared.settings.allowWrites).toBe("false");
    expect(prepared.credentials).toEqual({ token: "serenity_test_token" });
    expect(probeSerenityMock).toHaveBeenCalledOnce();
  });

  it("recalls isolated scope only against the bot entity", async () => {
    recallSerenityMock.mockResolvedValue({
      ok: true,
      value: [
        {
          factId: "fact-1",
          fact: "Prefer conventional commits.",
          provenance: "user told rakazo",
        },
      ],
    });

    const result = await provider().recall(
      { query: "commits", scope: "isolated", botId: "bot-1", limit: 5 },
      context,
    );

    expect(result).toEqual({
      ok: true,
      value: [
        {
          memory: "Prefer conventional commits.",
          score: expect.closeTo(1 / 3),
          id: "fact-1",
          provenance: "user told rakazo",
          entity: "rakazo-bot/bot-1",
        },
      ],
    });
    expect(recallSerenityMock).toHaveBeenCalledOnce();
    expect(recallSerenityMock).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: "http://127.0.0.1:8787/mcp" }),
      expect.objectContaining({ entity: "rakazo-bot/bot-1" }),
    );
  });

  it("ranks facts by relevance to the query instead of recency", async () => {
    // Serenity returns facts newest first, ignoring the query.
    const facts = [
      "The user is reading a novel.",
      "The user lives in Lisbon.",
      "The user drinks green tea every morning.",
      "The user prefers metric units.",
      "The user has a dog called Rex.",
      "The user prefers 绿茶 over coffee.",
    ];
    recallSerenityMock.mockResolvedValue({
      ok: true,
      value: facts.map((fact, index) => ({ factId: `fact-${index}`, fact, provenance: "chat" })),
    });

    const recall = async (query: string, limit: number) => {
      const result = await provider().recall(
        { query, scope: "isolated", botId: "bot-1", limit },
        context,
      );
      if (!result.ok) throw new Error(result.error);
      return result.value;
    };

    const tea = await recall("What tea does the user like?", 2);
    expect(tea[0]).toMatchObject({ id: "fact-2", entity: "rakazo-bot/bot-1" });
    expect(tea[0]!.score).toBeLessThan(1);
    // Words every fact shares count for little.
    expect(tea[1]!.score).toBeLessThan(tea[0]!.score / 2);

    const chinese = await recall("我喜欢绿茶", 1);
    expect(chinese.map((item) => item.id)).toEqual(["fact-5"]);

    const unrelated = await recall("quarterly revenue", 3);
    expect(unrelated.map((item) => [item.id, item.score])).toEqual([
      ["fact-0", 0],
      ["fact-1", 0],
      ["fact-2", 0],
    ]);
  });

  it("writes shared durable saves once, to the space entity", async () => {
    rememberSerenityMock.mockResolvedValue({
      ok: true,
      value: { id: "fact-2", status: "inserted" },
    });

    const result = await provider().save(
      {
        content: "Use metric units.",
        scope: "shared",
        botId: "bot-1",
        source: { kind: "durable" },
      },
      context,
    );

    expect(result).toEqual({ ok: true, value: undefined });
    expect(rememberSerenityMock.mock.calls.map((call) => call[3]?.entity)).toEqual([
      "rakazo-space/workspace-1",
    ]);
  });

  it("writes isolated durable saves to the bot entity", async () => {
    rememberSerenityMock.mockResolvedValue({
      ok: true,
      value: { id: "fact-2", status: "inserted" },
    });
    await provider().save(
      {
        content: "Use metric units.",
        scope: "isolated",
        botId: "bot-1",
        source: { kind: "durable" },
      },
      context,
    );
    expect(rememberSerenityMock.mock.calls.map((call) => call[3]?.entity)).toEqual([
      "rakazo-bot/bot-1",
    ]);
  });

  it("keys retried saves within a run so Serenity replays instead of duplicating", async () => {
    rememberSerenityMock.mockResolvedValue({
      ok: true,
      value: { id: "fact-2", status: "inserted" },
    });
    const request = {
      content: "Use metric units.",
      scope: "isolated" as const,
      botId: "bot-1",
      source: { kind: "durable" as const },
    };
    const run = { ...context, runId: "run-1" };
    await provider().save(request, { ...run, operationId: "op-1" });
    await provider().save(request, { ...run, operationId: "op-2" });
    await provider().save({ ...request, content: "Use imperial units." }, run);
    const keys = rememberSerenityMock.mock.calls.map((call) => call[3]?.operationKey);
    expect(keys[0]).toMatch(/^rakazo:[0-9a-f]{48}$/);
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[0]);
  });

  it("scopes shared durable saves by brain label when configured", async () => {
    rememberSerenityMock.mockResolvedValue({
      ok: true,
      value: { id: "fact-2", status: "inserted" },
    });

    const labeled = new SerenityMemoryProvider({
      endpoint: "http://127.0.0.1:8787/mcp",
      token: "serenity_test_token",
      brainLabel: "Personal Brain",
      allowWrites: true,
    });
    await labeled.save(
      {
        content: "Use metric units.",
        scope: "shared",
        botId: "bot-1",
        source: { kind: "durable" },
      },
      context,
    );

    expect(rememberSerenityMock.mock.calls.map((call) => call[3]?.entity)).toEqual([
      `rakazo-space/${PERSONAL_BRAIN}--workspace-1`,
    ]);
  });

  it("forgets a fact only after recall shows it in the cited bot entity", async () => {
    const entity = `rakazo-bot/${PERSONAL_BRAIN}--bot-1`;
    recallSerenityMock.mockResolvedValue({
      ok: true,
      value: [{ factId: "fact-9", fact: "Prefers tea.", provenance: "chat" }],
    });
    forgetSerenityMock.mockResolvedValue({
      ok: true,
      value: { id: "fact-9", expired: true, reason: null },
    });

    const labeled = provider(true, "Personal Brain");
    await labeled.forget(
      { id: "fact-9", scope: "isolated", botId: "bot-1", entity, reason: "cleanup" },
      context,
    );
    expect(recallSerenityMock).toHaveBeenCalledTimes(1);
    expect(recallSerenityMock.mock.calls[0]?.[1]?.entity).toBe(entity);
    expect(forgetSerenityMock).toHaveBeenCalledWith(
      "fact-9",
      expect.objectContaining({ brainLabel: "Personal Brain" }),
      expect.objectContaining({ reason: "cleanup" }),
    );
    expect(forgetSerenityMock.mock.calls[0]?.[2]).not.toHaveProperty("entity");
  });

  it("refuses to forget a fact cited from another bot or Space", async () => {
    for (const entity of ["rakazo-bot/bot-2", "rakazo-space/workspace-2", "person/someone"]) {
      const result = await provider().forget(
        { id: "fact-9", scope: "shared", botId: "bot-1", entity },
        context,
      );
      expect(result.ok).toBe(false);
    }
    // An isolated bot cannot reach the shared Space namespace either.
    const isolated = await provider().forget(
      { id: "fact-9", scope: "isolated", botId: "bot-1", entity: "rakazo-space/workspace-1" },
      context,
    );
    expect(isolated.ok).toBe(false);
    expect(recallSerenityMock).not.toHaveBeenCalled();
    expect(forgetSerenityMock).not.toHaveBeenCalled();
  });

  it("refuses to forget a fact id that is not in the bot's namespaces", async () => {
    recallSerenityMock.mockResolvedValue({
      ok: true,
      value: [{ factId: "fact-own", fact: "Prefers tea.", provenance: "chat" }],
    });
    const result = await provider().forget(
      { id: "fact-foreign", scope: "shared", botId: "bot-1" },
      context,
    );
    expect(result.ok).toBe(false);
    expect(recallSerenityMock.mock.calls.map((call) => call[1]?.entity)).toEqual([
      "rakazo-space/workspace-1",
      "rakazo-bot/bot-1",
    ]);
    expect(forgetSerenityMock).not.toHaveBeenCalled();
  });

  it("fails closed when ownership cannot be checked", async () => {
    recallSerenityMock.mockResolvedValue({ ok: false, error: "Serenity recall failed: down" });
    const result = await provider().forget(
      { id: "fact-1", scope: "isolated", botId: "bot-1" },
      context,
    );
    expect(result).toEqual({
      ok: false,
      error: expect.stringContaining("Could not confirm"),
    });
    expect(forgetSerenityMock).not.toHaveBeenCalled();
  });

  it("blocks durable writes when allowWrites is off", async () => {
    const result = await provider(false).save(
      {
        content: "Use metric units.",
        scope: "isolated",
        botId: "bot-1",
        source: { kind: "durable" },
      },
      context,
    );
    expect(result.ok).toBe(false);
    expect(rememberSerenityMock).not.toHaveBeenCalled();
  });

  it("skips history compaction writes and purges", async () => {
    await expect(
      provider().save(
        {
          content: "summary",
          scope: "isolated",
          botId: "bot-1",
          source: { kind: "history", generation: 3 },
        },
        context,
      ),
    ).resolves.toEqual({ ok: true, value: undefined });
    await expect(
      provider().purgeHistory({ botId: "bot-1", generations: [1, 2] }, context),
    ).resolves.toEqual({ ok: true, value: undefined });
    expect(rememberSerenityMock).not.toHaveBeenCalled();
  });

  it("keeps recall entity citations without forwarding them to Serenity forget", async () => {
    recallSerenityMock
      .mockResolvedValueOnce({
        ok: true,
        value: [
          {
            factId: "fact-space-1",
            fact: "The team uses metric units.",
            provenance: "space policy",
          },
        ],
      })
      .mockResolvedValueOnce({
        ok: true,
        value: [],
      });
    forgetSerenityMock.mockResolvedValue({
      ok: true,
      value: { id: "fact-space-1", expired: true, reason: null },
    });

    const labeled = new SerenityMemoryProvider({
      endpoint: "http://127.0.0.1:8787/mcp",
      token: "serenity_test_token",
      brainLabel: "Personal Brain",
      allowWrites: true,
    });
    const recalled = await labeled.recall(
      { query: "units", scope: "shared", botId: "bot-1", limit: 5 },
      context,
    );
    expect(recalled).toEqual({
      ok: true,
      value: [
        {
          memory: "The team uses metric units.",
          score: expect.closeTo(0.2),
          id: "fact-space-1",
          provenance: "space policy",
          entity: `rakazo-space/${PERSONAL_BRAIN}--workspace-1`,
        },
      ],
    });

    const fact = recalled.ok ? recalled.value[0] : undefined;
    recallSerenityMock.mockResolvedValueOnce({
      ok: true,
      value: [{ factId: "fact-space-1", fact: "The team uses metric units.", provenance: "" }],
    });
    await labeled.forget(
      { id: fact!.id!, scope: "shared", botId: "bot-1", entity: fact!.entity, reason: "cleanup" },
      context,
    );
    expect(forgetSerenityMock).toHaveBeenCalledWith(
      "fact-space-1",
      expect.objectContaining({ brainLabel: "Personal Brain" }),
      expect.objectContaining({ reason: "cleanup" }),
    );
    expect(forgetSerenityMock.mock.calls[0]?.[2]).not.toHaveProperty("entity");
  });

  it("forgets an uncited fact found in the bot's own namespace", async () => {
    recallSerenityMock.mockResolvedValueOnce({ ok: true, value: [] }).mockResolvedValueOnce({
      ok: true,
      value: [{ factId: "fact-1", fact: "Prefers tea.", provenance: "chat" }],
    });
    forgetSerenityMock.mockResolvedValue({
      ok: true,
      value: { id: "fact-1", expired: true, reason: "user requested" },
    });
    const result = await provider().forget(
      { id: "fact-1", scope: "shared", botId: "bot-1", reason: "user requested" },
      context,
    );
    expect(result).toEqual({
      ok: true,
      value: { id: "fact-1", expired: true, reason: "user requested" },
    });
  });

  it("createSerenityProvider builds a working adapter", () => {
    const created = createSerenityProvider(
      { endpoint: "https://serenity.example.test/mcp", allowWrites: "true" },
      { token: "serenity_test_token" },
    );
    expect(created.describe().id).toBe("serenity");
  });
});
