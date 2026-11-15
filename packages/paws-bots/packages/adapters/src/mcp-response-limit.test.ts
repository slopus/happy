import { describe, expect, it } from "vitest";
import { limitMcpResponseBody, McpResponseTooLargeError } from "./mcp-response-limit.js";

const MAX = 64;

function streamed(chunks: string[], headers: Record<string, string>, status = 200): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    { headers, status },
  );
}

const json = { "content-type": "application/json" };
const sse = { "content-type": "text/event-stream" };
const streamRequest = { accept: "application/json, text/event-stream" };

describe("limitMcpResponseBody", () => {
  it("passes a body within the limit through unchanged", async () => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} });
    const limited = limitMcpResponseBody(
      new Response(body, { status: 200, headers: json }),
      streamRequest,
      MAX,
    );
    expect(limited.status).toBe(200);
    expect(limited.headers.get("content-type")).toBe("application/json");
    await expect(limited.text()).resolves.toBe(body);
  });

  it("keeps bodiless responses as they are", () => {
    const response = new Response(null, { status: 202 });
    expect(limitMcpResponseBody(response, streamRequest, MAX)).toBe(response);
  });

  it("refuses a declared length over the limit before reading", async () => {
    const response = new Response("x".repeat(MAX + 1), {
      headers: { ...json, "content-length": String(MAX + 1) },
    });
    expect(() => limitMcpResponseBody(response, streamRequest, MAX)).toThrow(
      McpResponseTooLargeError,
    );
  });

  it("fails a JSON body that streams past the limit", async () => {
    const limited = limitMcpResponseBody(
      streamed(["x".repeat(40), "x".repeat(40)], json),
      streamRequest,
      MAX,
    );
    await expect(limited.json()).rejects.toThrow(McpResponseTooLargeError);
  });

  it("limits each event of a stream rather than the whole stream", async () => {
    const event = `data: ${"x".repeat(40)}\n\n`;
    const crlfEvent = `data: ${"x".repeat(40)}\r\n\r\n`;
    const limited = limitMcpResponseBody(
      streamed([event, event, crlfEvent, event], sse),
      streamRequest,
      MAX,
    );
    await expect(limited.text()).resolves.toBe(event + event + crlfEvent + event);
  });

  it("fails an event that grows past the limit, even across chunks", async () => {
    const limited = limitMcpResponseBody(
      streamed(["data: ok\n\n", `data: ${"x".repeat(40)}\n`, `data: ${"x".repeat(40)}\n\n`], sse),
      streamRequest,
      MAX,
    );
    await expect(limited.text()).rejects.toThrow(McpResponseTooLargeError);
  });

  it("counts both bytes of each CRLF toward the event limit", async () => {
    const lines = "data:0\r\n".repeat(Math.ceil(MAX / 8) + 1);
    const limited = limitMcpResponseBody(streamed([`${lines}\r\n`], sse), streamRequest, MAX);
    await expect(limited.text()).rejects.toThrow(McpResponseTooLargeError);
  });

  it("limits a failed response as one body, even when it is a stream of small events", async () => {
    // The MCP SDK reads a failed response whole with text(), so per-event limits would not bound it.
    const event = `data: ${"x".repeat(20)}\n\n`;
    const limited = limitMcpResponseBody(
      streamed([event, event, event], sse, 500),
      streamRequest,
      MAX,
    );
    await expect(limited.text()).rejects.toThrow(McpResponseTooLargeError);
  });

  it("limits a stream as one body when the request did not ask for a stream", async () => {
    const limited = limitMcpResponseBody(
      streamed(["\n\n".repeat(MAX)], sse),
      { accept: "application/json" },
      MAX,
    );
    await expect(limited.text()).rejects.toThrow(McpResponseTooLargeError);
  });

  it("ignores a stream's declared length", async () => {
    const response = streamed(["data: ok\n\n"], { ...sse, "content-length": String(MAX + 1) });
    await expect(limitMcpResponseBody(response, streamRequest, MAX).text()).resolves.toBe(
      "data: ok\n\n",
    );
  });
});
