import type { AdapterContext } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { ParallelWebProvider } from "./parallel-web.js";
import { parallelMcpFixture } from "./parallel-web.test-support.js";
import { callRemoteMcpTool } from "./remote-mcp.js";
import { MAX_WEB_FETCH_OFFSET } from "./web-limits.js";
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

describe("optional Parallel web provider", () => {
  it.each(["structured", "text", "duplicated", "utf8"])(
    "bounds readable large %s MCP envelopes through the selected caller",
    async (mode) => {
      const text =
        mode === "utf8"
          ? "界".repeat(400_000)
          : "Page text ".repeat(mode === "duplicated" ? 60_000 : 120_000);
      const data = {
        results: [
          {
            url: "https://example.test/page",
            title: "Large source",
            excerpts: ["Useful evidence"],
            full_content: text,
          },
        ],
      };
      const result = {
        content: mode === "structured" ? [] : [{ type: "text", text: JSON.stringify(data) }],
        ...(mode === "text" ? {} : { structuredContent: data }),
        _meta: { source: "fixture" },
      };
      expect(Buffer.byteLength(JSON.stringify(result))).toBeGreaterThan(1_000_000);
      if (mode === "duplicated") {
        expect(Buffer.byteLength(JSON.stringify(data))).toBeLessThan(1_000_000);
        expect(Buffer.byteLength(JSON.stringify(result.content))).toBeLessThan(1_000_000);
      }
      const peer = parallelMcpFixture({ result });
      const provider = createWebProvider("parallel", peer.network);
      for (const maxChars of [100, 50_000]) {
        expect(
          await webFetchFromTool(provider, context, { url: "https://example.test/page", maxChars }),
        ).toEqual({
          url: "https://example.test/page",
          title: "Large source",
          text: `${text.slice(0, maxChars)}\n\n[Content truncated; continue with offset ${maxChars}]`,
          truncated: true,
        });
      }
      expect(
        await webSearchFromTool(provider, context, { query: "question", maxResults: 1 }),
      ).toEqual({
        results: [
          { url: "https://example.test/page", title: "Large source", snippet: "Useful evidence" },
        ],
      });
      expect(peer.calls.map((call) => call.name)).toEqual(["web_fetch", "web_fetch", "web_search"]);
    },
  );

  it("keeps shared envelope limits and metadata for callers without a projection", async () => {
    const data = {
      content: [{ type: "text", text: "small" }],
      _meta: { source: "fixture" },
      isError: true,
    };
    const peer = parallelMcpFixture({ result: data });
    expect(
      await callRemoteMcpTool(
        { ...peer.network, endpoint: "https://search.parallel.ai/mcp" },
        "web_fetch",
        {},
      ),
    ).toEqual(data);
    const large = parallelMcpFixture({
      result: { ...data, content: [{ type: "text", text: "界".repeat(400_000) }] },
    });
    const limited = (await callRemoteMcpTool(
      { ...large.network, endpoint: "https://search.parallel.ai/mcp" },
      "web_fetch",
      {},
    )) as { truncated: boolean; content: string };
    expect(limited.truncated).toBe(true);
    expect(Buffer.byteLength(limited.content)).toBeLessThanOrEqual(1_000_000);
    const projected = (await callRemoteMcpTool(
      { ...peer.network, endpoint: "https://search.parallel.ai/mcp" },
      "web_fetch",
      {},
      () => ({ content: "界".repeat(400_000) }),
    )) as { truncated: boolean; content: string };
    expect(projected.truncated).toBe(true);
    expect(Buffer.byteLength(projected.content)).toBeLessThanOrEqual(1_000_000);
  });

  it("reads a window past the result size limit", async () => {
    const full_content = `${"a".repeat(1_200_000)}tail`;
    const data = {
      results: [{ url: "https://example.test/page", title: "Long", excerpts: [], full_content }],
    };
    const peer = parallelMcpFixture({ result: { content: [], structuredContent: data } });
    expect(
      await webFetchFromTool(createWebProvider("parallel", peer.network), context, {
        url: "https://example.test/page",
        maxChars: 100,
        offset: 1_199_998,
      }),
    ).toMatchObject({ text: "aatail", truncated: false });
  });

  it("rejects an offset past the read limit before calling Parallel", async () => {
    const peer = parallelMcpFixture();
    expect(
      await webFetchFromTool(createWebProvider("parallel", peer.network), context, {
        url: "https://example.test/page",
        offset: MAX_WEB_FETCH_OFFSET + 1,
      }),
    ).toEqual({ error: `web_fetch can skip at most ${MAX_WEB_FETCH_OFFSET} characters.` });
    expect(peer.calls).toEqual([]);
  });

  it("rejects a truncated serialized envelope instead of returning JSON as page text", async () => {
    const peer = parallelMcpFixture({
      result: { content: [{ type: "text", text: '{"results":[{"full_content":"Page text' }] },
    });
    expect(
      await webFetchFromTool(createWebProvider("parallel", peer.network), context, {
        url: "https://example.test/page",
        maxChars: 100,
      }),
    ).toEqual({ error: "Invalid Parallel MCP response" });
  });

  it("bounds long excerpts and result counts without consuming irrelevant full content", async () => {
    const data = {
      results: [
        {
          url: "https://example.test/first",
          title: "First",
          excerpts: ["a".repeat(600_000), "b".repeat(600_000)],
        },
        { url: "https://example.test/second", title: "Second", excerpts: ["second"] },
      ],
    };
    const peer = parallelMcpFixture({ result: { content: [], structuredContent: data } });
    const provider = createWebProvider("parallel", peer.network);
    expect(await webSearchFromTool(provider, context, { query: "q", maxResults: 1 })).toEqual({
      results: [{ url: "https://example.test/first", title: "First", snippet: "a".repeat(8_000) }],
    });
    expect(
      await webFetchFromTool(provider, context, {
        url: "https://example.test/first",
        maxChars: 100,
      }),
    ).toMatchObject({
      title: "First",
      text: `${"a".repeat(100)}\n\n[Content truncated; continue with offset 100]`,
      truncated: true,
    });
  });

  it("preserves exact-length content, leading whitespace and excerpt separators", async () => {
    for (const [full_content, excerpts, expected, truncated] of [
      ["x".repeat(100), [], "x".repeat(100), false],
      [
        `${" ".repeat(101)}body`,
        [],
        `${" ".repeat(100)}\n\n[Content truncated; continue with offset 100]`,
        true,
      ],
      [undefined, ["", "readable"], "\n\nreadable", false],
    ] as const) {
      const peer = parallelMcpFixture({
        result: {
          content: [],
          structuredContent: {
            results: [
              { url: "https://example.test/page", title: "Source", full_content, excerpts },
            ],
          },
        },
      });
      expect(
        await webFetchFromTool(createWebProvider("parallel", peer.network), context, {
          url: "https://example.test/page",
          maxChars: 100,
        }),
      ).toMatchObject({ text: expected, truncated });
    }
  });
  it.each([false, true])(
    "maps MCP results through the selected web tool (text-only=%s)",
    async (textOnly) => {
      const peer = parallelMcpFixture({ textOnly });
      const provider = createWebProvider(
        resolveWebProviderKind({ WEB_PROVIDER: "parallel" }),
        peer.network,
      );
      expect(
        await webSearchFromTool(provider, context, { query: "current question", maxResults: 1 }),
      ).toEqual({
        results: [
          { title: "Source", url: "https://example.test/page", snippet: "Useful evidence" },
        ],
      });
      expect(peer.calls[0]).toMatchObject({
        name: "web_search",
        arguments: { objective: "current question", search_queries: ["current question"] },
      });
      expect(peer.requests.length).toBeGreaterThan(1);
      for (const request of peer.requests) {
        expect(request.url).toBe("https://search.parallel.ai/mcp");
        expect(request.headers.get("user-agent")).toBe(
          "Rakazo/0.1 (+https://github.com/elie222/rakazo; web tools)",
        );
        expect(request.headers.has("authorization")).toBe(false);
      }
      expect(resolveWebProviderKind({})).toBe("keyless-http");
      for (const kind of ["", "keyless", "keyless-http"])
        expect(createWebProvider(kind).describe().id).toBe("keyless-http");
      expect(createWebProvider("fake").describe().id).toBe("fake");
      expect(() => createWebProvider("invalid")).toThrow("Unknown web provider");
    },
  );

  it("maps page markdown, caps content and keeps conversation accounting stable", async () => {
    const peer = parallelMcpFixture();
    const provider = new ParallelWebProvider(peer.network);
    await provider.search({ query: "question" }, context);
    const page = await webFetchFromTool(provider, context, {
      url: "https://example.test/page",
      maxChars: 100,
    });
    expect(page).toEqual({
      title: "Source",
      url: "https://example.test/page",
      text: `${"Page text ".repeat(10)}\n\n[Content truncated; continue with offset 100]`,
      truncated: true,
    });
    expect(peer.calls[1]).toMatchObject({
      name: "web_fetch",
      arguments: { urls: ["https://example.test/page"], full_content: true },
    });
    expect(peer.calls[0]!.arguments.session_id).toMatch(/^[a-f0-9]{64}$/);
    expect(peer.calls[1]!.arguments.session_id).toBe(peer.calls[0]!.arguments.session_id);
    await provider.search({ query: "question" }, { ...context, userId: "other-user" });
    expect(peer.calls[2]!.arguments.session_id).not.toBe(peer.calls[0]!.arguments.session_id);
  });

  it("salts stable session IDs with the deployment encryption secret", async () => {
    const peer = parallelMcpFixture();
    try {
      vi.stubEnv("ENCRYPTION_KEY", "deployment-a-synthetic-secret-32chars");
      await createWebProvider("parallel", peer.network).search({ query: "question" }, context);
      await createWebProvider("parallel", peer.network).search({ query: "question" }, context);
      vi.stubEnv("ENCRYPTION_KEY", "deployment-b-synthetic-secret-32chars");
      await createWebProvider("parallel", peer.network).search({ query: "question" }, context);
      const sessions = peer.calls.map((call) => call.arguments.session_id);
      expect(sessions[0]).toMatch(/^[a-f0-9]{64}$/);
      expect(sessions[1]).toBe(sessions[0]);
      expect(sessions[2]).not.toBe(sessions[0]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("works in production workers without the API auth secret", async () => {
    const peer = parallelMcpFixture();
    try {
      vi.stubEnv("NODE_ENV", "production");
      vi.stubEnv("VITEST", "");
      vi.stubEnv("RAKAZO_ALLOW_DEV_SECRETS", "");
      vi.stubEnv("BETTER_AUTH_SECRET", "");
      vi.stubEnv("ENCRYPTION_KEY", "a".repeat(64));
      await createWebProvider("parallel", peer.network).search({ query: "question" }, context);
      expect(peer.calls[0]!.arguments.session_id).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each([
    "http://localhost/private",
    "https://169.254.169.254/",
    "https://name:password@example.test/",
  ])("rejects unsafe page URL %s before any MCP request", async (url) => {
    const peer = parallelMcpFixture();
    await expect(new ParallelWebProvider(peer.network).fetch({ url }, context)).rejects.toThrow();
    expect(peer.fetch).not.toHaveBeenCalled();
  });

  it.each([
    [
      { isError: true, content: [{ type: "text", text: "Rate limit exceeded" }] },
      "Rate limit exceeded",
    ],
    [{ content: [{ type: "text", text: "broken JSON" }] }, "Invalid Parallel MCP response"],
    [
      {
        structuredContent: { results: [{ url: "https://example.test", excerpts: null }] },
        content: [],
      },
      "Invalid Parallel MCP response",
    ],
  ])("surfaces tool and malformed response errors without fallback", async (result, message) => {
    const peer = parallelMcpFixture({ result });
    const response = await webSearchFromTool(new ParallelWebProvider(peer.network), context, {
      query: "q",
    });
    expect(response).toEqual({ error: expect.stringContaining(message as string) });
    expect(peer.calls).toHaveLength(1);
    expect(peer.requests.every((request) => request.url === "https://search.parallel.ai/mcp")).toBe(
      true,
    );
  });

  it("surfaces failed page extraction", async () => {
    const peer = parallelMcpFixture({
      result: {
        content: [],
        structuredContent: { results: [], errors: [{ error_type: "FETCH_FAILED" }] },
      },
    });
    await expect(
      new ParallelWebProvider(peer.network).fetch({ url: "https://example.test/page" }, context),
    ).rejects.toThrow("FETCH_FAILED");
  });

  it.each(["request", "context"])(
    "makes no requests when the %s is already cancelled",
    async (source) => {
      const peer = parallelMcpFixture();
      const controller = new AbortController();
      controller.abort(new Error("Stopped"));
      await expect(
        new ParallelWebProvider(peer.network).search(
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
    const peer = parallelMcpFixture({
      call: async (request) =>
        new Promise<Response>((_resolve, reject) => {
          started();
          request.signal.addEventListener("abort", () => reject(request.signal.reason), {
            once: true,
          });
        }),
    });
    const controller = new AbortController();
    const provider = new ParallelWebProvider({
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
