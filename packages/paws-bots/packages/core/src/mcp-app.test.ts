import { describe, expect, it, vi } from "vitest";
import {
  createMcpAppHost,
  MCP_APP_SHELL_HTML,
  mcpAppContentSecurityPolicy,
  mcpAppDocument,
  mcpAppDomains,
  mcpAppMessageText,
  mcpAppShellDocument,
} from "./mcp-app.js";

describe("MCP app domains", () => {
  it("keeps public https origins and drops what could reach the person's network or Rakazo", () => {
    expect(
      mcpAppDomains(
        [
          "https://api.weather.example",
          "https://*.tiles.example:8443",
          "HTTPS://CDN.Example.com/",
          "http://plain.example",
          "https://*",
          "https://*.example",
          "https://localhost",
          "https://printer.local",
          "https://metadata.google.internal",
          "https://10.0.0.1",
          "https://[::1]",
          "https://intranet",
          "https://cdn.example.com/path",
          "https://app.rakazo.example",
          "https://*.rakazo.example",
          "javascript:alert(1)",
          "'unsafe-eval'",
          42,
        ],
        "resource",
        ["app.rakazo.example"],
      ),
    ).toEqual([
      "https://api.weather.example",
      "https://*.tiles.example:8443",
      "https://cdn.example.com",
    ]);
  });

  it("allows secure sockets only for connections", () => {
    expect(mcpAppDomains(["wss://live.example.com"], "connect")).toEqual([
      "wss://live.example.com",
    ]);
    expect(mcpAppDomains(["wss://live.example.com"], "resource")).toEqual([]);
  });

  it("caps how many origins one app can declare", () => {
    const many = Array.from({ length: 50 }, (_, index) => `https://cdn${index}.example.com`);
    expect(mcpAppDomains(many, "resource")).toHaveLength(32);
  });
});

describe("MCP app content policy", () => {
  it("allows nothing beyond inline code when the app declared no origins", () => {
    const policy = mcpAppContentSecurityPolicy(undefined);
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("connect-src 'none'");
    expect(policy).toContain("script-src 'unsafe-inline';");
    expect(policy).toContain("frame-src 'none'");
    expect(policy).toContain("form-action 'none'");
    expect(policy).not.toContain("https:");
  });

  it("adds declared origins to the matching directives only", () => {
    const policy = mcpAppContentSecurityPolicy({
      connectDomains: ["https://api.example.com"],
      resourceDomains: ["https://cdn.example.com", "https://localhost"],
    });
    expect(policy).toContain("connect-src https://api.example.com");
    expect(policy).toContain("script-src 'unsafe-inline' https://cdn.example.com");
    expect(policy).toContain("img-src data: blob: https://cdn.example.com");
    expect(policy).not.toContain("localhost");
    expect(policy).toContain("frame-src 'none'");
  });

  it("puts the policy before any of the app's own markup", () => {
    const app = mcpAppDocument(
      "<!doctype html><html><head><script>alert(1)</script></head><body>Hi</body></html>",
      undefined,
    );
    expect(app.head).toMatch(
      /^<!DOCTYPE html><meta http-equiv="Content-Security-Policy" content="default-src 'none';/,
    );
    expect(app.body).toBe("<html><head><script>alert(1)</script></head><body>Hi</body></html>");
  });
});

describe("MCP app shell", () => {
  it("embeds the app for a one-document WebView without letting it close the script", () => {
    const shell = mcpAppShellDocument({ head: "<meta>", body: "</script><b> </b>" });
    expect(shell).toContain('window.__rakazoApp={"head":"\\u003cmeta>"');
    expect(shell).not.toContain("</script><b>");
    expect(shell).toContain("\\u2028");
    // Minified code is full of `$&` and `$'`, which a string replacement would expand.
    const code = '<script>a.replace(/x/, "$&$\'$`")</script>';
    expect(mcpAppShellDocument({ head: "", body: code })).toContain(
      JSON.stringify(code).replace(/</g, "\\u003c"),
    );
    expect(MCP_APP_SHELL_HTML).toContain("<!--rakazo-app-boot-->");
    expect(MCP_APP_SHELL_HTML).toContain('sandbox="allow-scripts allow-forms"');
    expect(MCP_APP_SHELL_HTML).not.toContain("allow-same-origin");
  });
});

describe("MCP app host", () => {
  function host(allow = true) {
    const sent: Array<Record<string, unknown>> = [];
    const openLink = vi.fn();
    const offerMessage = vi.fn();
    const onHeight = vi.fn();
    const allowAction = vi.fn(() => allow);
    const session = createMcpAppHost({
      input: { city: "Lisbon" },
      result: { content: [], structuredContent: { high: 23 } },
      hostContext: { theme: "dark" },
      csp: { connectDomains: ["https://api.example.com"] },
      send: (message) => sent.push(message as Record<string, unknown>),
      allowAction,
      openLink,
      offerMessage,
      onHeight,
    });
    return { session, sent, openLink, offerMessage, onHeight, allowAction };
  }

  it("answers initialize, then sends the call's input and result only once the view is ready", () => {
    const { session, sent } = host();
    session.receive({
      jsonrpc: "2.0",
      id: 1,
      method: "ui/initialize",
      params: { protocolVersion: "2026-01-26", appInfo: { name: "a", version: "1" } },
    });
    expect(sent).toEqual([
      {
        jsonrpc: "2.0",
        id: 1,
        result: {
          protocolVersion: "2026-01-26",
          hostInfo: { name: "rakazo", version: "1.0.0" },
          hostCapabilities: {
            openLinks: {},
            message: { text: {} },
            sandbox: { csp: { connectDomains: ["https://api.example.com"] } },
          },
          hostContext: { theme: "dark" },
        },
      },
    ]);
    session.updateContext({ theme: "light" });
    expect(sent).toHaveLength(1);

    session.receive({ jsonrpc: "2.0", method: "ui/notifications/initialized" });
    session.receive({ jsonrpc: "2.0", method: "ui/notifications/initialized" });
    expect(sent.slice(1)).toEqual([
      {
        jsonrpc: "2.0",
        method: "ui/notifications/tool-input",
        params: { arguments: { city: "Lisbon" } },
      },
      {
        jsonrpc: "2.0",
        method: "ui/notifications/tool-result",
        params: { content: [], structuredContent: { high: 23 } },
      },
    ]);
  });

  it.each(["tools/call", "resources/read", "ui/update-model-context", "sampling/createMessage"])(
    "refuses %s from the view",
    (method) => {
      const { session, sent, allowAction } = host();
      session.receive({ jsonrpc: "2.0", id: "x", method, params: { name: "delete_everything" } });
      expect(sent).toEqual([
        { jsonrpc: "2.0", id: "x", error: { code: -32601, message: "Method not found" } },
      ]);
      expect(allowAction).not.toHaveBeenCalled();
    },
  );

  it("opens a web link and offers a message only when a gesture vouches for it", () => {
    const allowed = host(true);
    allowed.session.receive({
      jsonrpc: "2.0",
      id: 1,
      method: "ui/open-link",
      params: { url: "https://example.com/forecast" },
    });
    allowed.session.receive({
      jsonrpc: "2.0",
      id: 2,
      method: "ui/message",
      params: { role: "user", content: [{ type: "text", text: "Plan  lunch\non Sat" }] },
    });
    expect(allowed.openLink).toHaveBeenCalledWith("https://example.com/forecast");
    expect(allowed.offerMessage).toHaveBeenCalledWith("Plan lunch on Sat");
    expect(allowed.sent.map((message) => message.result)).toEqual([{}, {}]);

    const denied = host(false);
    denied.session.receive({
      jsonrpc: "2.0",
      id: 1,
      method: "ui/open-link",
      params: { url: "https://example.com" },
    });
    denied.session.receive({
      jsonrpc: "2.0",
      id: 2,
      method: "ui/message",
      params: { role: "user", content: { type: "text", text: "Send it" } },
    });
    expect(denied.openLink).not.toHaveBeenCalled();
    expect(denied.offerMessage).not.toHaveBeenCalled();
    expect(denied.sent.map((message) => (message.error as { message: string }).message)).toEqual([
      "Link opening denied",
      "Message sending denied",
    ]);
  });

  it("never opens a non-web link, even after a gesture", () => {
    const { session, sent, openLink, allowAction } = host(true);
    session.receive({
      jsonrpc: "2.0",
      id: 1,
      method: "ui/open-link",
      params: { url: "javascript:alert(document.cookie)" },
    });
    expect(openLink).not.toHaveBeenCalled();
    expect(allowAction).not.toHaveBeenCalled();
    expect(sent[0]).toMatchObject({ error: { message: "Invalid URL" } });
  });

  it("follows the view's reported height", () => {
    const { session, onHeight } = host();
    session.receive({
      jsonrpc: "2.0",
      method: "ui/notifications/size-changed",
      params: { width: 500, height: 312 },
    });
    session.receive({
      jsonrpc: "2.0",
      method: "ui/notifications/size-changed",
      params: { height: Number.NaN },
    });
    expect(onHeight).toHaveBeenCalledTimes(1);
    expect(onHeight).toHaveBeenCalledWith(312);
  });

  it("ignores oversized messages from the view", () => {
    const { session, sent } = host();
    session.receive({ jsonrpc: "2.0", id: 1, method: "ping", params: { pad: "x".repeat(70_000) } });
    expect(sent).toEqual([]);
  });

  it("asks an initialized view to tear down, and nothing before that", () => {
    const { session, sent } = host();
    session.teardown();
    expect(sent).toEqual([]);
    session.receive({ jsonrpc: "2.0", method: "ui/notifications/initialized" });
    session.teardown();
    expect(sent.at(-1)).toMatchObject({ method: "ui/resource-teardown", params: {} });
  });
});

describe("MCP app message text", () => {
  it("takes the text blocks of a user message, on one line and bounded", () => {
    expect(
      mcpAppMessageText({
        role: "user",
        content: [
          { type: "text", text: "Hello" },
          { type: "image", data: "..." },
        ],
      }),
    ).toBe("Hello");
    expect(mcpAppMessageText({ role: "assistant", content: { type: "text", text: "x" } })).toBe(
      null,
    );
    expect(mcpAppMessageText({ role: "user", content: [] })).toBe(null);
    expect(
      mcpAppMessageText({ role: "user", content: { type: "text", text: "x".repeat(2001) } }),
    ).toBe(null);
  });
});
