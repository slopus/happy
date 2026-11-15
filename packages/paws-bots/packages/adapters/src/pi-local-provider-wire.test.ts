import { once } from "node:events";
import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";

type WireRequest = {
  max_tokens?: number;
  max_completion_tokens?: number;
  [key: string]: unknown;
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

/** The Authorization header of the last request the fixture server received. */
let lastAuthorization: string | undefined;

/** Runs one real turn against a fake OpenAI-compatible server and returns the request it received. */
async function wireRequest(
  env: Record<string, string>,
  model: Record<string, unknown> = {},
  provider = "local",
): Promise<WireRequest> {
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
  // The model catalog reads the environment once, so each scenario loads a fresh one.
  vi.resetModules();
  const { PiAgentRuntime } = await import("./pi-runtime.js");
  const requests: WireRequest[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      lastAuthorization = request.headers.authorization;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        `data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: { role: "assistant", content: "Ready" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
      );
    })().catch(() => response.destroy());
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture endpoint unavailable");
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  vi.stubEnv("RAKAZO_LOCAL_MODELS_URL", baseUrl);
  try {
    const events = [];
    for await (const event of new PiAgentRuntime().run(
      {
        botId: "bot-fixture",
        threadId: "thread-fixture",
        runId: "run-local-wire",
        prompt: "Continue",
        instructions: "Answer briefly.",
        history: [],
        tools: [],
        model: {
          provider,
          id: "example-model",
          ...(provider === "local" ? {} : { baseUrl, allowPrivateEndpoint: true }),
          ...model,
        },
      },
      { signal: AbortSignal.timeout(15_000) },
    )) {
      events.push(event);
    }
    expect(events).toContainEqual(expect.objectContaining({ type: "done", text: "Ready" }));
    expect(requests).toHaveLength(1);
    return requests[0]!;
  } finally {
    server.close();
    server.closeAllConnections();
    await once(server, "close");
  }
}

const localServer = {
  RAKAZO_LOCAL_MODELS: "example-model",
  RAKAZO_LOCAL_CONTEXT_WINDOW: "120000",
};
const outputLimit = (request: WireRequest) => request.max_completion_tokens ?? request.max_tokens;

describe("local model output limit on the wire", () => {
  it("sends the operator's RAKAZO_LOCAL_MAX_TOKENS when the connection sets none", async () => {
    const request = await wireRequest({ ...localServer, RAKAZO_LOCAL_MAX_TOKENS: "20000" });
    expect(outputLimit(request)).toBe(20_000);
  });

  it("keeps 4096 when RAKAZO_LOCAL_MAX_TOKENS is unset", async () => {
    vi.stubEnv("RAKAZO_LOCAL_MAX_TOKENS", "");
    expect(outputLimit(await wireRequest(localServer))).toBe(4096);
  });

  it("lets the connection's own max-tokens field win", async () => {
    const request = await wireRequest(
      { ...localServer, RAKAZO_LOCAL_MAX_TOKENS: "20000" },
      { maxTokens: 2048 },
    );
    expect(outputLimit(request)).toBe(2048);
  });

  it("still reserves three quarters of the context window for input", async () => {
    const request = await wireRequest({
      ...localServer,
      RAKAZO_LOCAL_CONTEXT_WINDOW: "32000",
      RAKAZO_LOCAL_MAX_TOKENS: "20000",
    });
    expect(outputLimit(request)).toBe(8000);
  });

  it("leaves other providers on the default", async () => {
    const request = await wireRequest(
      { ...localServer, RAKAZO_LOCAL_MAX_TOKENS: "20000" },
      {},
      "openai-compatible",
    );
    expect(outputLimit(request)).toBe(4096);
  });
});

describe("local model reasoning on the wire", () => {
  it("sends reasoning_effort only for a model in RAKAZO_LOCAL_REASONING_MODELS", async () => {
    const plain = await wireRequest({
      ...localServer,
      RAKAZO_LOCAL_REASONING_MODELS: "other-model",
    });
    expect(plain).not.toHaveProperty("reasoning_effort");

    const listed = await wireRequest({
      ...localServer,
      RAKAZO_LOCAL_REASONING_MODELS: "example-model",
    });
    expect(listed.reasoning_effort).toBe("medium");
  });
});

describe("local model server key on the wire", () => {
  it("sends RAKAZO_LOCAL_MODELS_API_KEY as the bearer token", async () => {
    await wireRequest({ ...localServer, RAKAZO_LOCAL_MODELS_API_KEY: " local-server-test-key " });
    expect(lastAuthorization).toBe("Bearer local-server-test-key");
  });

  it("keeps the placeholder key when RAKAZO_LOCAL_MODELS_API_KEY is unset", async () => {
    await wireRequest({ ...localServer, RAKAZO_LOCAL_MODELS_API_KEY: "" });
    expect(lastAuthorization).toBe("Bearer local");
  });

  it("never sends it to a user's own OpenAI-compatible connection", async () => {
    await wireRequest(
      { ...localServer, RAKAZO_LOCAL_MODELS_API_KEY: "local-server-test-key" },
      { apiKey: "connection-test-key" },
      "openai-compatible",
    );
    expect(lastAuthorization).toBe("Bearer connection-test-key");
  });
});
