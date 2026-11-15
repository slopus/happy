import type { Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import type { RejectedProviderRequest } from "./provider-request-shape.js";
import {
  attachRejectedRequests,
  rejectedRequestsOf,
  summarizeProviderRequest,
  withRejectedRequestCapture,
} from "./provider-request-shape.js";

const SECRETS = [
  "PROMPT-TEXT-secret",
  "SYSTEM-PROMPT-secret",
  "TOOL-ARGS-secret",
  "TOOL-RESULT-secret",
  "IMAGE-DATA-secret",
  "sk-live-KEY-secret",
  "CACHE-KEY-secret",
  "USER-ID-secret",
  "ACCOUNT-ID-secret",
  "Bearer TOKEN-secret",
];

const responsesBody = {
  model: "gpt-test",
  store: false,
  stream: true,
  instructions: "SYSTEM-PROMPT-secret",
  input: [
    { role: "user", content: [{ type: "input_text", text: "PROMPT-TEXT-secret" }] },
    { role: "user", content: [{ type: "input_image", image_url: "IMAGE-DATA-secret" }] },
    { type: "function_call", name: "search", arguments: '{"q":"TOOL-ARGS-secret"}' },
    { type: "function_call_output", call_id: "c1", output: "TOOL-RESULT-secret" },
    { role: "assistant", content: [{ type: "output_text", text: "PROMPT-TEXT-secret" }] },
  ],
  text: {
    verbosity: "low",
    format: { type: "json_schema", schema: { title: "TOOL-ARGS-secret" } },
  },
  include: ["reasoning.encrypted_content"],
  prompt_cache_key: "CACHE-KEY-secret",
  safety_identifier: "USER-ID-secret",
  metadata: { user: "USER-ID-secret", type: "USER-ID-secret" },
  tool_choice: "auto",
  parallel_tool_calls: true,
  temperature: 0.2,
  max_output_tokens: 4096,
  reasoning: { effort: "high", summary: "auto" },
  api_key: "sk-live-KEY-secret",
  tools: [
    { type: "function", name: "search", description: "PROMPT-TEXT-secret", parameters: {} },
    { type: "web_search" },
  ],
};

describe("summarizeProviderRequest", () => {
  it("describes a request's structure without any content or secret", () => {
    const shape = summarizeProviderRequest(responsesBody);
    expect(shape).toMatchObject({
      keys: expect.arrayContaining(["input", "instructions", "reasoning", "tools"]),
      params: {
        model: "gpt-test",
        store: false,
        stream: true,
        "text.verbosity": "low",
        "text.format.type": "json_schema",
        include: ["reasoning.encrypted_content"],
        prompt_cache_key: "string",
        safety_identifier: "string",
        tool_choice: "auto",
        parallel_tool_calls: true,
        temperature: 0.2,
        max_output_tokens: 4096,
        "reasoning.effort": "high",
        "reasoning.summary": "auto",
        api_key: "string",
      },
      tools: {
        count: 2,
        maxNameLength: 6,
        invalidNames: 0,
        duplicateNames: 0,
        lists: [
          {
            at: "tools",
            tools: ["search 86B root=untyped", "(unnamed) 21B web_search"],
          },
        ],
      },
      messages: {
        count: 5,
        items: [
          "user:input_text",
          "user:input_image",
          "function_call",
          "function_call_output",
          "assistant:output_text",
        ],
      },
    });
    expect(shape?.bytes).toBeGreaterThan(0);
    expect(shape?.params).not.toHaveProperty("metadata.user");
    const serialized = JSON.stringify(shape);
    for (const secret of SECRETS) expect(serialized).not.toContain(secret);
  });

  it("reads chat and generate-content bodies and collapses repeated entries", () => {
    expect(
      summarizeProviderRequest({
        messages: [
          { role: "system", content: "SYSTEM-PROMPT-secret" },
          { role: "user", content: "PROMPT-TEXT-secret" },
          { role: "user", content: "PROMPT-TEXT-secret" },
          { role: "tool", tool_call_id: "c1", content: "TOOL-RESULT-secret" },
        ],
        tools: [{ type: "function", function: { name: "lookup", parameters: {} } }],
      }),
    ).toMatchObject({
      tools: {
        count: 1,
        lists: [{ at: "tools", tools: ["lookup 64B root=untyped"] }],
      },
      messages: { count: 4, items: ["system:text", "user:text x2", "tool:text"] },
    });
    expect(
      summarizeProviderRequest({
        contents: [
          {
            role: "model",
            parts: [{ functionCall: { name: "x", args: { q: "TOOL-ARGS-secret" } } }],
          },
        ],
        tools: [{ functionDeclarations: [{ name: "x" }, { name: "y" }] }],
        generationConfig: { maxOutputTokens: 100, thinkingConfig: { thinkingBudget: 512 } },
      }),
    ).toMatchObject({
      tools: { count: 2, maxNameLength: 1, lists: [{ at: "tools", tools: ["x 12B", "y 12B"] }] },
      messages: { items: ["model:functionCall"] },
      params: {
        "generationConfig.maxOutputTokens": 100,
        "generationConfig.thinkingConfig.thinkingBudget": 512,
      },
    });
  });

  it("keeps a string setting only when it is a known enum", () => {
    const shape = summarizeProviderRequest({
      model: "PROMPT TEXT secret with spaces",
      service_tier: "flex",
      user: "USER-ID-secret",
    });
    expect(shape?.params).toEqual({ model: "string", service_tier: "flex", user: "string" });
  });
});

describe("tool definitions", () => {
  it("lists every declared tool with its size and what could make it invalid, never its schema", () => {
    const strictTool = {
      type: "function",
      name: "lookup",
      description: "PROMPT-TEXT-secret",
      strict: true,
      parameters: {
        type: "object",
        properties: {
          not: { type: "string", description: "TOOL-ARGS-secret" },
          filter: { oneOf: [{ $ref: "#/$defs/range" }, { type: "string" }] },
        },
        $defs: { range: { type: "object", patternProperties: { "^x": { type: "number" } } } },
      },
    };
    const shape = summarizeProviderRequest({
      tools: [{ type: "function", name: "acme-server_search", parameters: { type: "object" } }],
      input: [
        { type: "additional_tools", role: "developer", tools: [strictTool] },
        { role: "user", content: "PROMPT-TEXT-secret" },
        {
          type: "tool_search_output",
          tools: [
            { ...strictTool, defer_loading: true },
            { type: "function", name: "has spaces", parameters: { type: "string" } },
          ],
        },
      ],
    });
    const uses = "uses=$defs,$ref,oneOf,patternProperties";
    expect(shape?.tools).toEqual({
      count: 4,
      maxNameLength: 18,
      invalidNames: 1,
      duplicateNames: 0,
      lists: [
        {
          at: "tools",
          tools: [
            `acme-server_search ${byteLength({ type: "function", name: "acme-server_search", parameters: { type: "object" } })}B`,
          ],
        },
        { at: "input.0", tools: [`lookup ${byteLength(strictTool)}B strict ${uses}`] },
        {
          at: "input.2",
          tools: [
            `lookup ${byteLength({ ...strictTool, defer_loading: true })}B strict deferred ${uses}`,
            expect.stringMatching(/^has spaces \d+B root=string$/),
          ],
        },
      ],
    });
    const serialized = JSON.stringify(shape);
    for (const secret of SECRETS) expect(serialized).not.toContain(secret);
  });

  it("keeps only the newest tool lists of a long history", () => {
    const load = (index: number) => ({
      type: "additional_tools",
      tools: [{ type: "function", name: `t${index}`, parameters: { type: "object" } }],
    });
    const tools = summarizeProviderRequest({
      input: Array.from({ length: 25 }, (_, index) => load(index)),
    })?.tools;
    expect(tools).toMatchObject({ count: 25, omittedLists: 5 });
    expect(tools?.lists.map((list) => list.at)).toEqual(
      Array.from({ length: 20 }, (_, index) => `input.${index + 5}`),
    );
  });

  it("counts an unnamed tool as invalid and scans every schema position", () => {
    const tools = summarizeProviderRequest({
      tools: [
        { type: "function", parameters: { type: "object" } },
        {
          type: "function",
          name: "x",
          parameters: {
            type: "object",
            dependencies: { a: { oneOf: [] } },
            additionalItems: { $ref: "#" },
          },
        },
      ],
    })?.tools;
    expect(tools?.invalidNames).toBe(1);
    expect(tools?.lists[0]?.tools[1]).toMatch(/ uses=\$ref,dependencies,oneOf$/);
  });

  it("counts a name declared twice in one list", () => {
    const tool = { type: "function", name: "x", parameters: { type: "object" } };
    expect(summarizeProviderRequest({ tools: [tool, tool] })?.tools?.duplicateNames).toBe(1);
  });
});

function byteLength(value: unknown) {
  return Buffer.byteLength(JSON.stringify(value));
}

describe("request size", () => {
  it("counts the encoded bytes, not characters", () => {
    expect(summarizeProviderRequest({ messages: [{ role: "user", content: "é" }] })?.bytes).toBe(
      Buffer.byteLength(JSON.stringify({ messages: [{ role: "user", content: "é" }] })),
    );
  });
});

describe("withRejectedRequestCapture", () => {
  const model = { provider: "test-provider", id: "test-model" } as Model<"openai-responses">;

  async function send(status: number, headers: Record<string, string> = {}) {
    let rejection: RejectedProviderRequest | undefined;
    const base: SimpleStreamOptions = {
      onPayload: (body) => ({ ...(body as object), relabelled: true }),
    };
    const options = withRejectedRequestCapture(base, (value) => {
      rejection = value;
    });
    await options.onPayload?.(responsesBody, model);
    await options.onResponse?.({ status, headers }, model);
    return rejection;
  }

  it("reports the final body's shape for a 4xx", async () => {
    const rejection = await send(400, { "X-Request-Id": "req_123" });
    expect(rejection).toMatchObject({
      provider: "test-provider",
      model: "test-model",
      status: 400,
      requestId: "req_123",
      body: { params: { relabelled: true } },
    });
    const serialized = JSON.stringify(rejection);
    for (const secret of SECRETS) expect(serialized).not.toContain(secret);
  });

  it("reports a success, so recovered rejections drop, but not a server error", async () => {
    const reported: unknown[] = [];
    const options = withRejectedRequestCapture({} as SimpleStreamOptions, (value) =>
      reported.push(value),
    );
    await options.onResponse?.({ status: 500, headers: {} }, model);
    await options.onResponse?.({ status: 302, headers: {} }, model);
    expect(reported).toEqual([]);
    await options.onResponse?.({ status: 200, headers: {} }, model);
    expect(reported).toEqual([undefined]);
  });
});

describe("attachRejectedRequests", () => {
  it("carries every attempt's rejection on the error it is attached to only", () => {
    const primary = { provider: "p", model: "m", status: 400 };
    const backup = { provider: "b", model: "n", status: 404 };
    const error = attachRejectedRequests(new Error("Bad Request"), [primary, backup]);
    expect(rejectedRequestsOf(error)).toEqual([primary, backup]);
    expect(rejectedRequestsOf(new Error("Bad Request"))).toBeUndefined();
    expect(rejectedRequestsOf(attachRejectedRequests(new Error("x"), []))).toBeUndefined();
  });
});
