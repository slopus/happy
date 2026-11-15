// A stand-in for the `claude` CLI that speaks its stream-json protocol, for offline tests.
// Usage: node fake-cli.test-support.mjs <scenario> <record file> ...cli args
import { spawn } from "node:child_process";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const [scenario, recordPath, ...args] = process.argv.slice(2);
const out = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
const stream = (event) => out({ type: "stream_event", event });

/** Prints a subcommand's output and exits once it is flushed. */
const reply = (text, code = 0) => process.stdout.write(text, () => process.exit(code));

if (
  (scenario === "hang-version" && args[0] === "--version") ||
  (scenario === "hang-auth" && args[0] === "auth")
) {
  writeFileSync(recordPath, JSON.stringify({ args }));
  setTimeout(() => writeFileSync(`${recordPath}.survived`, ""), 1_000);
  setInterval(() => {}, 1_000);
} else if (args[0] === "--version") {
  reply(scenario === "old-version" ? "2.0.1 (Claude Code)\n" : "2.1.311 (Claude Code)\n");
} else if (args[0] === "auth") {
  // The real command also names the account; the bridge must read only `loggedIn`.
  const signedIn = scenario !== "signed-out";
  reply(
    `${JSON.stringify({ loggedIn: signedIn, authMethod: "claude.ai", email: "someone@example.com" })}\n`,
    signedIn ? 0 : 1,
  );
} else {
  await chat();
}

/** Talks to the tool inventory server the way the CLI would. */
async function inventory() {
  const at = args.indexOf("--mcp-config");
  if (at < 0) return { tools: [] };
  const server = JSON.parse(readFileSync(args[at + 1], "utf8")).mcpServers.rakazo;
  const child = spawn(server.command, server.args, { stdio: ["pipe", "pipe", "inherit"] });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const request = async (id, method, params) => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return JSON.parse((await lines.next()).value);
  };
  const init = await request(1, "initialize", { protocolVersion: "2025-06-18" });
  const { result } = await request(2, "tools/list", {});
  const call = await request(3, "tools/call", { name: result.tools[0]?.name, arguments: {} });
  child.kill();
  return { init: init.result, tools: result.tools, call: call.result };
}

/** Answers one stream-json request the way the CLI would, by scenario. */
async function chat() {
  writeFileSync(`${recordPath}.spawned`, "");
  if (scenario === "slow-reply") await new Promise((resolve) => setTimeout(resolve, 300));
  const tools = await inventory();
  out({
    type: "system",
    subtype: "init",
    tools:
      scenario === "built-in-tools"
        ? ["Bash", "Read"]
        : tools.tools.map((tool) => `mcp__rakazo__${tool.name}`),
    mcp_servers:
      tools.tools.length && scenario !== "no-tool-server"
        ? [{ name: "rakazo", status: "connected" }]
        : [],
  });
  if (scenario === "deaf") {
    // Stays up without reading its input, so a large write never completes.
    setInterval(() => {}, 60_000);
    return;
  }

  const frames = [];
  for await (const line of createInterface({ input: process.stdin })) {
    const frame = JSON.parse(line);
    frames.push(frame);
    if (frame.type === "user" && frame.shouldQuery === false) {
      out({
        type: "result",
        subtype: "success",
        is_error: false,
        num_turns: scenario === "no-replay" ? 1 : 0,
      });
    }
  }
  const system = readFileSync(args[args.indexOf("--system-prompt-file") + 1], "utf8");
  writeFileSync(
    recordPath,
    JSON.stringify({
      args,
      env: process.env,
      cwd: process.cwd(),
      cwdEntries: readdirSync(process.cwd()),
      cwdMode: statSync(process.cwd()).mode & 0o777,
      system,
      frames,
      tools,
    }),
  );

  /** Writes a marker if the process is still running later, which it should not be. */
  function lingerAfter(ms) {
    setTimeout(() => {
      writeFileSync(`${recordPath}.survived`, "still running");
      process.exit(0);
    }, ms);
  }

  const usage = {
    input_tokens: 12,
    cache_read_input_tokens: 3,
    cache_creation_input_tokens: 4,
    output_tokens: 1,
  };
  const failWith = (error, text) => {
    out({
      type: "assistant",
      error,
      message: { role: "assistant", content: [{ type: "text", text }] },
    });
    out({ type: "result", subtype: "success", is_error: true, num_turns: 1, result: text });
  };

  switch (scenario) {
    case "slow-reply":
    case "late-error":
    case "reply": {
      stream({
        type: "message_start",
        message: { id: "msg_1", model: "claude-sonnet-5", usage },
      });
      stream({ type: "content_block_start", index: 0, content_block: { type: "thinking" } });
      stream({
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "Let me think." },
      });
      stream({
        type: "content_block_delta",
        index: 0,
        delta: { type: "signature_delta", signature: "sig-1" },
      });
      stream({ type: "content_block_stop", index: 0 });
      stream({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } });
      stream({
        type: "content_block_delta",
        index: 1,
        delta: { type: "text_delta", text: "Hello" },
      });
      stream({
        type: "content_block_delta",
        index: 1,
        delta: { type: "text_delta", text: " there" },
      });
      stream({ type: "content_block_stop", index: 1 });
      stream({
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 7 },
      });
      stream({ type: "message_stop" });
      out({
        type: "result",
        subtype: "success",
        is_error: scenario === "late-error",
        num_turns: 1,
        ...(scenario === "late-error" ? { result: "API Error: 503 final result failed" } : {}),
      });
      break;
    }
    case "unoffered-tool":
    case "wrong-prefix":
    case "bare-tool":
    case "incomplete-tool":
    case "tool": {
      process.on("SIGTERM", () => {});
      stream({ type: "message_start", message: { id: "msg_2", usage } });
      stream({
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: "toolu_1",
          name:
            {
              "unoffered-tool": "mcp__rakazo__feedback",
              "wrong-prefix": "mcp__other__lookup",
              "bare-tool": "lookup",
            }[scenario] ?? "mcp__rakazo__lookup",
          input: {},
        },
      });
      stream({
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"city":' },
      });
      stream({
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '"Taipei"}' },
      });
      if (scenario !== "incomplete-tool") stream({ type: "content_block_stop", index: 0 });
      stream({
        type: "message_delta",
        delta: { stop_reason: "tool_use" },
        usage: { output_tokens: 9 },
      });
      stream({ type: "message_stop" });
      // A CLI that kept going would run the tool or ask the model again.
      lingerAfter(800);
      break;
    }
    case "hang": {
      stream({ type: "message_start", message: { id: "msg_3", usage } });
      stream({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
      stream({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Partial" },
      });
      lingerAfter(800);
      break;
    }
    case "rate-limit":
      failWith(
        "rate_limit",
        'API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"Number of requests has exceeded your rate limit"}}',
      );
      break;
    case "usage-limit":
      failWith("rate_limit", "You've hit your usage limit for this plan.");
      break;
    case "billing":
      failWith("billing_error", "Your credit balance is too low to access the API.");
      break;
    case "rejected-login":
      failWith("authentication_failed", "Invalid API key · Please run /login");
      break;
    case "not-json":
      process.stdout.write("Welcome to Claude Code!\n");
      break;
    case "crash":
      process.stderr.write("fatal: token sk-fake-123 was rejected\n");
      process.exit(3);
      break;
    default:
      out({ type: "result", subtype: "success", is_error: false, num_turns: 1 });
  }
}
