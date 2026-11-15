import type { AdapterContext } from "@rakazo/adapter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KeenableWebProvider } from "./keenable-web.js";
import { keenableMcpFixture } from "./keenable-web.test-support.js";
import { createWebProvider, resolveWebProviderKind } from "./web-provider-factory.js";
import { webFetchFromTool, webSearchFromTool } from "./web-tools.js";

const context: AdapterContext = {
  operationId: "operation",
  traceId: "trace",
  spaceId: "space",
  userId: "user",
  botId: "bot",
  signal: new AbortController().signal,
};

/** Wrap Keenable JSON output in the MCP text content it arrives in. */
function textResult(data: unknown) {
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
}

afterEach(() => vi.unstubAllEnvs());

describe("optional Keenable web provider", () => {
  it("maps MCP results through the selected web tool without a key", async () => {
    vi.stubEnv("KEENABLE_API_KEY", "");
    const peer = keenableMcpFixture();
    const provider = createWebProvider(
      resolveWebProviderKind({ WEB_PROVIDER: "keenable" }),
      peer.network,
    );
    expect(provider.describe().id).toBe("keenable");
    expect(
      await webSearchFromTool(provider, context, { query: "current question", maxResults: 1 }),
    ).toEqual({
      results: [{ title: "Source", url: "https://example.test/page", snippet: "Useful evidence" }],
    });
    expect(peer.calls[0]).toEqual({
      name: "search_web_pages",
      arguments: { query: "current question", max_results: 1, output_format: "json" },
    });
    expect(peer.requests.length).toBeGreaterThan(1);
    for (const request of peer.requests) {
      expect(request.url).toBe("https://api.keenable.ai/mcp");
      expect(request.headers.get("x-keenable-title")).toBe("rakazo");
      expect(request.headers.get("user-agent")).toBe(
        "Rakazo/0.1 (+https://github.com/elie222/rakazo; web tools)",
      );
      expect(request.headers.has("x-api-key")).toBe(false);
      expect(request.headers.has("authorization")).toBe(false);
    }
    expect(createWebProvider().describe().id).toBe("keyless-http");
  });

  it("sends KEENABLE_API_KEY only to the Keenable endpoint", async () => {
    vi.stubEnv("KEENABLE_API_KEY", " synthetic-key ");
    const peer = keenableMcpFixture();
    await new KeenableWebProvider(peer.network).search({ query: "question" }, context);
    expect(peer.requests.length).toBeGreaterThan(1);
    for (const request of peer.requests) {
      expect(request.url).toBe("https://api.keenable.ai/mcp");
      expect(request.headers.get("x-api-key")).toBe("synthetic-key");
      expect(request.headers.get("x-keenable-title")).toBe("rakazo");
    }
  });

  it("reads the structured copy when the server repeats the text as JSON", async () => {
    const data = {
      query: "current question",
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
    const peer = keenableMcpFixture({
      result: {
        content: [{ type: "text", text: JSON.stringify(data) }],
        structuredContent: data,
        isError: false,
      },
    });
    expect(
      await webSearchFromTool(new KeenableWebProvider(peer.network), context, {
        query: "current question",
        maxResults: 1,
      }),
    ).toEqual({
      results: [{ title: "Source", url: "https://example.test/page", snippet: "Useful evidence" }],
    });
  });

  it("maps page markdown and caps content at the requested size", async () => {
    const peer = keenableMcpFixture();
    expect(
      await webFetchFromTool(new KeenableWebProvider(peer.network), context, {
        url: "https://example.test/page",
        maxChars: 100,
      }),
    ).toEqual({
      title: "Source",
      url: "https://example.test/page",
      text: `${"Page text ".repeat(10)}\n\n[Content truncated; continue with offset 100]`,
      truncated: true,
    });
    expect(peer.calls[0]).toEqual({
      name: "fetch_page_content",
      arguments: { url: "https://example.test/page", max_chars: 101, output_format: "json" },
    });
  });

  it("refuses an offset past what Keenable can return", async () => {
    const peer = keenableMcpFixture();
    expect(
      await webFetchFromTool(new KeenableWebProvider(peer.network), context, {
        url: "https://example.test/page",
        maxChars: 8_000,
        offset: 100_000,
      }),
    ).toEqual({ error: "Keenable can read the first 100000 characters of a page." });
    expect(peer.calls).toEqual([]);
  });

  it("returns the remainder when a window crosses Keenable's read limit", async () => {
    const content = `head${"a".repeat(100_000)}`;
    const peer = keenableMcpFixture({
      result: textResult({ url: "https://example.test/page", title: "Source", content }),
    });
    expect(
      await webFetchFromTool(new KeenableWebProvider(peer.network), context, {
        url: "https://example.test/page",
        maxChars: 8_000,
        offset: 96_000,
      }),
    ).toEqual({
      title: "Source",
      url: "https://example.test/page",
      text: `${content.slice(96_000, 100_000)}\n\n[Content truncated; stopped at the read limit]`,
      truncated: true,
    });
    expect(peer.calls[0]?.arguments).toMatchObject({ max_chars: 100_001 });
  });

  it("asks for the text up to the requested window when reading on", async () => {
    const peer = keenableMcpFixture();
    const page = await webFetchFromTool(new KeenableWebProvider(peer.network), context, {
      url: "https://example.test/page",
      maxChars: 100,
      offset: 50,
    });
    expect(page).toMatchObject({
      text: `${"Page text ".repeat(10)}\n\n[Content truncated; continue with offset 150]`,
      truncated: true,
    });
    expect(peer.calls[0]?.arguments).toMatchObject({ max_chars: 151 });
  });

  it.each([
    ["x".repeat(100), "x".repeat(100), false],
    [
      `${"x".repeat(101)}\n\n..._This content has been truncated to stay below 101 characters_...`,
      `${"x".repeat(100)}\n\n[Content truncated; continue with offset 100]`,
      true,
    ],
    [
      `${" ".repeat(101)}body`,
      `${" ".repeat(100)}\n\n[Content truncated; continue with offset 100]`,
      true,
    ],
  ])(
    "keeps exact-length pages and drops provider truncation notes (%#)",
    async (content, text, truncated) => {
      const peer = keenableMcpFixture({
        result: textResult({ url: "https://example.test/page", title: "", content }),
      });
      expect(
        await new KeenableWebProvider(peer.network).fetch(
          { url: "https://example.test/page", maxChars: 100 },
          context,
        ),
      ).toEqual({
        url: "https://example.test/page",
        title: "https://example.test/page",
        text,
        truncated,
      });
    },
  );

  it("bounds snippets and result counts and keeps only public citations", async () => {
    const peer = keenableMcpFixture({
      result: textResult({
        results: [
          { url: "https://name:secret@example.test/", title: "Credentials", snippet: "hidden" },
          { url: "file:///etc/passwd", title: "File", snippet: "hidden" },
          { url: "https://example.test/first", title: " First ", snippet: "a".repeat(20_000) },
          { url: "https://example.test/second", title: null, snippet: "", description: "fallback" },
          { url: "https://example.test/third", title: "Third", snippet: "third" },
        ],
      }),
    });
    expect(
      await new KeenableWebProvider(peer.network).search({ query: "q", maxResults: 2 }, context),
    ).toEqual([
      { url: "https://example.test/first", title: "First", snippet: "a".repeat(8_000) },
      {
        url: "https://example.test/second",
        title: "https://example.test/second",
        snippet: "fallback",
      },
    ]);
    expect(peer.calls[0]!.arguments.max_results).toBe(2);
  });

  it.each([
    "http://localhost/private",
    "https://169.254.169.254/",
    "https://name:password@example.test/",
  ])("rejects unsafe page URL %s before any MCP request", async (url) => {
    const peer = keenableMcpFixture();
    await expect(new KeenableWebProvider(peer.network).fetch({ url }, context)).rejects.toThrow();
    expect(peer.fetch).not.toHaveBeenCalled();
  });

  it.each([
    [
      { isError: true, content: [{ type: "text", text: "Error: Rate limit exceeded" }] },
      "Keenable: Error: Rate limit exceeded",
    ],
    [{ content: [{ type: "text", text: "broken JSON" }] }, "Invalid Keenable MCP response"],
    [textResult({ results: [{ url: "https://example.test", title: 1 }] }), "Invalid Keenable"],
    [{ content: [{ type: "text", text: "界".repeat(400_000) }] }, "Invalid Keenable MCP response"],
  ])("surfaces tool and malformed response errors without fallback", async (result, message) => {
    const peer = keenableMcpFixture({ result });
    expect(
      await webSearchFromTool(new KeenableWebProvider(peer.network), context, { query: "q" }),
    ).toEqual({ error: expect.stringContaining(message) });
    expect(peer.calls).toHaveLength(1);
    expect(peer.requests.every((request) => request.url === "https://api.keenable.ai/mcp")).toBe(
      true,
    );
  });

  it.each([
    [
      { isError: true, content: [{ type: "text", text: "Error fetching page" }] },
      "Keenable: Error fetching page",
    ],
    [textResult({ url: "https://example.test/page", content: " \n" }), "empty page content"],
    [textResult({ url: "javascript:alert(1)", content: "text" }), "invalid page URL"],
  ])("surfaces failed page extraction", async (result, message) => {
    const peer = keenableMcpFixture({ result });
    await expect(
      new KeenableWebProvider(peer.network).fetch({ url: "https://example.test/page" }, context),
    ).rejects.toThrow(message);
  });

  it.each(["request", "context"])(
    "makes no requests when the %s is already cancelled",
    async (source) => {
      const peer = keenableMcpFixture();
      const controller = new AbortController();
      controller.abort(new Error("Stopped"));
      await expect(
        new KeenableWebProvider(peer.network).search(
          {
            query: "q",
            signal: source === "request" ? controller.signal : new AbortController().signal,
          },
          source === "context" ? { ...context, signal: controller.signal } : context,
        ),
      ).rejects.toThrow("Stopped");
      expect(peer.fetch).not.toHaveBeenCalled();
    },
  );

  it.each(["cancel", "timeout"])("interrupts an active MCP call on %s", async (mode) => {
    let started!: () => void;
    const opened = new Promise<void>((resolve) => {
      started = resolve;
    });
    const peer = keenableMcpFixture({
      call: async (request) =>
        new Promise<Response>((_resolve, reject) => {
          started();
          request.signal.addEventListener("abort", () => reject(request.signal.reason), {
            once: true,
          });
        }),
    });
    const controller = new AbortController();
    const provider = new KeenableWebProvider({
      ...peer.network,
      searchTimeoutMs: mode === "timeout" ? 30 : 5000,
    });
    const result = provider
      .search({ query: "q", signal: controller.signal }, context)
      .catch((error: unknown) => error);
    await opened;
    if (mode === "cancel") controller.abort(new Error("Stopped"));
    expect(await result).toBeInstanceOf(Error);
    expect(peer.requests.findLast((request) => request.method === "POST")!.signal.aborted).toBe(
      true,
    );
  });
});
