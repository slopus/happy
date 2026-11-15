import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Socket } from "node:net";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  normalizeContext,
} from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { ModelConnectInputSchema, OPENAI_COMPATIBLE_PROVIDER_ID } from "@rakazo/contracts";
import { fetch as undiciFetch } from "undici";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildModelConnectPlaintext } from "./model-connect.js";
import { parseModelSecret, secretValuesToRedact, serializeModelSecret } from "./model-secret.js";
import {
  assertAllowedOpenAiCompatibleUrl,
  PRIVATE_MODEL_ENDPOINT_MESSAGE,
} from "./openai-compatible-url.js";
import { listPiCatalog } from "./pi-models.js";
import {
  createOpenAiCompatibleFetch,
  createOpenAiCompatibleLookup,
  OPENAI_COMPATIBLE_CATALOG_MODEL_ID,
  openAiCompatibleCatalogProvider,
  prepareOpenAiCompatibleConnect,
  probeOpenAiCompatibleModels,
  registerOpenAiCompatibleCatalog,
  registerOpenAiCompatibleRuntime,
  verifyOpenAiCompatibleApiKey,
} from "./pi-openai-compatible-provider.js";

const savedPrivateHosts = process.env.RAKAZO_OPENAI_COMPAT_PRIVATE_HOSTS;

afterEach(() => {
  if (savedPrivateHosts === undefined) delete process.env.RAKAZO_OPENAI_COMPAT_PRIVATE_HOSTS;
  else process.env.RAKAZO_OPENAI_COMPAT_PRIVATE_HOSTS = savedPrivateHosts;
});

/** Fixtures connect as the deployment owner, who may use local model servers. */
const connectAsOwner = (
  input: Parameters<typeof buildModelConnectPlaintext>[0],
  previous?: string,
  options?: Parameters<typeof buildModelConnectPlaintext>[2],
) => buildModelConnectPlaintext(input, previous, { allowPrivateEndpoint: true, ...options });

const OWNER = { allowPrivate: true };

describe("model connect", () => {
  it("round-trips generic cache capabilities and preserves them when rotating credentials", () => {
    const cacheCapabilities = {
      scope: "connection" as const,
      retentionMode: "short" as const,
      retentionMs: 300000,
      minimumTokens: 1024,
      inputCostPerMillion: 1,
      readCostPerMillion: 0.1,
      writeCostPerMillion: 1.25,
    };
    const encoded = connectAsOwner({
      provider: "fixture",
      apiKey: "fake-api-key",
      cacheCapabilities,
    });
    expect(parseModelSecret(encoded)).toMatchObject({
      kind: "api_key",
      cacheCapabilities,
    });
    const rotated = connectAsOwner({ provider: "fixture", apiKey: "fake-next-key" }, encoded);
    expect(parseModelSecret(rotated)).toMatchObject({
      kind: "api_key",
      cacheCapabilities,
    });
    expect(
      ModelConnectInputSchema.safeParse({
        provider: "fixture",
        apiKey: "fake-api-key",
        cacheCapabilities: { ...cacheCapabilities, retentionMode: "forever" },
      }).success,
    ).toBe(false);
  });
  it("stores generic limits with hosted credentials and preserves them when rotating the key", () => {
    const plaintext = connectAsOwner({
      provider: "openrouter",
      apiKey: "fake-api-key",
      contextWindow: 1000000,
      maxTokens: 4096,
    });
    expect(parseModelSecret(plaintext)).toEqual({
      kind: "api_key",
      key: "fake-api-key",
      contextWindow: 1000000,
      maxTokens: 4096,
    });
    expect(
      parseModelSecret(
        connectAsOwner({ provider: "openrouter", apiKey: "fake-new-key" }, plaintext),
      ),
    ).toEqual({
      kind: "api_key",
      key: "fake-new-key",
      contextWindow: 1000000,
      maxTokens: 4096,
    });
  });
  it("rejects invalid configured limits at the shared contract", () => {
    expect(
      ModelConnectInputSchema.safeParse({
        provider: "fixture",
        apiKey: "fake-api-key",
        contextWindow: 2048,
        maxTokens: 2048,
      }).success,
    ).toBe(false);
    expect(
      ModelConnectInputSchema.safeParse({
        provider: "fixture",
        apiKey: "fake-api-key",
        contextWindow: -1,
      }).success,
    ).toBe(false);
  });
  it("serializes keyless openai-compatible credentials", () => {
    const plaintext = connectAsOwner({
      provider: OPENAI_COMPATIBLE_PROVIDER_ID,
      baseUrl: "http://127.0.0.1:8000",
      modelId: "qwen3-4b",
    });
    const parsed = parseModelSecret(plaintext);
    expect(parsed).toEqual({
      kind: "openai_compatible",
      baseUrl: "http://127.0.0.1:8000/v1",
      enabledModelIds: ["qwen3-4b"],
    });
    expect(secretValuesToRedact(parsed)).toEqual([]);
  });

  it("still requires hosted providers to supply a real API key", () => {
    expect(() => connectAsOwner({ provider: "openrouter", apiKey: "short" })).toThrow(
      /at least 8 characters/,
    );
  });

  it("round-trips optional openai-compatible API keys", () => {
    const secret = {
      kind: "openai_compatible" as const,
      baseUrl: "http://127.0.0.1:8000/v1",
      apiKey: "local-secret",
    };
    const parsed = parseModelSecret(serializeModelSecret(secret));
    expect(parsed).toEqual(secret);
    expect(secretValuesToRedact(parsed)).toEqual(["local-secret"]);
  });

  it("keeps private http openai-compatible connects when an API key is set", () => {
    const plaintext = connectAsOwner({
      provider: OPENAI_COMPATIBLE_PROVIDER_ID,
      baseUrl: "http://127.0.0.1:8000",
      modelId: "local-model",
      apiKey: "local-secret",
    });
    expect(parseModelSecret(plaintext)).toEqual({
      kind: "openai_compatible",
      baseUrl: "http://127.0.0.1:8000/v1",
      apiKey: "local-secret",
      enabledModelIds: ["local-model"],
    });
  });

  it("rejects public http openai-compatible connects when an API key is set", () => {
    const previous = process.env.RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC;
    process.env.RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC = "1";
    try {
      expect(() =>
        prepareOpenAiCompatibleConnect({
          provider: OPENAI_COMPATIBLE_PROVIDER_ID,
          baseUrl: "http://api.example.com/v1",
          modelId: "my-model-id",
          apiKey: "secret-key",
        }),
      ).toThrow(/must use HTTPS/);
      expect(() =>
        connectAsOwner({
          provider: OPENAI_COMPATIBLE_PROVIDER_ID,
          baseUrl: "http://api.example.com/v1",
          modelId: "my-model-id",
          apiKey: "secret-key",
        }),
      ).toThrow(/must use HTTPS/);
    } finally {
      if (previous === undefined) delete process.env.RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC;
      else process.env.RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC = previous;
    }
  });

  it("allows public https openai-compatible connects when an API key is set", () => {
    const previous = process.env.RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC;
    process.env.RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC = "1";
    try {
      const prepared = prepareOpenAiCompatibleConnect({
        provider: OPENAI_COMPATIBLE_PROVIDER_ID,
        baseUrl: "https://api.example.com/v1",
        modelId: "my-model-id",
        apiKey: "secret-key",
      });
      expect(prepared).toEqual({
        baseUrl: "https://api.example.com/v1",
        modelId: "my-model-id",
        apiKey: "secret-key",
      });
    } finally {
      if (previous === undefined) delete process.env.RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC;
      else process.env.RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC = previous;
    }
  });
});

describe("private model endpoints", () => {
  const privateBaseUrl = "http://127.0.0.1:11434/v1";
  const connect = {
    provider: OPENAI_COMPATIBLE_PROVIDER_ID,
    baseUrl: privateBaseUrl,
    modelId: "local-model",
  };
  const okModels = () => Response.json({ data: [{ id: "local-model" }] });

  it("refuses to save a private endpoint unless the owner gate allows it", () => {
    expect(() => buildModelConnectPlaintext(connect)).toThrow(PRIVATE_MODEL_ENDPOINT_MESSAGE);
    expect(() =>
      buildModelConnectPlaintext(connect, undefined, { allowPrivateEndpoint: false }),
    ).toThrow(PRIVATE_MODEL_ENDPOINT_MESSAGE);
    expect(parseModelSecret(connectAsOwner(connect))).toMatchObject({ baseUrl: privateBaseUrl });
  });

  it("refuses to probe a private endpoint unless the owner gate allows it", async () => {
    const fetchImpl = vi.fn(async () => okModels());
    await expect(
      probeOpenAiCompatibleModels({ baseUrl: privateBaseUrl }, fetchImpl),
    ).rejects.toThrow(PRIVATE_MODEL_ENDPOINT_MESSAGE);
    expect(fetchImpl).not.toHaveBeenCalled();
    await expect(
      probeOpenAiCompatibleModels({ baseUrl: privateBaseUrl }, fetchImpl, undefined, OWNER),
    ).resolves.toEqual(["local-model"]);
  });

  it("refuses a stored private endpoint at run time unless the owner gate allows it", async () => {
    const run = async (allowPrivate?: boolean) => {
      const fetchImpl = vi.fn(
        async () =>
          new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } }),
      );
      const models = registerOpenAiCompatibleRuntime(createModels(), {
        modelId: "local-model",
        baseUrl: privateBaseUrl,
        allowPrivate,
      });
      const provider = models.getProvider(OPENAI_COMPATIBLE_PROVIDER_ID)!;
      const model = models.getModel(OPENAI_COMPATIBLE_PROVIDER_ID, "local-model")!;
      const result = await provider
        .streamSimple(model, normalizeContext({ messages: [] }), {
          apiKey: "fake-api-key",
          fetch: fetchImpl,
        })
        .result();
      return { fetchImpl, result };
    };
    const denied = await run();
    expect(denied.fetchImpl).not.toHaveBeenCalled();
    // The SDK reports a refused fetch as a connection error; the request never left.
    expect(denied.result).toMatchObject({ stopReason: "error" });
    const allowed = await run(true);
    expect(allowed.fetchImpl).toHaveBeenCalledOnce();
  });

  it("refuses private request URLs in the fetch guard by default", async () => {
    const fetchImpl = vi.fn(async () => okModels());
    for (const url of [
      "http://127.0.0.1:8000/v1/models",
      "http://localhost:8000/v1/models",
      "http://10.0.0.8/v1/models",
      "http://[fd00::1]/v1/models",
      "http://host.docker.internal:8000/v1/models",
    ]) {
      await expect(createOpenAiCompatibleFetch(fetchImpl)(url)).rejects.toThrow(
        PRIVATE_MODEL_ENDPOINT_MESSAGE,
      );
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("sends loopback requests to the deployment's host address", async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Response("{}", { status: 200 });
    });
    const safeFetch = createOpenAiCompatibleFetch(fetchImpl, undefined, OWNER);
    try {
      await safeFetch("http://localhost:11234/v1/models");
      vi.stubEnv("RAKAZO_LOOPBACK_HOST", "host.docker.internal");
      await safeFetch("http://127.0.0.1:11234/v1/models");
      await safeFetch("http://10.0.0.5:8000/v1/models");
      vi.stubEnv("RAKAZO_LOOPBACK_HOST", "169.254.169.254");
      await expect(safeFetch("http://localhost:11234/v1/models")).rejects.toThrow(
        "blocked metadata",
      );
    } finally {
      vi.unstubAllEnvs();
    }
    expect(urls).toEqual([
      "http://localhost:11234/v1/models",
      "http://host.docker.internal:11234/v1/models",
      "http://10.0.0.5:8000/v1/models",
    ]);
  });

  it.each([undefined, true])(
    "refuses a public hostname that resolves to a private address (allowPrivate=%s)",
    async (allowPrivate) => {
      const resolve = vi.fn(async () => [{ address: "10.0.0.8", family: 4 }]);
      const safeFetch = createOpenAiCompatibleFetch(undefined, resolve, {
        allowPublic: true,
        allowPrivate,
      });
      await expect(safeFetch("https://models.example.test/v1/models")).rejects.toMatchObject({
        cause: { message: "Public model server hostname resolved to a private address" },
      });
      expect(resolve).toHaveBeenCalledOnce();
    },
  );

  it("refuses a private hostname in the pinned lookup unless the owner gate allows it", () => {
    const resolve = async () => [{ address: "127.0.0.1", family: 4 }];
    expect(() =>
      createOpenAiCompatibleLookup(new URL("http://localhost:8000/v1"), resolve),
    ).toThrow(PRIVATE_MODEL_ENDPOINT_MESSAGE);
    expect(() =>
      createOpenAiCompatibleLookup(new URL("http://localhost:8000/v1"), resolve, OWNER),
    ).not.toThrow();
  });
});

describe("openai-compatible provider", () => {
  it("leaves other providers untouched during catalog and runtime registration", () => {
    const models = createModels();
    const other = fauxProvider();
    models.setProvider(other.provider);
    const setProvider = vi.spyOn(models, "setProvider");

    registerOpenAiCompatibleCatalog(models);
    registerOpenAiCompatibleRuntime(models, {
      modelId: "fixture-model",
      baseUrl: "http://127.0.0.1:8000/v1",
      allowPrivate: true,
    });

    expect(models.getProvider(other.provider.id)).toBe(other.provider);
    expect(setProvider).toHaveBeenCalledTimes(4);
    for (const [provider] of setProvider.mock.calls) {
      expect(provider.id).toBe(OPENAI_COMPATIBLE_PROVIDER_ID);
    }
  });

  it.each(["stream", "streamSimple"] as const)(
    "guards transcripts after runtime registration through %s",
    async (method) => {
      const models = registerOpenAiCompatibleCatalog(createModels());
      registerOpenAiCompatibleRuntime(models, {
        modelId: "fixture-model",
        baseUrl: "http://127.0.0.1:8000/v1",
        allowPrivate: true,
      });
      const provider = models.getProvider(OPENAI_COMPATIBLE_PROVIDER_ID)!;
      const model = models.getModel(OPENAI_COMPATIBLE_PROVIDER_ID, "fixture-model")!;
      const context = normalizeContext({
        messages: [
          fauxAssistantMessage([
            { type: "toolCall", id: "call_named", name: "list_tasks", arguments: {} },
            { type: "toolCall", id: "call_nameless", name: "", arguments: {} },
          ]),
          ...["call_nameless", "call_named"].map((toolCallId) => ({
            role: "toolResult" as const,
            toolCallId,
            toolName: "",
            content: [{ type: "text" as const, text: "real result" }],
            isError: false,
            timestamp: 1,
          })),
        ],
      });
      let messages: unknown;
      await provider[method](model, context, {
        apiKey: "fake-api-key",
        fetch: async (_input, init) => {
          messages = JSON.parse(String(init?.body)).messages;
          return new Response("data: [DONE]\n\n", {
            headers: { "content-type": "text/event-stream" },
          });
        },
      }).result();

      expect(messages).toEqual([
        expect.objectContaining({
          role: "assistant",
          tool_calls: [
            expect.objectContaining({
              id: "call_named",
              function: { name: "list_tasks", arguments: "{}" },
            }),
          ],
        }),
        expect.objectContaining({
          role: "tool",
          tool_call_id: "call_named",
          content: "real result",
        }),
      ]);
    },
  );

  it("does not treat replaced Request Authorization as keyed for public http", async () => {
    const previous = process.env.RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC;
    process.env.RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC = "1";
    try {
      const request = new Request("http://api.example.com/v1/models", {
        headers: { Authorization: "Bearer secret" },
      });
      const safeFetch = createOpenAiCompatibleFetch(
        async () => new Response("{}", { status: 200 }),
      );
      await expect(
        safeFetch(request, { headers: { Accept: "application/json" } }),
      ).resolves.toMatchObject({ status: 200 });
    } finally {
      if (previous === undefined) delete process.env.RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC;
      else process.env.RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC = previous;
    }
  });

  it("drives the guarded dispatcher with a fetch from the same undici", async () => {
    // See remote-mcp.test: failing inside the lookup proves the request was
    // dispatched through the Agent rather than rejected by a mismatched fetch.
    // Omitting fetch, passing the builtin, and passing a captured builtin must
    // all use the package fetch that matches the Agent.
    expect(undiciFetch).not.toBe(globalThis.fetch);
    const captured = globalThis.fetch;
    const previous = process.env.RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC;
    process.env.RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC = "1";
    try {
      for (const injected of [undefined, globalThis.fetch, captured] as const) {
        const safeFetch = createOpenAiCompatibleFetch(injected, async () => {
          throw new Error("lookup reached");
        });
        await expect(safeFetch("https://models.example.test/v1/models")).rejects.toMatchObject({
          cause: { message: "lookup reached" },
        });
      }
    } finally {
      if (previous === undefined) delete process.env.RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC;
      else process.env.RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC = previous;
    }
  });

  it("flattens a global Request so the package fetch can dispatch it", async () => {
    // undici's fetch reads a foreign Request as "[object Request]"; reaching
    // the lookup proves the request was dispatched with its URL instead.
    const previous = process.env.RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC;
    process.env.RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC = "1";
    try {
      const safeFetch = createOpenAiCompatibleFetch(undefined, async () => {
        throw new Error("lookup reached");
      });
      const request = new Request("https://models.example.test/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "local" }),
      });
      await expect(safeFetch(request)).rejects.toMatchObject({
        cause: { message: "lookup reached" },
      });
    } finally {
      if (previous === undefined) delete process.env.RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC;
      else process.env.RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC = previous;
    }
  });

  it("cancels a pending connection without waiting for the connect timeout", async () => {
    const controller = new AbortController();
    let markLookupStarted: () => void = () => {};
    const lookupStarted = new Promise<void>((resolve) => {
      markLookupStarted = resolve;
    });
    const safeFetch = createOpenAiCompatibleFetch(
      undefined,
      async () => {
        markLookupStarted();
        return new Promise(() => {});
      },
      OWNER,
    );
    const outcome = safeFetch("https://localhost:8000/v1/models", {
      signal: controller.signal,
    }).catch((error: unknown) => error);
    try {
      await lookupStarted;
      controller.abort();
      await expect(outcome).resolves.toMatchObject({ name: "AbortError" });
    } finally {
      controller.abort();
    }
  });

  it("gives up connecting after the configured connect timeout", async () => {
    vi.stubEnv("MODEL_CONNECT_TIMEOUT_MS", "1000");
    try {
      const safeFetch = createOpenAiCompatibleFetch(
        undefined,
        async () => new Promise(() => {}),
        OWNER,
      );
      await expect(safeFetch("https://localhost:8000/v1/models")).rejects.toMatchObject({
        cause: { code: "UND_ERR_CONNECT_TIMEOUT" },
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("carries a Request's method, headers and body through as init", async () => {
    let seen: { url: string; init?: RequestInit } | undefined;
    const safeFetch = createOpenAiCompatibleFetch(
      async (input, init) => {
        seen = { url: String(input), init };
        return new Response("{}", { status: 200 });
      },
      undefined,
      OWNER,
    );
    await safeFetch(
      new Request("http://127.0.0.1:8000/v1/models", {
        method: "POST",
        headers: { "x-trace": "1" },
        body: "payload",
      }),
      { headers: { "x-trace": "2" } },
    );
    expect(seen?.url).toBe("http://127.0.0.1:8000/v1/models");
    expect(seen?.init?.method).toBe("POST");
    expect(new Headers(seen?.init?.headers).get("x-trace")).toBe("2");
    expect(Buffer.from(seen?.init?.body as ArrayBuffer).toString()).toBe("payload");
  });

  it("rejects public hostnames that resolve to private addresses", async () => {
    const lookup = createOpenAiCompatibleLookup(
      new URL("https://models.example.test/v1"),
      async () => [{ address: "127.0.0.1", family: 4 }],
    );
    const error = await new Promise<Error | null>((resolve) => {
      lookup("models.example.test", { family: 0, all: false }, (lookupError) => {
        resolve(lookupError);
      });
    });
    expect(error).toMatchObject({
      message: "Public model server hostname resolved to a private address",
    });
  });

  it("rejects local hostnames that resolve to link-local addresses", async () => {
    const lookup = createOpenAiCompatibleLookup(
      new URL("http://localhost:8000/v1"),
      async () => [{ address: "169.254.1.1", family: 4 }],
      OWNER,
    );
    const error = await new Promise<Error | null>((resolve) => {
      lookup("localhost", { family: 0, all: false }, (lookupError) => resolve(lookupError));
    });
    expect(error).toMatchObject({
      message: "Local model server hostname resolved outside the private network",
    });
  });

  it("rejects allowlisted hostname lookups without private endpoint permission", () => {
    process.env.RAKAZO_OPENAI_COMPAT_PRIVATE_HOSTS = "models.example.test";
    const resolveHostname = vi.fn(async () => [{ address: "192.168.1.20", family: 4 }]);
    expect(() =>
      createOpenAiCompatibleLookup(new URL("https://models.example.test/v1"), resolveHostname),
    ).toThrow(PRIVATE_MODEL_ENDPOINT_MESSAGE);
    expect(resolveHostname).not.toHaveBeenCalled();
  });

  it("returns validated private DNS addresses for an explicitly trusted hostname", async () => {
    process.env.RAKAZO_OPENAI_COMPAT_PRIVATE_HOSTS = "models.example.test";
    const addresses = [
      { address: "192.168.1.20", family: 4 },
      { address: "fd12::20", family: 6 },
    ];
    const resolveHostname = vi.fn(async () => addresses);
    const lookup = createOpenAiCompatibleLookup(
      new URL("https://models.example.test/v1"),
      resolveHostname,
      OWNER,
    );
    const result = await new Promise<unknown>((resolve, reject) => {
      lookup("models.example.test", { family: 0, all: true }, (error, resolved) =>
        error ? reject(error) : resolve(resolved),
      );
    });
    expect(result).toEqual(addresses);
    expect(resolveHostname).toHaveBeenCalledWith("models.example.test");
  });

  it("dispatches trusted private hosts using checked DNS and the original Host header", async () => {
    process.env.RAKAZO_OPENAI_COMPAT_PRIVATE_HOSTS = "models.example.test";
    let host: string | undefined;
    const server = createServer((request, response) => {
      // A local tool can probe any listening loopback port; only model-list calls set the host.
      if (request.method !== "GET" || request.url !== "/v1/models") {
        request.resume();
        response.writeHead(404).end();
        return;
      }
      host = request.headers.host;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ data: [{ id: "local-model" }] }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing test server address");
      const resolveHostname = vi.fn(async () => [{ address: "127.0.0.1", family: 4 }]);
      const safeFetch = createOpenAiCompatibleFetch(undefined, resolveHostname, {
        allowPublic: false,
        allowPrivate: true,
      });
      const baseUrl = `http://models.example.test:${address.port}/v1`;
      await expect(
        probeOpenAiCompatibleModels({ baseUrl }, safeFetch, undefined, OWNER),
      ).resolves.toEqual(["local-model"]);
      expect(host).toBe(`models.example.test:${address.port}`);
      expect(resolveHostname).toHaveBeenCalledWith("models.example.test");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it.each([
    ["169.254.169.254", 4],
    ["100.100.100.200", 4],
    ["fd00:ec2::254", 6],
    ["169.254.1.1", 4],
    ["fe80::1", 6],
    ["203.0.113.1", 4],
    ["not-an-address", 4],
  ])("rejects unsafe or non-private DNS answers for trusted hosts: %s", async (address, family) => {
    process.env.RAKAZO_OPENAI_COMPAT_PRIVATE_HOSTS = "models.example.test";
    const lookup = createOpenAiCompatibleLookup(
      new URL("https://models.example.test/v1"),
      async () => [
        { address: "192.168.1.20", family: 4 },
        { address, family },
      ],
      OWNER,
    );
    const error = await new Promise<Error | null>((resolve) => {
      lookup("models.example.test", { family: 0, all: false }, (lookupError) =>
        resolve(lookupError),
      );
    });
    expect(error).toBeInstanceOf(Error);
  });

  it.each([
    ["100.100.100.200", 4],
    ["fd00:ec2::254", 6],
  ])("rejects local hostnames that resolve to metadata address %s", async (address, family) => {
    const lookup = createOpenAiCompatibleLookup(
      new URL("http://localhost:8000/v1"),
      async () => [{ address, family }],
      OWNER,
    );
    const error = await new Promise<Error | null>((resolve) => {
      lookup("localhost", { family: 0, all: false }, (lookupError) => resolve(lookupError));
    });
    expect(error).toMatchObject({
      message: "Model server hostname resolved to a blocked metadata address",
    });
  });

  it("always exposes a catalog provider entry", () => {
    const provider = openAiCompatibleCatalogProvider();
    expect(provider.id).toBe(OPENAI_COMPATIBLE_PROVIDER_ID);
    expect(provider.getModels()[0]?.id).toBe(OPENAI_COMPATIBLE_CATALOG_MODEL_ID);
  });

  it("defaults an unreported compatible context window to 256k", () => {
    const models = registerOpenAiCompatibleRuntime(builtinModels(), {
      modelId: "synthetic-model",
      baseUrl: "http://127.0.0.1:8000/v1",
      allowPrivate: true,
    });
    expect(models.getModel(OPENAI_COMPATIBLE_PROVIDER_ID, "synthetic-model")?.contextWindow).toBe(
      262_144,
    );
  });

  it("registers runtime models at the stored base URL", () => {
    const models = registerOpenAiCompatibleRuntime(builtinModels(), {
      modelId: "rapid-mlx",
      baseUrl: "http://127.0.0.1:8000/v1",
      allowPrivate: true,
      maxTokens: 8192,
      contextWindow: 65536,
    });
    const model = models.getModel(OPENAI_COMPATIBLE_PROVIDER_ID, "rapid-mlx");
    expect(model?.baseUrl).toBe("http://127.0.0.1:8000/v1");
    expect(model?.api).toBe("openai-completions");
    expect(model?.maxTokens).toBe(8192);
    expect(model?.contextWindow).toBe(65536);
  });

  it("probes /v1/models with mocked fetch", async () => {
    const fetchImpl = async () =>
      new Response(JSON.stringify({ object: "list", data: [{ id: "a" }, { id: "b" }] }), {
        status: 200,
      });
    await expect(
      probeOpenAiCompatibleModels(
        { baseUrl: "http://127.0.0.1:8000/v1" },
        fetchImpl,
        undefined,
        OWNER,
      ),
    ).resolves.toEqual(["a", "b"]);
  });

  it("still accepts legacy models[] probe responses", async () => {
    const fetchImpl = async () =>
      new Response(JSON.stringify({ models: [{ id: "legacy" }] }), {
        status: 200,
      });
    await expect(
      probeOpenAiCompatibleModels(
        { baseUrl: "http://127.0.0.1:8000/v1" },
        fetchImpl,
        undefined,
        OWNER,
      ),
    ).resolves.toEqual(["legacy"]);
  });

  it("accepts a gateway catalogue up to the custom model-count limit", async () => {
    const ids = Array.from({ length: 4_000 }, (_, index) => `m${index}`);
    const fetchImpl = async () => Response.json({ data: ids.map((id) => ({ id })) });
    await expect(
      probeOpenAiCompatibleModels(
        { baseUrl: "http://127.0.0.1:8000/v1" },
        fetchImpl,
        undefined,
        OWNER,
      ),
    ).resolves.toEqual(ids);
  });

  it("accepts metadata-rich catalogues larger than 64 KiB", async () => {
    const data = Array.from({ length: 100 }, (_, index) => ({
      id: `model-${index}`,
      description: "x".repeat(1024),
      context_length: 128_000,
    }));
    const fetchImpl = async () => Response.json({ data });
    await expect(
      probeOpenAiCompatibleModels(
        { baseUrl: "http://127.0.0.1:8000/v1" },
        fetchImpl,
        undefined,
        OWNER,
      ),
    ).resolves.toEqual(data.map((model) => model.id));
  });

  it("rejects catalogues above the custom model-count limit", async () => {
    const fetchImpl = async () =>
      Response.json({
        data: Array.from({ length: 4_001 }, (_, index) => ({ id: `m${index}` })),
      });
    await expect(
      probeOpenAiCompatibleModels(
        { baseUrl: "http://127.0.0.1:8000/v1" },
        fetchImpl,
        undefined,
        OWNER,
      ),
    ).rejects.toThrow(/too many or overly long model ids/);
  });

  it("still rejects overly long individual model IDs", async () => {
    const fetchImpl = async () => Response.json({ data: [{ id: "x".repeat(257) }] });
    await expect(
      probeOpenAiCompatibleModels(
        { baseUrl: "http://127.0.0.1:8000/v1" },
        fetchImpl,
        undefined,
        OWNER,
      ),
    ).rejects.toThrow(/too many or overly long model ids/);
  });

  it("rejects redirect responses during probing", async () => {
    const fetchImpl: typeof fetch = async (_input, init) => {
      expect(init?.redirect).toBe("error");
      return new Response(null, {
        status: 302,
        headers: { location: "http://127.0.0.1:9/blocked" },
      });
    };
    await expect(
      probeOpenAiCompatibleModels(
        { baseUrl: "http://127.0.0.1:8000/v1" },
        fetchImpl,
        undefined,
        OWNER,
      ),
    ).rejects.toThrow(/redirect.*explicit model id/is);
  });

  it("clarifies non-2xx probe failures with status and hand-fill hint", async () => {
    const fetchImpl = async () => new Response("nope", { status: 404 });
    await expect(
      probeOpenAiCompatibleModels(
        { baseUrl: "http://127.0.0.1:8000/v1" },
        fetchImpl,
        undefined,
        OWNER,
      ),
    ).rejects.toThrow(/returned 404.*You can still Connect with an explicit model id/s);
  });

  it("clarifies missing models list with hand-fill hint", async () => {
    const fetchImpl = async () => new Response(JSON.stringify({ object: "list" }), { status: 200 });
    await expect(
      probeOpenAiCompatibleModels(
        { baseUrl: "http://127.0.0.1:8000/v1" },
        fetchImpl,
        undefined,
        OWNER,
      ),
    ).rejects.toThrow(/did not include a models list.*explicit model id/s);
  });

  it.each([
    { name: "null", body: null },
    { name: "boolean", body: true },
    { name: "number", body: 42 },
    { name: "string", body: "catalog" },
    { name: "array", body: [] },
    { name: "null data", body: { data: null } },
    { name: "non-array data", body: { data: { id: "model" } } },
  ])("clarifies malformed models list responses ($name) with hand-fill hint", async ({ body }) => {
    const fetchImpl = async () => Response.json(body);
    await expect(
      probeOpenAiCompatibleModels(
        { baseUrl: "http://127.0.0.1:8000/v1" },
        fetchImpl,
        undefined,
        OWNER,
      ),
    ).rejects.toThrow(/did not include a models list.*explicit model id/s);
  });

  it("clarifies invalid JSON probe bodies with hand-fill hint", async () => {
    const fetchImpl = async () => new Response("{not-json", { status: 200 });
    await expect(
      probeOpenAiCompatibleModels(
        { baseUrl: "http://127.0.0.1:8000/v1" },
        fetchImpl,
        undefined,
        OWNER,
      ),
    ).rejects.toThrow(/invalid JSON.*explicit model id/s);
  });

  it("clarifies empty probe responses with hand-fill hint", async () => {
    const fetchImpl = async () => new Response(null, { status: 200 });
    await expect(
      probeOpenAiCompatibleModels(
        { baseUrl: "http://127.0.0.1:8000/v1" },
        fetchImpl,
        undefined,
        OWNER,
      ),
    ).rejects.toThrow(/empty response.*explicit model id/s);
  });

  it("rejects oversized model lists", async () => {
    const fetchImpl = async () => new Response("x".repeat(2 * 1024 * 1024 + 1));
    await expect(
      probeOpenAiCompatibleModels(
        { baseUrl: "http://127.0.0.1:8000/v1" },
        fetchImpl,
        undefined,
        OWNER,
      ),
    ).rejects.toThrow(/too large.*explicit model id/is);
  });

  it("cancels model responses whose declared size exceeds the limit", async () => {
    let cancelled = false;
    const fetchImpl = async () =>
      new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { "content-length": String(2 * 1024 * 1024 + 1) } },
      );
    await expect(
      probeOpenAiCompatibleModels(
        { baseUrl: "http://127.0.0.1:8000/v1" },
        fetchImpl,
        undefined,
        OWNER,
      ),
    ).rejects.toThrow(/too large.*explicit model id/is);
    expect(cancelled).toBe(true);
  });

  it("cancels streamed responses that cross the custom byte limit", async () => {
    let cancelled = false;
    const fetchImpl = async () =>
      new Response(
        new ReadableStream({
          /** Cross the byte cap in a second chunk without declaring a content length. */
          start(controller) {
            controller.enqueue(new Uint8Array(2 * 1024 * 1024));
            controller.enqueue(new Uint8Array(1));
          },
          /** Record cancellation so the test can verify the oversized stream is released. */
          cancel() {
            cancelled = true;
          },
        }),
      );
    await expect(
      probeOpenAiCompatibleModels(
        { baseUrl: "http://127.0.0.1:8000/v1" },
        fetchImpl,
        undefined,
        OWNER,
      ),
    ).rejects.toThrow(/too large.*explicit model id/is);
    expect(cancelled).toBe(true);
  });

  it("says a refused model server is not running, and keeps other transport errors", async () => {
    const down: typeof fetch = async () => {
      throw new TypeError("fetch failed", {
        cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
      });
    };
    const bothAddressesDown: typeof fetch = async () => {
      throw new TypeError("fetch failed", {
        cause: new AggregateError([
          Object.assign(new Error("connect ECONNREFUSED ::1"), { code: "ECONNREFUSED" }),
          Object.assign(new Error("connect ECONNREFUSED 127.0.0.1"), { code: "ECONNREFUSED" }),
        ]),
      });
    };
    const redirected: typeof fetch = async () => {
      throw new TypeError("fetch failed", { cause: new Error("unexpected redirect") });
    };
    await expect(
      probeOpenAiCompatibleModels({ baseUrl: "http://127.0.0.1:11234/v1" }, down, undefined, OWNER),
    ).rejects.toThrow("Check that it's running");
    await expect(
      probeOpenAiCompatibleModels(
        { baseUrl: "http://localhost:11234/v1" },
        bothAddressesDown,
        undefined,
        OWNER,
      ),
    ).rejects.toThrow("Check that it's running");
    await expect(
      probeOpenAiCompatibleModels({ baseUrl: "http://10.0.0.5:8000/v1" }, down, undefined, OWNER),
    ).rejects.toThrow("Check that it's running");
    await expect(
      probeOpenAiCompatibleModels(
        { baseUrl: "http://127.0.0.1:11234/v1" },
        redirected,
        undefined,
        OWNER,
      ),
    ).rejects.toThrow("fetch failed");
  });

  it("clarifies probe timeouts with hand-fill hint", async () => {
    const fetchImpl: typeof fetch = async (_input, init) =>
      new Promise((_, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
      });
    await expect(
      probeOpenAiCompatibleModels(
        { baseUrl: "http://127.0.0.1:8000/v1" },
        fetchImpl,
        undefined,
        OWNER,
      ),
    ).rejects.toThrow(/timed out.*explicit model id/is);
  });

  it("preserves caller AbortError without rewriting as timeout", async () => {
    const caller = new AbortController();
    caller.abort();
    const fetchImpl: typeof fetch = async () => {
      throw new DOMException("The operation was aborted.", "AbortError");
    };
    await expect(
      probeOpenAiCompatibleModels(
        { baseUrl: "http://127.0.0.1:8000/v1" },
        fetchImpl,
        caller.signal,
        OWNER,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("lists openai-compatible in the catalog even without RAKAZO_LOCAL_MODELS", () => {
    delete process.env.RAKAZO_LOCAL_MODELS;
    const entries = listPiCatalog().filter(
      (entry) => entry.provider === OPENAI_COMPATIBLE_PROVIDER_ID,
    );
    expect(entries.length).toBeGreaterThan(0);
  });
});

describe("custom connection headers", () => {
  const input = {
    provider: OPENAI_COMPATIBLE_PROVIDER_ID,
    baseUrl: "http://127.0.0.1:8000/v1",
    modelId: "custom",
  };
  it("sends headers to model discovery", async () => {
    const fetchImpl = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ data: [{ id: "custom" }] })),
    );
    await probeOpenAiCompatibleModels(
      { ...input, headers: { "x-session": "fake-session-secret" } },
      fetchImpl,
      undefined,
      OWNER,
    );
    expect(new Headers(fetchImpl.mock.calls[0]?.[1]?.headers).get("x-session")).toBe(
      "fake-session-secret",
    );
  });
});

describe("custom header transport", () => {
  it.each(["stream", "streamSimple"] as const)("sends headers through %s", async (method) => {
    const models = registerOpenAiCompatibleRuntime(createModels(), {
      modelId: "fixture-model",
      baseUrl: "http://127.0.0.1:8000/v1",
      allowPrivate: true,
      headers: { "x-session": "fake-session-secret" },
    });
    const provider = models.getProvider(OPENAI_COMPATIBLE_PROVIDER_ID)!;
    const model = models.getModel(OPENAI_COMPATIBLE_PROVIDER_ID, "fixture-model")!;
    let received: string | null = null;
    await provider[method](model, normalizeContext({ messages: [] }), {
      apiKey: "fake-api-key",
      fetch: async (_input, init) => {
        received = new Headers(init?.headers).get("x-session");
        expect(init?.redirect).toBe("error");
        return new Response("data: [DONE]\n\n", {
          headers: { "content-type": "text/event-stream" },
        });
      },
    }).result();
    expect(received).toBe("fake-session-secret");
  });
  it("sanitizes malformed stored headers", () => {
    expect(() =>
      parseModelSecret(
        JSON.stringify({
          kind: "openai_compatible",
          baseUrl: "http://127.0.0.1/v1",
          headers: { "x-session": { secret: "must-not-leak" } },
        }),
      ),
    ).toThrow(/^Invalid custom headers$/);
  });
  it("does not weaken the private endpoint gate when headers are set", async () => {
    const transport = vi.fn();
    const fetch = createOpenAiCompatibleFetch(transport, undefined, {
      headers: { "x-session": "fake-session-secret" },
    });
    await expect(fetch("http://127.0.0.1:8000/v1/models")).rejects.toThrow(
      PRIVATE_MODEL_ENDPOINT_MESSAGE,
    );
    expect(transport).not.toHaveBeenCalled();
  });
});

describe("built-in public compatible host", () => {
  it("allows only the exact HTTPS host on the default port without the public gate", () => {
    expect(
      assertAllowedOpenAiCompatibleUrl("https://ollama.com/v1", { allowPublic: false }).href,
    ).toBe("https://ollama.com/v1");
    for (const url of [
      "http://ollama.com",
      "https://ollama.com:8443",
      "https://evil.ollama.com",
      "https://ollama.com.evil.test",
      "https://user@ollama.com",
      "https://ollama.com.",
      "https://other.test",
    ]) {
      expect(() => assertAllowedOpenAiCompatibleUrl(url, { allowPublic: false })).toThrow();
    }
    expect(
      assertAllowedOpenAiCompatibleUrl("https://other.test", { allowPublic: true }).hostname,
    ).toBe("other.test");
  });
  it("still rejects a private DNS answer for the built-in host", async () => {
    const safeFetch = createOpenAiCompatibleFetch(
      undefined,
      async () => [{ address: "10.0.0.8", family: 4 }],
      { allowPublic: false },
    );
    await expect(safeFetch("https://ollama.com/v1/models")).rejects.toMatchObject({
      cause: { message: "Public model server hostname resolved to a private address" },
    });
  });
  it.each([401, 403])(
    "rejects an invalid Ollama key (%s) before listing public models",
    async (status) => {
      const transport = vi.fn(async () => new Response(null, { status }));
      await expect(
        probeOpenAiCompatibleModels(
          { baseUrl: "https://ollama.com/v1", apiKey: "fake-key" },
          transport,
        ),
      ).rejects.toThrow("API key was rejected by the provider.");
      expect(transport).toHaveBeenCalledOnce();
    },
  );
  it("verifies a key with the guarded balance endpoint and then discovers models", async () => {
    const transport = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.redirect).toBe("error");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fake-key");
      return String(input).endsWith("/api/balance")
        ? new Response(null)
        : Response.json({ data: [{ id: "example-model" }] });
    });
    await expect(
      probeOpenAiCompatibleModels(
        { baseUrl: "https://ollama.com/v1", apiKey: "fake-key" },
        transport,
      ),
    ).resolves.toEqual(["example-model"]);
    expect(String(transport.mock.calls[0]?.[0])).toBe("https://ollama.com/api/balance");
    expect(transport).toHaveBeenCalledTimes(2);
  });
  it("does not verify unrelated compatible servers and rejects missing keys", async () => {
    const transport = vi.fn();
    await verifyOpenAiCompatibleApiKey({ baseUrl: "https://other.test/v1" }, transport);
    await expect(
      verifyOpenAiCompatibleApiKey({ baseUrl: "https://ollama.com/v1" }, transport),
    ).rejects.toThrow("API key was rejected");
    expect(transport).not.toHaveBeenCalled();
  });
});

describe("per-connection wire protocol", () => {
  const input = {
    provider: OPENAI_COMPATIBLE_PROVIDER_ID,
    baseUrl: "http://127.0.0.1:8000/v1",
    modelId: "fixture-model",
  };
  it("round-trips Responses, preserves it on same-endpoint edits, and resets at a new endpoint", () => {
    const saved = connectAsOwner({ ...input, apiProtocol: "responses" });
    expect(parseModelSecret(saved)).toMatchObject({ apiProtocol: "responses" });
    expect(parseModelSecret(connectAsOwner(input, saved))).toMatchObject({
      apiProtocol: "responses",
    });
    expect(
      parseModelSecret(connectAsOwner({ ...input, baseUrl: "http://127.0.0.1:8001/v1" }, saved)),
    ).not.toHaveProperty("apiProtocol");
    expect(
      parseModelSecret(connectAsOwner({ ...input, apiProtocol: "chat-completions" }, saved)),
    ).toMatchObject({ apiProtocol: "chat-completions" });
  });
  it("rejects unsupported protocols at connection input and stored-secret boundaries", () => {
    expect(ModelConnectInputSchema.safeParse({ ...input, apiProtocol: "unknown" }).success).toBe(
      false,
    );
    expect(() =>
      parseModelSecret(
        JSON.stringify({
          kind: "openai_compatible",
          baseUrl: input.baseUrl,
          apiProtocol: "unknown",
        }),
      ),
    ).toThrow();
  });
  it.each(["stream", "streamSimple"] as const)(
    "sends Responses through %s with the existing fetch guard",
    async (method) => {
      const models = registerOpenAiCompatibleRuntime(createModels(), {
        ...input,
        apiProtocol: "responses",
        allowPrivate: true,
        headers: { "x-session": "fake-session" },
      });
      const provider = models.getProvider(OPENAI_COMPATIBLE_PROVIDER_ID)!;
      const model = models.getModel(OPENAI_COMPATIBLE_PROVIDER_ID, input.modelId)!;
      expect(model.api).toBe("openai-responses");
      let requestUrl = "";
      let body: Record<string, unknown> = {};
      const result = await provider[method](model, normalizeContext({ messages: [] }), {
        apiKey: "fake-api-key",
        fetch: async (url, init) => {
          requestUrl = String(url);
          body = JSON.parse(String(init?.body));
          expect(init?.redirect).toBe("error");
          expect(new Headers(init?.headers).get("x-session")).toBe("fake-session");
          const events = [
            {
              type: "response.created",
              response: { id: "resp_fixture", model: "fixture-model", status: "in_progress" },
            },
            {
              type: "response.completed",
              response: {
                id: "resp_fixture",
                status: "completed",
                output: [],
                usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 },
              },
            },
          ];
          return new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""), {
            headers: { "content-type": "text/event-stream" },
          });
        },
      }).result();
      expect(requestUrl).toBe(`${input.baseUrl}/responses`);
      expect(body).toHaveProperty("input");
      expect(body).not.toHaveProperty("messages");
      expect(result.stopReason, JSON.stringify(result)).not.toBe("error");
    },
  );
  it("still blocks private Responses endpoints without operator opt-in", async () => {
    const transport = vi.fn();
    const models = registerOpenAiCompatibleRuntime(createModels(), {
      ...input,
      apiProtocol: "responses",
    });
    const result = await models
      .getProvider(OPENAI_COMPATIBLE_PROVIDER_ID)!
      .streamSimple(
        models.getModel(OPENAI_COMPATIBLE_PROVIDER_ID, input.modelId)!,
        normalizeContext({ messages: [] }),
        { apiKey: "fake-api-key", fetch: transport },
      )
      .result();
    expect(result.stopReason).toBe("error");
    expect(transport).not.toHaveBeenCalled();
  });

  it("stores and round-trips Anthropic Messages as a connection protocol", () => {
    const saved = connectAsOwner({ ...input, apiProtocol: "anthropic-messages" });
    expect(parseModelSecret(saved)).toMatchObject({ apiProtocol: "anthropic-messages" });
    expect(parseModelSecret(connectAsOwner(input, saved))).toMatchObject({
      apiProtocol: "anthropic-messages",
    });
    expect(ModelConnectInputSchema.safeParse(input).success).toBe(true);
  });

  it("still blocks private Anthropic Messages endpoints without operator opt-in", async () => {
    const transport = vi.fn();
    const models = registerOpenAiCompatibleRuntime(createModels(), {
      ...input,
      apiProtocol: "anthropic-messages",
    });
    const result = await models
      .getProvider(OPENAI_COMPATIBLE_PROVIDER_ID)!
      .streamSimple(
        models.getModel(OPENAI_COMPATIBLE_PROVIDER_ID, input.modelId)!,
        normalizeContext({ messages: [] }),
        { apiKey: "fake-api-key", fetch: transport },
      )
      .result();
    expect(result.stopReason).toBe("error");
    expect(transport).not.toHaveBeenCalled();
  });
});

/** Minimal Anthropic Messages SSE, as `event:`/`data:` pairs. */
const anthropicSse = (events: ReadonlyArray<readonly [string, unknown]>) =>
  events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");

const ANTHROPIC_TEXT_EVENTS: ReadonlyArray<readonly [string, unknown]> = [
  [
    "message_start",
    {
      type: "message_start",
      message: { id: "msg_fixture", model: "fixture-model", usage: { input_tokens: 3 } },
    },
  ],
  [
    "content_block_start",
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  ],
  [
    "content_block_delta",
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Bonjour" } },
  ],
  ["content_block_stop", { type: "content_block_stop", index: 0 }],
  [
    "message_delta",
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } },
  ],
  ["message_stop", { type: "message_stop" }],
];

const anthropicTextResponse = () =>
  new Response(anthropicSse(ANTHROPIC_TEXT_EVENTS), {
    headers: { "content-type": "text/event-stream" },
  });

describe("anthropic-messages wire protocol", () => {
  const input = {
    provider: OPENAI_COMPATIBLE_PROVIDER_ID,
    baseUrl: "http://127.0.0.1:8000/v1",
    modelId: "fixture-model",
  };

  function registerAnthropic() {
    const models = registerOpenAiCompatibleRuntime(createModels(), {
      ...input,
      apiProtocol: "anthropic-messages",
      allowPrivate: true,
    });
    const provider = models.getProvider(OPENAI_COMPATIBLE_PROVIDER_ID)!;
    const model = models.getModel(OPENAI_COMPATIBLE_PROVIDER_ID, input.modelId)!;
    return { provider, model };
  }

  it("registers the model on the Anthropic API at the endpoint root", () => {
    const { model } = registerAnthropic();
    expect(model.api).toBe("anthropic-messages");
    // The endpoint the SDK appends /v1/messages to must not carry /v1 itself.
    expect(model.baseUrl).toBe("http://127.0.0.1:8000");
    expect(model.thinkingLevelMap).toBeUndefined();
  });

  it.each(["stream", "streamSimple"] as const)(
    "streams text from /v1/messages with Anthropic auth headers through %s",
    async (method) => {
      const { provider, model } = registerAnthropic();
      let requestUrl = "";
      let headers: Headers | undefined;
      let body: Record<string, unknown> = {};
      const result = await provider[method](
        model,
        normalizeContext({
          messages: [{ role: "user" as const, content: "Salut", timestamp: 1 }],
        }),
        {
          apiKey: "fake-api-key",
          fetch: async (url, init) => {
            requestUrl = String(url);
            headers = new Headers(init?.headers);
            body = JSON.parse(String(init?.body));
            expect(init?.redirect).toBe("error");
            return anthropicTextResponse();
          },
        },
      ).result();
      expect(requestUrl).toBe("http://127.0.0.1:8000/v1/messages?beta=true");
      expect(headers?.get("x-api-key")).toBe("fake-api-key");
      expect(headers?.get("anthropic-version")).toBe("2023-06-01");
      expect(body).toMatchObject({ model: input.modelId, stream: true });
      expect(body.messages).toEqual([
        expect.objectContaining({
          role: "user",
          content: [expect.objectContaining({ type: "text", text: "Salut" })],
        }),
      ]);
      expect(result.stopReason, JSON.stringify(result)).toBe("stop");
      expect(JSON.stringify(result.content)).toContain("Bonjour");
    },
  );

  it("carries custom headers on the guarded request", async () => {
    const models = registerOpenAiCompatibleRuntime(createModels(), {
      ...input,
      apiProtocol: "anthropic-messages",
      allowPrivate: true,
      headers: { "x-session": "fake-session" },
    });
    const provider = models.getProvider(OPENAI_COMPATIBLE_PROVIDER_ID)!;
    const model = models.getModel(OPENAI_COMPATIBLE_PROVIDER_ID, input.modelId)!;
    let received: string | null = null;
    await provider
      .streamSimple(model, normalizeContext({ messages: [] }), {
        apiKey: "fake-api-key",
        fetch: async (_url, init) => {
          received = new Headers(init?.headers).get("x-session");
          return anthropicTextResponse();
        },
      })
      .result();
    expect(received).toBe("fake-session");
  });

  it("sends a thinking budget when reasoning is on", async () => {
    const models = registerOpenAiCompatibleRuntime(createModels(), {
      ...input,
      apiProtocol: "anthropic-messages",
      allowPrivate: true,
      reasoning: true,
    });
    const provider = models.getProvider(OPENAI_COMPATIBLE_PROVIDER_ID)!;
    const model = models.getModel(OPENAI_COMPATIBLE_PROVIDER_ID, input.modelId)!;
    let body: Record<string, any> = {};
    await provider
      .streamSimple(model, normalizeContext({ messages: [] }), {
        apiKey: "fake-api-key",
        reasoning: "medium",
        fetch: async (_url, init) => {
          body = JSON.parse(String(init?.body));
          return anthropicTextResponse();
        },
      })
      .result();
    expect(body.thinking).toMatchObject({ type: "enabled" });
    expect(typeof body.thinking.budget_tokens).toBe("number");
  });

  it("uses adaptive thinking with an effort for models the built-in catalog marks adaptive", async () => {
    const modelId = "claude-opus-5-5";
    const models = registerOpenAiCompatibleRuntime(createModels(), {
      ...input,
      modelId,
      apiProtocol: "anthropic-messages",
      allowPrivate: true,
      reasoning: true,
    });
    const provider = models.getProvider(OPENAI_COMPATIBLE_PROVIDER_ID)!;
    const model = models.getModel(OPENAI_COMPATIBLE_PROVIDER_ID, modelId)!;
    expect(model.compat).toEqual({ forceAdaptiveThinking: true });
    let body: Record<string, any> = {};
    await provider
      .streamSimple(model, normalizeContext({ messages: [] }), {
        apiKey: "fake-api-key",
        reasoning: "high",
        fetch: async (_url, init) => {
          body = JSON.parse(String(init?.body));
          return anthropicTextResponse();
        },
      })
      .result();
    expect(body.thinking).toMatchObject({ type: "adaptive" });
    expect(body.output_config).toMatchObject({ effort: "high" });
  });

  it("probes /v1/models with Anthropic auth headers", async () => {
    let seenHeaders: Headers | undefined;
    let seenUrl = "";
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      seenUrl = String(input);
      seenHeaders = new Headers(init?.headers);
      return Response.json({ data: [{ id: "claude-fixture" }] });
    });
    await expect(
      probeOpenAiCompatibleModels(
        { baseUrl: input.baseUrl, apiKey: "fake-api-key", apiProtocol: "anthropic-messages" },
        fetchImpl,
        undefined,
        OWNER,
      ),
    ).resolves.toEqual(["claude-fixture"]);
    expect(seenUrl).toBe("http://127.0.0.1:8000/v1/models");
    expect(seenHeaders?.get("x-api-key")).toBe("fake-api-key");
    expect(seenHeaders?.get("anthropic-version")).toBe("2023-06-01");
    expect(seenHeaders?.get("authorization")).toBeNull();
  });

  it("follows Anthropic model pages with the same headers and signal", async () => {
    const first = Array.from({ length: 20 }, (_, index) => ({ id: `model-${index}` }));
    const requests: RequestInit[] = [];
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      requests.push(init ?? {});
      return Response.json(
        new URL(String(url)).searchParams.has("after_id")
          ? { data: [{ id: "model-20" }], has_more: false }
          : { data: first, has_more: true, last_id: "model-19" },
      );
    });
    const result = await probeOpenAiCompatibleModels(
      { baseUrl: input.baseUrl, apiKey: "fake-key", apiProtocol: "anthropic-messages" },
      fetchImpl,
      undefined,
      OWNER,
    );
    expect(result).toEqual([...first.map(({ id }) => id), "model-20"]);
    expect(requests[1]?.signal).toBe(requests[0]?.signal);
    for (const request of requests) {
      expect(new Headers(request.headers).get("x-api-key")).toBe("fake-key");
      expect(new Headers(request.headers).get("anthropic-version")).toBe("2023-06-01");
      expect(request.redirect).toBe("error");
    }
    expect(String(fetchImpl.mock.calls[1]?.[0])).toBe(`${input.baseUrl}/models?after_id=model-19`);
  });

  it.each([undefined, "", "   ", 42])(
    "rejects missing or invalid pagination cursor %s",
    async (last_id) => {
      const fetchImpl = vi.fn(async () =>
        Response.json({
          data: [{ id: "model" }],
          has_more: true,
          last_id,
        }),
      );
      await expect(
        probeOpenAiCompatibleModels(
          { baseUrl: input.baseUrl, apiProtocol: "anthropic-messages" },
          fetchImpl,
          undefined,
          OWNER,
        ),
      ).rejects.toThrow("pagination");
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    },
  );

  it("rejects repeated cursors rather than returning an incomplete list", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({
        data: [{ id: "model" }],
        has_more: true,
        last_id: "model",
      }),
    );
    await expect(
      probeOpenAiCompatibleModels(
        { baseUrl: input.baseUrl, apiProtocol: "anthropic-messages" },
        fetchImpl,
        undefined,
        OWNER,
      ),
    ).rejects.toThrow("pagination");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("enforces the model count limit across pages", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({
        data: Array.from({ length: 2001 }, (_, index) => ({ id: `model-${index}` })),
        has_more: true,
        last_id: "next",
      }),
    );
    await expect(
      probeOpenAiCompatibleModels(
        { baseUrl: input.baseUrl, apiProtocol: "anthropic-messages" },
        fetchImpl,
        undefined,
        OWNER,
      ),
    ).rejects.toThrow("too many");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("rejects a later page failure and releases its response body", async () => {
    const cancel = vi.fn();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          data: [{ id: "first" }],
          has_more: true,
          last_id: "first",
        }),
      )
      .mockResolvedValueOnce(new Response(new ReadableStream({ cancel }), { status: 429 }));
    await expect(
      probeOpenAiCompatibleModels(
        { baseUrl: input.baseUrl, apiProtocol: "anthropic-messages" },
        fetchImpl,
        undefined,
        OWNER,
      ),
    ).rejects.toThrow("returned 429");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("preserves caller cancellation on a later page", async () => {
    const caller = new AbortController();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          data: [{ id: "first" }],
          has_more: true,
          last_id: "first",
        }),
      )
      .mockImplementationOnce(async (_url: RequestInfo | URL, init?: RequestInit) => {
        caller.abort();
        init?.signal?.throwIfAborted();
      });
    await expect(
      probeOpenAiCompatibleModels(
        { baseUrl: input.baseUrl, apiProtocol: "anthropic-messages" },
        fetchImpl,
        caller.signal,
        OWNER,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("does not interpret Anthropic pagination for other protocols", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({
        data: [{ id: "model" }],
        has_more: true,
        last_id: "model",
      }),
    );
    await expect(
      probeOpenAiCompatibleModels({ baseUrl: input.baseUrl }, fetchImpl, undefined, OWNER),
    ).resolves.toEqual(["model"]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("probes keyless Anthropic-compatible servers with the version header", async () => {
    // A keyless endpoint can still require the version header the SDK always sends.
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (new Headers(init?.headers).get("anthropic-version") !== "2023-06-01") {
        return new Response(JSON.stringify({ error: "missing anthropic-version" }), {
          status: 400,
        });
      }
      return Response.json({ data: [{ id: "claude-fixture" }] });
    });
    await expect(
      probeOpenAiCompatibleModels(
        { baseUrl: input.baseUrl, apiProtocol: "anthropic-messages" },
        fetchImpl,
        undefined,
        OWNER,
      ),
    ).resolves.toEqual(["claude-fixture"]);
    expect(new Headers(fetchImpl.mock.calls[0]?.[1]?.headers).get("x-api-key")).toBeNull();
  });
});

describe("outbound proxy", () => {
  async function withConnectProxy(
    run: (proxy: { targetPort: number; connects: string[]; hosts: string[] }) => Promise<void>,
  ): Promise<void> {
    const connects: string[] = [];
    const hosts: string[] = [];
    const target = createServer((request, response) => {
      hosts.push(request.headers.host ?? "");
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ data: [{ id: "proxied-model" }] }));
    });
    const proxy = createServer((_request, response) => response.writeHead(405).end());
    proxy.on("connect", (request, client) => {
      connects.push(request.url ?? "");
      const upstream = new Socket();
      upstream.connect((target.address() as AddressInfo).port, "127.0.0.1", () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        upstream.pipe(client).pipe(upstream);
      });
    });
    await Promise.all(
      [target, proxy].map(
        (server) => new Promise<void>((done) => server.listen(0, "127.0.0.1", done)),
      ),
    );
    const proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
    vi.stubEnv("HTTP_PROXY", proxyUrl);
    vi.stubEnv("http_proxy", proxyUrl);
    vi.stubEnv("NO_PROXY", "");
    vi.stubEnv("no_proxy", "");
    try {
      await run({ targetPort: (target.address() as AddressInfo).port, connects, hosts });
    } finally {
      vi.unstubAllEnvs();
      proxy.closeAllConnections();
      target.closeAllConnections();
      await Promise.all([target, proxy].map((server) => new Promise((done) => server.close(done))));
    }
  }

  it("tunnels a public endpoint to the checked address and keeps the original host", async () => {
    await withConnectProxy(async ({ connects, hosts }) => {
      const safeFetch = createOpenAiCompatibleFetch(
        undefined,
        async () => [{ address: "203.0.113.10", family: 4 }],
        { allowPublic: true },
      );
      const response = await safeFetch("http://models.example.com/v1/models");

      await expect(response.json()).resolves.toEqual({ data: [{ id: "proxied-model" }] });
      expect(connects).toEqual(["203.0.113.10:80"]);
      expect(hosts).toEqual(["models.example.com"]);
    });
  });

  it("refuses a public endpoint that resolves to a private address before the proxy is asked", async () => {
    await withConnectProxy(async ({ connects }) => {
      const safeFetch = createOpenAiCompatibleFetch(
        undefined,
        async () => [{ address: "10.0.0.5", family: 4 }],
        { allowPublic: true },
      );

      await expect(safeFetch("http://models.example.com/v1/models")).rejects.toThrow();
      expect(connects).toEqual([]);
    });
  });

  it("keeps a local model server on the direct route", async () => {
    await withConnectProxy(async ({ targetPort, connects, hosts }) => {
      const safeFetch = createOpenAiCompatibleFetch(undefined, undefined, OWNER);
      const response = await safeFetch(`http://127.0.0.1:${targetPort}/v1/models`);

      await expect(response.json()).resolves.toEqual({ data: [{ id: "proxied-model" }] });
      expect(connects).toEqual([]);
      expect(hosts).toEqual([`127.0.0.1:${targetPort}`]);
    });
  });
});
