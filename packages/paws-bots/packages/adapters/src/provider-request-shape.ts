import type { Api, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";

/**
 * The shape of a model request a provider rejected, safe to log: key names, counts, part types,
 * numbers, booleans, a few known enum settings, and tool names with their definitions' sizes.
 * Never prompt or message text, tool descriptions, schemas, arguments or results, file data,
 * identifiers, keys or headers.
 */
export interface RejectedProviderRequest {
  provider: string;
  model: string;
  status: number;
  requestId?: string;
  body?: ProviderRequestShape;
}

export interface ProviderRequestShape {
  bytes?: number;
  keys: string[];
  params: Record<string, string | number | boolean | string[]>;
  tools?: {
    count: number;
    maxNameLength: number;
    invalidNames: number;
    duplicateNames: number;
    /** Older lists left out of `lists` once a request declares more than the cap. */
    omittedLists?: number;
    /** Each list of tools the request declares, by where it sits: `tools` or `input.<index>`. */
    lists: { at: string; tools: string[] }[];
  };
  messages?: { count: number; items: string[] };
}

/** Content the summary describes by structure only. */
const CONTENT_KEYS = new Set([
  "messages",
  "input",
  "contents",
  "instructions",
  "system",
  "systemInstruction",
  "system_instruction",
  "prompt",
  "tools",
  "metadata",
]);
/** Settings whose string values are fixed vocabularies, never free text or identifiers. */
const ENUM_SETTINGS = new Set([
  "model",
  "tool_choice",
  "tool_choice.type",
  "service_tier",
  "truncation",
  "reasoning_effort",
  "reasoning.effort",
  "reasoning.summary",
  "text.verbosity",
  "text.format.type",
  "response_format.type",
  "thinking.type",
  "include",
  "modalities",
]);
const ROLES = new Set(["system", "developer", "user", "assistant", "tool", "function", "model"]);
const TOKEN = /^[a-z][\w.:-]{0,63}$/i;
const MAX_ITEMS = 120;
/** The tool name rule the major model APIs share; a name outside it is a likely 400. */
const VALID_TOOL_NAME = /^[\w-]{1,64}$/;
const REQUEST_ID_HEADERS = ["x-request-id", "request-id", "x-amzn-requestid", "cf-ray"];
const REQUEST_ID = /^[\w.:-]{1,128}$/;

function token(value: unknown): string | undefined {
  return typeof value === "string" && TOKEN.test(value) ? value : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function describeSetting(
  path: string,
  value: unknown,
  params: ProviderRequestShape["params"],
  depth: number,
) {
  if (typeof value === "number" || typeof value === "boolean") params[path] = value;
  else if (typeof value === "string")
    params[path] = (ENUM_SETTINGS.has(path) && token(value)) || "string";
  else if (Array.isArray(value)) {
    const values = value.map(token);
    params[path] =
      ENUM_SETTINGS.has(path) && values.every((item) => item !== undefined)
        ? (values as string[])
        : `array(${value.length})`;
  } else if (record(value) && depth < 3) {
    for (const [key, nested] of Object.entries(value as object))
      describeSetting(`${path}.${key}`, nested, params, depth + 1);
  } else if (value !== undefined) params[path] = value === null ? "null" : "object";
}

/** Schema keywords some providers reject or only partly support; a likely cause of a 400. */
const RISKY_SCHEMA_KEYWORDS = new Set([
  "$ref",
  "$defs",
  "definitions",
  "$schema",
  "$id",
  "$anchor",
  "$dynamicRef",
  "oneOf",
  "allOf",
  "not",
  "if",
  "then",
  "else",
  "patternProperties",
  "dependentSchemas",
  "dependentRequired",
  "dependencies",
  "unevaluatedProperties",
  "unevaluatedItems",
  "propertyNames",
  "prefixItems",
  "contains",
]);
const SCHEMA_MAPS = [
  "properties",
  "patternProperties",
  "$defs",
  "definitions",
  "dependentSchemas",
  "dependencies",
];
const SCHEMA_LISTS = ["anyOf", "oneOf", "allOf", "prefixItems"];
const SCHEMA_VALUES = [
  "items",
  "additionalItems",
  "additionalProperties",
  "not",
  "if",
  "then",
  "else",
  "contains",
  "propertyNames",
  "unevaluatedProperties",
  "unevaluatedItems",
];
const MAX_SCHEMA_DEPTH = 64;
const MAX_TOOL_NAME = 80;
const MAX_TOOL_LISTS = 20;

/** Walks schema positions only, so a property named like a keyword is never mistaken for one. */
function scanSchema(
  schema: unknown,
  depth: number,
  found: { keywords: Set<string>; depth: number },
) {
  const node = record(schema);
  if (!node || depth > MAX_SCHEMA_DEPTH) return;
  found.depth = Math.max(found.depth, depth);
  for (const key of Object.keys(node)) if (RISKY_SCHEMA_KEYWORDS.has(key)) found.keywords.add(key);
  for (const key of SCHEMA_MAPS)
    for (const value of Object.values(record(node[key]) ?? {})) scanSchema(value, depth + 1, found);
  for (const key of SCHEMA_LISTS) {
    const list = node[key];
    if (Array.isArray(list)) for (const value of list) scanSchema(value, depth + 1, found);
  }
  for (const key of SCHEMA_VALUES) {
    const value = node[key];
    if (Array.isArray(value)) for (const item of value) scanSchema(item, depth + 1, found);
    else scanSchema(value, depth + 1, found);
  }
}

function byteLength(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? "");
  } catch {
    return 0;
  }
}

interface ToolEntry {
  name: string;
  invalidName: boolean;
  summary: string;
}

/**
 * One entry per tool: its name, encoded size, and only what could make a definition invalid,
 * such as a non-function type, strict mode, a root that is not an object, or risky keywords.
 */
function describeTools(tool: unknown): ToolEntry[] {
  const item = record(tool);
  if (!item) return [{ name: "", invalidName: true, summary: "?" }];
  const declarations = item.functionDeclarations ?? item.function_declarations;
  if (Array.isArray(declarations)) return declarations.flatMap(describeTools);
  const definition = record(item.function) ?? item;
  const name = typeof definition.name === "string" ? definition.name : "";
  const flags: string[] = [`${byteLength(tool)}B`];
  const type = token(item.type);
  if (type && type !== "function") flags.push(type);
  if (definition.strict === true) flags.push("strict");
  if (item.defer_loading === true) flags.push("deferred");
  const schema =
    definition.parameters ??
    definition.parametersJsonSchema ??
    definition.input_schema ??
    definition.inputSchema;
  if (schema !== undefined) {
    const root = record(schema);
    if (root?.type !== "object")
      flags.push(`root=${root ? (token(root.type) ?? "untyped") : typeof schema}`);
    const found = { keywords: new Set<string>(), depth: 0 };
    scanSchema(schema, 0, found);
    if (found.keywords.size) flags.push(`uses=${[...found.keywords].sort().join(",")}`);
    if (found.depth > 10) flags.push(`depth=${found.depth}`);
  }
  const label = name ? name.slice(0, MAX_TOOL_NAME) : "(unnamed)";
  // Built-in tools such as a web search carry a type and no name.
  const invalidName = name ? !VALID_TOOL_NAME.test(name) : !type || type === "function";
  return [{ name, invalidName, summary: `${label} ${flags.join(" ")}` }];
}

function describeToolLists(body: Record<string, unknown>): ProviderRequestShape["tools"] {
  const lists: { at: string; tools: unknown[] }[] = [];
  if (Array.isArray(body.tools)) lists.push({ at: "tools", tools: body.tools });
  if (Array.isArray(body.input))
    body.input.forEach((item, index) => {
      const tools = record(item)?.tools;
      if (Array.isArray(tools)) lists.push({ at: `input.${index}`, tools });
    });
  if (!lists.length) return undefined;
  let duplicateNames = 0;
  const all: ToolEntry[] = [];
  const described = lists.map(({ at, tools }) => {
    const entries = tools.flatMap(describeTools);
    const seen = new Set<string>();
    for (const { name } of entries) {
      if (name && seen.has(name)) duplicateNames += 1;
      seen.add(name);
    }
    all.push(...entries);
    return { at, tools: compact(entries.map((entry) => entry.summary)) };
  });
  const omittedLists = Math.max(0, described.length - MAX_TOOL_LISTS);
  return {
    count: all.length,
    maxNameLength: all.reduce((longest, { name }) => Math.max(longest, name.length), 0),
    invalidNames: all.filter((entry) => entry.invalidName).length,
    duplicateNames,
    ...(omittedLists ? { omittedLists } : {}),
    lists: described.slice(-MAX_TOOL_LISTS),
  };
}

function partTypes(content: unknown): string {
  if (typeof content === "string") return "text";
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      const item = record(part);
      if (!item) return typeof part === "string" ? "text" : "?";
      // Parts without a type tag are named by their single content key, as in `{ text }`.
      return token(item.type) ?? Object.keys(item).filter(Boolean).sort().join("|");
    })
    .join("+");
}

function describeMessage(message: unknown): string {
  const item = record(message);
  if (!item) return typeof message === "string" ? "text" : "?";
  const role = typeof item.role === "string" && ROLES.has(item.role) ? item.role : undefined;
  const label = [role, token(item.type)].filter(Boolean).join("/") || "?";
  const parts = partTypes(item.content ?? item.parts);
  return parts ? `${label}:${parts}` : label;
}

/** Runs of identical entries collapse to `entry x3`; long lists keep their newest entries. */
function compact(items: string[]): string[] {
  const runs: string[] = [];
  let index = 0;
  while (index < items.length) {
    let end = index + 1;
    while (end < items.length && items[end] === items[index]) end += 1;
    runs.push(end - index > 1 ? `${items[index]} x${end - index}` : (items[index] as string));
    index = end;
  }
  return runs.length > MAX_ITEMS ? ["…", ...runs.slice(-MAX_ITEMS)] : runs;
}

export function summarizeProviderRequest(payload: unknown): ProviderRequestShape | undefined {
  const body = record(payload);
  if (!body) return undefined;
  const params: ProviderRequestShape["params"] = {};
  for (const [key, value] of Object.entries(body))
    if (!CONTENT_KEYS.has(key)) describeSetting(key, value, params, 0);
  const shape: ProviderRequestShape = { keys: Object.keys(body).sort(), params };
  try {
    shape.bytes = Buffer.byteLength(JSON.stringify(body));
  } catch {}
  const tools = describeToolLists(body);
  if (tools) shape.tools = tools;
  const messages = [body.messages, body.input, body.contents].find(Array.isArray);
  if (messages)
    shape.messages = { count: messages.length, items: compact(messages.map(describeMessage)) };
  return shape;
}

/**
 * Stream options that report each response: the request's shape when it was rejected with a
 * 4xx, and undefined when that model succeeded, so the rejections it recovered from drop.
 */
export function withRejectedRequestCapture<O extends SimpleStreamOptions>(
  options: O,
  onRejected: (rejection: RejectedProviderRequest | undefined, model: Model<Api>) => void,
): O {
  let payload: unknown;
  const { onPayload, onResponse } = options;
  return {
    ...options,
    onPayload: async (body, model) => {
      const replaced = await onPayload?.(body, model);
      payload = replaced ?? body;
      return replaced;
    },
    onResponse: async (response, model) => {
      if (response.status >= 400 && response.status < 500) {
        const headers = Object.fromEntries(
          Object.entries(response.headers).map(([key, value]) => [key.toLowerCase(), value]),
        );
        const requestId = REQUEST_ID_HEADERS.map((name) => headers[name]).find(
          (value) => value !== undefined && REQUEST_ID.test(value),
        );
        onRejected(
          {
            provider: model.provider,
            model: model.id,
            status: response.status,
            ...(requestId ? { requestId } : {}),
            body: summarizeProviderRequest(payload),
          },
          model,
        );
      } else if (response.status >= 200 && response.status < 300) onRejected(undefined, model);
      return onResponse?.(response, model);
    },
  };
}

const rejections = new WeakMap<Error, RejectedProviderRequest[]>();

/** Every attempt's rejection, so a fallback chain shows the primary's and each backup's. */
export function attachRejectedRequests<E extends Error>(
  error: E,
  rejected: readonly RejectedProviderRequest[],
): E {
  if (rejected.length) rejections.set(error, [...rejected]);
  return error;
}

export function rejectedRequestsOf(error: unknown): RejectedProviderRequest[] | undefined {
  return error instanceof Error ? rejections.get(error) : undefined;
}
