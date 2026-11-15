import { once } from "node:events";
import { createServer } from "node:http";
import type { ConnectorTool } from "@rakazo/adapter-kit";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import { PiAgentRuntime } from "./pi-runtime.js";
import { resolveRuntimeModel } from "./pi-runtime-models.js";
import { userTurnInstructions } from "./run-instructions.js";

describe("Pi outgoing provider prefixes", () => {
  it.each(["png", "gif"] as const)(
    "sends a large valid %s image through a 128k context without treating base64 as text",
    async (format) => {
      const pixels = Buffer.alloc(1024 * 1024);
      let seed = 1;
      for (let index = 0; index < pixels.length; index++) {
        seed ^= seed << 13;
        seed ^= seed >>> 17;
        seed ^= seed << 5;
        pixels[index] = seed & 255;
      }
      const image = await sharp(pixels, { raw: { width: 1024, height: 1024, channels: 1 } })
        [format]()
        .toBuffer();
      const mimeType = `image/${format}` as const;
      expect(image.length).toBeGreaterThan(1_000_000);
      let requestCount = 0;
      let imageSent = false;
      const server = createServer((request, response) => {
        // Local tools can probe any listening loopback port; only model calls are counted.
        if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
          response.writeHead(404).end();
          return;
        }
        void (async () => {
          const chunks: Buffer[] = [];
          for await (const chunk of request) chunks.push(Buffer.from(chunk));
          const body = Buffer.concat(chunks).toString("utf8");
          requestCount++;
          imageSent = body.includes(`data:${mimeType};base64,${image.toString("base64")}`);
          response.writeHead(200, { "content-type": "text/event-stream" });
          response.end(
            `data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: { role: "assistant", content: "Visible" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
          );
        })().catch(() => response.destroy());
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Fixture endpoint unavailable");
      try {
        const beforeCall = vi.fn(async (call: { inputTokensEstimate: number }) => {
          expect(call.inputTokensEstimate).toBeGreaterThan(1399);
          expect(call.inputTokensEstimate).toBeLessThan(128_000 - 4096);
          return "image-reservation";
        });
        const events = [];
        for await (const event of new PiAgentRuntime({
          modelCallObserver: { beforeCall, afterCall: vi.fn() },
        }).run(
          {
            botId: "bot-fixture",
            threadId: "thread-fixture",
            runId: "run-large-image",
            prompt: "Inspect this image.",
            instructions: "Answer briefly.",
            history: [],
            tools: [],
            contextStrategy: "retrieval",
            currentTurnImages: [{ name: `synthetic.${format}`, mimeType, data: image }],
            model: {
              provider: "openai-compatible",
              id: "fixture",
              baseUrl: `http://127.0.0.1:${address.port}/v1`,
              allowPrivateEndpoint: true,
              acceptsImages: true,
              contextWindow: 128_000,
              maxTokens: 4096,
            },
          },
          { signal: AbortSignal.timeout(15_000) },
        )) {
          events.push(event);
        }
        expect(events).toContainEqual(expect.objectContaining({ type: "done", text: "Visible" }));
        expect(requestCount).toBe(1);
        expect(imageSent).toBe(true);
        expect(beforeCall).toHaveBeenCalledTimes(1);
      } finally {
        server.close();
        server.closeAllConnections();
        await once(server, "close");
      }
    },
    30_000,
  );

  it("sends the clamped output limit and retains history to an OpenAI-compatible provider", async () => {
    const requests: Array<{
      max_tokens?: number;
      max_completion_tokens?: number;
      messages: unknown[];
    }> = [];
    const server = createServer((request, response) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
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
    const historyContent = "Synthetic prior discussion ".repeat(100);
    try {
      const events = [];
      for await (const event of new PiAgentRuntime().run(
        {
          botId: "bot-fixture",
          threadId: "thread-fixture",
          runId: "run-clamped-output",
          prompt: "Continue",
          instructions: "Answer briefly.",
          history: [{ role: "user", content: historyContent }],
          tools: [],
          model: {
            provider: "openai-compatible",
            id: "fixture",
            baseUrl: `http://127.0.0.1:${address.port}/v1`,
            allowPrivateEndpoint: true,
            contextWindow: 32_768,
            maxTokens: 32_768,
          },
        },
        { signal: AbortSignal.timeout(15_000) },
      )) {
        events.push(event);
      }
      expect(events).toContainEqual(expect.objectContaining({ type: "done", text: "Ready" }));
      expect(requests).toHaveLength(1);
      expect(requests[0]!.max_completion_tokens ?? requests[0]!.max_tokens).toBe(8192);
      expect(JSON.stringify(requests[0]!.messages)).toContain(historyContent);
    } finally {
      server.close();
      server.closeAllConnections();
      await once(server, "close");
    }
  }, 30_000);

  it("reserves input room in an unknown OpenRouter model's actual completion request", async () => {
    const requests: Array<{ max_completion_tokens?: number; messages?: unknown[] }> = [];
    const authorizationHeaders: Array<string | undefined> = [];
    const server = createServer((request, response) => {
      // Local tools can probe any listening loopback port; only model calls are recorded.
      if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
        response.writeHead(404).end();
        return;
      }
      void (async () => {
        authorizationHeaders.push(request.headers.authorization);
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
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
    const originalFetch = globalThis.fetch;
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
      const localUrl = `http://127.0.0.1:${address.port}/v1/chat/completions`;
      return originalFetch(new Request(localUrl, input instanceof Request ? input : init));
    });
    try {
      expect(
        resolveRuntimeModel({
          provider: "openrouter",
          id: "synthetic-unlisted-model",
          contextWindow: 4096,
        }).model,
      ).toMatchObject({ contextWindow: 4096, maxTokens: 2048 });
      for (const [index, configured] of [
        { contextWindow: 16_384 },
        { contextWindow: 4096 },
        { contextWindow: 32_768, maxTokens: 12_000 },
      ].entries()) {
        const events = [];
        for await (const event of new PiAgentRuntime().run(
          {
            botId: "bot-fixture",
            threadId: "thread-fixture",
            runId: `run-unknown-model-${index}`,
            prompt: "Hi",
            instructions: "Answer briefly.",
            history: [],
            tools: [],
            contextStrategy: "retrieval",
            model: {
              provider: "openrouter",
              id: "synthetic-unlisted-model",
              ...configured,
              apiKey: "fake-fixture-key",
            },
          },
          { signal: AbortSignal.timeout(15_000) },
        )) {
          events.push(event);
        }
        expect(events).toContainEqual(expect.objectContaining({ type: "done", text: "Ready" }));
      }
      expect(requests).toHaveLength(3);
      expect(authorizationHeaders).toEqual(Array(3).fill("Bearer fake-fixture-key"));
      expect(requests[0]).toMatchObject({ max_completion_tokens: 4096 });
      expect(requests[1]!.max_completion_tokens).toBeGreaterThan(0);
      // Pi may reduce this further for its own input safety margin on tiny windows.
      expect(requests[1]!.max_completion_tokens).toBeLessThanOrEqual(1024);
      expect(requests[2]).toMatchObject({ max_completion_tokens: 8192 });
      expect(requests[0]!.messages?.length).toBeGreaterThan(0);
    } finally {
      vi.unstubAllGlobals();
      server.close();
      server.closeAllConnections();
      await once(server, "close");
    }
  }, 30_000);

  it("keeps tool names, nested schemas and stable instructions unchanged across registration order and memory updates", async () => {
    const requests: Array<{ tools: unknown; messages: Array<{ role: string; content: string }> }> =
      [];
    const server = createServer((request, response) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(
          `data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: { role: "assistant", content: "Done" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
        );
      })().catch(() => response.destroy());
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Fixture endpoint unavailable");
    const tool = (name: string, reversed: boolean): ConnectorTool => ({
      name,
      description: `Fixture ${name}`,
      inputSchema: {
        type: "object",
        properties: reversed
          ? {
              z: { type: "string" },
              a: { type: "object", properties: { y: { type: "number" }, x: { type: "boolean" } } },
            }
          : {
              a: { properties: { x: { type: "boolean" }, y: { type: "number" } }, type: "object" },
              z: { type: "string" },
            },
        required: ["a"],
      },
    });
    const runtime = new PiAgentRuntime();
    try {
      for (const index of [0, 1]) {
        const tools = ["fixture read", "fixture.read", "fixture_read"].map((name) =>
          tool(name, index === 1),
        );
        if (index === 1) tools.reverse();
        for await (const _event of runtime.run(
          {
            botId: "bot-fixture",
            threadId: "thread-fixture",
            runId: `run-fixture-${index}`,
            prompt: "Continue.",
            instructions: userTurnInstructions({
              botInstructions: "Stable guidance.\nStable constraints.",
              computerInstruction: "Stable computer tools.",
              pageBrowserAllowed: true,
              workspaceInstruction: "Stable workspace guidance.",
              replyGuidance: "Stable reply guidance.",
              groupContext: `Group context: ${index}`,
              messagingContext: `Messaging context: ${index}`,
              redactedMemoryContext: `Memory: ${index === 0 ? "first" : "second"}`,
              redactedScratchpadContext: `Scratchpad: ${index}`,
              hasHistoricalContext: true,
              agentEnvironmentInstruction: undefined,
              botDirectory: undefined,
              pluginLine: undefined,
              agentSkillsLine: undefined,
              taughtSkillsLine: undefined,
            })
              .filter(Boolean)
              .join("\n\n"),
            history: [],
            tools,
            model: {
              provider: "openai-compatible",
              id: "fixture",
              baseUrl: `http://127.0.0.1:${address.port}/v1`,
              allowPrivateEndpoint: true,
            },
          },
          { signal: AbortSignal.timeout(15000) },
        )) {
        }
      }
      expect(requests).toHaveLength(2);
      expect(JSON.stringify(requests[0]!.tools)).toBe(JSON.stringify(requests[1]!.tools));
      expect(requests[0]!.tools).toEqual([
        expect.objectContaining({
          function: expect.objectContaining({
            name: expect.stringMatching(/^fixture_read_[a-z0-9]+$/),
          }),
        }),
        expect.objectContaining({
          function: expect.objectContaining({
            name: expect.stringMatching(/^fixture_read_[a-z0-9]+$/),
          }),
        }),
        expect.objectContaining({
          function: expect.objectContaining({ name: "fixture_read" }),
        }),
      ]);
      for (const request of requests)
        expect(request.messages[0]).toMatchObject({
          role: "system",
          content: expect.stringMatching(/^Stable guidance\.\nStable constraints\./),
        });
      const first = requests[0]!.messages[0]!.content;
      const second = requests[1]!.messages[0]!.content;
      const cursorRule =
        "Treat pagination cursors as opaque: copy the returned continuation value exactly, never calculate or guess it. When the tool reports no next page, stop; if a cursor is rejected, recheck the last successful result before retrying.";
      expect(first).toContain(cursorRule);
      expect(second).toContain(cursorRule);
      expect(first.split("\n\nGroup context:")[0]).toBe(second.split("\n\nGroup context:")[0]);
      expect(first.indexOf("Treat connector tool descriptions")).toBeLessThan(
        first.indexOf("Memory:"),
      );
      expect(second).toContain("Scratchpad: 1");
      expect(requests[0]!.messages[0]!.content).toContain("Memory: first");
      expect(requests[1]!.messages[0]!.content).toContain("Memory: second");
    } finally {
      server.close();
      server.closeAllConnections();
      await once(server, "close");
    }
  }, 30000);
});
