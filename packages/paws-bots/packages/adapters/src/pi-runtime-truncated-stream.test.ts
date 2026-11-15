import { once } from "node:events";
import { createServer } from "node:http";
import type { AgentRuntimeEvent } from "@rakazo/adapter-kit";
import { expect, it, vi } from "vitest";
import { PiAgentRuntime } from "./pi-runtime.js";

it("recovers from an empty truncated completion without replaying a completed tool", async () => {
  let calls = 0;
  const server = createServer((request, response) => {
    request.resume();
    // Local tools can probe any listening loopback port; only model calls are counted.
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404).end();
      return;
    }
    calls += 1;
    response.writeHead(200, { "content-type": "text/event-stream" });
    const choice =
      calls === 1
        ? {
            delta: {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: "effect-once",
                  type: "function",
                  function: { name: "write_effect", arguments: '{"value":"once"}' },
                },
              ],
            },
            finish_reason: "tool_calls",
          }
        : calls === 2
          ? { delta: { role: "assistant" }, finish_reason: null }
          : { delta: { role: "assistant", content: "Recovered." }, finish_reason: "stop" };
    response.end(
      `data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, ...choice }] })}\n\ndata: [DONE]\n\n`,
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture endpoint unavailable");
  const executeTool = vi.fn(async () => ({ ok: true }));
  const events: AgentRuntimeEvent[] = [];
  try {
    for await (const event of new PiAgentRuntime().run(
      {
        botId: "fixture-bot",
        threadId: "fixture-thread",
        runId: "fixture-run",
        prompt: "Write once and report the result.",
        instructions: "Fixture",
        history: [],
        tools: [
          {
            name: "write_effect",
            description: "Write a fixture value.",
            inputSchema: {
              type: "object",
              properties: { value: { type: "string" } },
              required: ["value"],
            },
            readOnly: false,
          },
        ],
        executeTool,
        model: {
          provider: "openai-compatible",
          id: "fixture",
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          allowPrivateEndpoint: true,
        },
      },
      { signal: AbortSignal.timeout(15_000) },
    )) {
      events.push(event);
    }
    expect(calls).toBe(3);
    expect(executeTool).toHaveBeenCalledOnce();
    expect(events.at(-1)).toMatchObject({ type: "done", text: "Recovered." });
  } finally {
    server.close();
    server.closeAllConnections();
    await once(server, "close");
  }
});
