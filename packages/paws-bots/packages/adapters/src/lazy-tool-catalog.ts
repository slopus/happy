import type {
  ConnectorCall,
  ConnectorEvent,
  ConnectorRoute,
  ConnectorTool,
} from "@rakazo/adapter-kit";
import { z } from "zod";
import { catalogIdForRoute } from "./approval-effect.js";

export const DIRECT_TOOL_LIMIT = 20;
export const TOOL_SEARCH_LIMIT = 10;
export const SELECTED_SCHEMA_MAX_BYTES = 100_000;
export const NAME_INDEX_MAX_NAMES = 200;
export const NAME_INDEX_MAX_BYTES = 2_048;
const MAX_QUERY_LENGTH = 200;
const MAX_GROUP_LENGTH = 200;
const MAX_TOOL_NAME_LENGTH = 200;
const MAX_TOOL_ID_LENGTH = 500;
export const MAX_DESCRIPTION_LENGTH = 500;
export const CATALOG_SEARCH = "__catalog_search";
export const CATALOG_LOAD = "__catalog_load";
export const CATALOG_EXECUTE = "__catalog_execute";

export type CatalogEntry = { id: string; tool: ConnectorTool; group: string };

export type CatalogSearchHit = {
  id: string;
  name: string;
  description: string;
  readOnly: boolean;
};

export type CatalogSearchResult =
  | { tools: CatalogSearchHit[] }
  | {
      tools: CatalogSearchHit[];
      groups: Array<{ group: string; count: number }>;
      hint: string;
    }
  | { index: Array<{ group: string; names: string[] }> }
  | { groups: Array<{ group: string; count: number }>; hint: string }
  | { group: string; names: string[]; error?: string }
  | { group: string; count: number; hint: string };

/**
 * Build the three catalog wrapper tools (`<prefix>_search_tools`, `<prefix>_load_tool`,
 * `<prefix>_execute_tool`). Callers must not pass a prefix that yields names starting with
 * `mcp_`: Anthropic's Claude Code OAuth endpoint rejects such requests on every model with a
 * misleading "out of extra usage" error. `mcp__server__tool` (double underscore) is fine.
 */
export function lazyCatalogTools(
  prefix: string,
  connectorId: string,
  label: string,
  entries: CatalogEntry[] = [],
): ConnectorTool[] {
  const grouped = groupedNames(entries);
  const searchDescription =
    grouped.length > 0 && fitsNameIndexBudget(grouped)
      ? `Search connected ${label} tools. Empty query lists names by source. Pass group to expand one source.\n${formatNameIndexText(grouped)}`
      : `Search connected ${label} tools. Empty query lists sources. Pass group to list names in one source, or query to search.${sourceSummaryText(grouped)}`;
  return [
    {
      name: `${prefix}_search_tools`,
      description: searchDescription,
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            maxLength: MAX_QUERY_LENGTH,
            description: "Words describing the tool to find. Omit to list names by source.",
          },
          group: {
            type: "string",
            maxLength: MAX_GROUP_LENGTH,
            description: "Source name to list or search within",
          },
          limit: { type: "integer", minimum: 1, maximum: TOOL_SEARCH_LIMIT },
        },
      },
      readOnly: true,
      route: { connectorId, toolName: CATALOG_SEARCH },
    },
    {
      name: `${prefix}_load_tool`,
      description: `Load one ${label} tool's parameters by id.`,
      inputSchema: {
        type: "object",
        properties: {
          id: {
            type: "string",
            maxLength: MAX_TOOL_ID_LENGTH,
            description: "Exact tool ID returned by search",
          },
        },
        required: ["id"],
      },
      readOnly: true,
      route: { connectorId, toolName: CATALOG_LOAD },
    },
    {
      name: `${prefix}_execute_tool`,
      description: `Run an ${label} tool by id.`,
      inputSchema: {
        type: "object",
        properties: {
          id: {
            type: "string",
            maxLength: MAX_TOOL_ID_LENGTH,
            description: "Exact tool ID returned by search",
          },
          arguments: { type: "object", description: "Arguments matching the loaded schema" },
        },
        required: ["id", "arguments"],
      },
      route: { connectorId, toolName: CATALOG_EXECUTE },
    },
  ];
}

export function isLazyCatalogControlRoute(route: ConnectorRoute | undefined): boolean {
  return Boolean(
    route &&
      !route.resourceId &&
      (route.toolName === CATALOG_SEARCH ||
        route.toolName === CATALOG_LOAD ||
        route.toolName === CATALOG_EXECUTE),
  );
}

export function catalogEntries(tools: ConnectorTool[]): CatalogEntry[] {
  return tools
    .map((tool) => ({ id: catalogEntryId(tool), tool, group: catalogGroupOf(tool) }))
    .filter(
      ({ id, tool }) =>
        id.length <= MAX_TOOL_ID_LENGTH &&
        tool.name.length > 0 &&
        tool.name.length <= MAX_TOOL_NAME_LENGTH,
    );
}

export function catalogGroupLabel(
  name: string | null | undefined,
  kind: string,
  id: string,
): string {
  const trimmed = name?.trim();
  if (trimmed) return trimmed.slice(0, MAX_GROUP_LENGTH);
  const shortId = id.slice(0, 8) || "unknown";
  return `${kind}-${shortId}`.slice(0, MAX_GROUP_LENGTH);
}

export function searchCatalog(
  entries: CatalogEntry[],
  args: Record<string, unknown>,
): CatalogSearchResult {
  // Source labels can differ only by case, so pick a source from the query as typed.
  const typedQuery = String(args.query ?? "")
    .slice(0, MAX_QUERY_LENGTH)
    .trim();
  let query = typedQuery.toLowerCase();
  let groupFilter = String(args.group ?? "")
    .slice(0, MAX_GROUP_LENGTH)
    .trim();
  // A query that is only a source name asks for that source's tools, which word search
  // would cap before the names that sort late.
  if (!groupFilter && query && !entries.some((entry) => isExactName(entry, query))) {
    if (entriesInGroup(entries, typedQuery).length > 0) {
      groupFilter = typedQuery;
      query = "";
    }
  }
  const scoped = groupFilter ? entriesInGroup(entries, groupFilter) : entries;

  if (!query) {
    if (groupFilter) {
      if (scoped.length === 0) {
        return {
          group: groupFilter,
          names: [],
          error: "Unknown or empty group",
        };
      }
      const group = scoped[0]!.group;
      const names = listNames(scoped);
      if (!fitsNameIndexBudget([{ group, names }])) {
        return {
          group,
          count: names.length,
          hint: "Pass query to search within this source.",
        };
      }
      return { group, names };
    }
    const grouped = groupedNames(scoped);
    if (!fitsNameIndexBudget(grouped)) {
      return {
        groups: grouped.map(({ group, names }) => ({ group, count: names.length })),
        hint: "Pass group to list names in one source.",
      };
    }
    return { index: grouped };
  }

  const requested = Number(args.limit ?? TOOL_SEARCH_LIMIT);
  const limit = Number.isFinite(requested)
    ? Math.max(1, Math.min(TOOL_SEARCH_LIMIT, Math.trunc(requested)))
    : TOOL_SEARCH_LIMIT;
  const ranked = rankCatalogEntries(scoped, query, limit);
  const hits = ranked.hits.map((entry) => ({
    id: entry.id,
    name: entry.tool.name,
    description: entry.tool.description.slice(0, MAX_DESCRIPTION_LENGTH),
    readOnly: entry.tool.readOnly === true,
  }));
  if (hits.length > 0 && ranked.complete) return { tools: hits };
  return {
    tools: hits,
    groups: groupedNames(entries).map(({ group, names }) => ({ group, count: names.length })),
    hint: "No tool matches every word. Try other words or pass group. Built-in tools are not in this catalog.",
  };
}

/** The best `limit` entries for a query; `complete` when they match every query word. */
export function rankCatalogEntries(
  entries: CatalogEntry[],
  query: string,
  limit: number,
): { hits: CatalogEntry[]; complete: boolean } {
  const words = searchWords(query);
  const score = (inside: boolean) =>
    entries.map((entry) => ({ entry, ...catalogScore(entry, query, words, inside) }));
  let scored = score(false);
  // Rank on the words that matched before the cap, so a tool that matches every word is
  // not pushed out by tools that match one word and sort earlier by name.
  let bestMatched = Math.max(0, ...scored.map(({ matched }) => matched));
  // Matches inside a word ("mail" in gmail) count only when nothing matches every word at a
  // word start; otherwise "tool_0" would also find tool_10.
  if (bestMatched < words.length) {
    scored = score(true);
    bestMatched = Math.max(0, ...scored.map(({ matched }) => matched));
  }
  const hits = scored
    .filter(({ matched }) => matched > 0 && matched === bestMatched)
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.entry.tool.name.localeCompare(right.entry.tool.name) ||
        left.entry.id.localeCompare(right.entry.id),
    )
    .slice(0, limit)
    .map(({ entry }) => entry);
  return { hits, complete: bestMatched === words.length };
}

/** Exact label first; a model often capitalizes a source name ("Linear" for "linear"). */
function entriesInGroup(entries: CatalogEntry[], group: string): CatalogEntry[] {
  const exact = entries.filter((entry) => entry.group === group);
  if (exact.length > 0) return exact;
  const lower = group.toLowerCase();
  return entries.filter((entry) => entry.group.toLowerCase() === lower);
}

export function loadCatalogEntry(
  entries: CatalogEntry[],
  args: Record<string, unknown>,
): CatalogEntry {
  const id = String(args.id ?? "");
  const byId = entries.find((candidate) => candidate.id === id);
  if (byId) {
    assertSchemaSize(byId);
    return byId;
  }
  // Models often name a tool by the source label they saw in search ("pc-files:read_file",
  // "pc-files/read_file", "pc-files__read_file") instead of copying the opaque id. Accept a
  // group-qualified name when it identifies exactly one authorized entry.
  const candidates = entries.filter(
    (candidate) =>
      candidate.tool.name === id ||
      catalogShortName(candidate) === id ||
      matchesGroupQualifiedName(candidate, id),
  );
  if (candidates.length === 1) {
    assertSchemaSize(candidates[0]!);
    return candidates[0]!;
  }
  if (candidates.length > 1) {
    throw new Error(
      `Tool name is ambiguous; use one of these ids: ${candidates
        .slice(0, 5)
        .map((candidate) => candidate.id)
        .join(", ")}`,
    );
  }
  throw new Error(
    "Tool is unknown or not authorized for this bot. Use the exact id returned by search.",
  );
}

export const GROUP_SEPARATORS = [":", "/", "__", "."];

function matchesGroupQualifiedName(entry: CatalogEntry, id: string): boolean {
  const group = entry.group.toLowerCase();
  const qualifiedName = id.trim();
  const shortName = catalogShortName(entry);
  for (const separator of GROUP_SEPARATORS) {
    let separatorIndex = qualifiedName.indexOf(separator);
    while (separatorIndex !== -1) {
      if (qualifiedName.slice(0, separatorIndex).toLowerCase() === group) {
        const rest = qualifiedName.slice(separatorIndex + separator.length);
        if (rest === shortName || rest === entry.tool.name) return true;
        try {
          if (decodeURIComponent(rest) === shortName) return true;
        } catch {
          // Malformed escape: not a match.
        }
      }
      separatorIndex = qualifiedName.indexOf(separator, separatorIndex + 1);
    }
  }
  return false;
}

function assertSchemaSize(entry: CatalogEntry): void {
  const schemaBytes = Buffer.byteLength(JSON.stringify(entry.tool.inputSchema), "utf8");
  if (schemaBytes > SELECTED_SCHEMA_MAX_BYTES) throw new Error("Tool schema is too large");
}

export function resolveCatalogCall(
  call: ConnectorCall,
  entries: CatalogEntry[],
): { call: ConnectorCall; tool: ConnectorTool } {
  const entry = loadCatalogEntry(entries, call.args);
  const args = call.args.arguments;
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("Tool arguments must be an object");
  }
  const parsed = parseConnectorToolArgs(entry.tool.inputSchema, args as Record<string, unknown>);
  return {
    tool: entry.tool,
    call: {
      ...call,
      tool: entry.tool.name,
      args: parsed,
      route: entry.tool.route,
    },
  };
}

export function parseConnectorToolArgs(
  inputSchema: Record<string, unknown>,
  args: Record<string, unknown>,
): Record<string, unknown> {
  // Zod's fromJSONSchema currently builds loose records for patternProperties and
  // skips additionalProperties: false, so reject that combination instead of
  // letting non-matching keys reach connector execution.
  if (inputSchema.patternProperties != null && inputSchema.additionalProperties === false) {
    throw new Error(
      "Tool schema is unsupported: patternProperties with additionalProperties false",
    );
  }
  const schema = z.fromJSONSchema(hoistPointerRefs(inputSchema) as never);
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    throw new Error(`Tool arguments are invalid: ${z.prettifyError(parsed.error)}`);
  }
  return parsed.data as Record<string, unknown>;
}

// Values under these keywords are data, so a `$ref` key inside them is not a reference.
const LITERAL_KEYWORDS = new Set(["const", "enum", "default", "examples"]);
// Keys of these maps are names, so a property called `default` is still a schema.
const SCHEMA_MAP_KEYWORDS = new Set([
  "properties",
  "patternProperties",
  "$defs",
  "definitions",
  "dependentSchemas",
  "dependencies",
]);

/** Zod resolves only `#` and `#/$defs/<name>` refs, but a valid schema may point anywhere in
 * itself (`#/properties/values/anyOf/0`). Copy each such target into the definitions map and
 * point the ref there; targets are registered before they are walked so cycles stay refs. */
function hoistPointerRefs(root: Record<string, unknown>): Record<string, unknown> {
  // Mirrors Zod's draft detection, which decides the prefix its resolver accepts.
  const legacyDraft =
    root.$schema === "http://json-schema.org/draft-07/schema#" ||
    root.$schema === "http://json-schema.org/draft-04/schema#";
  const defsKey = legacyDraft ? "definitions" : "$defs";
  // Zod looks every name up in `$defs ?? definitions`, whichever prefix the ref used.
  const container =
    root.$defs != null ? "$defs" : root.definitions != null ? "definitions" : defsKey;
  const existing = (root[container] ?? {}) as Record<string, unknown>;
  const hoistedNames = new Map<unknown, string>();
  const hoisted: Record<string, unknown> = {};

  const resolve = (pointer: string): unknown => {
    let decoded: string;
    try {
      decoded = decodeURIComponent(pointer.slice(2));
    } catch {
      return;
    }
    let node: unknown = root;
    for (const raw of decoded.split("/")) {
      const segment = raw.replace(/~1/g, "/").replace(/~0/g, "~");
      if (node == null || typeof node !== "object" || !Object.hasOwn(node, segment)) return;
      node = (node as Record<string, unknown>)[segment];
    }
    return node;
  };

  const mapEntries = (node: object, map: (key: string, value: unknown) => unknown) =>
    Object.fromEntries(Object.entries(node).map(([key, value]) => [key, map(key, value)]));

  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (node == null || typeof node !== "object") return node;
    const result = mapEntries(node, (key, value) =>
      LITERAL_KEYWORDS.has(key)
        ? value
        : SCHEMA_MAP_KEYWORDS.has(key) && value != null && typeof value === "object"
          ? mapEntries(value, (_name, schema) => walk(schema))
          : walk(value),
    );
    const ref = result.$ref;
    if (typeof ref !== "string" || !ref.startsWith("#/")) return result;
    const segments = ref.slice(2).split("/");
    if (segments.length === 2 && segments[0] === defsKey) return result;
    const target = resolve(ref);
    if (target === undefined) return result;
    let name = hoistedNames.get(target);
    if (!name) {
      name = `ref${hoistedNames.size}`;
      while (Object.hasOwn(existing, name)) name = `_${name}`;
      hoistedNames.set(target, name);
      hoisted[name] = walk(target);
    }
    return { ...result, $ref: `#/${defsKey}/${name}` };
  };

  const walked = walk(root) as Record<string, unknown>;
  if (hoistedNames.size === 0) return root;
  return { ...walked, [container]: { ...(walked[container] as object), ...hoisted } };
}

export function assertConnectorToolArgs(
  inputSchema: Record<string, unknown>,
  args: Record<string, unknown>,
): void {
  parseConnectorToolArgs(inputSchema, args);
}

export async function* executeLazyCatalogControl(
  call: ConnectorCall,
  entries: CatalogEntry[],
  executeResolved: (resolved: ConnectorCall) => AsyncIterable<ConnectorEvent>,
): AsyncIterable<ConnectorEvent> {
  if (call.route?.toolName === CATALOG_SEARCH) {
    yield { type: "result", data: searchCatalog(entries, call.args) };
    return;
  }
  if (call.route?.toolName === CATALOG_LOAD) {
    const entry = loadCatalogEntry(entries, call.args);
    yield {
      type: "result",
      data: {
        id: call.args.id,
        name: entry.tool.name,
        description: entry.tool.description.slice(0, MAX_DESCRIPTION_LENGTH),
        inputSchema: entry.tool.inputSchema,
        readOnly: entry.tool.readOnly === true,
      },
    };
    return;
  }
  const resolved = resolveCatalogCall(call, entries);
  yield* executeResolved(resolved.call);
}

export function uniquifyInstalledToolName(installId: string, toolName: string): string {
  return `installed__${installId}__${toolName}`;
}

/** Prefix only when the same exposed name appears on more than one install. */
export function disambiguateInstalledToolNames(tools: ConnectorTool[]): ConnectorTool[] {
  const counts = new Map<string, number>();
  for (const tool of tools) counts.set(tool.name, (counts.get(tool.name) ?? 0) + 1);
  return tools.map((tool) => {
    const resourceId = tool.route?.resourceId;
    if (!resourceId || (counts.get(tool.name) ?? 0) < 2) return tool;
    return { ...tool, name: uniquifyInstalledToolName(resourceId, tool.name) };
  });
}

export function formatNameIndexText(groups: Array<{ group: string; names: string[] }>): string {
  return groups.map(({ group, names }) => `${group}:\n  ${names.join(", ")}`).join("\n");
}

export function fitsNameIndexBudget(groups: Array<{ group: string; names: string[] }>): boolean {
  const nameCount = groups.reduce((total, group) => total + group.names.length, 0);
  if (nameCount > NAME_INDEX_MAX_NAMES) return false;
  return Buffer.byteLength(formatNameIndexText(groups), "utf8") <= NAME_INDEX_MAX_BYTES;
}

function catalogEntryId(tool: ConnectorTool): string {
  const route = tool.route;
  if (!route?.resourceId) return tool.name;
  return catalogIdForRoute({ ...route, resourceId: route.resourceId });
}

function catalogGroupOf(tool: ConnectorTool): string {
  const labeled = tool.route?.catalogGroup?.trim();
  if (labeled) return labeled.slice(0, MAX_GROUP_LENGTH);
  return "other";
}

function catalogShortName(entry: CatalogEntry): string {
  const routeName = entry.tool.route?.toolName?.trim();
  if (routeName) return routeName;
  return entry.tool.name;
}

export function groupedNames(entries: CatalogEntry[]): Array<{ group: string; names: string[] }> {
  const byGroup = new Map<string, string[]>();
  for (const entry of entries) {
    const names = byGroup.get(entry.group) ?? [];
    names.push(catalogShortName(entry));
    byGroup.set(entry.group, names);
  }
  return [...byGroup.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([group, names]) => ({
      group,
      names: [...new Set(names)].sort((left, right) => left.localeCompare(right)),
    }));
}

function listNames(entries: CatalogEntry[]): string[] {
  return [...new Set(entries.map(catalogShortName))].sort((left, right) =>
    left.localeCompare(right),
  );
}

/** Overflowing sources still appear by name and count, with names for those that fit. */
function sourceSummaryText(groups: Array<{ group: string; names: string[] }>): string {
  if (groups.length === 0) return "";
  const sources = groups.map(({ group, names }) => `${group} (${names.length})`).join(", ");
  const listed: Array<{ group: string; names: string[] }> = [];
  for (const group of groups) {
    if (fitsNameIndexBudget([...listed, group])) listed.push(group);
  }
  return listed.length > 0
    ? `\nSources: ${sources}\n${formatNameIndexText(listed)}`
    : `\nSources: ${sources}`;
}

function searchWords(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

function isExactName(entry: CatalogEntry, query: string): boolean {
  return entry.tool.name.toLowerCase() === query || catalogShortName(entry).toLowerCase() === query;
}

/**
 * Score each query word on its best field: a name word outranks the source, which outranks
 * the description. A word matches the start of a word in that field, so "project" finds
 * list_projects, or with inside set anywhere in one. An exact tool name ranks above everything.
 */
function catalogScore(
  entry: CatalogEntry,
  query: string,
  words: string[],
  inside: boolean,
): { matched: number; score: number } {
  if (isExactName(entry, query)) return { matched: words.length, score: Number.MAX_SAFE_INTEGER };
  const fields = [
    { words: searchWords(`${entry.tool.name} ${catalogShortName(entry)}`), weight: 3 },
    { words: searchWords(entry.group), weight: 2 },
    { words: searchWords(entry.tool.description), weight: 1 },
  ];
  let matched = 0;
  let score = 0;
  for (const word of words) {
    const weight = Math.max(
      0,
      ...fields
        .filter((field) =>
          field.words.some((candidate) =>
            inside ? candidate.includes(word) : candidate.startsWith(word),
          ),
        )
        .map((field) => field.weight),
    );
    if (weight > 0) {
      matched += 1;
      score += weight;
    }
  }
  return { matched, score };
}
