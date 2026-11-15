import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  ImageContent,
  Model,
  SimpleStreamOptions,
  TextContent,
  ToolCall,
  ToolResultMessage,
  TranscriptContext,
  Usage,
  UserMessage,
} from "@earendil-works/pi-ai";
import {
  createAssistantMessageEventStream,
  getCurrentSystemPrompt,
  getCurrentTools,
  parseStreamingJson,
  parseToolCallArguments,
} from "@earendil-works/pi-ai";
import {
  splitErrorToolResultImages,
  transformMessages,
} from "@earendil-works/pi-ai/api/transform-messages";
import { sanitizeSensitiveText } from "../../pi-runtime-errors.js";
import { modelStreamIdleTimeoutMs } from "../../pi-runtime-limits.js";
import type { ClaudeCodeProcess } from "./cli.js";
import {
  CLAUDE_CODE_NOT_INSTALLED_ERROR,
  CLAUDE_CODE_SIGNED_OUT_ERROR,
  checkClaudeCode,
  claudeCodeEnv,
  startClaudeCode,
} from "./cli.js";

/** The CLI lists each MCP tool as `mcp__<server>__<tool>`. */
const TOOL_SERVER = "rakazo";
const TOOL_PREFIX = `mcp__${TOOL_SERVER}__`;

/**
 * A stdio MCP server that only lists Rakazo's tools to the CLI. It never runs one: the CLI runs
 * in `dontAsk` mode with nothing allowed and stops after one turn, so a tool call comes back to
 * Rakazo, which runs it with its own approvals.
 */
const INVENTORY_SERVER = `import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
const tools = JSON.parse(readFileSync(process.argv[2], "utf8"));
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
for await (const line of createInterface({ input: process.stdin })) {
  let request;
  try { request = JSON.parse(line); } catch { continue; }
  if (request === null || typeof request !== "object" || request.id === undefined) continue;
  const { id, method, params } = request;
  if (method === "initialize") {
    send({ id, result: {
      protocolVersion: params?.protocolVersion ?? "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "${TOOL_SERVER}", version: "1" },
    } });
  } else if (method === "tools/list") {
    send({ id, result: { tools } });
  } else if (method === "tools/call") {
    send({ id, result: { isError: true, content: [{ type: "text", text: "Rakazo runs its tools itself." }] } });
  } else if (method === "ping") {
    send({ id, result: {} });
  } else {
    send({ id, error: { code: -32601, message: "Method not found" } });
  }
}
`;

type Block = Record<string, unknown>;
interface Frame {
  type: "user" | "assistant";
  message: { role: "user" | "assistant"; content: Block[] };
  shouldQuery?: false;
}

/** Anthropic tool-use ids allow letters, digits, `_` and `-`, up to 64 characters. */
function normalizeToolCallId(id: string): string {
  return createHash("sha256").update(id).digest("hex");
}

function imageBlock(image: ImageContent): Block {
  return {
    type: "image",
    source: { type: "base64", media_type: image.mimeType, data: image.data },
  };
}

function contentBlocks(content: string | (TextContent | ImageContent)[]): Block[] {
  if (typeof content === "string") return content.trim() ? [{ type: "text", text: content }] : [];
  return content.flatMap((block) =>
    block.type === "image"
      ? [imageBlock(block)]
      : block.text.trim()
        ? [{ type: "text", text: block.text }]
        : [],
  );
}

function assistantBlocks(message: AssistantMessage): Block[] {
  return message.content.flatMap((block): Block[] => {
    if (block.type === "text") return block.text.trim() ? [{ type: "text", text: block.text }] : [];
    if (block.type === "thinking") {
      // Only signed thinking from this same model can go back; transformMessages drops the rest.
      if (!block.thinkingSignature) return [];
      return block.redacted
        ? [{ type: "redacted_thinking", data: block.thinkingSignature }]
        : [{ type: "thinking", thinking: block.thinking, signature: block.thinkingSignature }];
    }
    return [
      {
        type: "tool_use",
        id: block.id,
        name: `${TOOL_PREFIX}${block.name}`,
        input: block.arguments,
      },
    ];
  });
}

function toolResultBlocks(message: ToolResultMessage): { result: Block; after: Block[] } {
  // Anthropic rejects images in an error result; they follow the turn's results instead.
  const split = message.isError ? splitErrorToolResultImages(message) : undefined;
  const content = contentBlocks(split?.content ?? message.content);
  return {
    result: {
      type: "tool_result",
      tool_use_id: message.toolCallId,
      ...(content.length ? { content } : {}),
      ...(message.isError ? { is_error: true } : {}),
    },
    after: split ? [{ type: "text", text: split.caption }, ...split.images.map(imageBlock)] : [],
  };
}

/** The transcript as stream-json input frames; the CLI answers the last one. */
export function claudeCodeFrames(context: TranscriptContext, model: Model<Api>): Frame[] {
  const frames: Frame[] = [];
  let after: Block[] = [];
  let mergeNextUser = false;
  const addUser = (blocks: Block[], merge = true) => {
    if (!blocks.length) return;
    const last = frames.at(-1);
    if (merge && last?.type === "user") last.message.content.push(...blocks);
    else frames.push({ type: "user", message: { role: "user", content: blocks } });
  };
  const flushAfter = () => {
    addUser(after);
    after = [];
  };
  for (const message of transformMessages(context.messages, model, normalizeToolCallId)) {
    if (message.role === "toolResult") {
      const blocks = toolResultBlocks(message);
      addUser([blocks.result]);
      after.push(...blocks.after);
      mergeNextUser = true;
      continue;
    }
    flushAfter();
    if (message.role === "user") {
      addUser(contentBlocks((message as UserMessage).content), mergeNextUser);
    } else if (message.role === "assistant") {
      const content = assistantBlocks(message);
      if (content.length)
        frames.push({ type: "assistant", message: { role: "assistant", content } });
    }
    mergeNextUser = false;
  }
  flushAfter();
  if (frames.at(-1)?.type !== "user") {
    throw new Error("Claude Code can only answer a conversation that ends with a user message.");
  }
  // Every earlier user turn is history: the CLI records it without asking the model.
  return frames.map((frame, index) =>
    frame.type === "user" && index < frames.length - 1 ? { ...frame, shouldQuery: false } : frame,
  );
}

/** One id per conversation, from how it starts, so the CLI's prompt prefix stays cacheable. */
function conversationId(system: string, first: Frame | undefined): string {
  const hex = createHash("sha256")
    .update(JSON.stringify([system, first?.message ?? null]))
    .digest("hex");
  const variant = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

const EFFORT: Record<NonNullable<SimpleStreamOptions["reasoning"]>, string> = {
  minimal: "low",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
};

/** HTTP status for the CLI's error codes, in the shape the run error view classifies. */
const ERROR_STATUS: Record<string, number> = {
  authentication_failed: 401,
  billing_error: 402,
  invalid_request: 400,
  rate_limit: 429,
  server_error: 503,
  overloaded: 529,
};

function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function applyUsage(usage: Usage, raw: unknown): void {
  if (!raw || typeof raw !== "object") return;
  const value = raw as Record<string, unknown>;
  const count = (key: string, fallback: number) =>
    typeof value[key] === "number" ? (value[key] as number) : fallback;
  usage.input = count("input_tokens", usage.input);
  usage.output = count("output_tokens", usage.output);
  usage.cacheRead = count("cache_read_input_tokens", usage.cacheRead);
  usage.cacheWrite = count("cache_creation_input_tokens", usage.cacheWrite);
  usage.totalTokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

function textOf(content: unknown): string {
  return Array.isArray(content)
    ? content
        .map((block) =>
          block && typeof block === "object" && typeof block.text === "string" ? block.text : "",
        )
        .filter(Boolean)
        .join("\n")
    : "";
}

function apiError(code: unknown, detail: string, reportedStatus?: unknown): Error {
  const text = sanitizeSensitiveText(detail).trim();
  const status =
    (typeof code === "string" ? ERROR_STATUS[code] : undefined) ??
    (typeof reportedStatus === "number" ? reportedStatus : undefined) ??
    Number(/\bAPI Error:\s*(\d{3})\b/.exec(text)?.[1] ?? Number.NaN);
  if (status === 401) return new Error(CLAUDE_CODE_SIGNED_OUT_ERROR);
  return new Error(
    Number.isInteger(status)
      ? `Claude Code API error (${status}): ${text || code}`
      : `Claude Code error: ${text || code || "unknown error"}`,
  );
}

class Aborted extends Error {}

/**
 * Waits for one exchange with the CLI: reading an event or writing a frame. The CLI prints
 * something at least on every retry and every streamed token and reads its input as it comes, so
 * a long silence means it is stuck.
 */
function exchange<T>(step: Promise<T>, signal: AbortSignal | undefined, idleMs: number) {
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  return Promise.race([
    step,
    new Promise<never>((_, reject) => {
      if (idleMs > 0) {
        timer = setTimeout(
          () => reject(new Error("Claude Code stopped responding. Try again.")),
          idleMs,
        );
      }
      onAbort = () => reject(new Aborted("Request was aborted"));
      if (signal?.aborted) onAbort();
      signal?.addEventListener("abort", onAbort, { once: true });
    }),
  ]).finally(() => {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  });
}

/** Reads the CLI's next stream-json event. */
async function nextEvent(
  child: ClaudeCodeProcess,
  signal: AbortSignal | undefined,
  idleMs: number,
): Promise<Record<string, unknown> | undefined> {
  for (;;) {
    const line = await exchange(child.nextLine(), signal, idleMs);
    if (line === undefined) return undefined;
    if (!line.trim()) continue;
    try {
      const event: unknown = JSON.parse(line);
      if (event && typeof event === "object") return event as Record<string, unknown>;
    } catch {
      // Reported below with the line itself.
    }
    throw new Error(
      `Claude Code printed output that is not stream-json: ${sanitizeSensitiveText(line.slice(0, 200))}`,
    );
  }
}

async function exitError(child: ClaudeCodeProcess, during: string): Promise<Error> {
  const code = await child.exitCode();
  const stderr = sanitizeSensitiveText(child.stderrTail()).slice(-500);
  return new Error(
    `Claude Code exited ${during} (exit code ${code ?? "unknown"}).${stderr ? ` ${stderr}` : ""}`,
  );
}

/** Read-only helpers the CLI adds for any MCP server; Rakazo's server offers no resources. */
const MCP_RESOURCE_TOOLS = new Set(["ListMcpResourcesTool", "ReadMcpResourceTool"]);

/**
 * The CLI must offer Rakazo's tools only: its own tools stay off, and when the request has tools
 * the tool server must be connected, so the model never answers without them.
 */
function checkInit(event: Record<string, unknown>, expectTools: boolean): void {
  if (event.subtype !== "init") return;
  const tools = Array.isArray(event.tools) ? event.tools : [];
  const builtIn = tools.filter(
    (name) =>
      typeof name === "string" && !name.startsWith(TOOL_PREFIX) && !MCP_RESOURCE_TOOLS.has(name),
  );
  if (builtIn.length) {
    throw new Error(`Claude Code started with its own tools enabled: ${builtIn.join(", ")}.`);
  }
  const server = (Array.isArray(event.mcp_servers) ? event.mcp_servers : []).find(
    (entry) => entry && typeof entry === "object" && entry.name === TOOL_SERVER,
  ) as { status?: unknown } | undefined;
  if (expectTools && server?.status !== "connected") {
    throw new Error("Claude Code could not load Rakazo's tools.");
  }
}

interface OpenBlock {
  index: number;
  json: string;
}

/**
 * Streams one model turn through the operator's signed-in Claude Code CLI. The CLI is only the
 * model: Rakazo keeps the conversation, runs every tool, and replays the history each turn.
 */
export function streamClaudeCode(
  model: Model<Api>,
  context: TranscriptContext,
  options: SimpleStreamOptions & { assertAllowed?: () => Promise<void> } = {},
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const output: AssistantMessage = {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: emptyUsage(),
    stopReason: "stop",
    timestamp: Date.now(),
  };
  void (async () => {
    let child: ClaudeCodeProcess | undefined;
    let files: string | undefined;
    const stop = () => child?.stop();
    options.signal?.addEventListener("abort", stop, { once: true });
    try {
      await options.assertAllowed?.();
      if (options.signal?.aborted) throw new Aborted("Request was aborted");
      const system = getCurrentSystemPrompt(context.messages);
      const tools = getCurrentTools(context.messages);
      const offeredToolNames = new Set(tools.map((tool) => `${TOOL_PREFIX}${tool.name}`));
      const frames = claudeCodeFrames(context, model);
      files = await mkdtemp(join(tmpdir(), "rakazo-claude-code-request-"));
      const cwd = join(files, "cwd");
      await mkdir(cwd, { mode: 0o700 });
      await checkClaudeCode(cwd, options.signal);
      const systemFile = join(files, "system.md");
      await writeFile(systemFile, system, { mode: 0o600 });
      const args = [
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--model",
        model.id,
        "--system-prompt-file",
        systemFile,
        "--tools",
        "",
        "--strict-mcp-config",
        "--setting-sources",
        "",
        "--permission-mode",
        "dontAsk",
        "--max-turns",
        "1",
        "--no-session-persistence",
        "--disable-slash-commands",
        "--session-id",
        conversationId(system, frames[0]),
      ];
      if (tools.length) {
        const manifest = join(files, "tools.json");
        const server = join(files, "inventory.mjs");
        const config = join(files, "mcp.json");
        await writeFile(
          manifest,
          JSON.stringify(
            tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              inputSchema: tool.parameters,
            })),
          ),
          { mode: 0o600 },
        );
        await writeFile(server, INVENTORY_SERVER, { mode: 0o600 });
        await writeFile(
          config,
          JSON.stringify({
            mcpServers: {
              [TOOL_SERVER]: { type: "stdio", command: process.execPath, args: [server, manifest] },
            },
          }),
          { mode: 0o600 },
        );
        args.push("--mcp-config", config);
      }
      if (model.reasoning && options.reasoning) args.push("--effort", EFFORT[options.reasoning]);
      const maxTokens = options.maxTokens ?? model.maxTokens;
      options.signal?.throwIfAborted();
      child = startClaudeCode(args, {
        cwd,
        env: claudeCodeEnv(
          process.env,
          maxTokens ? { CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(maxTokens) } : {},
        ),
      });
      const idleMs = modelStreamIdleTimeoutMs();
      const read = () => nextEvent(child!, options.signal, idleMs);

      for (const frame of frames) {
        options.signal?.throwIfAborted();
        const write = child.write(`${JSON.stringify(frame)}\n`).then(
          () => true,
          () => false,
        );
        if (!(await exchange(write, options.signal, idleMs))) {
          throw await exitError(child, "while loading the conversation");
        }
        if (frame.shouldQuery !== false) continue;
        // A history turn is acknowledged with a result that used no model turn.
        for (;;) {
          const event = await read();
          if (!event) throw await exitError(child, "while loading the conversation");
          if (event.type === "system") checkInit(event, tools.length > 0);
          if (event.type !== "result") continue;
          if (event.num_turns !== 0 || event.is_error) {
            throw new Error(
              "This Claude Code version cannot load conversation history. Run `claude update`.",
            );
          }
          break;
        }
      }
      child.closeInput();

      const blocks = new Map<number, OpenBlock>();
      let started = false;
      const start = () => {
        if (started) return;
        started = true;
        stream.push({ type: "start", partial: output });
      };
      let messageComplete = false;
      const finish = () => {
        start();
        if (output.stopReason === "error") {
          stream.push({ type: "error", reason: "error", error: output });
        } else {
          stream.push({
            type: "done",
            reason: output.stopReason as "stop" | "length" | "toolUse",
            message: output,
          });
        }
        stream.end();
      };
      for (;;) {
        const event = await read();
        if (!event) throw await exitError(child, "before replying");
        if (event.type === "system") {
          checkInit(event, tools.length > 0);
          continue;
        }
        if (event.type === "assistant") {
          const message = (event.message ?? {}) as Record<string, unknown>;
          if (event.error || message.error) {
            throw apiError(event.error ?? message.error, textOf(message.content));
          }
          continue;
        }
        if (event.type === "result") {
          if (event.is_error) {
            const detail =
              typeof event.result === "string"
                ? event.result
                : Array.isArray(event.errors)
                  ? event.errors.join("; ")
                  : String(event.subtype ?? "");
            throw apiError(undefined, detail, event.api_error_status);
          }
          if (!messageComplete) throw new Error("Claude Code finished without a reply.");
          finish();
          return;
        }
        if (event.type !== "stream_event") continue;
        const native = (event.event ?? {}) as Record<string, unknown>;
        switch (native.type) {
          case "message_start": {
            const message = (native.message ?? {}) as Record<string, unknown>;
            if (typeof message.id === "string") output.responseId = message.id;
            if (typeof message.model === "string") output.responseModel = message.model;
            applyUsage(output.usage, message.usage);
            start();
            break;
          }
          case "content_block_start": {
            start();
            const index = Number(native.index);
            const block = (native.content_block ?? {}) as Record<string, unknown>;
            const contentIndex = output.content.length;
            if (block.type === "text") {
              output.content.push({ type: "text", text: "" });
              blocks.set(index, { index: contentIndex, json: "" });
              stream.push({ type: "text_start", contentIndex, partial: output });
            } else if (block.type === "thinking") {
              output.content.push({ type: "thinking", thinking: "", thinkingSignature: "" });
              blocks.set(index, { index: contentIndex, json: "" });
              stream.push({ type: "thinking_start", contentIndex, partial: output });
            } else if (block.type === "redacted_thinking") {
              output.content.push({
                type: "thinking",
                thinking: "[Reasoning redacted]",
                thinkingSignature: String(block.data ?? ""),
                redacted: true,
              });
              stream.push({ type: "thinking_start", contentIndex, partial: output });
              stream.push({
                type: "thinking_end",
                contentIndex,
                content: "[Reasoning redacted]",
                partial: output,
              });
            } else if (block.type === "tool_use") {
              const name = String(block.name ?? "");
              if (!offeredToolNames.has(name)) {
                throw new Error("Claude Code requested a tool that was not offered.");
              }
              output.content.push({
                type: "toolCall",
                id: String(block.id ?? ""),
                name: name.slice(TOOL_PREFIX.length),
                arguments: {},
              });
              blocks.set(index, { index: contentIndex, json: "" });
              stream.push({ type: "toolcall_start", contentIndex, partial: output });
            }
            break;
          }
          case "content_block_delta": {
            const open = blocks.get(Number(native.index));
            const delta = (native.delta ?? {}) as Record<string, unknown>;
            if (!open) break;
            const block = output.content[open.index]!;
            if (delta.type === "text_delta" && block.type === "text") {
              const text = String(delta.text ?? "");
              block.text += text;
              stream.push({
                type: "text_delta",
                contentIndex: open.index,
                delta: text,
                partial: output,
              });
            } else if (delta.type === "thinking_delta" && block.type === "thinking") {
              const text = String(delta.thinking ?? "");
              block.thinking += text;
              stream.push({
                type: "thinking_delta",
                contentIndex: open.index,
                delta: text,
                partial: output,
              });
            } else if (delta.type === "signature_delta" && block.type === "thinking") {
              block.thinkingSignature = `${block.thinkingSignature ?? ""}${String(delta.signature ?? "")}`;
            } else if (delta.type === "input_json_delta" && block.type === "toolCall") {
              const json = String(delta.partial_json ?? "");
              open.json += json;
              block.arguments = parseStreamingJson(open.json);
              stream.push({
                type: "toolcall_delta",
                contentIndex: open.index,
                delta: json,
                partial: output,
              });
            }
            break;
          }
          case "content_block_stop": {
            const key = Number(native.index);
            const open = blocks.get(key);
            if (!open) break;
            blocks.delete(key);
            const block = output.content[open.index]!;
            if (block.type === "text") {
              stream.push({
                type: "text_end",
                contentIndex: open.index,
                content: block.text,
                partial: output,
              });
            } else if (block.type === "thinking") {
              stream.push({
                type: "thinking_end",
                contentIndex: open.index,
                content: block.thinking,
                partial: output,
              });
            } else {
              const parsed = parseToolCallArguments(open.json || "{}");
              const toolCall: ToolCall = Object.assign(block, parsed);
              stream.push({
                type: "toolcall_end",
                contentIndex: open.index,
                toolCall,
                partial: output,
              });
            }
            break;
          }
          case "message_delta": {
            const delta = (native.delta ?? {}) as Record<string, unknown>;
            applyUsage(output.usage, native.usage);
            const reason = delta.stop_reason;
            if (reason === "max_tokens" || reason === "model_context_window_exceeded") {
              output.stopReason = "length";
            } else if (reason === "tool_use") {
              output.stopReason = "toolUse";
            } else if (reason === "refusal") {
              output.stopReason = "error";
              output.errorMessage = "The model refused to complete the request";
            } else if (typeof reason === "string") {
              output.stopReason = "stop";
            }
            break;
          }
          case "message_stop": {
            if (blocks.size)
              throw new Error("Claude Code ended a reply with incomplete content blocks.");
            messageComplete = true;
            if (output.stopReason === "toolUse" || output.stopReason === "error") {
              finish();
              return;
            }
            break;
          }
        }
      }
    } catch (error) {
      const aborted = options.signal?.aborted || error instanceof Aborted;
      output.stopReason = aborted ? "aborted" : "error";
      output.errorMessage = aborted
        ? "Request was aborted"
        : (error as NodeJS.ErrnoException)?.code === "ENOENT"
          ? CLAUDE_CODE_NOT_INSTALLED_ERROR
          : error instanceof Error
            ? error.message
            : String(error);
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    } finally {
      options.signal?.removeEventListener("abort", stop);
      // One turn is all Rakazo asks for: the CLI is done once the reply is complete.
      child?.stop();
      if (files) await rm(files, { recursive: true, force: true }).catch(() => {});
    }
  })();
  return stream;
}
