import { vi } from "vitest";

/** Offline Streamable HTTP peer; exercises the real MCP SDK and guarded transport. */
export function keenableMcpFixture(
  options: { result?: unknown; call?: (request: Request) => Promise<Response> } = {},
) {
  const requests: Request[] = [];
  const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    const message = request.method === "POST" ? await request.json() : undefined;
    if (message?.method === "initialize") {
      return Response.json({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: { name: "offline-search", version: "1" },
        },
      });
    }
    if (message?.method === "tools/call") {
      calls.push(message.params);
      if (options.call) return options.call(request);
      // Shapes of `output_format: "json"` results, including fields the adapter ignores.
      const data =
        message.params.name === "fetch_page_content"
          ? {
              url: "https://example.test/page",
              title: "Source",
              content: "Page text ".repeat(30),
              description: "",
              published_at: 1_791_014_819,
            }
          : {
              query: message.params.arguments.query,
              results: [
                {
                  url: "https://example.test/page",
                  title: "Source",
                  description: "",
                  snippet: "Useful evidence",
                  published_at: "2026-07-28T00:00:00Z",
                },
              ],
            };
      return Response.json({
        jsonrpc: "2.0",
        id: message.id,
        result: options.result ?? { content: [{ type: "text", text: JSON.stringify(data) }] },
      });
    }
    if (request.method === "GET") return new Response(null, { status: 405 });
    return new Response(null, { status: 202 });
  });
  return {
    requests,
    calls,
    fetch,
    network: {
      fetch,
      resolveHostname: async () => [{ address: "203.0.113.10", family: 4 as const }],
    },
  };
}
