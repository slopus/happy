import { MCP_APP_MIME_TYPE } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import { InstalledConnectorProvider } from "./installed-connectors.js";
import {
  mcpAppFromResource,
  mcpAppViewArguments,
  mcpAppViewResult,
  mcpToolAppResourceUri,
  mcpToolVisibleToModel,
  readMcpApp,
} from "./mcp-app.js";

const APP_HTML = "<!doctype html><html><body>Forecast</body></html>";

describe("MCP app tool metadata", () => {
  it("reads the app a tool names, in the current and the deprecated spelling", () => {
    expect(mcpToolAppResourceUri({ _meta: { ui: { resourceUri: "ui://weather/app" } } })).toBe(
      "ui://weather/app",
    );
    expect(mcpToolAppResourceUri({ _meta: { "ui/resourceUri": "ui://weather/old" } })).toBe(
      "ui://weather/old",
    );
    expect(mcpToolAppResourceUri({ _meta: { ui: { resourceUri: "https://evil.example" } } })).toBe(
      undefined,
    );
    expect(mcpToolAppResourceUri({})).toBe(undefined);
  });

  it("hides tools only the server's own app may call", () => {
    expect(mcpToolVisibleToModel({})).toBe(true);
    expect(mcpToolVisibleToModel({ _meta: { ui: { visibility: ["model", "app"] } } })).toBe(true);
    expect(mcpToolVisibleToModel({ _meta: { ui: { visibility: ["app"] } } })).toBe(false);
  });
});

describe("MCP app resource", () => {
  const read = (content: Record<string, unknown>) => ({
    contents: [{ uri: "ui://weather/app", mimeType: MCP_APP_MIME_TYPE, ...content }],
  });

  it("takes an app's HTML, its allowed origins and border preference", () => {
    expect(
      mcpAppFromResource(
        "Weather",
        "ui://weather/app",
        read({
          text: APP_HTML,
          _meta: {
            ui: {
              csp: {
                connectDomains: ["https://api.weather.example", "https://192.168.1.10"],
                resourceDomains: ["https://localhost"],
                frameDomains: ["https://video.example"],
              },
              prefersBorder: false,
            },
          },
        }),
      ),
    ).toEqual({
      server: "Weather",
      html: APP_HTML,
      csp: { connectDomains: ["https://api.weather.example"] },
      prefersBorder: false,
    });
  });

  it("decodes an app sent as a blob", () => {
    expect(
      mcpAppFromResource(
        "Weather",
        "ui://weather/app",
        read({ blob: Buffer.from(APP_HTML).toString("base64") }),
      )?.html,
    ).toBe(APP_HTML);
  });

  it("shows nothing when the read returns another resource's document", () => {
    expect(
      mcpAppFromResource("Weather", "ui://weather/app", {
        contents: [{ uri: "ui://weather/other", mimeType: MCP_APP_MIME_TYPE, text: APP_HTML }],
      }),
    ).toBe(undefined);
  });

  it("shows nothing for another type or an oversized document", () => {
    expect(
      mcpAppFromResource("Weather", "ui://weather/app", {
        contents: [{ uri: "ui://weather/app", mimeType: "text/html", text: APP_HTML }],
      }),
    ).toBe(undefined);
    expect(
      mcpAppFromResource("Weather", "ui://weather/app", read({ text: "x".repeat(2_000_001) })),
    ).toBe(undefined);
  });

  it("redacts the connection's credentials from the document", async () => {
    const app = await readMcpApp(
      "Weather",
      "ui://weather/app",
      { content: [] },
      async () => read({ text: "<p>token sk-connection-secret</p>" }),
      ["sk-connection-secret"],
    );
    expect(app?.html).not.toContain("sk-connection-secret");
  });

  it("reads no app for a failed call, and a failed read only means no app", async () => {
    const reader = vi.fn(async () => read({ text: APP_HTML }));
    expect(await readMcpApp("Weather", "ui://weather/app", { isError: true }, reader)).toBe(
      undefined,
    );
    expect(reader).not.toHaveBeenCalled();
    expect(
      await readMcpApp("Weather", "ui://weather/app", { content: [] }, async () => {
        throw new Error("resources/read not supported");
      }),
    ).toBe(undefined);
  });

  it("leaves oversized arguments out of the card", () => {
    expect(mcpAppViewArguments({ city: "Lisbon" })).toEqual({ city: "Lisbon" });
    expect(mcpAppViewArguments({ document: "x".repeat(70_000) })).toEqual({});
  });

  it("keeps the view's copy of a result within the card's budget", () => {
    const small = { content: [{ type: "text", text: "hi" }], structuredContent: { a: 1 } };
    expect(mcpAppViewResult(small)).toEqual(small);
    const big = {
      content: [{ type: "text", text: "x".repeat(300_000) }],
      structuredContent: { a: 1 },
    };
    expect(mcpAppViewResult(big)).toEqual({ content: [], structuredContent: { a: 1 } });
    expect(mcpAppViewResult({ content: "y".repeat(300_000) })).toEqual({ content: [] });
  });
});

describe("installed MCP server with an app", () => {
  /** A Streamable HTTP MCP server with one tool that has an app and one only the app calls. */
  function appServer() {
    const initializeParams: unknown[] = [];
    const reads: string[] = [];
    let failCall = false;
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      if (request.method !== "POST") return new Response(null, { status: 405 });
      const message = JSON.parse(await request.text()) as {
        id?: number;
        method?: string;
        params?: Record<string, unknown>;
      };
      const reply = (result: unknown) =>
        Response.json(
          { jsonrpc: "2.0", id: message.id, result },
          {
            headers: { "mcp-session-id": "s1" },
          },
        );
      if (message.method === "initialize") {
        initializeParams.push(message.params);
        return reply({
          protocolVersion: "2025-11-25",
          capabilities: { tools: {}, resources: {} },
          serverInfo: { name: "weather", version: "1" },
        });
      }
      if (message.id === undefined) return new Response(null, { status: 202 });
      if (message.method === "tools/list") {
        return reply({
          tools: [
            {
              name: "get_forecast",
              inputSchema: { type: "object" },
              _meta: { ui: { resourceUri: "ui://weather/app" } },
            },
            {
              name: "refresh_forecast",
              inputSchema: { type: "object" },
              _meta: { ui: { resourceUri: "ui://weather/app", visibility: ["app"] } },
            },
          ],
        });
      }
      if (message.method === "tools/call") {
        return reply({
          content: [{ type: "text", text: failCall ? "City not found" : "Sunny" }],
          structuredContent: failCall ? undefined : { high: 23 },
          isError: failCall,
        });
      }
      if (message.method === "resources/read") {
        reads.push(String(message.params?.uri));
        return reply({
          contents: [
            {
              uri: message.params?.uri,
              mimeType: MCP_APP_MIME_TYPE,
              text: APP_HTML,
              _meta: { ui: { csp: { resourceDomains: ["https://cdn.weather.example"] } } },
            },
          ],
        });
      }
      return new Response(null, { status: 202 });
    });
    const install = {
      id: "mcp-weather",
      kind: "mcp",
      name: "Weather",
      source: "https://mcp.weather.example/mcp",
      secretId: null,
      createdAt: new Date(0),
      config: { preset: "custom", auth: { type: "none" } },
    };
    const provider = new InstalledConnectorProvider(
      {
        capabilityInstall: {
          findFirst: vi.fn().mockResolvedValue(install),
          findMany: vi.fn().mockResolvedValue([install]),
        },
      } as never,
      {} as never,
      {
        fetch: fetch as unknown as typeof globalThis.fetch,
        resolveHostname: async () => [{ address: "203.0.113.10", family: 4 as const }],
      },
    );
    return {
      provider,
      initializeParams,
      reads,
      failNextCall: () => {
        failCall = true;
      },
    };
  }

  const context = { spaceId: "space-1", userId: "user-1", signal: new AbortController().signal };

  it("tells the server it shows apps and keeps app-only tools from the model", async () => {
    const server = appServer();
    const tools = await server.provider.discoverTools(context as never);
    expect(tools.map((tool) => tool.name)).toEqual(["get_forecast"]);
    expect(tools[0]?.route?.appResourceUri).toBe("ui://weather/app");
    expect(server.initializeParams[0]).toMatchObject({
      capabilities: {
        extensions: { "io.modelcontextprotocol/ui": { mimeTypes: [MCP_APP_MIME_TYPE] } },
      },
    });
  });

  it("follows a successful call with its app, and a failed one with none", async () => {
    const server = appServer();
    const [tool] = await server.provider.discoverTools(context as never);
    const call = async (withApp = true) => {
      const events: Array<{ type: string } & Record<string, unknown>> = [];
      for await (const event of server.provider.execute(
        {
          tool: "get_forecast",
          args: { city: "Lisbon" },
          executionId: "e1",
          route: tool!.route,
          withApp,
        },
        context as never,
      )) {
        events.push(event as never);
      }
      return events;
    };

    expect(await call()).toEqual([
      {
        type: "result",
        data: expect.objectContaining({ structuredContent: { high: 23 }, isError: false }),
      },
      {
        type: "app",
        app: {
          server: "Weather",
          html: APP_HTML,
          csp: { resourceDomains: ["https://cdn.weather.example"] },
        },
      },
    ]);
    expect(server.reads).toEqual(["ui://weather/app"]);

    // A caller that shows no card (a routine watch, background work) never fetches the app.
    expect((await call(false)).map((event) => event.type)).toEqual(["result"]);
    expect(server.reads).toHaveLength(1);

    server.failNextCall();
    expect((await call()).map((event) => event.type)).toEqual(["result"]);
    expect(server.reads).toHaveLength(1);
  });
});
