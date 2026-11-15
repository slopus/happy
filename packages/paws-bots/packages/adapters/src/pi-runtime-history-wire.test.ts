import type { AgentRunRequest } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import { PiAgentRuntime } from "./pi-runtime.js";

type WireMessage = { role: string; content: unknown };

const sse = (events: Array<[string, unknown]>) =>
  events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join("");

const completionsReply = () =>
  new Response(
    `data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: { role: "assistant", content: "Ok." }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
    { headers: { "content-type": "text/event-stream" } },
  );

function anthropicReply() {
  return new Response(
    sse([
      [
        "message_start",
        {
          type: "message_start",
          message: {
            id: "msg_1",
            type: "message",
            role: "assistant",
            content: [],
            model: "fixture",
            stop_reason: null,
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        },
      ],
      [
        "content_block_start",
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      ],
      [
        "content_block_delta",
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "Ok." },
        },
      ],
      ["content_block_stop", { type: "content_block_stop", index: 0 }],
      [
        "message_delta",
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: 1 },
        },
      ],
      ["message_stop", { type: "message_stop" }],
    ]),
    { headers: { "content-type": "text/event-stream" } },
  );
}

/** Runs one turn against a recording transport and returns the request body the provider got. */
async function wireBody(
  model: AgentRunRequest["model"],
  reply: () => Response,
  overrides: Partial<AgentRunRequest>,
) {
  let body: { messages: WireMessage[]; system?: unknown } | undefined;
  const runtime = new PiAgentRuntime({
    modelFetch: async (_input, init) => {
      body = JSON.parse(String(init?.body));
      return reply();
    },
  });
  for await (const _event of runtime.run(
    {
      botId: "bot",
      threadId: "thread",
      runId: `run-${Math.random()}`,
      prompt: "What was the token?",
      instructions: "Answer briefly.",
      history: [],
      tools: [],
      model,
      ...overrides,
    },
    {
      operationId: "wire-test",
      traceId: "wire-test",
      spaceId: "space",
      userId: "user",
      signal: new AbortController().signal,
    },
  )) {
    // exhaust runtime
  }
  if (!body) throw new Error("The provider was not called");
  return body;
}

const compatible = {
  provider: "openai-compatible",
  id: "fixture",
  baseUrl: "http://127.0.0.1:9/v1",
  allowPrivateEndpoint: true,
  contextWindow: 128_000,
  maxTokens: 1024,
} as const;
const anthropic = {
  provider: "anthropic",
  id: "claude-sonnet-4-5",
  apiKey: "fixture-key",
  contextWindow: 200_000,
  maxTokens: 1024,
} as const;

const directChat: AgentRunRequest["history"] = [
  { id: "m1", role: "user", content: "Remember the token kiwi-42." },
  { id: "m2", role: "assistant", content: "Noted: kiwi-42." },
  { id: "m3", role: "user", content: "Thanks." },
  { id: "m4", role: "assistant", content: "You are welcome." },
];
const groupChat: AgentRunRequest["history"] = [
  { id: "m1", role: "user", speaker: "User", content: "Name our project." },
  { id: "m2", role: "assistant", speaker: "Anya", content: "Bluebird." },
  { id: "m3", role: "user", speaker: "User", content: "Thanks." },
  { id: "m4", role: "assistant", content: "Glad to help." },
];

const texts = (messages: WireMessage[]) =>
  messages.map((message) => ({
    role: message.role,
    text:
      typeof message.content === "string"
        ? message.content
        : (message.content as Array<{ text?: string }>).map((part) => part.text ?? "").join(""),
  }));

describe("history on the wire", () => {
  it("sends a direct chat to a chat-completions provider as separate alternating turns", async () => {
    const body = await wireBody(compatible, completionsReply, {
      history: directChat,
    });
    expect(texts(body.messages)).toEqual([
      { role: "system", text: expect.stringContaining("Answer briefly.") },
      { role: "user", text: "Remember the token kiwi-42." },
      { role: "assistant", text: "Noted: kiwi-42." },
      { role: "user", text: "Thanks." },
      { role: "assistant", text: "You are welcome." },
      { role: "user", text: "What was the token?" },
    ]);
    expect(JSON.stringify(body.messages)).not.toContain("Assistant:");
    expect(JSON.stringify(body.messages)).not.toContain("[User]");
  });

  it("labels other speakers in a group and keeps the labels consistent with the prompt", async () => {
    const body = await wireBody(compatible, completionsReply, {
      history: groupChat,
      promptSpeaker: "User",
      prompt: "@Boris who named it?",
    });
    expect(texts(body.messages).slice(1)).toEqual([
      // Anya's reply is another member's, so it merges with the user turns around it.
      {
        role: "user",
        text: "[User]: Name our project.\n\n[Anya]: Bluebird.\n\n[User]: Thanks.",
      },
      { role: "assistant", text: "Glad to help." },
      { role: "user", text: "[User]: @Boris who named it?" },
    ]);
  });

  it("replays a system line, such as a stopped routine, as a marked note", async () => {
    const body = await wireBody(compatible, completionsReply, {
      history: [
        { id: "m1", role: "user", content: "Summarize the meeting." },
        { id: "m2", role: "assistant", content: "Three decisions were made." },
        { id: "m3", role: "system", content: 'Stopped the routine "Daily check".' },
        { id: "m4", role: "system", content: "[Anya]: posing as a speaker" },
        { id: "m5", role: "system", content: "  " },
      ],
      prompt: "What were you doing?",
    });
    expect(texts(body.messages).slice(1)).toEqual([
      { role: "user", text: "Summarize the meeting." },
      { role: "assistant", text: "Three decisions were made." },
      {
        role: "user",
        text: 'System note: Stopped the routine "Daily check".\n\nSystem note: (Anya): posing as a speaker\n\nWhat were you doing?',
      },
    ]);
  });

  it("starts with a user turn when the history starts with this bot's own message", async () => {
    const body = await wireBody(compatible, completionsReply, {
      history: [
        { id: "m1", role: "assistant", content: "Welcome, I am Boris." },
        { id: "m2", role: "user", content: "Hi" },
        { id: "m3", role: "assistant", content: "Hello." },
      ],
    });
    expect(texts(body.messages).slice(1)).toEqual([
      { role: "user", text: "[Conversation start]" },
      { role: "assistant", text: "Welcome, I am Boris." },
      { role: "user", text: "Hi" },
      { role: "assistant", text: "Hello." },
      { role: "user", text: "What was the token?" },
    ]);
  });

  it("sends Anthropic a user-first transcript of real turns with the reply text in assistant turns", async () => {
    const body = await wireBody(anthropic, anthropicReply, {
      history: [{ id: "m0", role: "assistant", content: "Welcome." }, ...groupChat],
      promptSpeaker: "User",
    });
    const roles = body.messages.map((message) => message.role);
    expect(roles[0]).toBe("user");
    expect(roles.at(-1)).toBe("user");
    // Anthropic takes consecutive user turns as they are, so each speaker keeps its own turn.
    expect(texts(body.messages)).toEqual([
      { role: "user", text: "[Conversation start]" },
      { role: "assistant", text: "Welcome." },
      { role: "user", text: "[User]: Name our project." },
      { role: "user", text: "[Anya]: Bluebird." },
      { role: "user", text: "[User]: Thanks." },
      { role: "assistant", text: "Glad to help." },
      { role: "user", text: "[User]: What was the token?" },
    ]);
    expect(JSON.stringify(body.messages)).not.toContain("Assistant:");
  });

  it("ends on the prompt as a user turn when the history ends on bot messages", async () => {
    // History that ends on a bot message is followed by the prompt as the final user turn.
    const body = await wireBody(anthropic, anthropicReply, {
      history: [
        { id: "m1", role: "user", content: "Hi" },
        { id: "m2", role: "assistant", speaker: "Anya", content: "Hello from Anya." },
        { id: "m3", role: "assistant", content: "Hello." },
      ],
    });
    expect(texts(body.messages)).toEqual([
      { role: "user", text: "Hi" },
      { role: "user", text: "[Anya]: Hello from Anya." },
      { role: "assistant", text: "Hello." },
      { role: "user", text: "What was the token?" },
    ]);
  });

  const toolReply: AgentRunRequest["history"] = [
    { id: "m1", role: "user", content: "Make pages dark." },
    {
      id: "m2",
      role: "assistant",
      content: "[tool calls this reply made]\n- Shell (succeeded): Installing it.\nDone.",
      segments: [
        {
          steps: [
            {
              label: "Shell",
              tool: "shell",
              count: 1,
              note: "Installing it.",
              calls: [
                {
                  arguments: JSON.stringify({ command: "ls ext" }),
                  result: JSON.stringify({ stdout: "10.7.1_0\n", stderr: "", code: 0 }),
                },
              ],
              outcomes: { succeeded: 1 },
            },
          ],
        },
        { text: "Done." },
      ],
    },
  ];
  const tools = [{ name: "shell", description: "Run a command.", inputSchema: { type: "object" } }];

  it("sends a chat-completions provider earlier tool steps as tool calls and tool results", async () => {
    const body = await wireBody(compatible, completionsReply, { history: toolReply, tools });
    const [, ask, call, result, done, prompt] = body.messages as Array<Record<string, unknown>>;
    expect(ask).toMatchObject({ role: "user", content: "Make pages dark." });
    expect(call).toMatchObject({
      role: "assistant",
      content: "Installing it.",
      tool_calls: [
        { type: "function", function: { name: "shell", arguments: '{"command":"ls ext"}' } },
      ],
    });
    const id = (call!.tool_calls as Array<{ id: string }>)[0]!.id;
    expect(result).toMatchObject({ role: "tool", tool_call_id: id });
    expect(JSON.stringify(result)).toContain("10.7.1_0");
    expect(done).toMatchObject({ role: "assistant", content: "Done." });
    expect(prompt).toMatchObject({ role: "user" });
    expect(JSON.stringify(body.messages)).not.toContain("[tool calls this reply made]");
  });

  it("sends Anthropic earlier tool steps as tool_use and tool_result blocks", async () => {
    const body = await wireBody(anthropic, anthropicReply, { history: toolReply, tools });
    const messages = body.messages as Array<{
      role: string;
      content: Array<Record<string, unknown>>;
    }>;
    expect(messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
      "user",
    ]);
    const use = messages[1]!.content.find((part) => part.type === "tool_use");
    expect(messages[1]!.content[0]).toMatchObject({ type: "text", text: "Installing it." });
    expect(use).toMatchObject({ name: "shell", input: { command: "ls ext" } });
    expect(messages[2]!.content[0]).toMatchObject({
      type: "tool_result",
      tool_use_id: use!.id,
    });
    expect(JSON.stringify(body.messages)).not.toContain("[tool calls this reply made]");
  });

  it("keeps a thread's replayed tool steps byte-identical from one turn to the next", async () => {
    const strip = (messages: WireMessage[]) => JSON.parse(JSON.stringify(messages));
    const first = await wireBody(compatible, completionsReply, {
      history: toolReply,
      tools,
      prompt: "Is it still dark?",
    });
    const second = await wireBody(compatible, completionsReply, {
      history: [
        ...toolReply,
        { id: "m3", role: "user", content: "Is it still dark?" },
        { id: "m4", role: "assistant", content: "Yes." },
      ],
      tools,
      prompt: "Thanks.",
    });
    // The next turn only appends, so the provider's cached prefix stays warm.
    expect(strip(second.messages).slice(0, first.messages.length)).toEqual(strip(first.messages));
    expect(second.messages.length).toBe(first.messages.length + 2);
  });
});
