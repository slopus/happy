import { MODEL_KEY_FORMAT_ERROR } from "@rakazo/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SpaceCatalogAuth } from "./model-selection.js";
import { defaultCatalogModelId, spaceCanRunCatalogModel } from "./model-selection.js";
import { modelAcceptsImageInput } from "./model-vision.js";
import { COMPATIBLE_ENDPOINT_PRESETS } from "./openai-compatible-url.js";
import {
  catalogModelLabel,
  catalogModelServesAgents,
  catalogProviderProbeBaseUrl,
  hiddenCatalogModel,
  listPiCatalog,
  offeredCatalog,
  probeCatalogProviderModels,
  scriptedCatalogEntry,
  verifyCatalogProviderApiKey,
} from "./pi-models.js";
import { probeOpenAiCompatibleModels } from "./pi-openai-compatible-provider.js";
import { MODEL_CONNECT_TIMEOUT_MS } from "./pi-runtime-limits.js";

describe("catalog provider authentication", () => {
  it("refuses a key that cannot travel in a header without calling the provider", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(
      verifyCatalogProviderApiKey({ provider: "openrouter", apiKey: "sk-fixture-ключ" }, fetchImpl),
    ).rejects.toThrow(MODEL_KEY_FORMAT_ERROR);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("checks authentication before listing a public OpenRouter catalog", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      Response.json({ data: [{ id: "fixture-model" }] }),
    );
    await expect(
      probeCatalogProviderModels({ provider: "openrouter", apiKey: " fixture-key " }, fetchImpl),
    ).resolves.toEqual(["fixture-model"]);
    expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual([
      "https://openrouter.ai/api/v1/key",
      "https://openrouter.ai/api/v1/models",
    ]);
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({
      headers: { Authorization: "Bearer fixture-key" },
      redirect: "error",
      signal: expect.any(AbortSignal),
    });
  });

  it.each([401, 403])(
    "refuses rejected credentials (%i) before reading the catalog",
    async (status) => {
      const fetchImpl = vi.fn<typeof fetch>(
        async () => new Response("private upstream details", { status }),
      );
      await expect(
        probeCatalogProviderModels({ provider: "openrouter", apiKey: "fixture-key" }, fetchImpl),
      ).rejects.toThrow("API key was rejected by the provider.");
      expect(fetchImpl).toHaveBeenCalledOnce();
    },
  );

  it.each([302, 429, 503])(
    "lets an upstream failure (%i) through as inconclusive",
    async (status) => {
      await expect(
        verifyCatalogProviderApiKey(
          { provider: "openrouter", apiKey: "fixture-key" },
          async () => new Response("private upstream details", { status }),
        ),
      ).resolves.toBeUndefined();
    },
  );

  it.each([
    ["deepseek", "https://api.deepseek.com/models", { Authorization: "Bearer fixture-key" }],
    [
      "google",
      "https://generativelanguage.googleapis.com/v1beta/models",
      { "x-goog-api-key": "fixture-key" },
    ],
  ])(
    "checks %s without calling a model or putting the key in the URL",
    async (provider, url, headers) => {
      const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({}));
      await verifyCatalogProviderApiKey({ provider, apiKey: " fixture-key " }, fetchImpl);
      expect(fetchImpl).toHaveBeenCalledWith(
        url,
        expect.objectContaining({ headers, redirect: "error" }),
      );
    },
  );

  it.each(["google", "deepseek"])("rejects unauthorized %s keys", async (provider) => {
    await expect(
      verifyCatalogProviderApiKey(
        { provider, apiKey: "fixture-key" },
        async () => new Response("private upstream details", { status: 401 }),
      ),
    ).rejects.toThrow("API key was rejected by the provider.");
  });

  it("recognizes Google's structured invalid-key response without exposing the body", async () => {
    await expect(
      verifyCatalogProviderApiKey({ provider: "google", apiKey: "fixture-key" }, async () =>
        Response.json(
          { error: { message: "private details", details: [{ reason: "API_KEY_INVALID" }] } },
          { status: 400 },
        ),
      ),
    ).rejects.toThrow("API key was rejected by the provider.");
  });

  it.each([
    "invalid JSON",
    JSON.stringify({ error: { details: [{ reason: "OTHER_REASON" }] } }),
    "x".repeat(4097),
  ])("does not label an unknown Google error as an invalid key", async (body) => {
    await expect(
      verifyCatalogProviderApiKey(
        { provider: "google", apiKey: "fixture-key" },
        async () => new Response(body, { status: 400 }),
      ),
    ).resolves.toBeUndefined();
  });

  it("finishes a Google check safely when cancellation interrupts a partial error body", async () => {
    const controller = new AbortController();
    let waitingForBody: (() => void) | undefined;
    const bodyStarted = new Promise<void>((resolve) => {
      waitingForBody = resolve;
    });
    const result = verifyCatalogProviderApiKey(
      { provider: "google", apiKey: "fixture-key" },
      async (_url, init) =>
        new Response(
          new ReadableStream({
            start(body) {
              body.enqueue(new TextEncoder().encode('{"error":'));
              init?.signal?.addEventListener(
                "abort",
                () => body.error(new Error("private fixture-key details")),
                { once: true },
              );
              waitingForBody?.();
            },
          }),
          { status: 400 },
        ),
      controller.signal,
    );
    const assertion = expect(result).rejects.toThrow("Could not verify the API key. Try again.");
    await bodyStarted;
    controller.abort();
    await assertion;
  });

  it("cancels an oversized Google error without waiting for the stream to finish", async () => {
    const cancel = vi.fn();
    const response = new Response(
      new ReadableStream({
        start(body) {
          body.enqueue(new Uint8Array(4097));
        },
        cancel,
      }),
      { status: 400 },
    );
    await expect(
      verifyCatalogProviderApiKey(
        { provider: "google", apiKey: "fixture-key" },
        async () => response,
      ),
    ).resolves.toBeUndefined();
    expect(cancel).toHaveBeenCalledOnce();
    expect(response.body?.locked).toBe(false);
  });

  it("bounds a stalled check and lets it through as inconclusive", async () => {
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    // The app gives up on saving a connection after 60 seconds, so key checks ignore the setting.
    vi.stubEnv("MODEL_CONNECT_TIMEOUT_MS", "90000");
    try {
      const result = verifyCatalogProviderApiKey(
        { provider: "openrouter", apiKey: "fixture-key" },
        async (_url, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new Error("fixture-key")));
          }),
      );
      const assertion = expect(result).resolves.toBeUndefined();
      expect(timeout).toHaveBeenCalledWith(MODEL_CONNECT_TIMEOUT_MS);
      deadline.abort();
      await assertion;
    } finally {
      timeout.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it("honors caller cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      verifyCatalogProviderApiKey(
        { provider: "openrouter", apiKey: "fixture-key" },
        async (_url, init) => {
          init?.signal?.throwIfAborted();
          throw new Error("must already be aborted");
        },
        controller.signal,
      ),
    ).rejects.toThrow("Could not verify the API key. Try again.");
  });

  it("adds no network requirement to other providers or local endpoints", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    for (const provider of ["openai-compatible", "local", "anthropic", "fixture-provider"]) {
      await verifyCatalogProviderApiKey({ provider, apiKey: "fixture-key" }, fetchImpl);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("Pi model catalog", () => {
  it("recommends one Luna or Haiku model per supported provider", () => {
    expect(
      listPiCatalog()
        .filter((entry) => entry.recommended)
        .map(({ provider, id }) => ({ provider, id })),
    ).toEqual(
      expect.arrayContaining([
        { provider: "openai-codex", id: "gpt-6-luna" },
        { provider: "openai", id: "gpt-6-luna" },
        { provider: "openrouter", id: "anthropic/claude-haiku-5.5" },
        { provider: "anthropic", id: "claude-haiku-5-5" },
      ]),
    );
    for (const provider of ["openai-codex", "openai", "openrouter", "anthropic"]) {
      expect(
        listPiCatalog().filter((entry) => entry.provider === provider && entry.recommended),
      ).toHaveLength(1);
    }
  });

  it("preserves provider names and sign-in options from before pi 1.3", () => {
    const catalog = listPiCatalog();
    const codex = catalog.filter((entry) => entry.provider === "openai-codex");
    expect(codex.length).toBeGreaterThan(0);
    for (const entry of codex) {
      expect(entry).toMatchObject({
        providerName: "OpenAI Codex",
        auth: "oauth",
        oauthLabel: "Sign in with ChatGPT",
        subscription: true,
        signIn: "device-code",
      });
    }
    const openai = catalog.filter((entry) => entry.provider === "openai");
    expect(openai.length).toBeGreaterThan(0);
    for (const entry of openai) {
      expect(entry).toMatchObject({
        providerName: "OpenAI",
        auth: "api-key",
        subscription: false,
        billing: "Uses your OpenAI API key. Rakazo does not pay for model usage.",
      });
      expect(entry.oauthLabel).toBeUndefined();
      expect(entry.signIn).toBeUndefined();
      expect(entry.authHint).toBeUndefined();
    }
    const azure = catalog.filter((entry) => entry.provider === "azure");
    expect(azure.length).toBeGreaterThan(0);
    for (const entry of azure) {
      expect(entry).toMatchObject({
        providerName: "Azure OpenAI",
        auth: "api-key",
        subscription: false,
        billing: "Uses your Azure OpenAI API key. Rakazo does not pay for model usage.",
      });
    }
  });

  it("keeps the custom catalog independent of server model IDs", () => {
    const custom = listPiCatalog().filter((entry) => entry.provider === "openai-compatible");
    expect(custom).toHaveLength(1);
    expect(custom[0]).toMatchObject({ id: "custom", placeholder: true, reasoning: false });
  });

  it("says which catalog models support images, the same way runs decide it", () => {
    const catalog = listPiCatalog();
    for (const entry of catalog) {
      if (entry.provider === "openai-compatible") {
        // The connection's own "Supports images" setting decides this one.
        expect(entry.images).toBeUndefined();
      } else {
        expect(entry.images).toBe(modelAcceptsImageInput(entry.provider, entry.id));
      }
    }
    expect(catalog.some((entry) => entry.images === true)).toBe(true);
    expect(catalog.some((entry) => entry.images === false)).toBe(true);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("lists real Pi providers instead of a two-option dropdown", () => {
    const catalog = listPiCatalog();
    const providers = new Set(catalog.map((entry) => entry.provider));
    expect(catalog.length).toBeGreaterThan(20);
    expect(providers.has("openrouter")).toBe(true);
    expect(providers.size).toBeGreaterThan(5);
    expect(
      catalog.some(
        (entry) => entry.auth === "oauth" || entry.auth === "both" || entry.subscription,
      ),
    ).toBe(true);
    const chatgpt = catalog.find((entry) => entry.provider === "openai-codex");
    expect(chatgpt?.signIn).toBe("device-code");
    expect(chatgpt?.billing).toMatch(/ChatGPT Plus or Pro/);
    const copilot = catalog.find((entry) => entry.provider === "github-copilot");
    expect(copilot?.signIn).toBe("device-code");
    const grok = catalog.find((entry) => entry.provider === "xai");
    expect(grok?.signIn).toBe("device-code");
    const claude = catalog.find((entry) => entry.provider === "anthropic");
    expect(claude).toMatchObject({
      signIn: "auth-url",
      authHint: "Claude Pro/Max / key",
      oauthLabel: "Sign in with Claude",
      billing: "",
    });
    expect(scriptedCatalogEntry.provider).toBe("scripted");
  });

  it("lists DeepSeek API model ids instead of display labels", () => {
    const deepseek = listPiCatalog().filter((entry) => entry.provider === "deepseek");
    const ids = deepseek.map((entry) => entry.id);
    expect(ids).toContain("deepseek-flash");
    expect(ids).toContain("deepseek-v4-pro");
    expect(ids).not.toContain("DeepSeek-V4.1-Flash");
    expect(ids).not.toContain("DeepSeek V4.1 Flash");
    for (const entry of deepseek) {
      expect(entry.id).not.toBe(entry.label);
      expect(entry.label.length).toBeGreaterThan(0);
    }
    expect(deepseek.find((entry) => entry.id === "deepseek-flash")?.label).toBe(
      "DeepSeek V4.1 Flash",
    );
  });

  it("lists current xAI and OpenCode Go models from the Pi catalog", () => {
    const catalog = listPiCatalog();
    const ids = (provider: string) =>
      catalog.filter((entry) => entry.provider === provider).map((entry) => entry.id);
    expect(ids("xai")).toContain("grok-4.6");
    expect(ids("opencode-go")).toContain("glm-5.3");
    const grok46 = catalog.find((entry) => entry.provider === "xai" && entry.id === "grok-4.6");
    expect(grok46).toMatchObject({
      reasoning: true,
      thinkingLevels: ["low", "medium", "high", "xhigh"],
    });
    const openAiCompatible = catalog.find((entry) => entry.provider === "openai-compatible");
    expect(openAiCompatible).toMatchObject({
      id: "custom",
      placeholder: true,
      endpointPresets: COMPATIBLE_ENDPOINT_PRESETS,
    });
    expect(openAiCompatible?.catalogProbe).toBeUndefined();
  });

  it("pins catalog probes to registry base URLs and leaves user URLs gated", async () => {
    const expected = {
      openrouter: "https://openrouter.ai/api/v1",
      openai: "https://api.openai.com/v1",
      groq: "https://api.groq.com/openai/v1",
    } as const;
    for (const [provider, baseUrl] of Object.entries(expected)) {
      expect(catalogProviderProbeBaseUrl(provider)).toBe(baseUrl);
      expect(listPiCatalog().find((entry) => entry.provider === provider)?.catalogProbe).toBe(true);
    }
    expect(catalogProviderProbeBaseUrl("openai-compatible")).toBeNull();
    expect(catalogProviderProbeBaseUrl("anthropic")).toBeNull();
    expect(catalogProviderProbeBaseUrl("cloudflare-workers-ai")).toBeNull();
    expect(
      listPiCatalog().find((entry) => entry.provider === "cloudflare-workers-ai")?.catalogProbe,
    ).toBeUndefined();

    const routing = (provider: string) =>
      listPiCatalog().find((entry) => entry.provider === provider)?.routingFields;
    expect(routing("cloudflare-workers-ai")).toEqual(["accountId"]);
    expect(routing("cloudflare-ai-gateway")).toEqual(["accountId", "gatewayId"]);
    expect(routing("anthropic")).toBeUndefined();

    const previous = process.env.RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC;
    process.env.RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC = "0";
    try {
      await expect(
        probeOpenAiCompatibleModels(
          { baseUrl: expected.openrouter, apiKey: "sk-test-key" },
          async () => {
            throw new Error("user-supplied probe should be rejected before fetch");
          },
        ),
      ).rejects.toThrow(/Public model endpoints are disabled/);

      for (const [provider, baseUrl] of Object.entries(expected)) {
        let requestedUrl = "";
        const fetchImpl = async (input: RequestInfo | URL) => {
          requestedUrl = input instanceof Request ? input.url : String(input);
          return new Response(JSON.stringify({ object: "list", data: [{ id: "pinned-model" }] }), {
            status: 200,
          });
        };
        await expect(
          probeCatalogProviderModels({ provider, apiKey: "sk-test-key-12345678" }, fetchImpl),
        ).resolves.toEqual(["pinned-model"]);
        expect(requestedUrl).toContain(baseUrl);
      }
    } finally {
      if (previous === undefined) delete process.env.RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC;
      else process.env.RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC = previous;
    }
  });

  it("accepts catalog model lists larger than the custom-server probe cap", async () => {
    const ids = Array.from({ length: 5_000 }, (_, index) => {
      const suffix = String(index).padStart(4, "0");
      return `vendor/catalog-model-${suffix}-${"x".repeat(120)}`;
    });
    const payload = JSON.stringify({
      object: "list",
      data: ids.map((id) => ({ id, description: "x".repeat(512) })),
    });
    expect(Buffer.byteLength(payload)).toBeGreaterThan(2 * 1024 * 1024);
    expect(ids).toHaveLength(5_000);

    const fetchImpl = async () =>
      new Response(payload, {
        status: 200,
        headers: { "content-length": String(Buffer.byteLength(payload)) },
      });

    await expect(
      probeCatalogProviderModels(
        { provider: "openrouter", apiKey: "sk-test-key-12345678" },
        fetchImpl,
      ),
    ).resolves.toEqual(ids);
    await expect(
      probeOpenAiCompatibleModels({ baseUrl: "http://127.0.0.1:8000/v1" }, fetchImpl, undefined, {
        allowPrivate: true,
      }),
    ).rejects.toThrow(/too large/i);
  });

  it("adds a configured OpenRouter model that is newer than the static catalog", async () => {
    vi.stubEnv("PI_DEFAULT_PROVIDER", " openrouter ");
    vi.stubEnv("PI_DEFAULT_MODEL", " rakazo-test/unknown-future-model ");
    vi.resetModules();

    const { listPiCatalog: listConfiguredCatalog } = await import("./pi-models.js");
    expect(listConfiguredCatalog()[0]).toMatchObject({
      provider: "openrouter",
      id: "rakazo-test/unknown-future-model",
      label: "rakazo-test/unknown-future-model",
    });
  });

  it("normalizes a PI_DEFAULT_MODEL id that ends in -latest", async () => {
    vi.stubEnv("PI_DEFAULT_PROVIDER", "openrouter");
    vi.stubEnv("PI_DEFAULT_MODEL", "foo-latest");
    vi.resetModules();

    const { listPiCatalog: listConfiguredCatalog } = await import("./pi-models.js");
    expect(listConfiguredCatalog()[0]).toMatchObject({
      provider: "openrouter",
      id: "foo-latest",
      label: "foo (auto-updates)",
    });
  });

  it("does not advertise a synthetic model for providers the runtime cannot synthesize", async () => {
    vi.stubEnv("PI_DEFAULT_PROVIDER", "anthropic");
    vi.stubEnv("PI_DEFAULT_MODEL", "future/unknown-model");
    vi.resetModules();

    const { listPiCatalog: listConfiguredCatalog } = await import("./pi-models.js");
    expect(
      listConfiguredCatalog().some(
        (entry) => entry.provider === "anthropic" && entry.id === "future/unknown-model",
      ),
    ).toBe(false);
  });

  it('never labels an older model "latest" and keeps aliases distinct from snapshots', () => {
    const catalog = listPiCatalog();
    const label = (id: string) =>
      catalog.find((entry) => entry.provider === "anthropic" && entry.id === id)?.label;
    expect(label("claude-opus-5")).toBeDefined();
    expect(label("claude-opus-4-5")).toBe("Claude Opus 4.5 (auto-updates)");
    expect(label("claude-haiku-4-5")).toBe("Claude Haiku 4.5 (auto-updates)");
    expect(label("claude-haiku-4-5-20251001")).toBe("Claude Haiku 4.5");
  });
});

describe("catalogModelLabel", () => {
  const providerModelIds = [
    "claude-opus-4-5",
    "claude-opus-4-5-20251101",
    "mistral-medium",
    "mistral-medium-2508",
    "mistral-small",
    "mistral-small-260401",
    "foo",
    "foo-preview",
  ];

  it.each([
    // Alias: the id ends in `latest`, or a dated sibling proves the undated id floats.
    ["claude-opus-4-5", "Claude Opus 4.5 (latest)", "Claude Opus 4.5 (auto-updates)"],
    ["mistral-medium", "Mistral Medium Latest", "Mistral Medium (auto-updates)"],
    ["mistral-small", "Mistral Small Latest", "Mistral Small (auto-updates)"],
    ["gemini-flash-latest", "Gemini Flash Latest", "Gemini Flash (auto-updates)"],
    ["foo-latest", "foo-latest", "foo (auto-updates)"],
    ["foo/latest", "foo/latest", "foo (auto-updates)"],
    ["qwen-max-latest", "Qwen Max Latest (Qwen3.8 Max)", "Qwen Max (auto-updates)"],
    // Pinned: `-preview` is its own model and a dated id is already a snapshot, so promise nothing.
    ["foo", "Foo Latest", "Foo"],
    ["claude-opus-4-5-20251101", "Claude Opus 4.5 (latest)", "Claude Opus 4.5"],
    // Untouched: no marker, no name, or nothing left once the marker goes.
    ["claude-opus-5", "Claude Opus 5", "Claude Opus 5"],
    ["some-model", undefined, "some-model"],
    ["latest", "latest", "latest"],
  ])("labels %s / %s as %s", (id, name, expected) => {
    expect(catalogModelLabel(id, name, providerModelIds)).toBe(expected);
  });
});

describe("models agents can run", () => {
  const free = { input: 0, output: 0 };
  const paid = { input: 1, output: 2 };

  it.each([
    // OpenRouter batch variants only exist on its batch endpoint.
    [{ provider: "openrouter", id: "fixture/model:batch", cost: paid }, false],
    [{ provider: "openrouter", id: "fixture/model", cost: paid }, true],
    // OpenRouter's own free models still answer API calls.
    [{ provider: "openrouter", id: "fixture/model:free", cost: free }, true],
    // OpenCode's free tier only answers inside the OpenCode app.
    [{ provider: "opencode", id: "fixture-free", cost: free }, false],
    [{ provider: "opencode", id: "fixture", cost: paid }, true],
    [{ provider: "opencode-go", id: "fixture-free", cost: free }, true],
    // Retired or integration-refused ids.
    [{ provider: "google", id: "gemini-2.5-flash", cost: paid }, false],
    [{ provider: "google", id: "gemini-3.8-flash", cost: paid }, true],
    [{ provider: "groq", id: "llama-3.1-8b-instant", cost: paid }, false],
    [{ provider: "github-copilot", id: "grok-4.5", cost: paid }, false],
  ])("judges %o as %s", (model, expected) => {
    expect(catalogModelServesAgents(model)).toBe(expected);
  });

  it("hides bundled models agents cannot run from the offered catalog", () => {
    const offered = offeredCatalog(listPiCatalog());
    const has = (provider: string, id: string) =>
      offered.some((entry) => entry.provider === provider && entry.id === id);
    expect(offered.some((entry) => entry.id.endsWith(":batch"))).toBe(false);
    expect(has("openrouter", "anthropic/claude-haiku-5.5")).toBe(true);
    expect(has("google", "gemini-2.5-flash")).toBe(false);
    expect(has("groq", "llama-3.1-8b-instant")).toBe(false);
    expect(has("opencode", "big-pickle")).toBe(false);
    expect(has("opencode", "claude-haiku-5-5")).toBe(true);
    // A hidden model stays a known catalog id, so saved choices keep running.
    expect(listPiCatalog().some((entry) => entry.id === "gemini-2.5-flash")).toBe(true);
  });

  it("keeps a hidden model the account already saved", () => {
    const entries = [
      { provider: "google", id: "gemini-2.5-flash" },
      { provider: "openrouter", id: "fixture/model:batch" },
    ];
    expect(offeredCatalog(entries, new Set(["google:gemini-2.5-flash"]))).toEqual([entries[0]]);
  });

  describe("models Rakazo credits cannot price", () => {
    const credits: SpaceCatalogAuth = {
      managedProvider: "openrouter",
      byProvider: { openrouter: "api_key" },
      byModel: {},
      secretIdByProvider: {},
      secretIdByModel: {},
    };
    const ownKey: SpaceCatalogAuth = {
      byProvider: { openrouter: "api_key" },
      byModel: {},
      secretIdByProvider: { openrouter: "personal-secret" },
      secretIdByModel: {},
    };

    it.each(["openrouter/free", "openrouter/pareto-code", "auto", "google/gemma-4-31b-it:free"])(
      "keeps %s for an own key but not on credits",
      (id) => {
        const entry = { provider: "openrouter", id };
        expect(spaceCanRunCatalogModel(credits, entry)).toBe(false);
        expect(spaceCanRunCatalogModel(ownKey, entry)).toBe(true);
        expect(
          spaceCanRunCatalogModel(
            { ...credits, secretIdByModel: { openrouter: { [id]: "model-secret" } } },
            entry,
          ),
        ).toBe(true);
      },
    );

    it("offers priced models on credits", () => {
      const entry = { provider: "openrouter", id: "anthropic/claude-haiku-5.5" };
      expect(spaceCanRunCatalogModel(credits, entry)).toBe(true);
    });

    it("treats a live id the registry does not price as unpriced on credits", () => {
      expect(spaceCanRunCatalogModel(credits, { provider: "openrouter", id: "fixture/live" })).toBe(
        false,
      );
    });
  });

  it("judges live ids the catalog does not bundle by their id", () => {
    expect(hiddenCatalogModel({ provider: "openrouter", id: "fixture/live:batch" })).toBe(true);
    expect(hiddenCatalogModel({ provider: "openrouter", id: "fixture/live" })).toBe(false);
  });

  it.each([
    ["google", "gemini-3.8-flash"],
    ["groq", "openai/gpt-oss-120b"],
    ["minimax", "MiniMax-M3"],
  ])("connects %s to %s when no model is chosen", (provider, model) => {
    expect(defaultCatalogModelId(provider, "fixture-api-key")).toBe(model);
    expect(
      listPiCatalog().find((entry) => entry.provider === provider && entry.id === model)
        ?.recommended,
    ).toBe(true);
  });
});
