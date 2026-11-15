import type { Api, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";

/**
 * OpenAI-compatible servers render `messages` through the model's chat template and
 * validate tool schemas with their own JSON Schema subset. Both are stricter than
 * OpenAI: templates reject a role sequence they were not written for, and validators
 * reject keywords they do not implement. Normalize the wire request in this one place,
 * after every other payload hook, so each chat-completions provider gets the same shape.
 */
export function withChatCompletionsCompatibility<O extends SimpleStreamOptions>(
  model: Pick<Model<Api>, "api" | "id" | "baseUrl">,
  options: O,
): O {
  if (model.api !== "openai-completions") return options;
  const previous = options.onPayload;
  const stringContent = requiresStringContent(model);
  return {
    ...options,
    async onPayload(payload, requestModel) {
      const replaced = await previous?.(payload, requestModel);
      return normalizeChatCompletionsPayload(replaced ?? payload, { stringContent }) ?? replaced;
    },
  };
}

/** Workers AI validates every message's content as a string, including tool-call turns. */
function requiresStringContent(model: Pick<Model<Api>, "id" | "baseUrl">): boolean {
  return (
    model.id.startsWith("@cf/") ||
    model.id.startsWith("workers-ai/") ||
    model.baseUrl.includes("api.cloudflare.com")
  );
}

/**
 * Validation-only keywords that OpenAI-compatible validators reject outright. Tool
 * arguments are still validated locally against the original schema, so dropping them
 * from the wire keeps the constraint.
 */
const UNSUPPORTED_TOOL_SCHEMA_KEYWORDS = new Set(["uniqueItems"]);

type ChatMessage = Record<string, unknown> & { role?: unknown; content?: unknown };
type Part = Record<string, unknown>;

/** A new payload when anything changed, otherwise undefined. */
export function normalizeChatCompletionsPayload(
  payload: unknown,
  options: { stringContent?: boolean } = {},
): unknown {
  if (!isRecord(payload)) return undefined;
  const messages = Array.isArray(payload.messages)
    ? normalizeMessages(payload.messages as ChatMessage[], options)
    : undefined;
  const tools = Array.isArray(payload.tools) ? normalizeTools(payload.tools) : undefined;
  if (!messages && !tools) return undefined;
  return {
    ...payload,
    ...(messages ? { messages } : {}),
    ...(tools ? { tools } : {}),
  };
}

/**
 * - one leading instruction message: consecutive leading system/developer messages merge
 * - no two user turns in a row (history, steering and follow-ups arrive as separate messages)
 * - no two plain assistant texts in a row
 * - text-only content as a plain string, which every template renders
 */
function normalizeMessages(
  messages: ChatMessage[],
  options: { stringContent?: boolean },
): ChatMessage[] | undefined {
  const result: ChatMessage[] = [];
  let changed = false;
  for (const original of messages) {
    let message = original;
    const flattened = flattenTextContent(message.content);
    if (flattened !== message.content) {
      message = { ...message, content: flattened };
      changed = true;
    }
    if (
      options.stringContent &&
      message.role === "assistant" &&
      (message.content === null || message.content === undefined)
    ) {
      message = { ...message, content: "" };
      changed = true;
    }
    const last = result.at(-1);
    if (last && canMerge(last, message, result.length === 1)) {
      result[result.length - 1] = {
        ...message,
        role: last.role,
        content: joinContent(last.content, message.content),
      };
      changed = true;
      continue;
    }
    result.push(message);
  }
  return changed ? result : undefined;
}

const INSTRUCTION_ROLES = new Set(["system", "developer"]);

function canMerge(previous: ChatMessage, next: ChatMessage, previousIsFirst: boolean): boolean {
  if (
    previousIsFirst &&
    INSTRUCTION_ROLES.has(String(previous.role)) &&
    INSTRUCTION_ROLES.has(String(next.role))
  ) {
    return isPlain(previous) && isPlain(next);
  }
  if (previous.role !== next.role) return false;
  if (next.role === "user") return isPlain(previous) && isPlain(next);
  // An assistant tool call must stay directly before its results.
  if (next.role === "assistant") return isPlain(previous);
  return false;
}

/** Only role and content: nothing else (tool calls, names, reasoning) to reconcile. */
function isPlain(message: ChatMessage): boolean {
  return Object.keys(message).every((key) => key === "role" || key === "content");
}

function flattenTextContent(content: unknown): unknown {
  if (!Array.isArray(content) || content.length === 0) return content;
  const texts: string[] = [];
  for (const part of content as unknown[]) {
    if (
      !isRecord(part) ||
      part.type !== "text" ||
      typeof part.text !== "string" ||
      Object.keys(part).length !== 2
    ) {
      return content;
    }
    texts.push(part.text);
  }
  return texts.join("\n");
}

function joinContent(left: unknown, right: unknown): unknown {
  if (isEmpty(left)) return right;
  if (isEmpty(right)) return left;
  if (typeof left === "string" && typeof right === "string") return `${left}\n\n${right}`;
  return [...toParts(left), ...toParts(right)];
}

function isEmpty(content: unknown): boolean {
  return (
    content === null ||
    content === undefined ||
    content === "" ||
    (Array.isArray(content) && content.length === 0)
  );
}

function toParts(content: unknown): Part[] {
  if (Array.isArray(content)) return content as Part[];
  return [{ type: "text", text: String(content) }];
}

function normalizeTools(tools: unknown[]): unknown[] | undefined {
  let changed = false;
  const next = tools.map((tool) => {
    if (!isRecord(tool) || !isRecord(tool.function) || !("parameters" in tool.function)) {
      return tool;
    }
    const parameters = withoutUnsupportedKeywords(tool.function.parameters);
    if (parameters === tool.function.parameters) return tool;
    changed = true;
    return { ...tool, function: { ...tool.function, parameters } };
  });
  return changed ? next : undefined;
}

/** Keywords whose values map names to subschemas, so their keys are names, not keywords. */
const SCHEMA_MAPS = new Set([
  "properties",
  "patternProperties",
  "$defs",
  "definitions",
  "dependentSchemas",
]);
/** Keywords whose values are data, never schemas. */
const SCHEMA_DATA = new Set(["enum", "const", "default", "examples", "required"]);

/** The schema without unsupported keywords; the same object when nothing was removed. */
export function withoutUnsupportedKeywords(schema: unknown): unknown {
  if (Array.isArray(schema)) {
    const next = schema.map(withoutUnsupportedKeywords);
    return next.some((value, index) => value !== schema[index]) ? next : schema;
  }
  if (!isRecord(schema)) return schema;
  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (UNSUPPORTED_TOOL_SCHEMA_KEYWORDS.has(key)) {
      changed = true;
      continue;
    }
    const sanitized = SCHEMA_DATA.has(key)
      ? value
      : SCHEMA_MAPS.has(key) && isRecord(value)
        ? sanitizeSchemaMap(value)
        : withoutUnsupportedKeywords(value);
    if (sanitized !== value) changed = true;
    next[key] = sanitized;
  }
  return changed ? next : schema;
}

function sanitizeSchemaMap(map: Record<string, unknown>): Record<string, unknown> {
  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [name, schema] of Object.entries(map)) {
    const sanitized = withoutUnsupportedKeywords(schema);
    if (sanitized !== schema) changed = true;
    next[name] = sanitized;
  }
  return changed ? next : map;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}
