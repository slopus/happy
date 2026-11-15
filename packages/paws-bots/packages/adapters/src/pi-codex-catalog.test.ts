import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { parseModelSecret } from "./model-secret.js";
import { listAvailablePiCatalog } from "./pi-catalog-availability.js";
import type { CodexCatalogModel, CodexCatalogSpaceAuth } from "./pi-codex-catalog.js";
import {
  applyCodexLiveCatalog,
  CODEX_MODELS_ENDPOINT,
  CodexCatalogCache,
  codexLiveCatalogsForSpace,
  codexLiveListsModel,
  fetchCodexCatalog,
  parseCodexCatalog,
  resolveCodexOAuthDefaultModel,
} from "./pi-codex-catalog.js";
import { liveCatalogEntry } from "./pi-live-catalog.js";
import { listPiCatalog } from "./pi-models.js";
import { CHATGPT_OAUTH_PROVIDER } from "./pi-oauth.js";

const SPARK = "gpt-5.3-codex-spark";
const LUNA = "gpt-6-luna";
const SOL = "gpt-6-sol";
const ACCESS_TOKEN = "fake-access-token-for-tests";
const ACCOUNT_ID = "acct-test-1";

function liveModel(slug: string, extra: Partial<CodexCatalogModel> = {}): CodexCatalogModel {
  return {
    slug,
    reasoningEfforts: [],
    supportsImages: false,
    supportsFastTier: false,
    ...extra,
  };
}

function catalogPayload(models: unknown[]) {
  return { models };
}

function okResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function oauthPlaintext(access = ACCESS_TOKEN, expiresInMs = 3_600_000, accountId = ACCOUNT_ID) {
  return JSON.stringify({
    type: "oauth",
    access,
    refresh: "fake-refresh-token",
    expires: Date.now() + expiresInMs,
    accountId,
  });
}

function authPrisma(options: { secrets?: Array<{ id: string; ciphertext: string }> }) {
  return {
    secret: {
      findMany: vi
        .fn()
        .mockImplementation(async (args: { where: { id?: string | { in?: string[] } } }) => {
          const id = args.where.id;
          const ids = typeof id === "string" ? [id] : (id?.in ?? []);
          return (options.secrets ?? []).filter((row) => ids.includes(row.id));
        }),
      update: vi.fn().mockResolvedValue({}),
    },
  } as unknown as PrismaClient;
}

describe("resolveCodexOAuthDefaultModel", () => {
  const oauthSecret = () => parseModelSecret(oauthPlaintext());
  const catalog = (models: CodexCatalogModel[]) => ({
    read: vi.fn(async () => models),
  });

  it("keeps the requested model when the connected account lists it", async () => {
    const result = await resolveCodexOAuthDefaultModel(
      catalog([liveModel(LUNA)]),
      "user-test",
      oauthSecret(),
      LUNA,
    );

    expect(result).toBe(LUNA);
  });

  it("uses an account model when the requested model is unavailable", async () => {
    const result = await resolveCodexOAuthDefaultModel(
      catalog([liveModel(LUNA)]),
      "user-test",
      oauthSecret(),
      SPARK,
    );

    expect(result).toBe(LUNA);
  });

  it("uses an account model when no model was requested", async () => {
    const result = await resolveCodexOAuthDefaultModel(
      catalog([liveModel(SOL)]),
      "user-test",
      oauthSecret(),
      undefined,
    );

    expect(result).toBe(SOL);
  });

  it("keeps the normal fallback when the account catalog cannot be trusted", async () => {
    const result = await resolveCodexOAuthDefaultModel(
      catalog([liveModel("unrelated-model")]),
      "user-test",
      oauthSecret(),
      LUNA,
    );

    expect(result).toBe(LUNA);
  });
});

describe("fetchCodexCatalog", () => {
  it("requests the backend catalog with OAuth headers and the pinned client version", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => okResponse(catalogPayload([])));

    const result = await fetchCodexCatalog(ACCESS_TOKEN, ACCOUNT_ID, fetchImpl);

    expect(result.status).toBe("ok");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe(`${CODEX_MODELS_ENDPOINT}?client_version=0.159.3`);
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(headers.get("chatgpt-account-id")).toBe(ACCOUNT_ID);
    expect(headers.get("originator")).toBe("rakazo");
    expect(headers.get("accept")).toBe("application/json");
  });

  it("returns typed http failures with the status code", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () => new Response("nope", { status: 401, statusText: "Unauthorized" }),
    );
    const result = await fetchCodexCatalog(ACCESS_TOKEN, ACCOUNT_ID, fetchImpl);
    expect(result).toEqual({ status: "error", reason: "http", httpStatus: 401 });
  });

  it("treats invalid JSON and missing models as malformed", async () => {
    const badJson = await fetchCodexCatalog(ACCESS_TOKEN, ACCOUNT_ID, async () =>
      okResponse("<html>not json</html>"),
    );
    expect(badJson).toEqual({ status: "error", reason: "malformed" });

    const noModels = await fetchCodexCatalog(ACCESS_TOKEN, ACCOUNT_ID, async () =>
      okResponse({ unexpected: true }),
    );
    expect(noModels).toEqual({ status: "error", reason: "malformed" });
  });

  it("caps the response body size via content-length", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(null, {
          status: 200,
          headers: { "content-length": String(2 * 1024 * 1024) },
        }),
    );
    const result = await fetchCodexCatalog(ACCESS_TOKEN, ACCOUNT_ID, fetchImpl);
    expect(result).toEqual({ status: "error", reason: "malformed" });
  });

  it("caps the response body size while streaming", async () => {
    const chunk = new Uint8Array(1024).fill(65);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 1200; i += 1) controller.enqueue(chunk);
      },
    });
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(stream, { status: 200 }));
    const result = await fetchCodexCatalog(ACCESS_TOKEN, ACCOUNT_ID, fetchImpl);
    expect(result).toEqual({ status: "error", reason: "malformed" });
  });

  it("maps abort timeouts and transport failures to typed reasons", async () => {
    const timeout = await fetchCodexCatalog(ACCESS_TOKEN, ACCOUNT_ID, async () => {
      throw new DOMException("timed out", "TimeoutError");
    });
    expect(timeout).toEqual({ status: "error", reason: "timeout" });

    const transport = await fetchCodexCatalog(ACCESS_TOKEN, ACCOUNT_ID, async () => {
      throw new Error("fetch failed");
    });
    expect(transport).toEqual({ status: "error", reason: "transport" });
  });

  it("never embeds credential material in failures", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new Error(`connection failed while sending ${ACCESS_TOKEN} for ${ACCOUNT_ID}`);
    });
    const result = await fetchCodexCatalog(ACCESS_TOKEN, ACCOUNT_ID, fetchImpl);
    expect(JSON.stringify(result)).not.toContain(ACCESS_TOKEN);
    expect(JSON.stringify(result)).not.toContain(ACCOUNT_ID);
  });
});

describe("parseCodexCatalog", () => {
  it("keeps only listed models that the API supports", () => {
    const parsed = parseCodexCatalog(
      catalogPayload([
        {
          slug: "gpt-5.4-mini",
          visibility: "list",
          supported_in_api: true,
          priority: 7,
          supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }],
          additional_speed_tiers: [],
          input_modalities: ["text", "image"],
          context_window: 272000,
        },
        {
          slug: "hidden",
          visibility: "hide",
          supported_in_api: true,
          supported_reasoning_levels: [],
          additional_speed_tiers: ["fast"],
          input_modalities: ["text"],
          context_window: 1,
        },
        {
          slug: "unsupported",
          visibility: "list",
          supported_in_api: false,
        },
      ]),
    );

    expect(parsed).toEqual([
      {
        slug: "gpt-5.4-mini",
        reasoningEfforts: ["low", "high"],
        contextWindow: 272000,
        supportsImages: true,
        supportsFastTier: false,
      },
    ]);
  });

  it("detects the fast tier", () => {
    const parsed = parseCodexCatalog(
      catalogPayload([
        {
          slug: SPARK,
          visibility: "list",
          supported_in_api: true,
          additional_speed_tiers: ["fast", "standard"],
          input_modalities: ["text"],
        },
      ]),
    );
    expect(parsed?.[0]?.supportsFastTier).toBe(true);
    expect(parsed?.[0]?.supportsImages).toBe(false);
  });

  it.each([undefined, null])(
    "leaves image support unset when input modalities are %s",
    (inputModalities) => {
      const parsed = parseCodexCatalog(
        catalogPayload([
          {
            slug: "gpt-6.1-sol",
            visibility: "list",
            supported_in_api: true,
            ...(inputModalities === null ? { input_modalities: null } : {}),
          },
        ]),
      );
      expect(parsed?.[0]?.supportsImages).toBeUndefined();
      expect(parsed?.[0]?.supportsFastTier).toBe(false);
    },
  );

  it.each([
    ["non-object payload", "nope"],
    ["models not an array", { models: {} }],
    ["entry not an object", catalogPayload([42])],
    ["missing visibility", catalogPayload([{ slug: "x", supported_in_api: true }])],
    [
      "non-boolean supported_in_api",
      catalogPayload([{ visibility: "list", supported_in_api: "yes" }]),
    ],
    [
      "missing slug on a kept entry",
      catalogPayload([{ visibility: "list", supported_in_api: true }]),
    ],
    [
      "slug with a space",
      catalogPayload([{ slug: "not a slug", visibility: "list", supported_in_api: true }]),
    ],
    [
      "slug over the length bound",
      catalogPayload([{ slug: "x".repeat(1025), visibility: "list", supported_in_api: true }]),
    ],
    [
      "malformed reasoning level",
      catalogPayload([
        {
          slug: "ok",
          visibility: "list",
          supported_in_api: true,
          supported_reasoning_levels: [{ effort: "not valid!" }],
        },
      ]),
    ],
    [
      "negative context window",
      catalogPayload([
        { slug: "ok", visibility: "list", supported_in_api: true, context_window: -5 },
      ]),
    ],
    [
      "non-integer context window",
      catalogPayload([
        { slug: "ok", visibility: "list", supported_in_api: true, context_window: 1.5 },
      ]),
    ],
    [
      "non-string modality",
      catalogPayload([
        { slug: "ok", visibility: "list", supported_in_api: true, input_modalities: [3] },
      ]),
    ],
  ])("rejects malformed input: %s", (_name, payload) => {
    expect(parseCodexCatalog(payload)).toBeUndefined();
  });

  it("rejects a catalog over the model count bound", () => {
    const models = Array.from({ length: 129 }, (_, i) => ({
      slug: `model-${i}`,
      visibility: "list",
      supported_in_api: true,
    }));
    expect(parseCodexCatalog(catalogPayload(models))).toBeUndefined();
  });

  it("accepts a catalog at the model count bound", () => {
    const models = Array.from({ length: 128 }, (_, i) => ({
      slug: `model-${i}`,
      visibility: "list",
      supported_in_api: true,
    }));
    expect(parseCodexCatalog(catalogPayload(models))).toHaveLength(128);
  });
});

describe("CodexCatalogCache", () => {
  const account = (accessToken: string | null = ACCESS_TOKEN) => ({
    accountId: ACCOUNT_ID,
    accessToken: async () => accessToken,
  });

  function listFetch(slugs: string[] = [SPARK]) {
    return vi.fn<typeof fetch>(async () =>
      okResponse(
        catalogPayload(slugs.map((slug) => ({ slug, visibility: "list", supported_in_api: true }))),
      ),
    );
  }

  it("serves a fresh entry without refetching inside the TTL", async () => {
    let now = 1_000_000;
    const fetchImpl = listFetch();
    const cache = new CodexCatalogCache({
      enabled: true,
      fetch: fetchImpl,
      now: () => now,
      waitMs: 50,
    });

    const first = await cache.read("user-1", account());
    expect(first?.map((model) => model.slug)).toEqual([SPARK]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    now += 14 * 60_000;
    const second = await cache.read("user-1", account());
    expect(second).toEqual(first);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("serves stale entries while revalidating in the background", async () => {
    let now = 1_000_000;
    let resolveSecond: ((response: Response) => void) | undefined;
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(async () =>
        okResponse(catalogPayload([{ slug: SPARK, visibility: "list", supported_in_api: true }])),
      )
      .mockImplementationOnce(
        async () => new Promise<Response>((resolve) => (resolveSecond = resolve)),
      )
      .mockImplementation(async () =>
        okResponse(catalogPayload([{ slug: SPARK, visibility: "list", supported_in_api: true }])),
      );
    const cache = new CodexCatalogCache({
      enabled: true,
      fetch: fetchImpl,
      now: () => now,
      waitMs: 50,
    });

    await cache.read("user-1", account());
    now += 16 * 60_000;

    const stale = await cache.read("user-1", account());
    expect(stale?.map((model) => model.slug)).toEqual([SPARK]);
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));

    resolveSecond?.(
      okResponse(
        catalogPayload([
          { slug: SPARK, visibility: "list", supported_in_api: true },
          { slug: LUNA, visibility: "list", supported_in_api: true },
        ]),
      ),
    );
    await vi.waitFor(async () => {
      const next = await cache.read("user-1", account());
      expect(next?.map((model) => model.slug)).toEqual([SPARK, LUNA]);
    });
  });

  it("single-flights concurrent cold reads", async () => {
    let resolveFetch: ((response: Response) => void) | undefined;
    const fetchImpl = vi.fn<typeof fetch>(
      async () => new Promise<Response>((resolve) => (resolveFetch = resolve)),
    );
    const cache = new CodexCatalogCache({
      enabled: true,
      fetch: fetchImpl,
      now: () => 0,
      waitMs: 2_000,
    });

    const reads = Promise.all([
      cache.read("user-1", account()),
      cache.read("user-1", account()),
      cache.read("user-1", account()),
    ]);
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    resolveFetch?.(
      okResponse(catalogPayload([{ slug: SPARK, visibility: "list", supported_in_api: true }])),
    );
    const results = await reads;
    for (const result of results) expect(result?.[0]?.slug).toBe(SPARK);
  });

  it("bounds the cold read wait and caches the eventual result", async () => {
    let resolveFetch: ((response: Response) => void) | undefined;
    const fetchImpl = vi.fn<typeof fetch>(
      async () => new Promise<Response>((resolve) => (resolveFetch = resolve)),
    );
    const cache = new CodexCatalogCache({
      enabled: true,
      fetch: fetchImpl,
      now: () => 0,
      waitMs: 30,
    });

    const slow = await cache.read("user-1", account());
    expect(slow).toBeUndefined();

    resolveFetch?.(
      okResponse(catalogPayload([{ slug: SPARK, visibility: "list", supported_in_api: true }])),
    );
    await vi.waitFor(async () => {
      const later = await cache.read("user-1", account());
      expect(later?.[0]?.slug).toBe(SPARK);
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("a hung fetch never delays reads and later recovers", async () => {
    let now = 1_000_000;
    const hung = new Promise<Response>(() => undefined);
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(async () => hung)
      .mockImplementation(async () =>
        okResponse(catalogPayload([{ slug: SPARK, visibility: "list", supported_in_api: true }])),
      );
    const cache = new CodexCatalogCache({
      enabled: true,
      fetch: fetchImpl,
      now: () => now,
      waitMs: 20,
      deadlineMs: 40,
      failureTtlMs: 1_000,
    });

    const start = Date.now();
    const result = await cache.read("user-1", account());
    expect(result).toBeUndefined();
    expect(Date.now() - start).toBeLessThan(1_000);

    // Let the hard deadline retire the hung refresh, then move past the
    // failure TTL so the next read revalidates instead of serving the miss.
    await new Promise((resolve) => setTimeout(resolve, 80));
    now += 2_000;
    expect(await cache.read("user-1", account())).toBeUndefined();
    await vi.waitFor(async () => {
      const retry = await cache.read("user-1", account());
      expect(retry?.[0]?.slug).toBe(SPARK);
    });
    expect(fetchImpl.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("negative-caches failures for the failure TTL", async () => {
    let now = 1_000_000;
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("x", { status: 503 }));
    const cache = new CodexCatalogCache({
      enabled: true,
      fetch: fetchImpl,
      now: () => now,
      waitMs: 50,
      failureTtlMs: 30_000,
    });

    expect(await cache.read("user-1", account())).toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    now += 10_000;
    expect(await cache.read("user-1", account())).toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    now += 30_000;
    expect(await cache.read("user-1", account())).toBeUndefined();
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
  });

  it("keeps serving the last good catalog when a refresh fails", async () => {
    let now = 1_000_000;
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(async () =>
        okResponse(catalogPayload([{ slug: SPARK, visibility: "list", supported_in_api: true }])),
      )
      .mockImplementation(async () => new Response("x", { status: 503 }));
    const cache = new CodexCatalogCache({
      enabled: true,
      fetch: fetchImpl,
      now: () => now,
      waitMs: 50,
      failureTtlMs: 30_000,
    });

    expect((await cache.read("user-1", account()))?.[0]?.slug).toBe(SPARK);

    // Past the TTL a read serves the stale list and refreshes in the background;
    // the refresh fails but the good catalog must not be evicted.
    now += 16 * 60_000;
    expect((await cache.read("user-1", account()))?.[0]?.slug).toBe(SPARK);
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
    // Let the failed refresh settle so the stale-on-failure entry is stored.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await cache.read("user-1", account()))?.[0]?.slug).toBe(SPARK);

    // The failure TTL only paces the next retry, which fails again — still stale.
    now += 31_000;
    expect((await cache.read("user-1", account()))?.[0]?.slug).toBe(SPARK);
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(3));
    expect((await cache.read("user-1", account()))?.[0]?.slug).toBe(SPARK);
  });

  it("stops serving the last good catalog past the staleness bound, until a refresh succeeds", async () => {
    let now = 1_000_000;
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(async () =>
        okResponse(catalogPayload([{ slug: SPARK, visibility: "list", supported_in_api: true }])),
      )
      .mockImplementation(async () => new Response("x", { status: 503 }));
    const cache = new CodexCatalogCache({
      enabled: true,
      fetch: fetchImpl,
      now: () => now,
      waitMs: 50,
      ttlMs: 60_000,
      failureTtlMs: 10_000,
      staleMaxAgeMs: 120_000,
    });

    expect((await cache.read("user-1", account()))?.[0]?.slug).toBe(SPARK);

    // Expired but within the bound: failed refreshes keep the last good list.
    now += 70_000;
    expect((await cache.read("user-1", account()))?.[0]?.slug).toBe(SPARK);
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve, 20));

    now += 11_000;
    expect((await cache.read("user-1", account()))?.[0]?.slug).toBe(SPARK);
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(3));
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Past the bound the account's old list is distrusted: reads fall back to
    // static even though a refresh is still running and failing behind them.
    now += 50_000;
    expect(await cache.read("user-1", account())).toBeUndefined();
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(4));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await cache.read("user-1", account())).toBeUndefined();

    // A refresh that finally succeeds repopulates the list as fresh data.
    fetchImpl.mockImplementation(async () =>
      okResponse(catalogPayload([{ slug: LUNA, visibility: "list", supported_in_api: true }])),
    );
    now += 11_000;
    expect(await cache.read("user-1", account())).toBeUndefined();
    await vi.waitFor(async () => {
      expect((await cache.read("user-1", account()))?.[0]?.slug).toBe(LUNA);
    });
  });

  it("waitMs 0 consults only settled cache state while still warming a miss", async () => {
    let resolveFetch: ((response: Response) => void) | undefined;
    const fetchImpl = vi.fn<typeof fetch>(
      async () => new Promise<Response>((resolve) => (resolveFetch = resolve)),
    );
    const cache = new CodexCatalogCache({
      enabled: true,
      fetch: fetchImpl,
      now: () => 0,
      waitMs: 30_000,
    });

    // A cold miss returns immediately instead of waiting on the network.
    expect(await cache.read("user-1", account(), { waitMs: 0 })).toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // The kicked revalidation keeps running; a later zero-wait read sees it.
    resolveFetch?.(
      okResponse(catalogPayload([{ slug: SPARK, visibility: "list", supported_in_api: true }])),
    );
    await vi.waitFor(async () => {
      expect((await cache.read("user-1", account(), { waitMs: 0 }))?.[0]?.slug).toBe(SPARK);
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("keeps catalogs isolated per (userId, accountId)", async () => {
    const fetchImpl = listFetch();
    const cache = new CodexCatalogCache({
      enabled: true,
      fetch: fetchImpl,
      now: () => 0,
      waitMs: 50,
    });

    await cache.read("user-1", account());
    await cache.read("user-2", account());
    await cache.read("user-1", { accountId: "acct-other", accessToken: async () => ACCESS_TOKEN });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("cannot collide keys across the userId/accountId boundary", async () => {
    const fetchImpl = listFetch();
    const cache = new CodexCatalogCache({
      enabled: true,
      fetch: fetchImpl,
      now: () => 0,
      waitMs: 50,
    });

    await cache.read("ab", { accountId: "c", accessToken: async () => ACCESS_TOKEN });
    await cache.read("a", { accountId: "bc", accessToken: async () => ACCESS_TOKEN });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("treats an empty catalog as a failure so the static list stays", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => okResponse(catalogPayload([])));
    const cache = new CodexCatalogCache({
      enabled: true,
      fetch: fetchImpl,
      now: () => 0,
      waitMs: 50,
    });
    expect(await cache.read("user-1", account())).toBeUndefined();
  });

  it("does not negative-cache a read that never got a bearer", async () => {
    const fetchImpl = listFetch();
    const cache = new CodexCatalogCache({
      enabled: true,
      fetch: fetchImpl,
      now: () => 0,
      waitMs: 50,
      failureTtlMs: 30_000,
    });

    // No usable bearer: no fetch, and — unlike a real failure — no failure
    // entry, so the next read retries instead of waiting out the TTL.
    expect(await cache.read("user-1", account(null))).toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();

    // The credential's detached refresh landed: the very next read, well inside
    // what would have been the failure TTL, must reach the network.
    expect((await cache.read("user-1", account()))?.[0]?.slug).toBe(SPARK);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("keeps serving the last good catalog while the bearer is expired, then recovers", async () => {
    let now = 1_000_000;
    const fetchImpl = listFetch();
    const cache = new CodexCatalogCache({
      enabled: true,
      fetch: fetchImpl,
      now: () => now,
      waitMs: 50,
      failureTtlMs: 30_000,
    });
    let bearer: string | null = ACCESS_TOKEN;
    const liveAccount = { accountId: ACCOUNT_ID, accessToken: async () => bearer };

    expect((await cache.read("user-1", liveAccount))?.[0]?.slug).toBe(SPARK);

    // Bearer expires while the entry is stale: the last good list still serves
    // and no fetch is attempted — and nothing is cached over the stale entry,
    // so every read re-checks the credential.
    now += 16 * 60_000;
    bearer = null;
    expect((await cache.read("user-1", liveAccount))?.[0]?.slug).toBe(SPARK);
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));

    // Refresh landed: the next read revalidates for real, not after the
    // failure TTL, and the fresh entry then serves without refetching.
    bearer = ACCESS_TOKEN;
    await vi.waitFor(async () => {
      await cache.read("user-1", liveAccount);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    });
    now += 60_000;
    expect((await cache.read("user-1", liveAccount))?.[0]?.slug).toBe(SPARK);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe("codexLiveListsModel", () => {
  const oauthSecret = (access = ACCESS_TOKEN, expiresInMs = 3_600_000, accountId = ACCOUNT_ID) =>
    parseModelSecret(oauthPlaintext(access, expiresInMs, accountId));

  it("confirms a model the credential's own account catalog lists", async () => {
    const read = vi.fn(async () => [liveModel(SPARK)]);
    await expect(codexLiveListsModel({ read }, "user-1", oauthSecret(), SPARK)).resolves.toBe(true);
    expect(read).toHaveBeenCalledWith(
      "user-1",
      expect.objectContaining({ accountId: ACCOUNT_ID }),
      undefined,
    );
  });

  it("rejects when the live catalog does not list the model", async () => {
    const read = vi.fn(async () => [liveModel(LUNA)]);
    await expect(codexLiveListsModel({ read }, "user-1", oauthSecret(), SPARK)).resolves.toBe(
      false,
    );
  });

  it("rejects without a catalog, an account id, or OAuth auth", async () => {
    const read = vi.fn(async () => [liveModel(SPARK)]);
    await expect(codexLiveListsModel(undefined, "user-1", oauthSecret(), SPARK)).resolves.toBe(
      false,
    );
    await expect(
      codexLiveListsModel({ read }, "user-1", parseModelSecret("sk-plain-key"), SPARK),
    ).resolves.toBe(false);
    await expect(
      codexLiveListsModel(
        { read },
        "user-1",
        oauthSecret("opaque-not-a-jwt", 3_600_000, ""),
        SPARK,
      ),
    ).resolves.toBe(false);
    expect(read).not.toHaveBeenCalled();
  });

  it("extracts the account id from the access JWT when the credential lacks it", async () => {
    const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const access = `${b64({ alg: "none" })}.${b64({
      "https://api.openai.com/auth": { chatgpt_account_id: "acct-jwt" },
    })}.sig`;
    const read = vi.fn(async () => [liveModel(SPARK)]);

    await expect(
      codexLiveListsModel({ read }, "user-1", oauthSecret(access, 3_600_000, ""), SPARK),
    ).resolves.toBe(true);
    expect(read).toHaveBeenCalledWith(
      "user-1",
      expect.objectContaining({ accountId: "acct-jwt" }),
      undefined,
    );
  });

  it("never fetches for an expired token — and never refreshes or writes one", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      okResponse(catalogPayload([{ slug: SPARK, visibility: "list", supported_in_api: true }])),
    );
    const cache = new CodexCatalogCache({
      enabled: true,
      fetch: fetchImpl,
      now: () => Date.now(),
      waitMs: 50,
    });
    const expired = oauthSecret(ACCESS_TOKEN, -1_000);

    await expect(codexLiveListsModel(cache, "user-1", expired, SPARK)).resolves.toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fires onExpiredToken for an expired bearer but still answers statically", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      okResponse(catalogPayload([{ slug: SPARK, visibility: "list", supported_in_api: true }])),
    );
    const cache = new CodexCatalogCache({
      enabled: true,
      fetch: fetchImpl,
      now: () => Date.now(),
      waitMs: 50,
    });
    const onExpiredToken = vi.fn();

    await expect(
      codexLiveListsModel(cache, "user-1", oauthSecret(ACCESS_TOKEN, -1_000), SPARK, {
        onExpiredToken,
      }),
    ).resolves.toBe(false);
    expect(onExpiredToken).toHaveBeenCalledTimes(1);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("recovers on the next read once the detached refresh replaces the bearer", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      okResponse(catalogPayload([{ slug: SPARK, visibility: "list", supported_in_api: true }])),
    );
    // failureTtlMs dwarfs the test: a cached failure would hide the model.
    const cache = new CodexCatalogCache({
      enabled: true,
      fetch: fetchImpl,
      now: () => Date.now(),
      waitMs: 50,
    });
    const onExpiredToken = vi.fn();

    await expect(
      codexLiveListsModel(cache, "user-1", oauthSecret(ACCESS_TOKEN, -1_000), SPARK, {
        onExpiredToken,
      }),
    ).resolves.toBe(false);
    expect(onExpiredToken).toHaveBeenCalledTimes(1);
    expect(fetchImpl).not.toHaveBeenCalled();

    // The expired-bearer read left no failure entry, so a refreshed credential
    // reaches the network on the very next check.
    await expect(codexLiveListsModel(cache, "user-1", oauthSecret(), SPARK)).resolves.toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not fire onExpiredToken while the bearer is valid", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      okResponse(catalogPayload([{ slug: SPARK, visibility: "list", supported_in_api: true }])),
    );
    const cache = new CodexCatalogCache({
      enabled: true,
      fetch: fetchImpl,
      now: () => Date.now(),
      waitMs: 50,
    });
    const onExpiredToken = vi.fn();

    await expect(
      codexLiveListsModel(cache, "user-1", oauthSecret(), SPARK, { onExpiredToken }),
    ).resolves.toBe(true);
    expect(onExpiredToken).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("codexLiveCatalogsForSpace", () => {
  const scope = { userId: "user-1", spaceId: "space-1" };
  const oauthAuthFor = (secretId: string): CodexCatalogSpaceAuth => ({
    byProvider: { [CHATGPT_OAUTH_PROVIDER]: "oauth" },
    byModel: {},
    secretIdByProvider: { [CHATGPT_OAUTH_PROVIDER]: secretId },
    secretIdByModel: {},
  });

  function secretsById(map: Record<string, string>) {
    return {
      load: vi.fn(async (ciphertext: string, id: string) => {
        const plaintext = map[ciphertext];
        if (plaintext === undefined) throw new Error(`unreadable ${id}`);
        return plaintext;
      }),
      // Deliberately present so a test can pin the read-only contract.
      put: vi.fn(async () => ({ id: "unused", ciphertext: "unused" })),
    };
  }

  it("reads the catalog for each OAuth credential that governs a codex slot", async () => {
    const prisma = authPrisma({
      secrets: [
        { id: "secret-a", ciphertext: "cipher-a" },
        { id: "secret-b", ciphertext: "cipher-b" },
      ],
    });
    const secrets = secretsById({
      "cipher-a": oauthPlaintext(ACCESS_TOKEN, 3_600_000, "acct-a"),
      "cipher-b": oauthPlaintext(ACCESS_TOKEN, 3_600_000, "acct-b"),
    });
    const read = vi.fn(async (_userId: string, account: { accountId: string }) =>
      account.accountId === "acct-b" ? [liveModel(SPARK)] : [liveModel(LUNA)],
    );
    const auth: CodexCatalogSpaceAuth = {
      byProvider: { [CHATGPT_OAUTH_PROVIDER]: "oauth" },
      byModel: { [CHATGPT_OAUTH_PROVIDER]: { [SPARK]: "oauth" } },
      secretIdByProvider: { [CHATGPT_OAUTH_PROVIDER]: "secret-a" },
      secretIdByModel: { [CHATGPT_OAUTH_PROVIDER]: { [SPARK]: "secret-b" } },
    };

    const live = await codexLiveCatalogsForSpace(prisma, secrets, scope, auth, { read });

    expect(live.get("secret-a")?.[0]?.slug).toBe(LUNA);
    expect(live.get("secret-b")?.[0]?.slug).toBe(SPARK);
    const accountIds = read.mock.calls.map((call) => call[1].accountId).sort();
    expect(accountIds).toEqual(["acct-a", "acct-b"]);
    expect(secrets.put).not.toHaveBeenCalled();
  });

  it("skips credentials that are not OAuth, unreadable, or lack an account id", async () => {
    const prisma = authPrisma({
      secrets: [
        { id: "secret-a", ciphertext: "cipher-a" },
        { id: "secret-b", ciphertext: "cipher-b" },
        { id: "secret-c", ciphertext: "cipher-c" },
      ],
    });
    const secrets = secretsById({
      "cipher-a": "sk-test-plain-key",
      "cipher-c": oauthPlaintext("opaque-token", 3_600_000, ""),
    });
    const read = vi.fn(async () => [liveModel(SPARK)]);
    const auth: CodexCatalogSpaceAuth = {
      byProvider: { [CHATGPT_OAUTH_PROVIDER]: "oauth" },
      byModel: {
        [CHATGPT_OAUTH_PROVIDER]: { [SPARK]: "oauth", [LUNA]: "oauth" },
      },
      secretIdByProvider: { [CHATGPT_OAUTH_PROVIDER]: "secret-a" },
      secretIdByModel: {
        [CHATGPT_OAUTH_PROVIDER]: { [SPARK]: "secret-b", [LUNA]: "secret-c" },
      },
    };

    const live = await codexLiveCatalogsForSpace(prisma, secrets, scope, auth, { read });

    expect(live.size).toBe(0);
    expect(read).not.toHaveBeenCalled();
  });

  it("does not read a catalog for an api_key or disconnected slot", async () => {
    const prisma = authPrisma({ secrets: [{ id: "secret-a", ciphertext: "cipher-a" }] });
    const secrets = secretsById({ "cipher-a": "sk-test-plain-key" });
    const read = vi.fn(async () => [liveModel(SPARK)]);
    const auth: CodexCatalogSpaceAuth = {
      byProvider: { [CHATGPT_OAUTH_PROVIDER]: "api_key" },
      byModel: { [CHATGPT_OAUTH_PROVIDER]: { [SPARK]: "disconnected" } },
      secretIdByProvider: { [CHATGPT_OAUTH_PROVIDER]: "secret-a" },
      secretIdByModel: { [CHATGPT_OAUTH_PROVIDER]: { [SPARK]: "secret-b" } },
    };

    const live = await codexLiveCatalogsForSpace(prisma, secrets, scope, auth, { read });

    expect(live.size).toBe(0);
    expect(read).not.toHaveBeenCalled();
  });

  it("never fetches for an expired credential and never writes secrets", async () => {
    const prisma = authPrisma({ secrets: [{ id: "secret-a", ciphertext: "cipher-a" }] });
    const secrets = secretsById({ "cipher-a": oauthPlaintext(ACCESS_TOKEN, -1_000) });
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      okResponse(catalogPayload([{ slug: SPARK, visibility: "list", supported_in_api: true }])),
    );
    const cache = new CodexCatalogCache({
      enabled: true,
      fetch: fetchImpl,
      now: () => Date.now(),
      waitMs: 50,
    });

    const live = await codexLiveCatalogsForSpace(
      prisma,
      secrets,
      scope,
      oauthAuthFor("secret-a"),
      cache,
    );

    expect(live.size).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(secrets.put).not.toHaveBeenCalled();
    expect(prisma.secret.update).not.toHaveBeenCalled();
  });

  it("fires onExpiredToken per expired credential so the caller can kick a refresh", async () => {
    const prisma = authPrisma({
      secrets: [
        { id: "secret-a", ciphertext: "cipher-a" },
        { id: "secret-b", ciphertext: "cipher-b" },
      ],
    });
    const secrets = secretsById({
      "cipher-a": oauthPlaintext(ACCESS_TOKEN, -1_000, "acct-a"),
      "cipher-b": oauthPlaintext(ACCESS_TOKEN, 3_600_000, "acct-b"),
    });
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      okResponse(catalogPayload([{ slug: SPARK, visibility: "list", supported_in_api: true }])),
    );
    const cache = new CodexCatalogCache({
      enabled: true,
      fetch: fetchImpl,
      now: () => Date.now(),
      waitMs: 50,
    });
    const onExpiredToken = vi.fn();
    const auth: CodexCatalogSpaceAuth = {
      byProvider: { [CHATGPT_OAUTH_PROVIDER]: "oauth" },
      byModel: { [CHATGPT_OAUTH_PROVIDER]: { [SPARK]: "oauth" } },
      secretIdByProvider: { [CHATGPT_OAUTH_PROVIDER]: "secret-a" },
      secretIdByModel: { [CHATGPT_OAUTH_PROVIDER]: { [SPARK]: "secret-b" } },
    };

    const live = await codexLiveCatalogsForSpace(prisma, secrets, scope, auth, cache, {
      onExpiredToken,
    });

    // Only the expired credential's hook fires; the valid one fetched normally.
    expect(onExpiredToken).toHaveBeenCalledTimes(1);
    expect(onExpiredToken).toHaveBeenCalledWith("secret-a");
    expect(live.get("secret-b")?.[0]?.slug).toBe(SPARK);
    expect(live.has("secret-a")).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("applyCodexLiveCatalog", () => {
  const oauthAuth: CodexCatalogSpaceAuth = {
    byProvider: { [CHATGPT_OAUTH_PROVIDER]: "oauth" },
    byModel: {},
    secretIdByProvider: { [CHATGPT_OAUTH_PROVIDER]: "secret-a" },
    secretIdByModel: {},
  };
  const base = listAvailablePiCatalog(oauthAuth.byProvider, oauthAuth.byModel);
  const liveFor = (entries: Record<string, CodexCatalogModel[]>) =>
    new Map(Object.entries(entries));

  it("adds Spark, which the bundled catalog lacks, when the account can call it", () => {
    expect(
      base.some((entry) => entry.provider === CHATGPT_OAUTH_PROVIDER && entry.id === SPARK),
    ).toBe(false);
    const merged = applyCodexLiveCatalog(
      base,
      oauthAuth,
      liveFor({ "secret-a": [liveModel(SPARK), liveModel(LUNA)] }),
    );

    const ids = merged
      .filter((entry) => entry.provider === CHATGPT_OAUTH_PROVIDER)
      .map((entry) => entry.id);
    expect(ids).toEqual([LUNA, SPARK]);

    const spark = merged.find(
      (entry) => entry.provider === CHATGPT_OAUTH_PROVIDER && entry.id === SPARK,
    );
    expect(spark?.auth).toBe("oauth");
    expect(spark?.label).toBeTruthy();
    expect(spark?.billing).toBeTruthy();
  });

  it("drops OAuth-governed models the live catalog does not list", () => {
    const merged = applyCodexLiveCatalog(
      base,
      oauthAuth,
      liveFor({ "secret-a": [liveModel(LUNA)] }),
    );
    const codexIds = merged
      .filter((entry) => entry.provider === CHATGPT_OAUTH_PROVIDER)
      .map((entry) => entry.id);
    expect(codexIds).toEqual([LUNA]);
  });

  it("adds live-only slugs using a runnable sibling", () => {
    const merged = applyCodexLiveCatalog(
      base,
      oauthAuth,
      liveFor({
        "secret-a": [
          liveModel(LUNA),
          liveModel("gpt-7-codex-new", { reasoningEfforts: ["low", "high"] }),
        ],
      }),
    );

    const ids = merged
      .filter((entry) => entry.provider === CHATGPT_OAUTH_PROVIDER)
      .map((entry) => entry.id);
    expect(ids).toEqual([LUNA, "gpt-7-codex-new"]);
  });

  it("adds live-only models from their owning model-specific accounts once", () => {
    const saved = "gpt-6-luna-latest";
    const other = "gpt-7-codex-other";
    const auth: CodexCatalogSpaceAuth = {
      ...oauthAuth,
      byModel: { [CHATGPT_OAUTH_PROVIDER]: { [saved]: "oauth" } },
      secretIdByModel: { [CHATGPT_OAUTH_PROVIDER]: { [saved]: "secret-b" } },
    };
    const idsFor = (providerModels: CodexCatalogModel[], modelModels: CodexCatalogModel[]) =>
      applyCodexLiveCatalog(
        base,
        auth,
        liveFor({
          "secret-a": [liveModel(LUNA), ...providerModels],
          "secret-b": [liveModel(LUNA), ...modelModels],
        }),
      )
        .filter((entry) => entry.provider === CHATGPT_OAUTH_PROVIDER)
        .map((entry) => entry.id);

    expect(idsFor([], [liveModel(saved), liveModel(other)])).toEqual([LUNA, saved]);
    expect(idsFor([liveModel(saved)], [liveModel(saved)])).toEqual([LUNA, saved]);
    expect(idsFor([liveModel(saved)], [])).toEqual([LUNA]);
  });

  it("overrides thinking levels only when the endpoint supplies known efforts", () => {
    const staticEntry = listPiCatalog().find(
      (entry) => entry.provider === CHATGPT_OAUTH_PROVIDER && entry.id === LUNA,
    )!;
    const merged = applyCodexLiveCatalog(
      base,
      oauthAuth,
      liveFor({ "secret-a": [liveModel(LUNA, { reasoningEfforts: ["minimal", "medium"] })] }),
    );
    const liveEntry = merged.find(
      (entry) => entry.provider === CHATGPT_OAUTH_PROVIDER && entry.id === LUNA,
    );
    expect(liveEntry?.thinkingLevels).toEqual(["minimal", "medium"]);

    const mergedUnknown = applyCodexLiveCatalog(
      base,
      oauthAuth,
      liveFor({ "secret-a": [liveModel(LUNA, { reasoningEfforts: ["mystery-effort"] })] }),
    );
    const fallback = mergedUnknown.find(
      (entry) => entry.provider === CHATGPT_OAUTH_PROVIDER && entry.id === LUNA,
    );
    expect(fallback?.thinkingLevels).toEqual(staticEntry.thinkingLevels);
  });

  it("keeps API-key-governed codex models outside the live gate", () => {
    const mixedAuth: CodexCatalogSpaceAuth = {
      byProvider: { [CHATGPT_OAUTH_PROVIDER]: "oauth" },
      byModel: { [CHATGPT_OAUTH_PROVIDER]: { [SOL]: "api_key" } },
      secretIdByProvider: { [CHATGPT_OAUTH_PROVIDER]: "secret-a" },
      secretIdByModel: { [CHATGPT_OAUTH_PROVIDER]: { [SOL]: "secret-api" } },
    };
    const mixedBase = listAvailablePiCatalog(mixedAuth.byProvider, mixedAuth.byModel);
    const merged = applyCodexLiveCatalog(
      mixedBase,
      mixedAuth,
      liveFor({ "secret-a": [liveModel(LUNA)] }),
    );

    const codexIds = merged
      .filter((entry) => entry.provider === CHATGPT_OAUTH_PROVIDER)
      .map((entry) => entry.id);
    expect(codexIds).toEqual([LUNA, SOL]);
  });

  it("governs each model by the account that owns its credential", () => {
    // Spark's model-specific preference points at account B while the provider
    // default is account A: each slot follows its own credential's catalog.
    const splitAuth: CodexCatalogSpaceAuth = {
      byProvider: { [CHATGPT_OAUTH_PROVIDER]: "oauth" },
      byModel: { [CHATGPT_OAUTH_PROVIDER]: { [SPARK]: "oauth" } },
      secretIdByProvider: { [CHATGPT_OAUTH_PROVIDER]: "secret-a" },
      secretIdByModel: { [CHATGPT_OAUTH_PROVIDER]: { [SPARK]: "secret-b" } },
    };
    const splitBase = listAvailablePiCatalog(splitAuth.byProvider, splitAuth.byModel);
    const merged = applyCodexLiveCatalog(
      splitBase,
      splitAuth,
      // A catalog is trusted only when it shares a bundled slug, so B lists Luna too.
      liveFor({ "secret-a": [liveModel(LUNA)], "secret-b": [liveModel(SPARK), liveModel(LUNA)] }),
    );
    const codexIds = merged
      .filter((entry) => entry.provider === CHATGPT_OAUTH_PROVIDER)
      .map((entry) => entry.id);
    expect(codexIds).toEqual([LUNA, SPARK]);

    // Account A listing Spark must not unlock it — B's slot has no catalog read.
    const wrongAccount = applyCodexLiveCatalog(
      splitBase,
      splitAuth,
      liveFor({ "secret-a": [liveModel(SPARK), liveModel(LUNA)] }),
    );
    const wrongIds = wrongAccount
      .filter((entry) => entry.provider === CHATGPT_OAUTH_PROVIDER)
      .map((entry) => entry.id);
    expect(wrongIds).toEqual([LUNA]);
  });

  it("keeps a per-model disconnected slot hidden even when the provider account lists it", () => {
    const disconnectedAuth: CodexCatalogSpaceAuth = {
      byProvider: { [CHATGPT_OAUTH_PROVIDER]: "oauth" },
      byModel: { [CHATGPT_OAUTH_PROVIDER]: { [SPARK]: "disconnected" } },
      secretIdByProvider: { [CHATGPT_OAUTH_PROVIDER]: "secret-a" },
      secretIdByModel: { [CHATGPT_OAUTH_PROVIDER]: { [SPARK]: "secret-b" } },
    };
    const disconnectedBase = listAvailablePiCatalog(
      disconnectedAuth.byProvider,
      disconnectedAuth.byModel,
    );
    const merged = applyCodexLiveCatalog(
      disconnectedBase,
      disconnectedAuth,
      liveFor({ "secret-a": [liveModel(SPARK), liveModel(LUNA)] }),
    );
    const codexIds = merged
      .filter((entry) => entry.provider === CHATGPT_OAUTH_PROVIDER)
      .map((entry) => entry.id);
    expect(codexIds).toEqual([LUNA]);
  });

  it("ignores a live catalog sharing no slug with the static codex catalog", () => {
    const foreign = liveFor({
      "secret-a": [liveModel("some-unrelated-model"), liveModel("another-foreign")],
    });
    expect(applyCodexLiveCatalog(base, oauthAuth, foreign)).toEqual(base);
  });

  it("keeps image support from the account list when a live slug is outside its sibling family", () => {
    const terra = "gpt-6.2-terra";
    const sol = "gpt-6.1-sol";
    const bundled = base.find(
      (entry) => entry.provider === CHATGPT_OAUTH_PROVIDER && entry.id === sol,
    );
    expect(bundled?.images).toBe(true);
    expect(liveCatalogEntry(CHATGPT_OAUTH_PROVIDER, terra)?.images).toBe(false);

    const modalities = (image: boolean) =>
      parseCodexCatalog(
        catalogPayload([
          {
            slug: sol,
            visibility: "list",
            supported_in_api: true,
            input_modalities: image ? ["text", "image"] : ["text"],
          },
          {
            slug: terra,
            visibility: "list",
            supported_in_api: true,
            input_modalities: image ? ["text", "image"] : ["text"],
          },
        ]),
      )!;
    const imagesOf = (models: CodexCatalogModel[], id: string) =>
      applyCodexLiveCatalog(base, oauthAuth, liveFor({ "secret-a": models })).find(
        (entry) => entry.provider === CHATGPT_OAUTH_PROVIDER && entry.id === id,
      )?.images;

    expect(imagesOf(modalities(true), terra)).toBe(true);
    expect(imagesOf(modalities(true), sol)).toBe(true);
    expect(imagesOf(modalities(false), terra)).toBe(false);
    expect(imagesOf(modalities(false), sol)).toBe(false);
  });

  it("keeps bundled image support when the account omits input modalities", () => {
    const sol = "gpt-6.1-sol";
    const terra = "gpt-6.2-terra";
    const parsed = (inputModalities: null | undefined | string[]) =>
      parseCodexCatalog(
        catalogPayload([
          {
            slug: sol,
            visibility: "list",
            supported_in_api: true,
            ...(inputModalities !== undefined ? { input_modalities: inputModalities } : {}),
          },
          {
            slug: terra,
            visibility: "list",
            supported_in_api: true,
            ...(inputModalities !== undefined ? { input_modalities: inputModalities } : {}),
          },
        ]),
      )!;
    const imagesOf = (models: CodexCatalogModel[], id: string) =>
      applyCodexLiveCatalog(base, oauthAuth, liveFor({ "secret-a": models })).find(
        (entry) => entry.provider === CHATGPT_OAUTH_PROVIDER && entry.id === id,
      )?.images;

    expect(parsed(undefined)[0]?.supportsImages).toBeUndefined();
    expect(parsed(null)[0]?.supportsImages).toBeUndefined();
    expect(imagesOf(parsed(undefined), sol)).toBe(true);
    expect(imagesOf(parsed(null), sol)).toBe(true);
    expect(imagesOf(parsed(undefined), terra)).toBe(false);
    expect(imagesOf(parsed(["text"]), sol)).toBe(false);
    expect(imagesOf(parsed(["text"]), terra)).toBe(false);
  });

  it("leaves other providers untouched", () => {
    const merged = applyCodexLiveCatalog(
      base,
      oauthAuth,
      liveFor({ "secret-a": [liveModel(LUNA)] }),
    );
    const otherProviders = merged.filter((entry) => entry.provider !== CHATGPT_OAUTH_PROVIDER);
    expect(otherProviders).toEqual(
      base.filter((entry) => entry.provider !== CHATGPT_OAUTH_PROVIDER),
    );
  });
});
