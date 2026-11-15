import { once } from "node:events";
import type { ServerResponse } from "node:http";
import { createServer } from "node:http";
import { connect } from "node:net";
import type * as Undici from "undici";
import { afterEach, describe, expect, it, vi } from "vitest";

const agentOptions = vi.hoisted(() => [] as Record<string, unknown>[]);

vi.mock("undici", async (importOriginal) => {
  const undici = await importOriginal<typeof Undici>();
  class RecordedAgent extends undici.Agent {
    constructor(options?: ConstructorParameters<typeof undici.Agent>[0]) {
      super(options);
      agentOptions.push({ ...options });
    }
  }
  return { ...undici, Agent: RecordedAgent };
});

afterEach(() => {
  agentOptions.length = 0;
  vi.unstubAllEnvs();
  vi.resetModules();
});

const finished = `data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: { role: "assistant", content: "Ready" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`;

/** Runs one real turn against a fake OpenAI-compatible server that answers with `respond`. */
async function runTurn(
  provider: "local" | "openai-compatible",
  respond: (response: ServerResponse) => void,
) {
  vi.stubEnv("RAKAZO_LOCAL_MODELS", "example-model");
  // One attempt: a retry would only repeat the same scripted response.
  vi.stubEnv("MODEL_STREAM_MAX_RETRIES", "0");
  vi.stubEnv("MODEL_STREAM_TIMEOUT_MS", "1000");
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => respond(response));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture endpoint unavailable");
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  vi.stubEnv("RAKAZO_LOCAL_MODELS_URL", baseUrl);
  // The model catalog reads the environment once, so each scenario loads a fresh one.
  vi.resetModules();
  const { PiAgentRuntime } = await import("./pi-runtime.js");
  try {
    const events = [];
    for await (const event of new PiAgentRuntime().run(
      {
        botId: "bot-fixture",
        threadId: "thread-fixture",
        runId: "run-transport",
        prompt: "Continue",
        instructions: "Answer briefly.",
        history: [],
        tools: [],
        model: {
          provider,
          id: "example-model",
          ...(provider === "local" ? {} : { baseUrl, allowPrivateEndpoint: true }),
        },
      },
      { signal: AbortSignal.timeout(15_000) },
    )) {
      events.push(event);
    }
    return events;
  } finally {
    server.closeAllConnections();
    server.close();
    await once(server, "close");
  }
}

describe.each(["local", "openai-compatible"] as const)("%s model stream transport", (provider) => {
  it("leaves header and body waits to the runtime instead of undici's 5-minute limits", async () => {
    const events = await runTurn(provider, (response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(finished);
    });
    expect(events).toContainEqual(expect.objectContaining({ type: "done", text: "Ready" }));
    expect(agentOptions).toContainEqual(
      expect.objectContaining({ headersTimeout: 0, bodyTimeout: 0 }),
    );
  });

  it("still bounds the wait for response headers", async () => {
    await expect(runTurn(provider, () => {})).rejects.toThrow(/timeout|timed out/i);
  });

  it("still aborts a response body that stays silent", async () => {
    vi.stubEnv("MODEL_STREAM_IDLE_TIMEOUT_MS", "1000");
    await expect(
      runTurn(provider, (response) => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.flushHeaders();
      }),
    ).rejects.toThrow("Model stream idle timeout");
  });

  it("names why a stream that started was cut off", async () => {
    await expect(
      runTurn(provider, (response) => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(": still thinking\n\n", () => response.socket?.destroy());
      }),
    ).rejects.toThrow("terminated (other side closed)");
  });

  it("keeps thoughts a model writes into its answer text out of the reply", async () => {
    const chunk = (content: string, finish_reason: string | null = null) =>
      `data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason }] })}\n\n`;
    const events = await runTurn(provider, (response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(chunk("<think>\nThe user wants a short "));
      response.write(chunk("confirmation.\n</th"));
      response.write(chunk("ink>\n\nRea"));
      response.end(`${chunk("dy", "stop")}data: [DONE]\n\n`);
    });
    expect(events).toContainEqual(expect.objectContaining({ type: "done", text: "Ready" }));
    const streamed = events
      .flatMap((event) => (event.type === "text" ? [event.text] : []))
      .join("");
    expect(streamed).toBe("Ready");
    expect(events).toContainEqual({ type: "thinking", active: true });
  });
});

describe("local model stream through a proxy", () => {
  it("keeps the proxy Node's fetch was told to use", async () => {
    const proxied: string[] = [];
    // Tunnels CONNECT to the target and answers plain proxied requests itself.
    const proxy = createServer((request, response) => {
      proxied.push(request.url ?? "");
      request.resume();
      request.on("end", () => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(finished);
      });
    });
    proxy.on("connect", (request, client, head) => {
      proxied.push(request.url ?? "");
      const [host, port] = (request.url ?? "").split(":");
      const upstream = connect(Number(port), host, () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        upstream.write(head);
        upstream.pipe(client);
        client.pipe(upstream);
      });
      upstream.on("error", () => client.destroy());
      client.on("error", () => upstream.destroy());
    });
    proxy.listen(0, "127.0.0.1");
    await once(proxy, "listening");
    const address = proxy.address();
    if (!address || typeof address === "string") throw new Error("Fixture proxy unavailable");
    vi.stubEnv("NODE_USE_ENV_PROXY", "1");
    vi.stubEnv("HTTP_PROXY", `http://127.0.0.1:${address.port}`);
    vi.stubEnv("NO_PROXY", "");
    try {
      const events = await runTurn("local", (response) => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(finished);
      });
      expect(events).toContainEqual(expect.objectContaining({ type: "done", text: "Ready" }));
      expect(proxied).not.toHaveLength(0);
    } finally {
      proxy.closeAllConnections();
      proxy.close();
      await once(proxy, "close");
    }
  });
});
