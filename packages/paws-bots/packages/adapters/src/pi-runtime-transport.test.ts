import type {
  Api,
  Context,
  Model,
  ModelsSimpleStreamOptions,
  ProviderHeaders,
} from "@earendil-works/pi-ai";
import { DEFAULT_MODEL_MAX_TOKENS } from "@rakazo/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MODEL_STREAM_MAX_RETRIES, MODEL_STREAM_TIMEOUT_MS } from "./pi-runtime-limits.js";
import { resolveRuntimeModel } from "./pi-runtime-models.js";
import {
  conversationSessionId,
  isOpenCodeProvider,
  reliableModelStream,
  reliableStreamOptions,
} from "./pi-runtime-stream.js";

const streamDefaults = {
  timeoutMs: MODEL_STREAM_TIMEOUT_MS,
  maxRetries: DEFAULT_MODEL_STREAM_MAX_RETRIES,
  maxTokens: DEFAULT_MODEL_MAX_TOKENS,
};

// Unsigned fake JWT: base64url JSON payload, no real token material.
const fakeJwt = (payload: unknown) =>
  `fake.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.fake`;

const codexModel = { provider: "openai-codex", api: "openai-codex-responses" } as Model<Api>;

// Mirrors Models.applyAuth: provider auth headers merge with options.headers,
// then transformHeaders runs on the result just before the request is sent.
const residencyFor = async (options: ModelsSimpleStreamOptions, headers: ProviderHeaders = {}) =>
  (await options.transformHeaders?.(headers))?.["x-openai-internal-codex-residency"];

describe("Pi runtime transport", () => {
  beforeEach(() => vi.stubEnv("MODEL_STREAM_MAX_RETRIES", undefined));
  afterEach(() => vi.unstubAllEnvs());

  it.each(["0", "3", "5"])("uses the configured retry limit %s", (value) => {
    vi.stubEnv("MODEL_STREAM_MAX_RETRIES", value);
    expect(reliableStreamOptions(codexModel).maxRetries).toBe(Number(value));
  });

  it("reads the configured stream timeout on each call unless the caller sets one", () => {
    vi.stubEnv("MODEL_STREAM_TIMEOUT_MS", "240000");
    expect(reliableStreamOptions(codexModel).timeoutMs).toBe(240_000);

    vi.stubEnv("MODEL_STREAM_TIMEOUT_MS", "13800000");
    expect(reliableStreamOptions(codexModel).timeoutMs).toBe(13_800_000);
    expect(reliableStreamOptions(codexModel, { timeoutMs: 5_000 }).timeoutMs).toBe(5_000);
    vi.stubEnv("MODEL_STREAM_TIMEOUT_MS", "soon");
    expect(reliableStreamOptions(codexModel).timeoutMs).toBe(MODEL_STREAM_TIMEOUT_MS);
  });

  it.each([0, 2])("preserves an explicit retry limit of %i", (maxRetries) => {
    vi.stubEnv("MODEL_STREAM_MAX_RETRIES", "3");
    expect(reliableStreamOptions(codexModel, { maxRetries }).maxRetries).toBe(maxRetries);
  });

  it.each([
    { source: "provider", provider: "openai-codex", api: "openai-completions" },
    { source: "API", provider: "custom-provider", api: "openai-codex-responses" },
  ])("forces SSE when Codex is identified by $source", ({ provider, api }) => {
    const model = { provider, api } as Model<Api>;
    const { transformHeaders, ...rest } = reliableStreamOptions(model, {
      transport: "auto",
      maxRetries: 4,
    });

    expect(rest).toEqual({
      ...streamDefaults,
      transport: "sse",
      maxRetries: 4,
    });
    // Codex requests also get the residency transformHeaders hook.
    expect(transformHeaders).toBeTypeOf("function");
  });

  it("applies a stream timeout and output cap without changing other transports", () => {
    const model = {
      provider: "openrouter",
      api: "openai-completions",
      maxTokens: 128_000,
    } as Model<Api>;
    const options = { transport: "auto" as const, maxRetries: 2 };

    expect(reliableStreamOptions(model, options)).toEqual({
      transport: "auto",
      maxRetries: 2,
      timeoutMs: MODEL_STREAM_TIMEOUT_MS,
      maxTokens: DEFAULT_MODEL_MAX_TOKENS,
    });
  });

  it("keeps a configured maxTokens as the escape hatch", () => {
    const model = {
      provider: "openrouter",
      api: "openai-completions",
      maxTokens: 128_000,
    } as Model<Api>;

    expect(reliableStreamOptions(model, { transport: "auto" }, 8_192)?.maxTokens).toBe(8_192);
  });

  it.each(["opencode", "opencode-go"] as const)(
    "attaches a sticky OpenCode session header for %s",
    (provider) => {
      const model = { provider, api: "openai-completions" } as Model<Api>;
      const options = {
        sessionId: "thread-1:bot-1",
        transport: "auto" as const,
        headers: { "X-Custom": "1" },
      };

      expect(isOpenCodeProvider(provider)).toBe(true);
      expect(reliableStreamOptions(model, options)).toEqual({
        ...streamDefaults,
        sessionId: "thread-1:bot-1",
        transport: "auto",
        headers: {
          "x-opencode-session": "thread-1:bot-1",
          "x-opencode-client": "rakazo",
          "X-Custom": "1",
        },
      });
    },
  );

  it("generates an OpenCode session id when the agent did not provide one", () => {
    const model = { provider: "opencode-go", api: "openai-completions" } as Model<Api>;
    const result = reliableStreamOptions(model, { transport: "auto" });

    expect(result.sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(result.headers?.["x-opencode-session"]).toBe(result.sessionId);
    expect(result.headers?.["x-opencode-client"]).toBe("rakazo");
    expect(result.timeoutMs).toBe(MODEL_STREAM_TIMEOUT_MS);
  });

  it.each([
    {
      source: "provider",
      model: { provider: "openai-codex", api: "openai-completions" } as Model<Api>,
    },
    {
      source: "API",
      model: { provider: "custom-provider", api: "openai-codex-responses" } as Model<Api>,
    },
  ])(
    "forwards the compute residency claim when Codex is identified by $source",
    async ({ model }) => {
      const token = fakeJwt({
        "https://api.openai.com/auth": { chatgpt_compute_residency: "us-east" },
      });

      const { transformHeaders, ...rest } = reliableStreamOptions(
        model,
        { transport: "auto" },
        undefined,
        token,
      );
      expect(rest).toEqual({ ...streamDefaults, transport: "sse" });
      expect(await transformHeaders?.({})).toEqual({
        "x-openai-internal-codex-residency": "us-east",
      });
    },
  );

  it("forwards a root-level residency claim when the namespaced one is absent", async () => {
    const token = fakeJwt({ chatgpt_compute_residency: "eu-west" });

    expect(await residencyFor(reliableStreamOptions(codexModel, undefined, undefined, token))).toBe(
      "eu-west",
    );
  });

  it("prefers the namespaced residency claim over the root-level one", async () => {
    const token = fakeJwt({
      "https://api.openai.com/auth": { chatgpt_compute_residency: "us-east" },
      chatgpt_compute_residency: "eu-west",
    });

    expect(await residencyFor(reliableStreamOptions(codexModel, undefined, undefined, token))).toBe(
      "us-east",
    );
  });

  it("forwards unknown residency values unvalidated", async () => {
    const token = fakeJwt({
      "https://api.openai.com/auth": { chatgpt_compute_residency: "future-region_1" },
    });

    expect(await residencyFor(reliableStreamOptions(codexModel, undefined, undefined, token))).toBe(
      "future-region_1",
    );
  });

  it.each([
    ["missing", {}],
    [
      "no_constraint",
      { "https://api.openai.com/auth": { chatgpt_compute_residency: "no_constraint" } },
    ],
    ["empty", { chatgpt_compute_residency: "" }],
    ["non-string", { "https://api.openai.com/auth": { chatgpt_compute_residency: 42 } }],
    ["non-object namespace", { "https://api.openai.com/auth": "us-east" }],
  ])("sends no residency header when the claim is %s", async (_case, payload) => {
    const result = reliableStreamOptions(codexModel, undefined, undefined, fakeJwt(payload));

    expect(await residencyFor(result)).toBeUndefined();
  });

  it.each(["not-a-jwt", "only.two", "a.b.c.d", undefined])(
    "sends no residency header for malformed or absent token %s",
    async (token) => {
      const result = reliableStreamOptions(codexModel, undefined, undefined, token);

      expect(await residencyFor(result)).toBeUndefined();
    },
  );

  it("sends no residency header for a malformed payload", async () => {
    const token = `fake.${Buffer.from("not json").toString("base64url")}.fake`;

    const result = reliableStreamOptions(codexModel, undefined, undefined, token);

    expect(await residencyFor(result)).toBeUndefined();
  });

  it("keeps an explicitly-passed residency header over the token claim", async () => {
    const token = fakeJwt({
      "https://api.openai.com/auth": { chatgpt_compute_residency: "us-east" },
    });
    const options = {
      transport: "auto" as const,
      headers: { "x-openai-internal-codex-residency": "manual" },
    };

    const result = reliableStreamOptions(codexModel, options, undefined, token);
    expect(result.headers).toEqual({ "x-openai-internal-codex-residency": "manual" });
    // applyAuth merges options.headers before transformHeaders runs.
    expect(await result.transformHeaders?.(result.headers ?? {})).toEqual({
      "x-openai-internal-codex-residency": "manual",
    });
  });

  it("keeps an explicitly-passed residency header under a different casing", async () => {
    const token = fakeJwt({
      "https://api.openai.com/auth": { chatgpt_compute_residency: "us-east" },
    });
    const options = {
      transport: "auto" as const,
      headers: { "X-OPENAI-INTERNAL-CODEX-RESIDENCY": "manual" },
    };

    const result = reliableStreamOptions(codexModel, options, undefined, token);
    expect(result.headers).toEqual({ "X-OPENAI-INTERNAL-CODEX-RESIDENCY": "manual" });
    // The caller's casing suppresses injection: no duplicate lowercase key.
    expect(await result.transformHeaders?.(result.headers ?? {})).toEqual({
      "X-OPENAI-INTERNAL-CODEX-RESIDENCY": "manual",
    });
  });

  it("composes a caller-supplied transformHeaders after injecting residency", async () => {
    const token = fakeJwt({
      "https://api.openai.com/auth": { chatgpt_compute_residency: "us-east" },
    });
    let seen: string | null | undefined;
    const result = reliableStreamOptions(
      codexModel,
      {
        transformHeaders: (headers) => {
          seen = headers["x-openai-internal-codex-residency"];
          return { ...headers, "x-caller-test": "1" };
        },
      },
      undefined,
      token,
    );

    expect(await result.transformHeaders?.({})).toEqual({
      "x-openai-internal-codex-residency": "us-east",
      "x-caller-test": "1",
    });
    // The caller transform runs last and sees the injected header.
    expect(seen).toBe("us-east");
  });

  it("lets a caller-supplied transformHeaders override residency", async () => {
    const token = fakeJwt({
      "https://api.openai.com/auth": { chatgpt_compute_residency: "us-east" },
    });
    const result = reliableStreamOptions(
      codexModel,
      {
        transformHeaders: async (headers) => ({
          ...headers,
          "x-openai-internal-codex-residency": "manual",
        }),
      },
      undefined,
      token,
    );

    expect(await residencyFor(result)).toBe("manual");
  });

  it("derives residency from the live credential after a mid-run OAuth refresh", async () => {
    const initial = fakeJwt({
      "https://api.openai.com/auth": { chatgpt_compute_residency: "us-east" },
    });
    const refreshed = fakeJwt({
      "https://api.openai.com/auth": { chatgpt_compute_residency: "eu-west" },
    });
    const resolved = resolveRuntimeModel({
      provider: "openai-codex",
      id: "gpt-5.3-codex",
      oauth: {
        credential: { type: "oauth", access: initial, refresh: "refresh-1", expires: 0 },
      },
    });
    // The getter the stream functions hand to reliableStreamOptions, and the
    // options built once up front — transformHeaders resolves residency when
    // each request is dispatched, after applyAuth may have refreshed the token.
    const accessToken = () => resolved.credentials?.accessToken ?? resolved.apiKey;
    const options = reliableStreamOptions(codexModel, undefined, undefined, accessToken);

    expect(await residencyFor(options)).toBe("us-east");

    // Pi swaps the stored credential when the OAuth token refreshes mid-run.
    await resolved.credentials?.modify("openai-codex", async () => ({
      type: "oauth",
      access: refreshed,
      refresh: "refresh-2",
      expires: Date.now() + 3_600_000,
    }));

    expect(await residencyFor(options)).toBe("eu-west");
  });

  it("sends the residency of the token streamSimple refreshed before the request", async () => {
    const initial = fakeJwt({
      "https://api.openai.com/auth": {
        chatgpt_account_id: "acct_test",
        chatgpt_compute_residency: "us-east",
      },
    });
    const refreshed = fakeJwt({
      "https://api.openai.com/auth": {
        chatgpt_account_id: "acct_test",
        chatgpt_compute_residency: "eu-west",
      },
    });
    const resolved = resolveRuntimeModel({
      provider: "openai-codex",
      id: "gpt-5.5",
      oauth: {
        credential: { type: "oauth", access: initial, refresh: "refresh-1", expires: 0 },
      },
    });
    expect(resolved.model?.provider).toBe("openai-codex");

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url !== "https://auth.openai.com/oauth/token") {
          throw new Error(`unexpected fetch ${url}`);
        }
        return Response.json({
          access_token: refreshed,
          refresh_token: "refresh-2",
          expires_in: 3600,
        });
      }),
    );
    try {
      let residency: string | null = null;
      const stream = reliableModelStream(
        resolved.models,
        resolved.model!,
        { messages: [{ role: "user", content: "ping", timestamp: 0 }] } as Context,
        {
          fetch: async (input, init) => {
            const headers = new Headers(
              init?.headers ?? (input instanceof Request ? input.headers : undefined),
            );
            residency = headers.get("x-openai-internal-codex-residency");
            return Response.json({ error: { message: "unauthorized" } }, { status: 401 });
          },
        },
        undefined,
        () => resolved.credentials?.accessToken,
      );
      const events = [];
      for await (const event of stream) events.push(event.type);
      const result = await stream.result();

      expect(residency).toBe("eu-west");
      expect(resolved.credentials?.accessToken).toBe(refreshed);
      expect(events).toContain("error");
      expect(result.stopReason).toBe("error");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("never attaches the residency header for non-Codex providers", () => {
    const model = { provider: "openrouter", api: "openai-completions" } as Model<Api>;
    const token = fakeJwt({
      "https://api.openai.com/auth": { chatgpt_compute_residency: "us-east" },
    });

    const result = reliableStreamOptions(model, undefined, undefined, token);

    expect(result.headers).toBeUndefined();
    expect(result.transformHeaders).toBeUndefined();
  });

  it("keeps a stable conversation session id per bot thread", () => {
    expect(conversationSessionId("thread-1", "bot-1")).toBe("thread-1:bot-1");
    expect(conversationSessionId("thread-1", "bot-1", "sub-1")).toBe("thread-1:bot-1:sub-1");
  });

  it.each(["none", "short", "long"] as const)(
    "forwards configured %s cache retention without changing caller options",
    (cacheRetention) => {
      const model = { provider: "openrouter", api: "openai-completions" } as Model<Api>;
      const options = { transport: "auto" as const, maxRetries: 2 };
      expect(
        reliableStreamOptions(model, options, undefined, undefined, cacheRetention),
      ).toMatchObject({
        ...options,
        cacheRetention,
      });
      expect(options).not.toHaveProperty("cacheRetention");
    },
  );
});
