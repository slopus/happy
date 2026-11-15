import { describe, expect, it } from "vitest";
import { McpHeadersSchema, McpServerConfigInput } from "./mcp.js";

describe("MCP headers", () => {
  it.each(["streamable_http", "sse"])("accepts underscore headers for %s", (transport) => {
    const headers = { X_API_KEY: "fake-key" };
    expect(new Headers(headers).get("x_api_key")).toBe("fake-key");
    expect(
      McpServerConfigInput.safeParse({
        slug: "demo",
        name: "Demo",
        transport,
        endpoint: "https://mcp.example.test",
        headers,
      }).success,
    ).toBe(true);
  });

  it("accepts all HTTP token punctuation without changing names or values", () => {
    const headers = { "X!#$%&'*+-.^_`|~": "fake-key", Authorization: "Bearer fake-token" };
    expect(() => new Headers(headers)).not.toThrow();
    expect(McpHeadersSchema.parse(headers)).toEqual(headers);
  });

  it.each([
    "",
    "X Key",
    " X-Key",
    "X-Key ",
    "X-\u00e9",
    ...Array.from('()<>@,;:\\"/[]?={}', (char) => `X${char}Key`),
    ...Array.from({ length: 33 }, (_, index) => {
      const char = String.fromCharCode(index === 32 ? 127 : index);
      return `X-Key${char}`;
    }),
  ])("rejects invalid header name %j", (name) => {
    expect(McpHeadersSchema.safeParse({ [name]: "fake-key" }).success).toBe(false);
    expect(() => new Headers({ [name]: "fake-key" })).toThrow();
  });

  it("keeps the header count and value length limits", () => {
    const headers = Object.fromEntries(
      Array.from({ length: 32 }, (_, index) => [`X_Key_${index}`, "x".repeat(4096)]),
    );
    expect(McpHeadersSchema.safeParse(headers).success).toBe(true);
    expect(McpHeadersSchema.safeParse({ ...headers, X_Extra: "fake-key" }).success).toBe(false);
    expect(McpHeadersSchema.safeParse({ X_Key: "x".repeat(4097) }).success).toBe(false);
  });
});
