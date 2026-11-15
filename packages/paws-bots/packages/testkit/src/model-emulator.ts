import assert from "node:assert/strict";
import type { ServerResponse } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { AgentRunRequest } from "@rakazo/adapter-kit";

export interface ModelEmulatorRequest {
  model: string;
  stream: boolean;
  messages: Array<{
    role: string;
    content?: unknown;
    tool_call_id?: string;
    tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
  }>;
  tools?: Array<{ type: string; function: { name: string; parameters: unknown } }>;
}

export type ModelEmulatorResponse =
  | { type: "text"; text: string }
  | {
      type: "tools";
      calls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
    }
  | {
      type: "tool";
      id: string;
      name: string;
      arguments: Record<string, unknown>;
      /** Synthetic assistant prose emitted alongside a tool call; never real model traces. */
      assistantText?: string;
      /** Concatenation must equal the JSON arguments. Each fragment is a separate SSE delta. */
      argumentChunks?: string[];
    }
  | { type: "error"; status: number; message: string }
  | { type: "disconnect"; text?: string }
  | { type: "hold"; text?: string; onOpen?: () => void; onClose?: () => void };

export interface ModelEmulatorStep {
  /** Synthetic endpoint usage, including explicit zero and omitted breakdown fields. */
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    prompt_tokens_details?: { cached_tokens?: number };
    completion_tokens_details?: { reasoning_tokens?: number };
    cost?: number;
  };
  /** Assertions run before the response; failures also make assertComplete fail. */
  expect: (request: ModelEmulatorRequest) => void | Promise<void>;
  response: ModelEmulatorResponse | ((request: ModelEmulatorRequest) => ModelEmulatorResponse);
}

/**
 * A loopback-only model protocol fixture. Pi itself and its HTTP/SSE transport
 * stay real. This tests execution, not whether a model can choose these actions.
 * Always call assertComplete: a runtime can consume a provider failure without
 * propagating the original fixture assertion.
 */
export async function startModelEmulator(options: {
  steps: ModelEmulatorStep[];
  modelId?: string;
  apiKey?: string;
}) {
  const modelId = options.modelId ?? "offline-fixture";
  const requests: ModelEmulatorRequest[] = [];
  const failures: Error[] = [];
  let stepIndex = 0;
  const server = createServer((request, response) => {
    // Local tools can probe any listening loopback port; the runtime only calls under /v1.
    if (!request.url?.startsWith("/v1/")) {
      response.writeHead(404).end();
      return;
    }
    void (async () => {
      assert.equal(request.method, "POST", "Expected a model POST request");
      assert.equal(request.url, "/v1/chat/completions", "Unexpected model endpoint");
      assert.equal(request.headers.authorization, `Bearer ${options.apiKey ?? "local"}`);
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of request) {
        bytes += Buffer.byteLength(chunk);
        assert.ok(bytes <= 2 * 1024 * 1024, "Model fixture request exceeds 2 MiB");
        chunks.push(Buffer.from(chunk));
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as ModelEmulatorRequest;
      requests.push(body);
      assert.equal(body.model, modelId, "Model routing changed");
      assert.equal(body.stream, true, "Expected streaming model request");
      assert.ok(Array.isArray(body.messages), "Expected model messages");
      const step = options.steps[stepIndex++];
      assert.ok(step, `Unexpected model request ${stepIndex}`);
      await step.expect(body);
      const reply = typeof step.response === "function" ? step.response(body) : step.response;
      if (reply.type === "error") {
        response.writeHead(reply.status, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: reply.message, type: "fixture_error" } }));
        return;
      }
      if (reply.type === "tool" && reply.argumentChunks) {
        assert.equal(reply.argumentChunks.join(""), JSON.stringify(reply.arguments));
      }
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      response.flushHeaders();
      const emit = (delta: unknown, finishReason: string | null = null) => {
        response.write(
          `data: ${JSON.stringify({
            id: `fixture-${stepIndex}`,
            object: "chat.completion.chunk",
            created: 0,
            model: modelId,
            choices: [{ index: 0, delta, finish_reason: finishReason }],
          })}\n\n`,
        );
      };
      const emitUsage = () => {
        if (step.usage)
          response.write(
            `data: ${JSON.stringify({ id: `fixture-${stepIndex}`, choices: [], usage: step.usage })}\n\n`,
          );
      };
      emit({ role: "assistant" });
      if (reply.type === "tools") {
        emit({
          tool_calls: reply.calls.map((call, index) => ({
            index,
            id: call.id,
            type: "function",
            function: { name: call.name, arguments: JSON.stringify(call.arguments) },
          })),
        });
        emit({}, "tool_calls");
      } else if (reply.type === "tool") {
        if (reply.assistantText) emit({ content: reply.assistantText });
        emit({
          tool_calls: [
            {
              index: 0,
              id: reply.id,
              type: "function",
              function: { name: reply.name, arguments: "" },
            },
          ],
        });
        for (const fragment of reply.argumentChunks ?? [JSON.stringify(reply.arguments)]) {
          emit({ tool_calls: [{ index: 0, function: { arguments: fragment } }] });
        }
        emit({}, "tool_calls");
      } else {
        if (reply.text) emit({ content: reply.text });
        if (reply.type === "hold") {
          emitUsage();
          response.once("close", () => reply.onClose?.());
          reply.onOpen?.();
          return;
        }
        if (reply.type === "disconnect") {
          emitUsage();
          // Flush the partial SSE stream, then close without a terminal chunk.
          await new Promise<void>((resolve) => response.write(": disconnect\n\n", () => resolve()));
          response.destroy();
          return;
        }
        emit({}, "stop");
      }
      emitUsage();
      response.end("data: [DONE]\n\n");
    })().catch((error: unknown) => {
      failures.push(error instanceof Error ? error : new Error(String(error)));
      failResponse(response);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  const model: AgentRunRequest["model"] = {
    provider: "openai-compatible",
    id: modelId,
    baseUrl,
    // The emulator listens on loopback, as an owner-run local model server would.
    allowPrivateEndpoint: true,
    ...(options.apiKey ? { apiKey: options.apiKey } : {}),
  };
  return {
    baseUrl,
    model,
    requests,
    assertComplete() {
      if (failures.length)
        throw new AggregateError(failures, failures.map((error) => error.message).join("\n"));
      assert.equal(stepIndex, options.steps.length, "Not all model fixture steps were consumed");
    },
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
    },
  };
}

function failResponse(response: ServerResponse) {
  if (response.headersSent) response.destroy();
  else {
    response.writeHead(400, { "content-type": "application/json" });
    // Assertion details are retained locally; do not inject them into the agent conversation.
    response.end(
      JSON.stringify({
        error: { message: "Model fixture request mismatch", type: "fixture_error" },
      }),
    );
  }
}
