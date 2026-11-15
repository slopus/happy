import { createHash } from "node:crypto";
import type { AdapterContext, SemanticMemoryConversationRequest } from "@rakazo/adapter-kit";
import { createLogger, createTestSink, installLogger } from "@rakazo/logging";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HINDSIGHT_CLOUD_BASE_URL } from "./hindsight-client.js";
import {
  createHindsightProvider,
  HindsightMemoryProvider,
  prepareHindsightConnection,
  resetHindsightBankState,
} from "./hindsight-memory-provider.js";
import type { ResolveHostname } from "./network-address.js";
import { MemoryProviderPrivateEndpointRequiredError } from "./serenity-memory-provider.js";

const context: AdapterContext = {
  operationId: "op-1",
  traceId: "trace-1",
  spaceId: "space-1",
  userId: "user-1",
  botId: "bot-1",
  signal: new AbortController().signal,
};

const TEAM_BANK = `rakazo-${createHash("sha256").update("space-1").digest("hex")}`;
const OWN_BANK = `${TEAM_BANK}-${createHash("sha256").update("bot-1").digest("hex")}`;

interface RecordedRequest {
  method: string;
  bank: string;
  rest: string;
  body?: Record<string, unknown>;
}

/**
 * `operations` is the status sequence every async operation reports; a turn's document appears in
 * its bank once the operation completes. `recall` maps a bank to its results, or to an HTTP status;
 * a bank missing from it answers 404 like a bank nothing was retained to.
 */
function hindsightFake(
  options: {
    banks?: string[];
    /** "down" makes the server unreachable for that bank, like a request that timed out. */
    recall?: Record<string, object[] | number | "down">;
    reflect?: Record<string, string>;
    documents?: Record<string, string[]>;
    operations?: string[];
    /** Banks whose writes answer 500. */
    failWrites?: string[];
    /** Banks whose async operations always end failed. */
    failOperations?: string[];
    /** Banks whose operation status checks never get an answer. */
    statusDown?: string[];
    /** Banks that keep no document text, so they refuse to append. */
    noAppend?: string[];
    /** Banks that refuse a turn stored as its own document. */
    failSeparate?: string[];
    /** Per-turn documents already in a bank, each tagged with the conversation's session. */
    turnDocuments?: { bank: string; session: string; count: number };
    apiKey?: string;
  } = {},
) {
  const banks = new Set(options.banks ?? []);
  const documents = new Map(
    Object.entries(options.documents ?? {}).map(([bank, ids]) => [bank, new Set(ids)]),
  );
  const statuses = [...(options.operations ?? ["completed"])];
  const pending = new Map<string, { bank: string; document: string; tags: string[] }>();
  /** `${bank}\n${document}` → the document's tags. */
  const tags = new Map<string, string[]>();
  if (options.turnDocuments) {
    const { bank, session, count } = options.turnDocuments;
    const ids = documents.get(bank) ?? new Set<string>();
    for (let index = 0; index < count; index++) {
      ids.add(`rakazo-turn-run-${index}`);
      tags.set(`${bank}\nrakazo-turn-run-${index}`, [`session:${session}`]);
    }
    documents.set(bank, ids);
  }
  const operationBanks = new Map<string, string>();
  const requests: RecordedRequest[] = [];
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const parsed = new URL(String(url));
    expect(parsed.origin).toBe(HINDSIGHT_CLOUD_BASE_URL);
    expect(new Headers(init?.headers).get("authorization")).toBe(
      `Bearer ${options.apiKey ?? "hsk-test-key"}`,
    );
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (method === "GET" && parsed.pathname === "/v1/default/banks") {
      requests.push({ method, bank: "", rest: "" });
      return Response.json({ banks: [] });
    }
    const match = parsed.pathname.match(/^\/v1\/default\/banks\/([^/]+)(\/.*)?$/);
    const bank = decodeURIComponent(match?.[1] ?? "");
    const rest = match?.[2] ?? "";
    requests.push({ method, bank, rest, ...(body ? { body } : {}) });
    if (method === "GET" && rest === "/config") {
      return banks.has(bank) ? Response.json({}) : new Response("{}", { status: 404 });
    }
    if (method === "POST" && rest === "/memories") {
      if (options.failWrites?.includes(bank)) return new Response("{}", { status: 500 });
      const appends = body.items.some(
        (item: { update_mode?: string }) => item.update_mode === "append",
      );
      // Any wording: only the status tells the refusal apart.
      if (options.noAppend?.includes(bank) && appends) {
        return new Response(JSON.stringify({ detail: "Bad request" }), { status: 400 });
      }
      if (options.failSeparate?.includes(bank) && !appends) {
        return new Response("{}", { status: 500 });
      }
      banks.add(bank);
      operationBanks.set(body.operation_id, bank);
      for (const item of body.items) {
        if (item.document_id) {
          pending.set(body.operation_id, {
            bank,
            document: item.document_id,
            tags: item.tags ?? [],
          });
        }
      }
      return Response.json({ success: true, operation_id: body.operation_id });
    }
    const operation = rest.match(/^\/operations\/([^/]+)$/);
    if (operation && method === "GET") {
      if (options.statusDown?.includes(bank)) throw new TypeError("fetch failed");
      const status = options.failOperations?.includes(operationBanks.get(operation[1]!) ?? "")
        ? "failed"
        : statuses.length > 1
          ? statuses.shift()!
          : statuses[0]!;
      const stored = pending.get(operation[1]!);
      if (status === "completed" && stored) {
        pending.delete(operation[1]!);
        const ids = documents.get(stored.bank) ?? new Set<string>();
        ids.add(stored.document);
        tags.set(`${stored.bank}\n${stored.document}`, stored.tags);
        documents.set(stored.bank, ids);
      }
      return Response.json({ operation_id: operation[1], status });
    }
    if (method === "POST" && rest === "/memories/recall") {
      const results = options.recall?.[bank];
      if (results === "down") throw new TypeError("fetch failed");
      if (results === undefined) return new Response("{}", { status: 404 });
      if (typeof results === "number") return new Response("{}", { status: results });
      return Response.json({ results });
    }
    if (method === "POST" && rest === "/reflect") {
      const text = options.reflect?.[bank];
      return text === undefined
        ? new Response("{}", { status: 404 })
        : Response.json({ text, based_on: null });
    }
    if (method === "GET" && rest === "/documents") {
      expect(parsed.searchParams.get("tags_match")).toBe("all_strict");
      const tag = parsed.searchParams.get("tags")!;
      const ids = [...(documents.get(bank) ?? [])].filter((id) =>
        tags.get(`${bank}\n${id}`)?.includes(tag),
      );
      return Response.json({ items: ids.slice(0, 100).map((id) => ({ id })) });
    }
    const document = rest.match(/^\/documents\/([^/]+)$/);
    if (document && method === "DELETE") {
      if (!documents.get(bank)?.delete(decodeURIComponent(document[1]!))) {
        return new Response("{}", { status: 404 });
      }
      return Response.json({});
    }
    throw new Error(`Unexpected request: ${method} ${parsed.pathname}`);
  });
  return { fetch, requests, documents };
}

function provider(
  fetch: typeof globalThis.fetch,
  options: {
    recallBanks?: string[];
    retainConversations?: boolean;
    recallBudget?: string;
    recallFacts?: boolean;
    skipUnrelated?: boolean;
    apiKey?: string;
    connectionIdentity?: string;
  } = {},
) {
  return new HindsightMemoryProvider(
    { baseUrl: HINDSIGHT_CLOUD_BASE_URL, apiKey: options.apiKey ?? "hsk-test-key", fetch },
    {
      recallBanks: options.recallBanks ?? [],
      retainConversations: options.retainConversations ?? true,
      autoRecall: true,
      recallBudget: options.recallBudget ?? "mid",
      recallFacts: options.recallFacts ?? false,
      skipUnrelated: options.skipUnrelated ?? false,
    },
    false,
    options.connectionIdentity ?? "test-connection",
  );
}

beforeEach(() => resetHindsightBankState());
afterEach(() => vi.useRealTimers());

it("uses a supplied connection version rather than deriving identity from the API key", () => {
  const fetch = vi.fn();
  const original = provider(fetch).connectionIdentity;
  expect(original).toBe(provider(vi.fn()).connectionIdentity);
  expect(original).toBe(provider(fetch, { apiKey: "hsk-rotated-test-key" }).connectionIdentity);
  expect(original).not.toBe(
    provider(fetch, { connectionIdentity: "replacement-connection" }).connectionIdentity,
  );
  expect(original).not.toContain("hsk-test-key");
  const local = createHindsightProvider(
    { mode: "local", baseUrl: "http://127.0.0.1:8888" },
    { apiKey: "hsk-test-key" },
    "test-connection",
  );
  expect(local.connectionIdentity).not.toBe(original);
});

const writes = (requests: RecordedRequest[]) =>
  requests.filter((request) => request.method === "POST" && request.rest === "/memories");

describe("Hindsight saves", () => {
  const save = {
    content: " Prefers tea. ",
    botId: "bot-1",
    source: { kind: "durable" as const },
  };

  it("writes an isolated bot's fact to its own bank only", async () => {
    const fake = hindsightFake();
    await expect(
      provider(fake.fetch).save({ ...save, scope: "isolated" }, context),
    ).resolves.toEqual({ ok: true, value: undefined });
    const [write] = writes(fake.requests);
    expect(writes(fake.requests)).toHaveLength(1);
    expect(write?.bank).toBe(OWN_BANK);
    expect(write?.body).toEqual({
      items: [
        {
          content: "Prefers tea.",
          context:
            "A fact a Rakazo AI assistant chose to remember about the people it works for and their work",
          timestamp: expect.any(String),
        },
      ],
      // Stored before the bot hears it was saved, so a failed extraction reaches the bot.
      async: false,
      operation_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
  });

  it("reuses the operation id when the same operation saves the same fact again", async () => {
    const fake = hindsightFake();
    const memory = provider(fake.fetch);
    await memory.save({ ...save, scope: "isolated" }, context);
    await memory.save({ ...save, content: "Prefers tea.", scope: "isolated" }, context);
    await memory.save({ ...save, content: "Prefers coffee.", scope: "isolated" }, context);
    await memory.save({ ...save, scope: "isolated" }, { ...context, operationId: "op-2" });
    const ids = writes(fake.requests).map((request) => request.body?.operation_id);
    expect(ids[1]).toBe(ids[0]);
    expect(new Set(ids).size).toBe(3);
  });

  it("writes a sharing bot's fact to its own bank, then the Space's team bank", async () => {
    const fake = hindsightFake();
    await provider(fake.fetch).save({ ...save, scope: "shared" }, context);
    const [own, team] = writes(fake.requests);
    expect([own?.bank, team?.bank]).toEqual([OWN_BANK, TEAM_BANK]);
    expect(own?.body?.items).toEqual(team?.body?.items);
    // One id cannot serve two banks.
    expect(own?.body?.operation_id).not.toBe(team?.body?.operation_id);
  });

  it("keeps legacy Space and bot identifiers from colliding in generated bank names", async () => {
    const fake = hindsightFake();
    const memory = provider(fake.fetch);
    await memory.save(
      { ...save, botId: "team-bot", scope: "isolated" },
      { ...context, spaceId: "legacy" },
    );
    await memory.save(
      { ...save, botId: "another-bot", scope: "shared" },
      { ...context, spaceId: "legacy-team-bot" },
    );
    expect(new Set(writes(fake.requests).map((request) => request.bank)).size).toBe(3);
  });

  it("fails at its own bank before touching the team bank", async () => {
    const fake = hindsightFake({ failWrites: [OWN_BANK] });
    await expect(provider(fake.fetch).save({ ...save, scope: "shared" }, context)).resolves.toEqual(
      { ok: false, error: "Hindsight request failed: 500" },
    );
    expect(writes(fake.requests).map((request) => request.bank)).toEqual([OWN_BANK]);
  });

  it("reports a failed shared save instead of claiming success", async () => {
    const fake = hindsightFake({ failWrites: [TEAM_BANK] });
    await expect(provider(fake.fetch).save({ ...save, scope: "shared" }, context)).resolves.toEqual(
      { ok: false, error: "Hindsight request failed: 500" },
    );
    expect(writes(fake.requests).map((request) => request.bank)).toEqual([OWN_BANK, TEAM_BANK]);
  });

  it("attempts every shared save even after an earlier team write failed", async () => {
    const failing = hindsightFake({ failWrites: [TEAM_BANK] });
    await provider(failing.fetch).save({ ...save, scope: "shared" }, context);
    const other = hindsightFake({ apiKey: "hsk-other-key" });
    await provider(other.fetch, { apiKey: "hsk-other-key" }).save(
      { ...save, scope: "shared" },
      context,
    );
    expect(writes(other.requests).map((request) => request.bank)).toEqual([OWN_BANK, TEAM_BANK]);
    await provider(failing.fetch).save({ ...save, scope: "shared" }, context);
    expect(writes(failing.requests).map((request) => request.bank)).toEqual([
      OWN_BANK,
      TEAM_BANK,
      OWN_BANK,
      TEAM_BANK,
    ]);
  });

  it("can retry a shared save with the same operation IDs after the team recovers", async () => {
    const failing = [TEAM_BANK];
    const fake = hindsightFake({ failWrites: failing });
    const memory = provider(fake.fetch);
    expect((await memory.save({ ...save, scope: "shared" }, context)).ok).toBe(false);
    failing.length = 0;
    expect((await memory.save({ ...save, scope: "shared" }, context)).ok).toBe(true);
    const ids = writes(fake.requests).map((request) => request.body?.operation_id);
    expect(ids[2]).toBe(ids[0]);
    expect(ids[3]).toBe(ids[1]);
  });

  it("keeps compaction summaries out of Hindsight", async () => {
    const fake = hindsightFake();
    await expect(
      provider(fake.fetch).save(
        { ...save, scope: "isolated", source: { kind: "history", generation: 2 } },
        context,
      ),
    ).resolves.toEqual({ ok: true, value: undefined });
    expect(fake.requests).toEqual([]);
  });
});

describe("Hindsight recall", () => {
  const recall = { query: " tea? ", botId: "bot-1", limit: 10 } as const;

  it("keeps imports out of automatic context while allowing explicit recall", async () => {
    const fake = hindsightFake({
      recall: {
        [OWN_BANK]: [{ text: "Own fact", scores: { final: 0.8 } }],
        [TEAM_BANK]: [{ text: "Shared fact", scores: { final: 0.9 } }],
        "other-app": [{ text: "Imported fact", scores: { final: 1 } }],
      },
    });
    const memory = provider(fake.fetch, { recallBanks: ["other-app"] });
    const automatic = await memory.recall(
      { ...recall, scope: "shared", includeExternal: false },
      context,
    );
    expect(automatic).toMatchObject({
      ok: true,
      value: [{ memory: "Shared fact" }, { memory: "Own fact" }],
    });
    expect(fake.requests.map((request) => request.bank)).toEqual([OWN_BANK, TEAM_BANK]);
    const explicit = await memory.recall({ ...recall, scope: "shared" }, context);
    expect(explicit).toMatchObject({
      ok: true,
      value: [
        { memory: "Imported fact", external: true },
        { memory: "Shared fact" },
        { memory: "Own fact" },
      ],
    });
  });

  it("never cools down the Space's shared bank after a failed recall", async () => {
    const sink = createTestSink();
    installLogger(createLogger({ service: "test", sinks: [sink] }));
    const fake = hindsightFake({ recall: { [OWN_BANK]: [], [TEAM_BANK]: "down" } });
    const memory = provider(fake.fetch);
    const timeout = vi.spyOn(AbortSignal, "timeout");
    try {
      await memory.recall({ ...recall, scope: "shared" }, context);
      await memory.recall({ ...recall, scope: "shared" }, context);
      expect(fake.requests.map((request) => request.bank)).toEqual([
        OWN_BANK,
        TEAM_BANK,
        OWN_BANK,
        TEAM_BANK,
      ]);
      expect(timeout.mock.calls).toEqual([[15_000], [15_000], [15_000], [15_000]]);
      expect(
        sink.events.filter(
          (event) => event.message === "Hindsight recall failed for a Space memory bank",
        ),
      ).toHaveLength(2);
    } finally {
      timeout.mockRestore();
      installLogger(createLogger({ service: "test", level: "off", sinks: [] }));
    }
  });

  it("keeps successful shared results when the own bank fails", async () => {
    const fake = hindsightFake({
      recall: { [OWN_BANK]: 500, [TEAM_BANK]: [{ text: "Shared fact", scores: { final: 0.9 } }] },
    });
    await expect(
      provider(fake.fetch).recall({ ...recall, scope: "shared" }, context),
    ).resolves.toMatchObject({ ok: true, value: [{ memory: "Shared fact" }] });
  });

  it("asks every bank for observations", async () => {
    const fake = hindsightFake({ recall: { [OWN_BANK]: [] } });
    await provider(fake.fetch).recall(
      { ...recall, query: "x".repeat(900), scope: "isolated" },
      context,
    );
    expect(fake.requests).toEqual([
      {
        method: "POST",
        bank: OWN_BANK,
        rest: "/memories/recall",
        body: { query: "x".repeat(800), budget: "mid", max_tokens: 4096, types: ["observation"] },
      },
    ]);
  });

  it("sends the chosen budget and memory types", async () => {
    const fake = hindsightFake({ recall: { [OWN_BANK]: [] }, reflect: { [OWN_BANK]: "" } });
    const memory = provider(fake.fetch, { recallBudget: "high", recallFacts: true });
    await memory.recall({ ...recall, scope: "isolated" }, context);
    await memory.reflect({ query: "Drinks?", botId: "bot-1" }, context);
    expect(fake.requests.map((request) => request.body)).toEqual([
      {
        query: "tea?",
        budget: "high",
        max_tokens: 4096,
        types: ["observation", "world", "experience"],
      },
      { query: "Drinks?", budget: "high" },
    ]);
  });

  it("asks the server to skip unrelated results only when the setting is on", async () => {
    const fake = hindsightFake({ recall: { [OWN_BANK]: [] } });
    await provider(fake.fetch, { skipUnrelated: true }).recall(
      { ...recall, scope: "isolated" },
      context,
    );
    expect(fake.requests[0]!.body).toMatchObject({ min_scores: { reranker: 0.25 } });
    await provider(fake.fetch).recall({ ...recall, scope: "isolated" }, context);
    expect(fake.requests[1]!.body).not.toHaveProperty("min_scores");
  });

  it("ranks its banks and imported banks together, dropping repeated text", async () => {
    const fake = hindsightFake({
      recall: {
        [OWN_BANK]: [{ id: "a", text: "Prefers tea.", scores: { final: 0.9 } }],
        [TEAM_BANK]: [
          { id: "b", text: " Prefers tea. ", scores: { final: 0.8 } },
          { id: "c", text: "Works in Lisbon.", mentioned_at: "2026-11-01T00:00:00Z" },
        ],
        "other-app": [{ id: "d", text: "Has a dog named Pixel.", scores: { final: 0.5 } }],
      },
    });
    const memory = provider(fake.fetch, { recallBanks: ["other-app"] });
    await expect(memory.recall({ ...recall, scope: "shared" }, context)).resolves.toEqual({
      ok: true,
      value: [
        { memory: "Prefers tea.", score: 0.9, provenance: "hindsight" },
        {
          memory: "Has a dog named Pixel.",
          score: 0.5,
          provenance: "another app via hindsight",
          external: true,
        },
        {
          memory: "Works in Lisbon.",
          score: 0,
          updatedAt: "2026-11-01T00:00:00Z",
          provenance: "hindsight",
        },
      ],
    });
    expect(fake.requests.map((request) => request.bank)).toEqual([
      OWN_BANK,
      TEAM_BANK,
      "other-app",
    ]);
    const limited = await memory.recall({ ...recall, scope: "shared", limit: 1 }, context);
    expect(limited).toMatchObject({ ok: true, value: [{ memory: "Prefers tea.", score: 0.9 }] });
    const isolated = await memory.recall({ ...recall, scope: "isolated", limit: 1 }, context);
    expect(isolated).toEqual({
      ok: true,
      value: [{ memory: "Prefers tea.", score: 0.9, provenance: "hindsight" }],
    });
  });

  it("keeps relevant shared and imported matches when the own bank fills the limit", async () => {
    const fake = hindsightFake({
      recall: {
        [OWN_BANK]: Array.from({ length: 6 }, (_, index) => ({
          text: `Own fact ${index}`,
          scores: { final: 0.2 },
        })),
        [TEAM_BANK]: [{ text: "Shared finding", scores: { final: 0.95 } }],
        "other-app": [{ text: "Imported finding", scores: { final: 0.9 } }],
      },
    });
    const result = await provider(fake.fetch, { recallBanks: ["other-app"] }).recall(
      { ...recall, scope: "shared", limit: 2 },
      context,
    );
    expect(result).toEqual({
      ok: true,
      value: [
        { memory: "Shared finding", score: 0.95, provenance: "hindsight" },
        {
          memory: "Imported finding",
          score: 0.9,
          provenance: "another app via hindsight",
          external: true,
        },
      ],
    });
  });

  it("keeps the strongest duplicate and prefers the own bank on ties", async () => {
    const fake = hindsightFake({
      recall: {
        [OWN_BANK]: [{ text: "A finding", scores: { final: 0.4 } }],
        "other-app": [{ text: "A finding", scores: { final: 0.8 } }],
      },
    });
    const memory = provider(fake.fetch, { recallBanks: ["other-app"] });
    const stronger = await memory.recall({ ...recall, scope: "isolated", limit: 1 }, context);
    expect(stronger).toEqual({
      ok: true,
      value: [
        {
          memory: "A finding",
          score: 0.8,
          provenance: "another app via hindsight",
          external: true,
        },
      ],
    });
    const tied = hindsightFake({
      recall: {
        [OWN_BANK]: [{ text: "A finding", scores: { final: 0.8 } }],
        "other-app": [{ text: "A finding", scores: { final: 0.8 } }],
      },
    });
    expect(
      await provider(tied.fetch, { recallBanks: ["other-app"] }).recall(
        { ...recall, scope: "isolated", limit: 1 },
        context,
      ),
    ).toEqual({ ok: true, value: [{ memory: "A finding", score: 0.8, provenance: "hindsight" }] });
  });

  it("reads a bank nothing was written to as empty and skips a failing extra bank", async () => {
    const fake = hindsightFake({
      recall: { broken: 500, "other-app": [{ id: "d", text: "Has a dog named Pixel." }] },
    });
    await expect(
      provider(fake.fetch, { recallBanks: ["broken", "other-app"] }).recall(
        { ...recall, scope: "isolated" },
        context,
      ),
    ).resolves.toEqual({
      ok: true,
      value: [
        {
          memory: "Has a dog named Pixel.",
          score: 0,
          provenance: "another app via hindsight",
          external: true,
        },
      ],
    });
  });

  it("fails when the bot's own bank fails", async () => {
    const fake = hindsightFake({ recall: { [OWN_BANK]: 500, "other-app": [] } });
    await expect(
      provider(fake.fetch, { recallBanks: ["other-app"] }).recall(
        { ...recall, scope: "isolated" },
        context,
      ),
    ).resolves.toEqual({ ok: false, error: "Hindsight request failed: 500" });
  });

  it("skips an extra bank that stops answering for five minutes, never its own bank", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-11T10:00:00.000Z"));
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const fake = hindsightFake({ recall: { [OWN_BANK]: [], "other-app": "down" } });
    const memory = provider(fake.fetch, { recallBanks: ["other-app"] });
    const asked = () =>
      fake.requests.filter((request) => request.rest === "/memories/recall").map((r) => r.bank);
    await expect(memory.recall({ ...recall, scope: "isolated" }, context)).resolves.toEqual({
      ok: true,
      value: [],
    });
    // An extra bank gets 80% of the recall timeout so it never costs the own bank its results.
    expect(timeout.mock.calls).toEqual([[15_000], [12_000]]);
    timeout.mockRestore();
    vi.setSystemTime(new Date("2026-11-11T10:04:59.000Z"));
    await memory.recall({ ...recall, scope: "isolated" }, context);
    expect(asked()).toEqual([OWN_BANK, "other-app", OWN_BANK]);
    vi.setSystemTime(new Date("2026-11-11T10:05:01.000Z"));
    await memory.recall({ ...recall, scope: "isolated" }, context);
    expect(asked()).toEqual([OWN_BANK, "other-app", OWN_BANK, OWN_BANK, "other-app"]);
  });

  it("keeps asking its own bank after it fails", async () => {
    const fake = hindsightFake({ recall: { [OWN_BANK]: 500 } });
    const memory = provider(fake.fetch);
    await memory.recall({ ...recall, scope: "isolated" }, context);
    await memory.recall({ ...recall, scope: "isolated" }, context);
    expect(fake.requests.filter((request) => request.bank === OWN_BANK)).toHaveLength(2);
  });

  it("attempts shared recall even after shared saves failed", async () => {
    const fake = hindsightFake({ failWrites: [TEAM_BANK], recall: { [TEAM_BANK]: [] } });
    const memory = provider(fake.fetch);
    const save = { content: "Prefers tea.", botId: "bot-1", scope: "shared" as const };
    await memory.save({ ...save, source: { kind: "durable" } }, context);
    await memory.save({ ...save, source: { kind: "durable" } }, context);
    expect(writes(fake.requests).map((request) => request.bank)).toEqual([
      OWN_BANK,
      TEAM_BANK,
      OWN_BANK,
      TEAM_BANK,
    ]);
    await memory.recall({ ...recall, scope: "shared" }, context);
    expect(fake.requests.some((r) => r.bank === TEAM_BANK && r.rest === "/memories/recall")).toBe(
      true,
    );
  });

  it("sends nothing for an empty query", async () => {
    const fake = hindsightFake();
    await expect(
      provider(fake.fetch).recall({ ...recall, query: "  ", scope: "isolated" }, context),
    ).resolves.toEqual({ ok: true, value: [] });
    expect(fake.requests).toEqual([]);
  });
});

describe("Hindsight conversations", () => {
  const turn: SemanticMemoryConversationRequest = {
    botId: "bot-1",
    botName: "Ada",
    userName: "Sam",
    scope: "isolated",
    threadId: "thread-1",
    generation: 3,
    runId: "run-1",
    conversation: "direct",
    turns: [
      { role: "user", content: "I'm moving to Lisbon.", timestamp: "2026-11-11T10:00:00.000Z" },
      {
        role: "user",
        content: "Bring wine.",
        timestamp: "2026-11-11T10:00:01.000Z",
        speaker: "Bob",
      },
      { role: "assistant", content: "  ", timestamp: "2026-11-11T10:00:02.000Z" },
      { role: "assistant", content: "Congratulations!", timestamp: "2026-11-11T10:00:03.000Z" },
    ],
  };
  const SESSION = "rakazo-thread-1-3-bot-1";

  /** Submits the turn, then checks once whether it settled. */
  async function retainAndCheck(
    memory: HindsightMemoryProvider,
    request: SemanticMemoryConversationRequest = turn,
  ) {
    const submitted = await memory.retainConversation!(request, context);
    if (!submitted.ok || !submitted.value.pending) return submitted;
    return memory.retainedConversationSettled(submitted.value.pending, context);
  }

  it("appends the turn to the conversation's document in the bot's own bank", async () => {
    const fake = hindsightFake();
    const memory = provider(fake.fetch);
    const submitted = await memory.retainConversation?.(turn, context);
    await memory.retainConversation?.(turn, context);
    const [first, retry] = writes(fake.requests);
    expect(submitted).toEqual({
      ok: true,
      value: {
        pending: JSON.stringify([{ bank: OWN_BANK, operationId: first?.body?.operation_id }]),
      },
    });
    // Submitting only stores; whether it settled is asked separately.
    expect(fake.requests.every((request) => request.method === "POST")).toBe(true);
    expect(first?.bank).toBe(OWN_BANK);
    expect(first?.body).toEqual({
      items: [
        {
          content: JSON.stringify([
            {
              role: "user",
              content: "User: I'm moving to Lisbon.",
              timestamp: "2026-11-11T10:00:00.000Z",
            },
            { role: "user", content: "Bob: Bring wine.", timestamp: "2026-11-11T10:00:01.000Z" },
            {
              role: "assistant",
              content: "Assistant: Congratulations!",
              timestamp: "2026-11-11T10:00:03.000Z",
            },
          ]),
          context: "Conversation in Rakazo with Sam, Ada and Bob",
          timestamp: "2026-11-11T10:00:03.000Z",
          document_id: SESSION,
          update_mode: "append",
          tags: [`session:${SESSION}`],
          observation_scopes: "shared",
        },
      ],
      async: true,
      operation_id: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab]/),
    });
    // A repeated call replays the same operation.
    expect(retry?.body?.operation_id).toBe(first?.body?.operation_id);
  });

  it("also appends a sharing bot's turn to the team bank under its own operation id", async () => {
    const fake = hindsightFake();
    await expect(
      retainAndCheck(provider(fake.fetch), { ...turn, scope: "shared" }),
    ).resolves.toEqual({ ok: true, value: { settled: true } });
    const [own, team] = writes(fake.requests);
    expect([own?.bank, team?.bank]).toEqual([OWN_BANK, TEAM_BANK]);
    expect(team?.body?.items).toEqual(own?.body?.items);
    expect(team?.body?.operation_id).not.toBe(own?.body?.operation_id);
    expect(fake.documents.get(TEAM_BANK)?.has(SESSION)).toBe(true);
  });

  it("fails a turn its own bank refused before touching the team bank", async () => {
    const fake = hindsightFake({ failWrites: [OWN_BANK] });
    await expect(
      provider(fake.fetch).retainConversation?.({ ...turn, scope: "shared" }, context),
    ).resolves.toEqual({ ok: false, error: "Hindsight request failed: 500" });
    expect(fake.requests.some((request) => request.bank === TEAM_BANK)).toBe(false);
  });

  it("retries both banks with stable IDs when a shared turn is only partially submitted", async () => {
    const failing = [TEAM_BANK];
    const fake = hindsightFake({ failWrites: failing });
    const memory = provider(fake.fetch);
    await expect(
      memory.retainConversation!({ ...turn, scope: "shared" }, context),
    ).resolves.toEqual({
      ok: false,
      error: "Hindsight request failed: 500",
    });
    failing.length = 0;
    await expect(retainAndCheck(memory, { ...turn, scope: "shared" })).resolves.toEqual({
      ok: true,
      value: { settled: true },
    });
    const ids = writes(fake.requests).map((request) => request.body?.operation_id);
    expect(ids[2]).toBe(ids[0]);
    expect(ids[3]).toBe(ids[1]);
    expect(fake.documents.get(OWN_BANK)?.has(SESSION)).toBe(true);
    expect(fake.documents.get(TEAM_BANK)?.has(SESSION)).toBe(true);
  });

  it.each(["save", "retain"] as const)(
    "shares one write deadline across own and shared banks for %s",
    async (operation) => {
      const deadline = new AbortController();
      const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValueOnce(deadline.signal);
      const signals: AbortSignal[] = [];
      const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        const signal = init!.signal!;
        signals.push(signal);
        if (signals.length === 1) return Response.json({ success: true });
        deadline.abort(new Error("write deadline"));
        signal.throwIfAborted();
        throw new Error("shared write outlived deadline");
      });
      try {
        const memory = provider(fetch);
        const result =
          operation === "save"
            ? await memory.save(
                {
                  content: "Prefers tea.",
                  botId: "bot-1",
                  scope: "shared",
                  source: { kind: "durable" },
                },
                context,
              )
            : await memory.retainConversation!({ ...turn, scope: "shared" }, context);
        expect(result).toMatchObject({ ok: false });
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(signals.every((signal) => signal.aborted)).toBe(true);
        expect(timeout.mock.calls).toEqual([[30_000], [30_000], [30_000]]);
      } finally {
        timeout.mockRestore();
      }
    },
  );

  it("stores a turn with only the person's words", async () => {
    const fake = hindsightFake();
    await retainAndCheck(provider(fake.fetch), {
      ...turn,
      turns: turn.turns.filter((message) => message.role === "user"),
    });
    const [write] = writes(fake.requests);
    const content = JSON.parse((write!.body as { items: [{ content: string }] }).items[0].content);
    expect(content.length).toBeGreaterThan(0);
    expect(content.every((message: { role: string }) => message.role === "user")).toBe(true);
  });

  it("skips a turn without content", async () => {
    const fake = hindsightFake();
    await expect(
      provider(fake.fetch).retainConversation?.(
        { ...turn, turns: turn.turns.map((message) => ({ ...message, content: " " })) },
        context,
      ),
    ).resolves.toEqual({ ok: true, value: {} });
    expect(fake.requests).toEqual([]);
  });

  it("settles only once the turn is stored, without submitting it again", async () => {
    const fake = hindsightFake({ operations: ["pending", "processing", "completed"] });
    const memory = provider(fake.fetch);
    const submitted = await memory.retainConversation!(turn, context);
    const pending = submitted.ok ? submitted.value.pending! : "";
    for (const settled of [false, false]) {
      await expect(memory.retainedConversationSettled(pending, context)).resolves.toEqual({
        ok: true,
        value: { settled },
      });
      expect(fake.documents.get(OWN_BANK)?.has(SESSION)).toBeFalsy();
    }
    await expect(memory.retainedConversationSettled(pending, context)).resolves.toEqual({
      ok: true,
      value: { settled: true },
    });
    expect(fake.documents.get(OWN_BANK)?.has(SESSION)).toBe(true);
    expect(writes(fake.requests)).toHaveLength(1);
  });

  it("keeps a turn unsettled while the team bank is still storing it", async () => {
    const fake = hindsightFake({ operations: ["completed", "pending", "completed"] });
    await expect(
      retainAndCheck(provider(fake.fetch), { ...turn, scope: "shared" }),
    ).resolves.toEqual({ ok: true, value: { settled: false } });
  });
  it("checks banks concurrently under one short settlement deadline", async () => {
    const fake = hindsightFake({ operations: ["pending"] });
    let active = 0;
    let peak = 0;
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const status = String(input).includes("/operations/");
      if (status) {
        active++;
        peak = Math.max(peak, active);
        await Promise.resolve();
      }
      try {
        return await fake.fetch(input, init);
      } finally {
        if (status) active--;
      }
    };
    const memory = provider(fetch);
    const retained = await memory.retainConversation!({ ...turn, scope: "shared" }, context);
    if (!retained.ok) throw new Error(retained.error);
    const timeout = vi.spyOn(AbortSignal, "timeout");
    try {
      await expect(
        memory.retainedConversationSettled(retained.value.pending!, context),
      ).resolves.toEqual({ ok: true, value: { settled: false } });
      expect(peak).toBe(2);
      expect(timeout.mock.calls.every(([ms]) => ms === 10_000)).toBe(true);
    } finally {
      timeout.mockRestore();
    }
  });

  it("counts a turn the server failed to store as done, without storing it again", async () => {
    const fake = hindsightFake({ operations: ["failed"] });
    const memory = provider(fake.fetch);
    await expect(retainAndCheck(memory)).resolves.toEqual({ ok: true, value: { settled: true } });
    expect(writes(fake.requests)).toHaveLength(1);
    expect(fake.requests.filter((request) => request.method === "POST")).toHaveLength(1);
    expect(fake.documents.get(OWN_BANK)?.has(SESSION)).toBeFalsy();
  });

  it("counts a team-bank operation that failed as done", async () => {
    const fake = hindsightFake({ failOperations: [TEAM_BANK] });
    await expect(
      retainAndCheck(provider(fake.fetch), { ...turn, scope: "shared" }),
    ).resolves.toEqual({ ok: true, value: { settled: true } });
    expect(fake.documents.get(OWN_BANK)?.has(SESSION)).toBe(true);
  });

  it("counts an operation the server lost as done", async () => {
    const fake = hindsightFake({ operations: ["not_found"] });
    await expect(retainAndCheck(provider(fake.fetch))).resolves.toEqual({
      ok: true,
      value: { settled: true },
    });
  });

  it("stays unsettled while a status check gets no answer, in either bank", async () => {
    for (const down of [OWN_BANK, TEAM_BANK]) {
      const fake = hindsightFake({ statusDown: [down] });
      await expect(
        retainAndCheck(provider(fake.fetch), { ...turn, scope: "shared" }),
      ).resolves.toEqual({ ok: true, value: { settled: false } });
    }
  });

  it("keeps writing to the team bank after its status check failed", async () => {
    const fake = hindsightFake({ statusDown: [TEAM_BANK] });
    const memory = provider(fake.fetch);
    await retainAndCheck(memory, { ...turn, scope: "shared" });
    await memory.retainConversation!({ ...turn, scope: "shared", runId: "run-2" }, context);
    expect(writes(fake.requests).map((request) => request.bank)).toEqual([
      OWN_BANK,
      TEAM_BANK,
      OWN_BANK,
      TEAM_BANK,
    ]);
  });

  it("rejects a pending turn it did not hand out", async () => {
    const fake = hindsightFake();
    const memory = provider(fake.fetch);
    const operationId = "00000000-0000-4000-8000-000000000000";
    for (const pending of [
      "not json",
      "[]",
      JSON.stringify([{ bank: OWN_BANK, operationId: "x" }]),
      JSON.stringify([{ bank: "rakazo-space-2-bot-1", operationId }]),
      JSON.stringify([{ bank: "rakazo-space-2", operationId, team: true }]),
    ]) {
      await expect(memory.retainedConversationSettled(pending, context)).resolves.toEqual({
        ok: false,
        error: "Hindsight got an invalid pending turn.",
      });
    }
    expect(fake.requests).toEqual([]);
  });

  it("describes direct chats, messages between bots and group chats", async () => {
    const fake = hindsightFake();
    const memory = provider(fake.fetch);
    const [person, , , reply] = turn.turns;
    const carol = { ...person!, speaker: "Carol" };
    await memory.retainConversation?.({ ...turn, turns: [person!, reply!] }, context);
    await memory.retainConversation?.(turn, context);
    await memory.retainConversation?.(
      { ...turn, turns: [...turn.turns, carol, { ...carol }] },
      context,
    );
    await memory.retainConversation?.(
      { ...turn, conversation: "group", turns: [...turn.turns, carol] },
      context,
    );
    expect(writes(fake.requests).map((request) => request.body?.items)).toEqual([
      [
        expect.objectContaining({
          context: "Chat in Rakazo between Sam and Ada, an AI assistant",
        }),
      ],
      [
        expect.objectContaining({
          context: "Conversation in Rakazo with Sam, Ada and Bob",
        }),
      ],
      [
        expect.objectContaining({
          context: "Conversation in Rakazo with Sam, Ada, Bob and Carol",
        }),
      ],
      [
        expect.objectContaining({
          context: "Group chat in Rakazo with Sam, Ada, Bob and Carol",
        }),
      ],
    ]);
  });

  it("stores each turn in its own document in a bank that cannot append", async () => {
    const fake = hindsightFake({ noAppend: [OWN_BANK] });
    const memory = provider(fake.fetch);
    await expect(retainAndCheck(memory)).resolves.toEqual({ ok: true, value: { settled: true } });
    await retainAndCheck(memory, { ...turn, runId: "run-2" });
    const items = writes(fake.requests).map(
      (request) => (request.body!.items as Array<Record<string, unknown>>)[0]!,
    );
    expect(items.map((item) => [item.document_id, item.update_mode, item.tags])).toEqual([
      [SESSION, "append", [`session:${SESSION}`]],
      ["rakazo-turn-run-1", undefined, [`session:${SESSION}`]],
      // The bank is remembered: the next turn goes straight to its own document.
      ["rakazo-turn-run-2", undefined, [`session:${SESSION}`]],
    ]);
    expect([...(fake.documents.get(OWN_BANK) ?? [])]).toEqual([
      "rakazo-turn-run-1",
      "rakazo-turn-run-2",
    ]);

    await expect(
      memory.purgeHistory({ botId: "bot-1", threadId: "thread-1", generations: [3] }, context),
    ).resolves.toEqual({ ok: true, value: undefined });
    expect([...(fake.documents.get(OWN_BANK) ?? [])]).toEqual([]);
  });

  it("fails a turn neither document takes and keeps trying to append the next one", async () => {
    const fake = hindsightFake({ noAppend: [OWN_BANK], failSeparate: [OWN_BANK] });
    const memory = provider(fake.fetch);
    await expect(memory.retainConversation!(turn, context)).resolves.toEqual({
      ok: false,
      error: "Hindsight request failed: 500",
    });
    await memory.retainConversation!({ ...turn, runId: "run-2" }, context);
    const items = writes(fake.requests).map(
      (request) => (request.body!.items as Array<Record<string, unknown>>)[0]!,
    );
    expect(items.map((item) => item.document_id)).toEqual([
      SESSION,
      "rakazo-turn-run-1",
      SESSION,
      "rakazo-turn-run-2",
    ]);
  });

  it("does not learn from conversations when turned off, yet still purges cleared chats", () => {
    const memory = createHindsightProvider(
      { retainConversations: "false" },
      { apiKey: "hsk-test-key" },
    );
    expect(memory.retainConversation).toBeUndefined();
    expect(memory.describe().capabilities).toMatchObject({ purgesByThread: true });
  });

  it("purges the cleared conversations from the bot's own and team banks", async () => {
    const fake = hindsightFake({
      documents: {
        [OWN_BANK]: ["rakazo-thread-1-2-bot-1", "rakazo-thread-1-4-bot-1"],
        [TEAM_BANK]: ["rakazo-thread-1-3-bot-1", "rakazo-thread-1-2-bot-2"],
      },
    });
    await expect(
      provider(fake.fetch).purgeHistory(
        { botId: "bot-1", threadId: "thread-1", generations: [2, 3, 3] },
        context,
      ),
    ).resolves.toEqual({ ok: true, value: undefined });
    expect(
      fake.requests
        .filter((request) => request.method === "DELETE")
        .map((request) => `${request.bank}${request.rest}`)
        .sort(),
    ).toEqual(
      [
        `${OWN_BANK}/documents/rakazo-thread-1-2-bot-1`,
        `${TEAM_BANK}/documents/rakazo-thread-1-2-bot-1`,
        `${OWN_BANK}/documents/rakazo-thread-1-3-bot-1`,
        `${TEAM_BANK}/documents/rakazo-thread-1-3-bot-1`,
      ].sort(),
    );
    expect(fake.requests.filter((request) => request.method === "GET")).toHaveLength(4);
    expect([...(fake.documents.get(OWN_BANK) ?? [])]).toEqual(["rakazo-thread-1-4-bot-1"]);
    expect([...(fake.documents.get(TEAM_BANK) ?? [])]).toEqual(["rakazo-thread-1-2-bot-2"]);
  });

  it("shares one cleanup deadline across deletes and later document listings", async () => {
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValueOnce(deadline.signal);
    let markListingsStarted!: () => void;
    const listingsStarted = new Promise<void>((resolve) => {
      markListingsStarted = resolve;
    });
    let listings = 0;
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "DELETE") return Response.json({});
      if (++listings === 2) markListingsStarted();
      const signal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });
    try {
      const purging = provider(fetch).purgeHistory(
        { botId: "bot-1", threadId: "thread-1", generations: [3] },
        context,
      );
      await listingsStarted;
      deadline.abort();
      expect((await purging).ok).toBe(false);
      expect(fetch.mock.calls).toHaveLength(4);
      expect(fetch.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
      expect(timeout).toHaveBeenNthCalledWith(1, 10_000);
    } finally {
      timeout.mockRestore();
    }
  });

  it("keeps deleting a conversation's per-turn documents page after page", async () => {
    const fake = hindsightFake({
      turnDocuments: { bank: OWN_BANK, session: SESSION, count: 250 },
    });
    let active = 0;
    let peak = 0;
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const perTurn =
        init?.method === "DELETE" && String(input).includes("/documents/rakazo-turn-");
      if (perTurn) {
        active++;
        peak = Math.max(peak, active);
        await Promise.resolve();
      }
      try {
        return await fake.fetch(input, init);
      } finally {
        if (perTurn) active--;
      }
    };
    await expect(
      provider(fetch).purgeHistory(
        { botId: "bot-1", threadId: "thread-1", generations: [3] },
        context,
      ),
    ).resolves.toEqual({ ok: true, value: undefined });
    expect([...(fake.documents.get(OWN_BANK) ?? [])]).toEqual([]);
    expect(peak).toBe(10);
  });
});

describe("Hindsight reflect", () => {
  it("reflects over the bot's own bank", async () => {
    const fake = hindsightFake({ reflect: { [OWN_BANK]: "They prefer tea." } });
    await expect(
      provider(fake.fetch).reflect({ query: " Drinks? ", botId: "bot-1" }, context),
    ).resolves.toEqual({ ok: true, value: "They prefer tea." });
    expect(fake.requests).toEqual([
      {
        method: "POST",
        bank: OWN_BANK,
        rest: "/reflect",
        body: { query: "Drinks?", budget: "mid" },
      },
    ]);
  });

  it("answers empty for a bank nothing was written to", async () => {
    const fake = hindsightFake();
    await expect(
      provider(fake.fetch).reflect({ query: "Drinks?", botId: "bot-1" }, context),
    ).resolves.toEqual({ ok: true, value: "" });
  });

  it("has no forget", () => {
    expect("forget" in provider(vi.fn())).toBe(false);
  });
});

describe("Hindsight connection", () => {
  const LOCAL_URL = "http://hindsight.example.test:8888";
  const privateResolver: ResolveHostname = async () => [{ address: "fd12:3456::7", family: 6 }];
  const publicResolver: ResolveHostname = async () => [{ address: "203.0.113.10", family: 4 }];

  it("includes stalled DNS in the setup deadline", async () => {
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValueOnce(deadline.signal);
    const fetch = vi.fn();
    const resolveHostname = vi.fn(() => new Promise<never>(() => {}));
    try {
      const preparing = prepareHindsightConnection(
        { mode: "local", baseUrl: LOCAL_URL },
        { apiKey: "" },
        { allowPrivateEndpoint: true, resolveHostname, fetch },
      );
      const rejected = expect(preparing).rejects.toThrow("Local mode requires");
      expect(resolveHostname).toHaveBeenCalledOnce();
      deadline.abort();
      await rejected;
      expect(timeout).toHaveBeenNthCalledWith(1, 10_000);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      timeout.mockRestore();
    }
  });

  it.each(["recall", "purge", "settlement", "save", "retain"] as const)(
    "includes stalled DNS in the %s deadline",
    async (operation) => {
      const deadline = new AbortController();
      const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValueOnce(deadline.signal);
      const fetch = vi.fn();
      const resolveHostname = vi.fn(() => new Promise<never>(() => {}));
      const memory = new HindsightMemoryProvider(
        { baseUrl: LOCAL_URL, apiKey: "", resolveHostname, fetch },
        {
          recallBanks: [],
          retainConversations: true,
          autoRecall: true,
          recallBudget: "mid",
          recallFacts: false,
          skipUnrelated: false,
        },
        true,
      );
      try {
        const operations = {
          recall: () =>
            memory.recall(
              { query: "context", botId: "bot-1", scope: "isolated", limit: 5 },
              context,
            ),
          purge: () =>
            memory.purgeHistory(
              { botId: "bot-1", threadId: "thread-1", generations: [3] },
              context,
            ),
          save: () =>
            memory.save(
              {
                content: "Prefers tea.",
                botId: "bot-1",
                scope: "isolated",
                source: { kind: "durable" },
              },
              context,
            ),
          retain: () =>
            memory.retainConversation!(
              {
                botId: "bot-1",
                botName: "Ada",
                userName: "Sam",
                scope: "isolated",
                threadId: "thread-1",
                generation: 3,
                runId: "run-1",
                conversation: "direct",
                turns: [
                  { role: "user", content: "Prefers tea.", timestamp: "2026-11-11T10:00:00.000Z" },
                ],
              },
              context,
            ),
          settlement: () =>
            memory.retainedConversationSettled(
              JSON.stringify([
                { bank: OWN_BANK, operationId: "00000000-0000-4000-8000-000000000000" },
              ]),
              context,
            ),
        };
        const pending = operations[operation]();
        expect(resolveHostname).toHaveBeenCalledOnce();
        deadline.abort(new Error("operation deadline"));
        await expect(pending).resolves.toMatchObject({ ok: false });
        expect(timeout).toHaveBeenNthCalledWith(
          1,
          operation === "recall"
            ? 15_000
            : operation === "save" || operation === "retain"
              ? 30_000
              : 10_000,
        );
        expect(fetch).not.toHaveBeenCalled();
      } finally {
        timeout.mockRestore();
      }
    },
  );

  it("keeps the local recall deadline when HTTP starts after DNS", async () => {
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValueOnce(deadline.signal);
    let finishDns!: (addresses: { address: string; family: number }[]) => void;
    const resolveHostname = vi.fn(
      () =>
        new Promise<{ address: string; family: number }[]>((resolve) => {
          finishDns = resolve;
        }),
    );
    let requestStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      requestStarted = resolve;
    });
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      requestStarted();
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    });
    const memory = new HindsightMemoryProvider(
      { baseUrl: LOCAL_URL, apiKey: "", resolveHostname, fetch },
      {
        recallBanks: [],
        retainConversations: true,
        autoRecall: true,
        recallBudget: "mid",
        recallFacts: false,
        skipUnrelated: false,
      },
      true,
    );
    try {
      const pending = memory.recall(
        { query: "context", botId: "bot-1", scope: "isolated", limit: 5 },
        context,
      );
      finishDns([{ address: "10.0.0.2", family: 4 }]);
      await started;
      deadline.abort(new Error("shared operation deadline"));
      await expect(pending).resolves.toMatchObject({ ok: false });
      expect(fetch).toHaveBeenCalledOnce();
      expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    } finally {
      timeout.mockRestore();
    }
  });

  it("needs the deployment owner before contacting a self-hosted server", async () => {
    const fetch = vi.fn();
    const resolveHostname = vi.fn(privateResolver);
    await expect(
      prepareHindsightConnection(
        { mode: "local", baseUrl: LOCAL_URL },
        { apiKey: "" },
        { resolveHostname, fetch },
      ),
    ).rejects.toBeInstanceOf(MemoryProviderPrivateEndpointRequiredError);
    await expect(
      prepareHindsightConnection(
        { mode: "local", baseUrl: "https://hindsight.example.com" },
        { apiKey: "" },
        { allowPrivateEndpoint: true, resolveHostname: publicResolver, fetch },
      ),
    ).rejects.toThrow(/private-network/);
    expect(fetch).not.toHaveBeenCalled();
    expect(resolveHostname).not.toHaveBeenCalled();
  });

  it("requires a cloud key but lets a self-hosted server run without one", async () => {
    await expect(
      prepareHindsightConnection({}, { apiKey: "1234567" }, { fetch: vi.fn() }),
    ).rejects.toThrow("apiKey must contain 8–4096 characters");
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe(`${LOCAL_URL}/v1/default/banks?limit=1`);
      expect(new Headers(init?.headers).has("authorization")).toBe(false);
      return Response.json({ banks: [] });
    });
    await expect(
      prepareHindsightConnection(
        { mode: "local", baseUrl: LOCAL_URL, apiKey: "leaked" },
        { apiKey: " " },
        { allowPrivateEndpoint: true, resolveHostname: privateResolver, fetch },
      ),
    ).resolves.toEqual({
      settings: { mode: "local", baseUrl: LOCAL_URL },
      credentials: { apiKey: "" },
    });
  });

  it("normalizes recall banks and requires each to exist", async () => {
    const existing = hindsightFake({ banks: ["other-app", "notes"] });
    await expect(
      prepareHindsightConnection(
        {
          recallBanks: " other-app, ,notes,other-app ",
          retainConversations: "false",
          apiKey: "hsk-test-key",
        },
        { apiKey: "hsk-test-key" },
        { fetch: existing.fetch },
      ),
    ).resolves.toEqual({
      settings: { recallBanks: "other-app,notes", retainConversations: "false" },
      credentials: { apiKey: "hsk-test-key" },
    });
    expect(
      existing.requests.map((request) => `${request.method} ${request.bank}${request.rest}`),
    ).toEqual(["GET ", "GET other-app/config", "GET notes/config"]);
    await expect(
      prepareHindsightConnection(
        { recallBanks: "other-app,missing" },
        { apiKey: "hsk-test-key" },
        { fetch: hindsightFake({ banks: ["other-app"] }).fetch },
      ),
    ).rejects.toThrow('Hindsight bank "missing" was not found.');
  });

  it("checks banks concurrently under the setup deadline and names an unverified bank", async () => {
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValueOnce(deadline.signal);
    let markBanksStarted!: () => void;
    const banksStarted = new Promise<void>((resolve) => {
      markBanksStarted = resolve;
    });
    let banks = 0;
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (!String(url).endsWith("/config")) return Response.json({ banks: [] });
      if (++banks === 2) markBanksStarted();
      const signal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });
    try {
      const preparing = prepareHindsightConnection(
        { recallBanks: "notes,profile" },
        { apiKey: "hsk-test-key" },
        { fetch },
      );
      await banksStarted;
      deadline.abort();
      await expect(preparing).rejects.toThrow('Hindsight bank "notes" could not be verified:');
      expect(fetch).toHaveBeenCalledTimes(3);
      expect(fetch.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
      expect(timeout).toHaveBeenNthCalledWith(1, 10_000);
    } finally {
      timeout.mockRestore();
    }
  });

  it("rejects malformed or too many recall banks before any request", async () => {
    const fetch = vi.fn();
    for (const recallBanks of ["my bank", "a/b", "a?b", "a#b", "a%b", "a\\b"]) {
      await expect(
        prepareHindsightConnection({ recallBanks }, { apiKey: "hsk-test-key" }, { fetch }),
      ).rejects.toThrow("recallBanks may not contain spaces, /, ?, #, % or \\");
    }
    await expect(
      prepareHindsightConnection(
        { recallBanks: Array.from({ length: 11 }, (_, index) => `bank-${index}`).join(",") },
        { apiKey: "hsk-test-key" },
        { fetch },
      ),
    ).rejects.toThrow("recallBanks may list at most 10 banks");
    for (const recallBanks of [".", "notes,.."]) {
      await expect(
        prepareHindsightConnection({ recallBanks }, { apiKey: "hsk-test-key" }, { fetch }),
      ).rejects.toThrow("recallBanks may not include . or ..");
    }
    for (const recallBanks of [
      "rakazo-0123456789abcdef0123456789ABCDEF",
      "rakazo-clegacyspaceid",
      "rakazo-private-team-bot-1",
      "RAKAZO-legacy-organization",
      "notes,rakazo-notes",
      "notes,rakazo-01234567-89ab-cdef-0123-456789abcdef-bot-9",
    ]) {
      await expect(
        prepareHindsightConnection({ recallBanks }, { apiKey: "hsk-test-key" }, { fetch }),
      ).rejects.toThrow("Bank names starting with rakazo- are reserved.");
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects the reserved namespace in persisted settings before making requests", () => {
    expect(() =>
      createHindsightProvider(
        { recallBanks: "rakazo-legacy-organization" },
        { apiKey: "hsk-test-key" },
      ),
    ).toThrow("Bank names starting with rakazo- are reserved.");
  });

  it("validates recall settings and keeps only those that differ from the defaults", async () => {
    const fetch = vi.fn();
    await expect(
      prepareHindsightConnection({ recallBudget: "max" }, { apiKey: "hsk-test-key" }, { fetch }),
    ).rejects.toThrow("recallBudget must be low, mid or high");
    await expect(
      prepareHindsightConnection({ recallFacts: "yes" }, { apiKey: "hsk-test-key" }, { fetch }),
    ).rejects.toThrow("recallFacts must be true or false");
    expect(fetch).not.toHaveBeenCalled();
    const defaults = {
      autoRecall: "true",
      recallBudget: "mid",
      recallFacts: "false",
      skipUnrelated: "false",
    };
    await expect(
      prepareHindsightConnection(
        defaults,
        { apiKey: "hsk-test-key" },
        {
          fetch: hindsightFake().fetch,
        },
      ),
    ).resolves.toEqual({ settings: {}, credentials: { apiKey: "hsk-test-key" } });
    const changed = {
      autoRecall: "false",
      recallBudget: "high",
      recallFacts: "true",
      skipUnrelated: "true",
    };
    await expect(
      prepareHindsightConnection(
        changed,
        { apiKey: "hsk-test-key" },
        {
          fetch: hindsightFake().fetch,
        },
      ),
    ).resolves.toEqual({ settings: changed, credentials: { apiKey: "hsk-test-key" } });
  });

  it("recalls before every run unless automatic recall is off", () => {
    const key = { apiKey: "hsk-test-key" };
    const on = createHindsightProvider({}, key).describe().capabilities;
    expect(on).toMatchObject({ recallEachRun: true });
    expect(on).not.toHaveProperty("recallOnRequestOnly");
    const off = createHindsightProvider({ autoRecall: "false" }, key).describe().capabilities;
    expect(off).toMatchObject({ recallOnRequestOnly: true });
    expect(off).not.toHaveProperty("recallEachRun");
  });
});
