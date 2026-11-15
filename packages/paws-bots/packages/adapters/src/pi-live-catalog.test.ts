import { DEFAULT_MODEL_CONTEXT_WINDOW } from "@rakazo/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexCatalogCache } from "./pi-codex-catalog.js";
import { liveModelCatalogEnabled } from "./pi-live-cache.js";
import {
  applyProviderLiveCatalog,
  liveCatalogEntry,
  ProviderCatalogCache,
  providerLiveCatalogsForSpace,
} from "./pi-live-catalog.js";
import { isChatModelId } from "./pi-live-model.js";
import { listPiCatalog } from "./pi-models.js";
import { resolveRuntimeModel } from "./pi-runtime-models.js";

const provider = "openai";
const base = listPiCatalog();
const bundled = base.filter((entry) => entry.provider === provider);
const ids = bundled.map((entry) => entry.id);
const added = "gpt-future-chat";
const credential = {
  provider,
  secretId: "secret-test",
  version: "version-1",
  apiKey: async () => "fake-key-never-in-cache-key",
};
const auth = {
  byProvider: { openai: "api_key" as const },
  byModel: {},
  secretIdByProvider: { openai: credential.secretId },
};
const merge = (live: string[], selected = new Set<string>()) =>
  applyProviderLiveCatalog(base, auth, new Map([[credential.secretId, live]]), selected);
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("live catalog merge and execution", () => {
  it("recomputes recommendations for live IDs instead of inheriting a sibling's flag", () => {
    expect(liveCatalogEntry("openai-codex", "gpt-6-luna")?.recommended).toBe(true);
    expect(liveCatalogEntry("openai-codex", "gpt-future-chat")?.recommended).toBe(false);
  });

  it("defaults probing on and honors the deployment off switch", () => {
    expect(liveModelCatalogEnabled({})).toBe(true);
    expect(liveModelCatalogEnabled({ RAKAZO_LIVE_MODEL_CATALOG: " off " })).toBe(false);
  });
  it("skips credential reads and both provider transports when probing is off", async () => {
    vi.stubEnv("RAKAZO_LIVE_MODEL_CATALOG", "off");
    const probe = vi.fn();
    const cache = new ProviderCatalogCache({ probe });
    expect(await cache.read(credential)).toBeUndefined();
    expect(probe).not.toHaveBeenCalled();
    const findMany = vi.fn();
    const load = vi.fn();
    expect(
      await providerLiveCatalogsForSpace(
        { secret: { findMany } } as unknown as Parameters<typeof providerLiveCatalogsForSpace>[0],
        { load },
        { userId: "user-test", spaceId: "space-test" },
        auth,
        cache,
      ),
    ).toEqual(new Map());
    expect(findMany).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
    const fetch = vi.fn();
    const accessToken = vi.fn();
    expect(
      await new CodexCatalogCache({ fetch }).read("user-test", {
        accountId: "account-test",
        accessToken,
      }),
    ).toBeUndefined();
    expect(accessToken).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("keeps configured OpenRouter limits and defaults ahead of sibling inference", () => {
    vi.stubEnv("PI_DEFAULT_PROVIDER", "openrouter");
    vi.stubEnv("PI_DEFAULT_MODEL", " vendor/future-chat ");
    const configured = resolveRuntimeModel({
      provider: "openrouter",
      id: "vendor/future-chat",
      contextWindow: 32_768,
      maxTokens: 4096,
    }).model;
    expect(configured).toMatchObject({ reasoning: true, contextWindow: 32_768, maxTokens: 4096 });
    const scripted = resolveRuntimeModel({ provider: "scripted", id: "scripted" }).model;
    expect(scripted).toMatchObject({
      id: "vendor/future-chat",
      reasoning: true,
      contextWindow: 16_384,
    });
  });
  it("gives a live-only model the default window instead of an unrelated sibling's", () => {
    const unrelated = resolveRuntimeModel({ provider: "openrouter", id: "vendor/new-chat:free" });
    expect(unrelated.model?.contextWindow).toBe(DEFAULT_MODEL_CONTEXT_WINDOW);
    const sibling = resolveRuntimeModel({ provider: "openai", id: "gpt-4o" }).model!;
    const dated = resolveRuntimeModel({ provider: "openai", id: "gpt-4o-2099-01-01" }).model;
    expect(dated?.contextWindow).toBe(sibling.contextWindow);
  });
  it("keeps bundled metadata, hides retired models, preserves saved models and appends runnable additions", () => {
    const retired = ids[0]!;
    const saved = ids[1]!;
    const live = [...ids.slice(2), added, "text-embedding-future", "gpt-image-future"];
    const merged = merge(live, new Set([`${provider}:${saved}`]));
    expect(merged.some((entry) => entry.provider === provider && entry.id === retired)).toBe(false);
    expect(merged.find((entry) => entry.provider === provider && entry.id === saved)).toBe(
      bundled[1],
    );
    expect(merged.find((entry) => entry.provider === provider && entry.id === ids[2])).toBe(
      bundled[2],
    );
    const entries = merged.filter((entry) => entry.provider === provider);
    expect(entries.at(-1)).toMatchObject({
      id: added,
      providerName: "OpenAI",
      live: true,
      images: false,
      reasoning: false,
    });
    expect(entries.some((entry) => /embedding|gpt-image/.test(entry.id))).toBe(false);
    const result = resolveRuntimeModel({ provider, id: added, apiKey: "fake-key" });
    expect(result.model).toMatchObject({ id: added, provider, input: ["text"], reasoning: false });
    expect(result.model?.api).toMatch(/^openai-(completions|responses)$/);
    expect(result.model?.baseUrl).toBe("https://api.openai.com/v1");
    expect(result.model?.contextWindow).toBeGreaterThan(0);
    expect(result.model?.maxTokens).toBeGreaterThan(0);
  });
  it("keeps a saved live-only model after retirement and preserves unrelated ordering", () => {
    const selected = new Set([`${provider}:${added}`]);
    const merged = merge(ids, selected);
    expect(merged.find((entry) => entry.provider === provider && entry.id === added)).toMatchObject(
      { live: true },
    );
    expect(merged.filter((entry) => entry.provider !== provider)).toEqual(
      base.filter((entry) => entry.provider !== provider),
    );
  });
  it("does not retire or add through a disconnected per-model override", () => {
    const scoped = {
      ...auth,
      byModel: { openai: { [added]: "disconnected" as const, [ids[0]!]: "disconnected" as const } },
    };
    const merged = applyProviderLiveCatalog(
      base,
      scoped,
      new Map([[credential.secretId, [...ids.slice(1), added]]]),
    );
    expect(merged.some((entry) => entry.provider === provider && entry.id === added)).toBe(false);
    expect(merged.find((entry) => entry.provider === provider && entry.id === ids[0])).toBe(
      bundled[0],
    );
  });
  it("falls back unchanged for missing, empty or implausible lists", () => {
    expect(applyProviderLiveCatalog(base, auth, new Map())).toEqual(base);
    expect(merge([])).toEqual(base);
    expect(merge([ids[0]!, added])).toEqual(base);
  });
  it("does not overlay OAuth, disconnected, or another credential's slots", () => {
    expect(
      applyProviderLiveCatalog(
        base,
        { ...auth, byProvider: { openai: "oauth" } },
        new Map([[credential.secretId, [...ids, added]]]),
      ),
    ).toEqual(base);
    expect(
      applyProviderLiveCatalog(base, auth, new Map([["other-secret", [...ids, added]]])),
    ).toEqual(base);
  });
  it.each([
    "text-embedding-3",
    "tts-1",
    "tts_1",
    "whisper-1",
    "transcribe",
    "gpt-audio",
    "gpt-realtime",
    "dall-e-3",
    "gpt-image-1",
    "moderation-latest",
    "rerank-3",
    "vendor/flux-dev",
    "imagen-4",
    "text-to-speech",
    "sora-2",
    "veo-3",
    "gemini-2.5-flash-image",
    "grok-2-image-1212",
    "mistral-ocr-latest",
    "davinci-002",
    "babbage-002",
    "gpt-3.5-turbo-instruct",
    "computer-use-preview",
  ])("filters non-chat id %s", (id) => expect(isChatModelId(id)).toBe(false));
  it.each([
    "gpt-future-chat",
    "vendor/llama-new",
    "deepseek-chat",
    "o9",
    "Mistral-7B-Instruct-v0.3",
    "grok-2-vision-1212",
  ])("allows chat id %s", (id) => expect(isChatModelId(id)).toBe(true));
});

describe("provider catalog cache", () => {
  it("never loads or probes credentials for an unpinned provider", async () => {
    const probe = vi.fn(async () => ids);
    const apiKey = vi.fn(async () => "fake-key");
    const cache = new ProviderCatalogCache({ enabled: true, probe });
    expect(
      await cache.read({ ...credential, provider: "openai-compatible", apiKey }),
    ).toBeUndefined();
    expect(apiKey).not.toHaveBeenCalled();
    expect(probe).not.toHaveBeenCalled();
  });

  it("dedupes cold reads, caches success, refreshes stale immediately, and never keys by raw key", async () => {
    let now = 0;
    const probe = vi.fn(async () => [...ids, added]);
    const cache = new ProviderCatalogCache({ enabled: true, probe, now: () => now, ttlMs: 100 });
    const [a, b] = await Promise.all([cache.read(credential), cache.read(credential)]);
    expect(a).toEqual(b);
    expect(probe).toHaveBeenCalledTimes(1);
    await cache.read(credential);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(
      [
        ...(cache as unknown as { cache: { entries: Map<string, unknown> } }).cache.entries.keys(),
      ].join(),
    ).not.toContain(await credential.apiKey());
    now = 101;
    expect(await cache.read(credential)).toEqual(a);
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(2));
    cache.invalidate(provider);
    await cache.read(credential);
    expect(probe).toHaveBeenCalledTimes(3);
    await cache.read({ ...credential, version: "version-2" });
    expect(probe).toHaveBeenCalledTimes(4);
  });
  it.each(["failure", "empty", "implausible"])(
    "negative caches %s and retries after its short TTL",
    async (kind) => {
      let now = 0;
      const probe = vi.fn(async () => {
        if (kind === "failure") throw new Error("fake-secret-error");
        return kind === "empty" ? [] : [ids[0]!];
      });
      const cache = new ProviderCatalogCache({
        enabled: true,
        probe,
        now: () => now,
        failureTtlMs: 100,
      });
      expect(await cache.read(credential)).toBeUndefined();
      expect(await cache.read(credential)).toBeUndefined();
      expect(probe).toHaveBeenCalledTimes(1);
      now = 101;
      expect(await cache.read(credential)).toBeUndefined();
      await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(2));
    },
  );
  it("bounds cold latency and cuts off a hung probe; invalidation prevents its result returning", async () => {
    vi.useFakeTimers();
    let finish!: (ids: string[]) => void;
    const probe = vi.fn(
      () =>
        new Promise<string[]>((resolve) => {
          finish = resolve;
        }),
    );
    const cache = new ProviderCatalogCache({
      enabled: true,
      probe,
      waitMs: 1_500,
      deadlineMs: 5_000,
    });
    const read = cache.read(credential);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(await read).toBeUndefined();
    cache.invalidate(provider);
    finish(ids);
    await vi.advanceTimersByTimeAsync(0);
    expect(
      (cache as unknown as { cache: { entries: Map<string, unknown> } }).cache.entries.size,
    ).toBe(0);
    const second = cache.read(credential);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await second).toBeUndefined();
    expect(probe).toHaveBeenCalledTimes(2);
  });
  it("bounds entries", async () => {
    const cache = new ProviderCatalogCache({
      enabled: true,
      probe: async () => ids,
      maxEntries: 2,
    });
    for (const secretId of ["one", "two", "three"]) await cache.read({ ...credential, secretId });
    expect(
      (cache as unknown as { cache: { entries: Map<string, unknown> } }).cache.entries.size,
    ).toBe(2);
  });
});
