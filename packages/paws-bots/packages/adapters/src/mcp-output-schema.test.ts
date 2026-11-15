import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import type { JsonSchemaType } from "@modelcontextprotocol/sdk/validation/types.js";
import { createLogger, createTestSink, installLogger } from "@rakazo/logging";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMcpJsonSchemaValidator } from "./mcp-output-schema.js";
import { McpSession } from "./mcp-transport.js";

/** `\:` is a legal identity escape without the `u` flag and a SyntaxError with it.
 * PayPal's MCP server publishes a tool outputSchema that contains this pattern. */
const PAYPAL_STYLE_PATTERN = "^https\\:\\/\\/";

const PAYPAL_STYLE_OUTPUT_SCHEMA: JsonSchemaType = {
  type: "object",
  properties: {
    href: { type: "string", pattern: PAYPAL_STYLE_PATTERN },
    id: { type: "string" },
  },
  required: ["href", "id"],
  additionalProperties: false,
};

const UNICODE_OUTPUT_SCHEMA: JsonSchemaType = {
  type: "object",
  properties: {
    label: { type: "string", pattern: "^\\p{L}+$" },
  },
  required: ["label"],
  additionalProperties: false,
};

const FIXTURE_TOOLS = [
  {
    name: "checkout",
    description: "Tool whose output pattern is illegal under unicode regular expressions",
    inputSchema: { type: "object" },
    outputSchema: PAYPAL_STYLE_OUTPUT_SCHEMA,
  },
  {
    name: "label",
    description: "Tool whose output pattern needs unicode property escapes",
    inputSchema: { type: "object" },
    outputSchema: UNICODE_OUTPUT_SCHEMA,
  },
];

const TEST_NETWORK = {
  fetch: (input: string | URL | Request, init?: RequestInit) => globalThis.fetch(input, init),
  resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }],
};

afterEach(() => {
  installLogger(createLogger({ service: "rakazo", level: "off", sinks: [] }));
});

function recordWarnings() {
  const sink = createTestSink();
  installLogger(createLogger({ service: "test", level: "warn", sinks: [sink] }));
  return sink;
}

function fixtureFetch() {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    if (request.method !== "POST") return new Response(null, { status: 405 });
    const message = (await request.json()) as {
      id?: number;
      method?: string;
      params?: { arguments?: Record<string, unknown> };
    };
    if (message.method === "initialize") {
      return Response.json({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: { name: "paypal-fixture", version: "1" },
        },
      });
    }
    if (message.method === "tools/list") {
      return Response.json({
        jsonrpc: "2.0",
        id: message.id,
        result: { tools: FIXTURE_TOOLS },
      });
    }
    if (message.method === "tools/call") {
      return Response.json({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          content: [{ type: "text", text: "ok" }],
          structuredContent: message.params?.arguments ?? {},
        },
      });
    }
    return new Response(null, { status: 202 });
  });
}

describe("MCP output schema patterns", () => {
  it("reproduces a pattern Ajv rejects only when the unicode flag is set", () => {
    expect(() => new RegExp(PAYPAL_STYLE_PATTERN, "u")).toThrow(SyntaxError);
    expect(() => new RegExp(PAYPAL_STYLE_PATTERN)).not.toThrow();
    expect(() => new AjvJsonSchemaValidator().getValidator(PAYPAL_STYLE_OUTPUT_SCHEMA)).toThrow(
      /Invalid escape/,
    );
  });

  it("repairs a schema that Ajv cached under an $id", () => {
    const compiler = createMcpJsonSchemaValidator();
    const id = "https://example.test/schemas/checkout";
    const repaired = compiler.getValidator({ $id: id, ...PAYPAL_STYLE_OUTPUT_SCHEMA });
    const unicode = compiler.getValidator({ $id: id, ...UNICODE_OUTPUT_SCHEMA });

    expect(repaired({ href: "not-a-url", id: "charge-1" })).toMatchObject({ valid: true });
    expect(repaired({ href: "not-a-url", id: 1 }).valid).toBe(false);
    expect(unicode({ label: "A1" }).valid).toBe(false);
    expect(unicode({ label: "É" })).toMatchObject({ valid: true });
  });

  it("drops only the illegal pattern and keeps validating the rest of that schema", () => {
    const sink = recordWarnings();
    const schema = structuredClone(PAYPAL_STYLE_OUTPUT_SCHEMA);
    const validate = createMcpJsonSchemaValidator().getValidator(schema);

    expect(schema).toEqual(PAYPAL_STYLE_OUTPUT_SCHEMA);
    expect(validate({ href: "not-a-url", id: "charge-1" })).toMatchObject({ valid: true });
    expect(validate({ href: "not-a-url", id: 1 }).valid).toBe(false);
    expect(validate({ href: "https://example.test/pay" }).valid).toBe(false);
    expect(sink.events).toEqual([
      expect.objectContaining({
        level: "warn",
        message:
          "mcp output schema pattern is invalid under unicode regular expressions; validating without it",
        patterns: [PAYPAL_STYLE_PATTERN],
        patternCount: 1,
      }),
    ]);
  });

  it.each(["const", "enum"])("preserves %s literals when repairing a pattern", (keyword) => {
    const literal = { pattern: "^https\\:" };
    const schema: JsonSchemaType = {
      type: "object",
      properties: {
        href: { type: "string", pattern: PAYPAL_STYLE_PATTERN },
        value: { [keyword]: keyword === "enum" ? [literal] : literal },
      },
      required: ["value"],
    };
    const original = structuredClone(schema);
    const validate = createMcpJsonSchemaValidator().getValidator(schema);

    expect(validate({ value: literal }).valid).toBe(true);
    expect(validate({ value: {} }).valid).toBe(false);
    expect(validate({ value: { pattern: "different" } }).valid).toBe(false);
    expect(schema).toEqual(original);
  });

  it.each(["default", "examples", "example"])(
    "preserves %s annotations when repairing a pattern",
    (keyword) => {
      const sink = recordWarnings();
      const literal = { pattern: "^https\\:" };
      const validate = createMcpJsonSchemaValidator().getValidator({
        type: "string",
        pattern: PAYPAL_STYLE_PATTERN,
        [keyword]: keyword === "examples" ? [literal] : literal,
      });

      expect(validate("text").valid).toBe(true);
      expect(sink.events).toEqual([
        expect.objectContaining({ patterns: [PAYPAL_STYLE_PATTERN], patternCount: 1 }),
      ]);
    },
  );

  it("preserves schema map entries named after keywords", () => {
    const validate = createMcpJsonSchemaValidator().getValidator({
      type: "object",
      properties: {
        href: { type: "string", pattern: PAYPAL_STYLE_PATTERN },
        pattern: { type: "string" },
        patternProperties: { type: "string" },
        const: { type: "string", pattern: PAYPAL_STYLE_PATTERN },
      },
      required: ["pattern", "patternProperties", "const"],
      additionalProperties: false,
    });

    expect(validate({ pattern: "text", patternProperties: "text", const: "text" }).valid).toBe(
      true,
    );
    expect(validate({ pattern: 1, patternProperties: "text", const: "text" }).valid).toBe(false);
    expect(validate({ pattern: "text", patternProperties: 1, const: "text" }).valid).toBe(false);
  });

  it("still applies unicode patterns on a schema that also has an illegal one", () => {
    const validate = createMcpJsonSchemaValidator().getValidator({
      type: "object",
      properties: {
        href: { type: "string", pattern: PAYPAL_STYLE_PATTERN },
        label: { type: "string", pattern: "^\\p{L}+$" },
      },
      required: ["label"],
      additionalProperties: false,
    });

    expect(validate({ label: "É", href: "not-a-url" })).toMatchObject({ valid: true });
    expect(validate({ label: "A1", href: "https://example.test" }).valid).toBe(false);
    expect(validate({ label: "É", href: 1 }).valid).toBe(false);
  });

  it("does not weaken a schema whose patterns already compile", () => {
    const sink = recordWarnings();
    const validate = createMcpJsonSchemaValidator().getValidator(UNICODE_OUTPUT_SCHEMA);

    expect(validate({ label: "É" })).toMatchObject({ valid: true });
    expect(validate({ label: "A1" }).valid).toBe(false);
    expect(validate({}).valid).toBe(false);
    expect(sink.events).toEqual([]);
  });

  it("drops an illegal patternProperties key and still checks the other constraints", () => {
    const validate = createMcpJsonSchemaValidator().getValidator({
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      patternProperties: { [PAYPAL_STYLE_PATTERN]: { type: "number" } },
    });

    expect(validate({ id: "charge-1", "https://example.test": "text" })).toMatchObject({
      valid: true,
    });
    expect(validate({ id: 1 }).valid).toBe(false);
  });

  it("skips output validation for one schema that still cannot be compiled", () => {
    const sink = recordWarnings();
    const compiler = createMcpJsonSchemaValidator();

    expect(compiler.getValidator({ $ref: "#/$defs/missing" })({ href: 1 })).toMatchObject({
      valid: true,
    });
    expect(compiler.getValidator(UNICODE_OUTPUT_SCHEMA)({ label: "A1" }).valid).toBe(false);
    expect(sink.events).toEqual([
      expect.objectContaining({
        level: "warn",
        message:
          "mcp output schema could not be compiled; skipping output validation for that tool",
      }),
    ]);
  });
});

describe("MCP tool discovery with an invalid output pattern", () => {
  it("lists every tool and validates only the schemas that compile", async () => {
    const sink = recordWarnings();
    const session = new McpSession();
    try {
      await session.connectRemote({
        url: "https://mcp.example.test/mcp",
        network: { ...TEST_NETWORK, fetch: fixtureFetch() },
      });

      const listed = await session.listTools();

      expect(listed.tools.map((tool) => tool.name)).toEqual(["checkout", "label"]);
      expect(listed.tools[0]?.outputSchema).toMatchObject({
        properties: { href: { pattern: PAYPAL_STYLE_PATTERN } },
      });
      await expect(
        session.callTool("checkout", { href: "not-a-url", id: "charge-1" }),
      ).resolves.toMatchObject({
        structuredContent: { href: "not-a-url", id: "charge-1" },
      });
      await expect(session.callTool("checkout", { href: "not-a-url", id: 1 })).rejects.toThrow(
        /does not match the tool's output schema/,
      );
      await expect(session.callTool("label", { label: "É" })).resolves.toMatchObject({
        structuredContent: { label: "É" },
      });
      await expect(session.callTool("label", { label: "A1" })).rejects.toThrow(
        /does not match the tool's output schema/,
      );
      expect(sink.events.map((event) => event.message)).toEqual([
        "mcp output schema pattern is invalid under unicode regular expressions; validating without it",
      ]);
    } finally {
      await session.close();
    }
  });

  it("is the SDK default that fails the whole list", async () => {
    const transport = new StreamableHTTPClientTransport(new URL("https://mcp.example.test/mcp"), {
      fetch: fixtureFetch(),
    });
    const client = new Client({ name: "bare", version: "0.1.0" });
    try {
      await client.connect(transport);
      await expect(client.listTools()).rejects.toThrow(/Invalid escape/);
    } finally {
      await client.close();
    }
  });
});
