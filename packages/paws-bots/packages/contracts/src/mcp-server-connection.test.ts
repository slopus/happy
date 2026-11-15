import { describe, expect, it } from "vitest";
import { MCP_OAUTH_CLIENT_REQUIRED } from "./connector-errors.js";
import type { McpServer } from "./mcp.js";
import { mcpServerConnection, mcpServerNeedsSignIn } from "./mcp.js";

function server(overrides: Partial<McpServer> = {}): McpServer {
  return {
    id: "srv",
    spaceId: "space",
    slug: "srv",
    name: "Server",
    description: "",
    transport: "streamable_http",
    endpoint: "https://mcp.example.test/mcp",
    command: null,
    hasArgs: false,
    envKeys: [],
    fileKeys: [],
    headerKeys: [],
    hasSecret: false,
    oauthStatus: "none",
    oauthClientId: null,
    health: { status: "unknown", message: null, toolCount: null, checkedAt: null },
    enabled: true,
    verbatimResults: false,
    revision: 1,
    createdAt: "2026-11-04T00:00:00.000Z",
    updatedAt: "2026-11-04T00:00:00.000Z",
    ...overrides,
  };
}

const ok = { status: "ok", message: null, toolCount: 3, checkedAt: null } as const;
const failed = { status: "error", message: "HTTP 500", toolCount: null, checkedAt: null } as const;

describe("mcpServerConnection", () => {
  it("names one state from how the server signs in and its last check", () => {
    const clientRequired = { ...failed, code: MCP_OAUTH_CLIENT_REQUIRED } as const;
    expect(
      mcpServerConnection(
        server({ enabled: false, oauthStatus: "connected", health: clientRequired }),
      ),
    ).toBe("disabled");
    expect(mcpServerConnection(server({ health: clientRequired, oauthStatus: "reconnect" }))).toBe(
      "needs_client",
    );
    expect(mcpServerConnection(server({ health: clientRequired, oauthClientId: "client-1" }))).toBe(
      "not_working",
    );
    expect(mcpServerConnection(server({ oauthStatus: "reconnect", health: ok }))).toBe(
      "needs_sign_in",
    );
    expect(mcpServerConnection(server({ oauthStatus: "reconnect", health: failed }))).toBe(
      "needs_sign_in",
    );
    expect(mcpServerConnection(server({ oauthStatus: "connected", health: failed }))).toBe(
      "not_working",
    );
    expect(mcpServerConnection(server({ hasSecret: true, health: failed }))).toBe("not_working");
    expect(mcpServerConnection(server({ oauthStatus: "connected" }))).toBe("connected");
    expect(mcpServerConnection(server({ hasSecret: true, health: ok }))).toBe("connected");
    expect(mcpServerConnection(server())).toBe("not_connected");
    expect(
      mcpServerConnection(server({ health: { ...failed, status: "installing", message: null } })),
    ).toBe("not_connected");
  });

  it("asks for a sign-in only when one is what the server is missing", () => {
    expect(mcpServerNeedsSignIn(server({ oauthStatus: "connected" }))).toBe(false);
    expect(mcpServerNeedsSignIn(server({ oauthStatus: "connected", health: failed }))).toBe(false);
    expect(mcpServerNeedsSignIn(server({ enabled: false }))).toBe(false);
    // An unauthenticated first check fails before any sign-in has started.
    expect(mcpServerNeedsSignIn(server({ health: failed }))).toBe(true);
    expect(mcpServerNeedsSignIn(server({ oauthStatus: "reconnect", health: ok }))).toBe(true);
    expect(mcpServerNeedsSignIn(server())).toBe(true);
    expect(
      mcpServerNeedsSignIn(server({ health: { ...failed, code: MCP_OAUTH_CLIENT_REQUIRED } })),
    ).toBe(true);
  });
});
