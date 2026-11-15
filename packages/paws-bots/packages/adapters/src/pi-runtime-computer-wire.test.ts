import { zstdDecompressSync } from "node:zlib";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import type { AgentRunModel } from "@rakazo/adapter-kit";
import { expect, it, vi } from "vitest";
import { computerTarget } from "./pi-runtime-computer-mode.js";

const claude: AgentRunModel = {
  provider: "anthropic",
  id: "claude-sonnet-4-5",
  connectionId: "claude-account",
  apiKey: "fixture-claude-key",
};
const codex: AgentRunModel = {
  provider: "openai-codex",
  id: "gpt-5.3-codex",
  connectionId: "codex-account",
  acceptsImages: true,
  oauth: {
    credential: {
      type: "oauth",
      access: `fake.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" } })).toString("base64url")}.fake`,
      refresh: "fixture-refresh",
      expires: 9999999999999,
      accountId: "fixture-account",
    },
  },
};
const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
function assistant(config: AgentRunModel, name: string): AssistantMessage {
  return {
    role: "assistant",
    provider: config.provider,
    model: config.id,
    api: config.provider === "anthropic" ? "anthropic-messages" : "openai-codex-responses",
    content: [
      {
        type: "thinking",
        thinking: `${config.provider} reasoning`,
        thinkingSignature:
          config.provider === "anthropic"
            ? "claude-signature"
            : JSON.stringify({
                type: "reasoning",
                id: "rs_fixture",
                encrypted_content: "codex-encrypted",
                summary: [],
              }),
      },
      {
        type: "toolCall",
        id: config.provider === "anthropic" ? `toolu_${name}` : `call_${name}|fc_${name}`,
        name,
        arguments: {},
      },
    ],
    usage,
    stopReason: "toolUse",
    timestamp: 1,
  };
}
function exchange(config: AgentRunModel, name: string): Message[] {
  const call = assistant(config, name);
  return [
    call,
    {
      role: "toolResult",
      toolCallId: (call.content[1] as { id: string }).id,
      toolName: name,
      content: [{ type: "text", text: `${name} completed once` }],
      isError: false,
      timestamp: 2,
    },
  ];
}

// Exercise installed Pi serializers, not a mock stream: all network I/O is intercepted.
// Native messages retain their origin metadata so Pi can translate foreign reasoning,
// strip incompatible signatures and normalize tool ids and their results together.
it.each([false, true])(
  "serializes Claude -> Codex -> Claude and reverse without foreign reasoning/auth on the wire (reverse=%s)",
  async (reverse) => {
    const main = reverse ? codex : claude;
    const computer = reverse ? claude : codex;
    const messages: Message[] = [
      { role: "user", content: "Use the computer", timestamp: 0 },
      ...exchange(main, "enter_computer_mode"),
    ];
    for (const config of [computer, main]) {
      const target = computerTarget(config);
      let wire:
        | {
            url: string;
            headers: Headers;
            body: {
              messages: { content: { type: string; id: string; tool_use_id: string }[] | string }[];
              input: { type: string; call_id: string }[];
            };
          }
        | undefined;
      const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        const bytes = Buffer.from(await request.arrayBuffer());
        const body =
          request.headers.get("content-encoding") === "zstd" ? zstdDecompressSync(bytes) : bytes;
        wire = { url: request.url, headers: request.headers, body: JSON.parse(body.toString()) };
        // A deterministic terminal rejection is sufficient to inspect the actual serialized request.
        return new Response(
          JSON.stringify({ error: { message: "fixture stop", type: "invalid_request_error" } }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      });
      const stream = target.models.streamSimple(
        target.model,
        { messages },
        {
          apiKey: target.credentials?.accessToken ?? target.apiKey,
          fetch,
          transport: "sse",
        },
      );
      const result = await stream.result();
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(wire, result.errorMessage).toBeDefined();
      const payload = JSON.stringify(wire!.body);
      if (config.provider === "anthropic") {
        expect(wire!.url).toContain("api.anthropic.com/v1/messages");
        expect(wire!.headers.get("x-api-key")).toBe(claude.apiKey);
        expect(wire!.headers.get("authorization")).toBeNull();
        expect(payload).not.toContain("codex-encrypted");
        expect(payload).not.toContain("rs_fixture");
        const blocks = wire!.body.messages.flatMap((m: { content: unknown }) =>
          Array.isArray(m.content) ? m.content : [],
        );
        const calls = blocks.filter((b: { type: string }) => b.type === "tool_use");
        const results = blocks.filter((b: { type: string }) => b.type === "tool_result");
        expect(results.map((b: { tool_use_id: string }) => b.tool_use_id)).toEqual(
          calls.map((b: { id: string }) => b.id),
        );
        expect(calls.length).toBeGreaterThan(0);
        for (const call of calls) expect(call.id).toMatch(/^[a-zA-Z0-9_-]+$/);
      } else {
        expect(wire!.url).toContain("chatgpt.com/backend-api/codex/responses");
        expect(wire!.headers.get("authorization")).toBe(`Bearer ${codex.oauth!.credential.access}`);
        expect(wire!.headers.get("x-api-key")).toBeNull();
        expect(payload).not.toContain("claude-signature");
        const calls = wire!.body.input.filter((b: { type: string }) => b.type === "function_call");
        const results = wire!.body.input.filter(
          (b: { type: string }) => b.type === "function_call_output",
        );
        expect(results.map((b: { call_id: string }) => b.call_id)).toEqual(
          calls.map((b: { call_id: string }) => b.call_id),
        );
        expect(calls.length).toBeGreaterThan(0);
      }
      expect(payload).toContain("enter_computer_mode completed once");
      expect(payload).not.toContain("fixture-claude-key");
      messages.push(...exchange(computer, "leave_computer_mode"));
    }
  },
);

// Screenshots from computer mode stay in the transcript. A text-only main model must not
// receive them after leave_computer_mode: Pi's serializer replaces each image with text.
it("sends a text-only main model placeholders, not screenshots, after computer mode", async () => {
  const target = computerTarget(claude);
  const textOnly = { ...target.model, input: ["text" as const] };
  const screenshot = "c2NyZWVuc2hvdC1maXh0dXJlLWJ5dGVz";
  const observe = assistant(codex, "computer_observe");
  const messages: Message[] = [
    { role: "user", content: "Use the computer", timestamp: 0 },
    ...exchange(claude, "enter_computer_mode"),
    observe,
    {
      role: "toolResult",
      toolCallId: (observe.content[1] as { id: string }).id,
      toolName: "computer_observe",
      content: [
        { type: "text", text: "Observed the desktop" },
        { type: "image", data: screenshot, mimeType: "image/png" },
      ],
      isError: false,
      timestamp: 3,
    },
    ...exchange(codex, "leave_computer_mode"),
  ];
  let payload = "";
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    payload = await new Request(input, init).text();
    return new Response(
      JSON.stringify({ error: { message: "fixture stop", type: "invalid_request_error" } }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
  });
  await target.models
    .streamSimple(textOnly, { messages }, { apiKey: claude.apiKey, fetch, transport: "sse" })
    .result();
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(payload).toContain("Observed the desktop");
  expect(payload).not.toContain(screenshot);
  expect(payload).not.toContain('"type":"image"');
  expect(payload).toContain("image omitted");
});
