import { isDeepStrictEqual } from "node:util";
import type {
  AdapterContext,
  ConnectorCall,
  ConnectorEvent,
  ConnectorProvider,
  ConnectorTool,
  SecretStore,
} from "@rakazo/adapter-kit";
import type { McpSourcePreset } from "@rakazo/contracts";
import { cancelResponseBody } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { availableInSpace, itemSecretIn } from "@rakazo/db";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import {
  AuthSchema,
  applyCredential,
  asRecord,
  assertNoSensitiveQuery,
  HeaderName,
  isSensitiveHeader,
  isTransportHeader,
  PublicHeadersSchema,
  readBoundedText,
  requireCredential,
} from "./connector-http.js";
import {
  combineSignals,
  redactConnectorPayload,
  sanitizeConnectorError,
} from "./connector-safety.js";
import { executeGraphqlOperation, GraphqlConfigSchema } from "./graphql-connectors.js";
import {
  CATALOG_EXECUTE,
  catalogEntries,
  catalogGroupLabel,
  DIRECT_TOOL_LIMIT,
  disambiguateInstalledToolNames,
  executeLazyCatalogControl,
  isLazyCatalogControlRoute,
  lazyCatalogTools,
  MAX_DESCRIPTION_LENGTH,
  resolveCatalogCall,
  SELECTED_SCHEMA_MAX_BYTES,
} from "./lazy-tool-catalog.js";
import { readMcpApp } from "./mcp-app.js";
import { localSchemaReference } from "./openai-tool-parameters.js";
import type { RemoteTransportDependencies, RemoteUrlPolicy } from "./remote-mcp.js";
import {
  assertSafeRemoteUrl,
  callRemoteMcpTool,
  createSafeRemoteFetch,
  listRemoteMcpTools,
  RemoteMcpSessionCache,
  readRemoteMcpResource,
} from "./remote-mcp.js";

const ModelHeaderName = HeaderName.refine(
  (name) => !isSensitiveHeader(name),
  "Sensitive headers cannot be model-controlled",
);
const McpAuthSchema = z
  .object({
    type: z.enum(["none", "bearer", "header"]).default("none"),
    name: HeaderName.optional(),
  })
  .default({ type: "none" });

/** MCP services offered as one-step sources. A preset with a URL always connects there. */
export const MCP_SOURCE_PRESETS: McpSourcePreset[] = [
  { id: "executor", name: "Executor", urlPlaceholder: "https://executor.example/mcp" },
];

/** Applies a preset named in an MCP install: its fixed URL and bearer auth, so clients send
 * only the id. Stored configs keep only fixed-URL preset ids; the rest store as custom. */
export function applyMcpSourcePreset(
  source: string,
  config: Record<string, unknown>,
): { source: string; config: Record<string, unknown> } {
  const preset = MCP_SOURCE_PRESETS.find((entry) => entry.id === config.preset);
  if (!preset) return { source, config: { ...config, preset: "custom" } };
  return {
    source: preset.url ?? source,
    config: { ...config, preset: preset.url ? preset.id : "custom", auth: { type: "bearer" } },
  };
}

const McpConfigSchema = z.object({
  // Installs keep the preset id they were made with, even after it leaves MCP_SOURCE_PRESETS;
  // nothing reads it back, so any stored id stays valid.
  preset: z.string().min(1).max(64).default("custom"),
  auth: McpAuthSchema,
  headers: PublicHeadersSchema,
});

const ApiOperationSchema = z.object({
  id: z.string().min(1).max(160),
  name: z.string().min(1).max(160).optional(),
  description: z.string().max(2_000).optional(),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  path: z.string().startsWith("/").max(2_048),
  inputSchema: z.record(z.string(), z.unknown()).default({
    type: "object",
    properties: {},
  }),
  readOnly: z.boolean().default(false),
  queryParameters: z.array(z.string().min(1).max(120)).default([]),
  formObjectQueryParameters: z.array(z.string().min(1).max(120)).optional(),
  commaSeparatedQueryParameters: z.array(z.string().min(1).max(120)).optional(),
  headerParameters: z.array(ModelHeaderName).default([]),
});

const ApiConfigSchema = z.object({
  auth: AuthSchema,
  headers: PublicHeadersSchema,
  operations: z.array(ApiOperationSchema).min(1).max(100),
});

type ApiOperation = z.infer<typeof ApiOperationSchema>;
type InstalledRow = {
  id: string;
  kind: string;
  name: string;
  source: string;
  secretId: string | null;
  config: unknown;
};

export type RemoteConnectorDependencies = RemoteTransportDependencies;
type RemoteRequestPolicy = RemoteConnectorDependencies & RemoteUrlPolicy;

export class InstalledConnectorProvider implements ConnectorProvider {
  /** Run-scoped MCP sessions, so a stateful server sees one session per run. */
  private readonly mcpSessions = new RemoteMcpSessionCache();

  constructor(
    private readonly prisma: PrismaClient,
    private readonly secrets: SecretStore,
    private readonly remote: RemoteConnectorDependencies = {},
    /** Instance flag letting every user reach loopback / LAN endpoints. */
    private readonly allowPrivateEndpoint = false,
  ) {}

  /** Decided per request from the install owner's current standing, so an install saved
   * before an ownership change cannot keep reaching private endpoints. */
  private async remoteFor(_context: AdapterContext): Promise<RemoteRequestPolicy> {
    return {
      ...this.remote,
      allowPrivateEndpoint: this.allowPrivateEndpoint,
    };
  }

  /** Session reuse only inside one run, lasting the run rather than one
   * attempt; discovery and calls outside a run (settings, verification) keep
   * one session per call. */
  private mcpSessionOptions(
    context: AdapterContext,
    install: Pick<InstalledRow, "id">,
  ): {
    sessionScope?: string;
    sessionPool?: RemoteMcpSessionCache;
    sessionRunId?: string;
  } {
    if (!context.runId) return {};
    return {
      sessionScope: `${context.spaceId} ${context.userId} ${context.runId} ${install.id}`,
      sessionPool: this.mcpSessions,
      sessionRunId: context.runId,
    };
  }

  /** Close the run-scoped MCP sessions of a run that ended on this worker;
   * see `RemoteMcpSessionCache.endRun`. */
  endRun(runId: string): void {
    this.mcpSessions.endRun(runId);
  }

  /** Close every run-scoped MCP session; for shutdown. */
  async close(): Promise<void> {
    await this.mcpSessions.close();
  }

  describe() {
    return {
      id: "installed",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { discover: true, oauth: false, secretsBrokered: true },
    };
  }

  async discoverTools(context: AdapterContext): Promise<ConnectorTool[]> {
    const tools = await this.authorizedTools(context);
    if (tools.length <= DIRECT_TOOL_LIMIT) return tools;
    return lazyCatalogTools("installed", "installed", "API", catalogEntries(tools));
  }

  async resolveCall(
    call: ConnectorCall,
    context: AdapterContext,
  ): Promise<{ call: ConnectorCall; tool: ConnectorTool } | undefined> {
    // Wrappers have no resourceId; real tools always do.
    if (call.route?.resourceId || call.route?.toolName !== CATALOG_EXECUTE) return undefined;
    return resolveCatalogCall(call, catalogEntries(await this.authorizedTools(context)));
  }

  private async authorizedTools(context: AdapterContext): Promise<ConnectorTool[]> {
    const installs = await this.prisma.capabilityInstall.findMany({
      where: {
        ...availableInSpace(context),
        kind: { in: ["mcp", "api", "graphql"] },
      },
      orderBy: { createdAt: "asc" },
    });
    // Only MCP installs reach the network during discovery.
    const remote = installs.some((install) => install.kind === "mcp")
      ? await this.remoteFor(context)
      : this.remote;
    const tools: ConnectorTool[] = [];
    for (let offset = 0; offset < installs.length; offset += 4) {
      const groups = await Promise.all(
        installs
          .slice(offset, offset + 4)
          .map((install) => this.discoverInstall(install, context, remote)),
      );
      tools.push(...groups.flat());
    }
    return disambiguateInstalledToolNames(tools);
  }

  private async discoverInstall(
    install: InstalledRow,
    context: AdapterContext,
    remote: RemoteRequestPolicy,
  ): Promise<ConnectorTool[]> {
    const catalogGroup = catalogGroupLabel(install.name, install.kind, install.id);
    try {
      if (install.kind === "mcp") {
        const config = McpConfigSchema.parse(install.config);
        const credential = await this.loadCredential(install, context);
        const tools = await listRemoteMcpTools({
          ...remote,
          endpoint: install.source,
          headers: connectorHeaders(config, credential),
          signal: context.signal,
          ...this.mcpSessionOptions(context, install),
        });
        return tools.map((tool) => ({
          ...tool,
          route: {
            connectorId: "installed",
            resourceId: install.id,
            toolName: tool.name,
            catalogGroup,
            appResourceUri: tool.appResourceUri,
          },
        }));
      }
      if (install.kind === "api") {
        const config = ApiConfigSchema.parse(install.config);
        return config.operations.map((operation) => ({
          name: operation.name ?? operation.id,
          description: operationDescription(
            `${operation.method} ${operation.path}`,
            operation.description,
          ),
          inputSchema: operation.inputSchema,
          // The stored method is authoritative: a read-only flag cannot make a write a read.
          readOnly: operation.readOnly && operation.method === "GET",
          route: {
            connectorId: "installed",
            resourceId: install.id,
            toolName: operation.id,
            catalogGroup,
          },
        }));
      }
      if (install.kind === "graphql") {
        const config = GraphqlConfigSchema.parse(install.config);
        return config.operations.map((operation) => ({
          name: operation.name ?? operation.id,
          description: operationDescription(
            `${operation.operationType} ${operation.fieldName}`,
            operation.description,
          ),
          inputSchema: operation.inputSchema,
          readOnly: operation.readOnly && operation.operationType === "query",
          route: {
            connectorId: "installed",
            resourceId: install.id,
            toolName: operation.id,
            catalogGroup,
          },
        }));
      }
    } catch {
      // One unavailable user-installed source must not hide the other tools.
    }
    return [];
  }

  async *execute(call: ConnectorCall, context: AdapterContext): AsyncIterable<ConnectorEvent> {
    if (call.route?.connectorId === "installed" && isLazyCatalogControlRoute(call.route)) {
      try {
        yield* executeLazyCatalogControl(
          call,
          catalogEntries(await this.authorizedTools(context)),
          (resolved) => this.execute(resolved, context),
        );
      } catch (error) {
        yield { type: "error", message: sanitizeConnectorError(error) };
      }
      return;
    }
    const installId = call.route?.resourceId;
    if (!installId) {
      yield { type: "error", message: "Installed connector route is missing" };
      return;
    }
    const install = await this.prisma.capabilityInstall.findFirst({
      where: {
        id: installId,
        ...availableInSpace(context),
        kind: { in: ["mcp", "api", "graphql"] },
      },
    });
    if (!install) {
      yield { type: "error", message: "Installed connector is unavailable" };
      return;
    }
    let credential: string | undefined;
    try {
      credential = await this.loadCredential(install, context);
      const remote = await this.remoteFor(context);
      if (install.kind === "mcp") {
        const config = McpConfigSchema.parse(install.config);
        const session = {
          ...remote,
          endpoint: install.source,
          headers: connectorHeaders(config, credential),
          signal: context.signal,
          ...this.mcpSessionOptions(context, install),
        };
        const result = await callRemoteMcpTool(
          session,
          call.route?.toolName ?? call.tool,
          call.args,
        );
        yield {
          type: "result",
          data: redactConnectorPayload(result, credential ? [credential] : []),
        };
        const app = await readMcpApp(
          install.name,
          call.withApp ? call.route?.appResourceUri : undefined,
          result,
          (uri) => readRemoteMcpResource(session, uri),
          credential ? [credential] : [],
        );
        if (app) yield { type: "app", app };
        return;
      }
      if (install.kind === "graphql") {
        const config = GraphqlConfigSchema.parse(install.config);
        const operation = config.operations.find(
          (candidate) => candidate.id === (call.route?.toolName ?? call.tool),
        );
        if (!operation) throw new Error("GraphQL operation is unavailable");
        const result = await executeGraphqlOperation(
          install.source,
          config,
          operation,
          call.args,
          credential,
          context.signal,
          remote,
        );
        yield {
          type: "result",
          data: redactConnectorPayload(result, credential ? [credential] : []),
        };
        return;
      }
      const config = ApiConfigSchema.parse(install.config);
      const operation = config.operations.find(
        (candidate) => candidate.id === (call.route?.toolName ?? call.tool),
      );
      if (!operation) throw new Error("API operation is unavailable");
      const result = await executeApiOperation(
        install.source,
        config,
        operation,
        call.args,
        credential,
        context.signal,
        remote,
      );
      yield {
        type: "result",
        data: redactConnectorPayload(result, credential ? [credential] : []),
      };
    } catch (error) {
      yield {
        type: "error",
        message: sanitizeConnectorError(error, credential ? [credential] : []),
      };
    }
  }

  private async loadCredential(
    install: Pick<InstalledRow, "secretId">,
    context: AdapterContext,
  ): Promise<string | undefined> {
    if (!install.secretId) return undefined;
    const row = await this.prisma.secret.findFirst({
      where: { id: install.secretId, ...itemSecretIn(context) },
    });
    return row ? await this.secrets.load(row.ciphertext, row.id) : undefined;
  }
}

export async function verifyMcpInstall(input: {
  source: string;
  config: unknown;
  credential?: string;
  signal?: AbortSignal;
  remote?: RemoteConnectorDependencies;
  /** Loopback / LAN endpoint escape: operator-configured instance flag. */
  allowPrivateEndpoint?: boolean;
}): Promise<{ config: Record<string, unknown>; toolCount: number }> {
  assertNoSensitiveQuery(input.source);
  const config = McpConfigSchema.parse(input.config);
  requireCredential(config.auth, input.credential);
  const tools = await listRemoteMcpTools({
    ...input.remote,
    endpoint: input.source,
    headers: connectorHeaders(config, input.credential),
    signal: input.signal,
    allowPrivateEndpoint: input.allowPrivateEndpoint,
  });
  if (tools.length === 0) throw new Error("MCP server returned no tools");
  return { config, toolCount: tools.length };
}

export async function prepareApiInstall(input: {
  source: string;
  config: Record<string, unknown>;
  credential?: string;
  signal?: AbortSignal;
  remote?: RemoteConnectorDependencies;
  /** Loopback / LAN endpoint escape: operator-configured instance flag. */
  allowPrivateEndpoint?: boolean;
}): Promise<{ source: string; config: Record<string, unknown>; operationCount: number }> {
  const auth = AuthSchema.parse(input.config.auth);
  requireCredential(auth, input.credential);
  const headers = PublicHeadersSchema.parse(input.config.headers);
  assertNoSensitiveQuery(input.source);
  const remote = { ...input.remote, allowPrivateEndpoint: input.allowPrivateEndpoint };
  let source = input.source;
  let operationsValue = input.config.operations;
  if (input.config.openApi === true || input.config.openapi === true) {
    const documentUrl = new URL(input.source);
    const documentHeaders: Record<string, string> = {
      accept: "application/json, application/yaml;q=0.9",
      ...headers,
    };
    applyCredential(documentUrl, documentHeaders, auth, input.credential);
    const document = await loadOpenApiDocument(documentUrl, documentHeaders, input.signal, remote);
    const imported = importOpenApiDocument(document);
    source = imported.baseUrl;
    operationsValue = imported.operations;
  }
  await assertSafeRemoteUrl(source, remote.resolveHostname, remote);
  const config = ApiConfigSchema.parse({ auth, headers, operations: operationsValue });
  return {
    source,
    config,
    operationCount: config.operations.length,
  };
}

async function loadOpenApiDocument(
  url: URL,
  headers: Record<string, string>,
  signal?: AbortSignal,
  remote: RemoteRequestPolicy = {},
): Promise<Record<string, unknown>> {
  const safeFetch = createSafeRemoteFetch(remote.fetch, remote.resolveHostname, remote);
  try {
    const response = await safeFetch(url, {
      headers,
      signal: combineSignals(signal, AbortSignal.timeout(15_000)),
    });
    if (!response.ok) {
      cancelResponseBody(response);
      throw new Error(`OpenAPI document returned HTTP ${response.status}`);
    }
    const size = Number(response.headers.get("content-length") ?? 0);
    if (size > 2_000_000) {
      cancelResponseBody(response);
      throw new Error("OpenAPI document is too large");
    }
    const { text, truncated } = await readBoundedText(response, 2_000_000);
    if (truncated) throw new Error("OpenAPI document is too large");
    return parseOpenApiText(text);
  } finally {
    await safeFetch.close().catch(() => undefined);
  }
}

/** OpenAPI documents may be published as JSON or YAML; JSON is tried first. */
function parseOpenApiText(text: string): Record<string, unknown> {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    try {
      // Without duplicate-key checks large mappings parse in linear time; the last key wins, as
      // with JSON.parse. Warnings would print document excerpts outside the logger.
      const parsed: unknown = parseYaml(text, { uniqueKeys: false, logLevel: "error" });
      // An anchor that refers to its own ancestor parses into a circular object.
      document = isCircular(parsed) ? undefined : parsed;
    } catch {
      document = undefined;
    }
  }
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    throw new Error("OpenAPI document is not valid JSON or YAML");
  }
  return document as Record<string, unknown>;
}

/** Iterative depth-first walk; shared (non-circular) nodes are visited once. */
function isCircular(root: unknown): boolean {
  const open = new Set<object>();
  const finished = new Set<object>();
  const stack: Array<[object, Iterator<unknown>]> = [];
  const enter = (value: unknown): boolean => {
    if (!value || typeof value !== "object" || finished.has(value)) return false;
    if (open.has(value)) return true;
    open.add(value);
    stack.push([value, Object.values(value)[Symbol.iterator]()]);
    return false;
  };
  if (enter(root)) return true;
  while (stack.length > 0) {
    const [node, children] = stack[stack.length - 1]!;
    const next = children.next();
    if (!next.done) {
      if (enter(next.value)) return true;
      continue;
    }
    stack.pop();
    open.delete(node);
    finished.add(node);
  }
  return false;
}

const OPENAPI_SERVER_VARIABLE = /\{([^{}]+)\}/g;
const MAX_OPENAPI_BASE_URL_LENGTH = 2_048;

export function importOpenApiDocument(document: Record<string, unknown>): {
  baseUrl: string;
  operations: ApiOperation[];
} {
  const server = asRecord(Array.isArray(document.servers) ? document.servers[0] : undefined);
  if (typeof server?.url !== "string" || !server.url) {
    throw new Error("OpenAPI document must define servers[0].url");
  }
  const variables = asRecord(server.variables);
  const serverDefault = (name: string) => {
    const variable = asRecord(variables?.[name]);
    if (typeof variable?.default !== "string") {
      throw new Error("OpenAPI server variable must define a string default");
    }
    return variable.default;
  };
  // Repeating a long default can expand a small document into a huge URL,
  // so measure the result before building it.
  let length = server.url.length;
  for (const [placeholder, name] of server.url.matchAll(OPENAPI_SERVER_VARIABLE)) {
    length += serverDefault(name!).length - placeholder.length;
  }
  if (length > MAX_OPENAPI_BASE_URL_LENGTH) {
    throw new Error(`OpenAPI server URL exceeds ${MAX_OPENAPI_BASE_URL_LENGTH} characters`);
  }
  const baseUrl = server.url.replace(OPENAPI_SERVER_VARIABLE, (_placeholder, name: string) =>
    serverDefault(name),
  );
  assertNoSensitiveQuery(baseUrl);
  const paths = document.paths;
  if (!paths || typeof paths !== "object" || Array.isArray(paths)) {
    throw new Error("OpenAPI document has no paths");
  }
  const refs: OpenApiRefs = { document, size: 0, literalSizes: new Map() };
  const operations: ApiOperation[] = [];
  for (const [path, pathValue] of Object.entries(paths)) {
    if (!pathValue || typeof pathValue !== "object" || Array.isArray(pathValue)) continue;
    for (const method of ["get", "post", "put", "patch", "delete"] as const) {
      const raw = (pathValue as Record<string, unknown>)[method];
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const operation = raw as Record<string, unknown>;
      const id = typeof operation.operationId === "string" ? operation.operationId : undefined;
      if (!id) continue;
      refs.size = 0;
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      const queryParameters: string[] = [];
      const commaSeparatedQueryParameters: string[] = [];
      const formObjectQueryParameters: string[] = [];
      const headerParameters: string[] = [];
      for (const parameter of openApiParameters(
        document,
        (pathValue as Record<string, unknown>).parameters,
        operation.parameters,
      )) {
        const schema = asRecord(inlineOpenApiSchema(refs, parameter.schema, "string")) ?? {
          type: "string",
        };
        properties[parameter.name] =
          typeof parameter.description === "string"
            ? { ...schema, description: parameter.description }
            : schema;
        if (parameter.in === "query") {
          queryParameters.push(parameter.name);
          if (
            (parameter.style === undefined || parameter.style === "form") &&
            schema.type === "object"
          ) {
            formObjectQueryParameters.push(parameter.name);
          }
          if (
            (parameter.style === undefined || parameter.style === "form") &&
            parameter.explode === false
          ) {
            commaSeparatedQueryParameters.push(parameter.name);
          }
        }
        if (parameter.in === "header") {
          if (isSensitiveHeader(parameter.name) || isTransportHeader(parameter.name)) {
            throw new Error(`OpenAPI operation ${id} contains unsafe header ${parameter.name}`);
          }
          headerParameters.push(parameter.name);
        }
        if (parameter.required === true) required.push(parameter.name);
      }
      const requestBody = asRecord(dereferenceOpenApi(document, operation.requestBody));
      const content = asRecord(requestBody?.content);
      const jsonBody = asRecord(content?.["application/json"]);
      const bodySchema = asRecord(inlineOpenApiSchema(refs, jsonBody?.schema, "object"));
      if (bodySchema) {
        properties.body = bodySchema;
        if (requestBody?.required === true) required.push("body");
      }
      operations.push({
        id,
        name: id,
        description:
          typeof operation.description === "string"
            ? operation.description
            : typeof operation.summary === "string"
              ? operation.summary
              : `${method.toUpperCase()} ${path}`,
        method: method.toUpperCase() as ApiOperation["method"],
        path,
        inputSchema: {
          type: "object",
          properties,
          ...(required.length > 0 ? { required: [...new Set(required)] } : {}),
        },
        readOnly: method === "get",
        queryParameters,
        ...(formObjectQueryParameters.length > 0 ? { formObjectQueryParameters } : {}),
        ...(commaSeparatedQueryParameters.length > 0 ? { commaSeparatedQueryParameters } : {}),
        headerParameters,
      });
      if (operations.length >= 100) break;
    }
    if (operations.length >= 100) break;
  }
  if (operations.length === 0) {
    throw new Error("OpenAPI document has no operations with operationId");
  }
  return { baseUrl, operations };
}

/** Longer same-document `$ref` chains resolve as unknown, like remote and cyclic refs. */
const MAX_OPENAPI_REF_DEPTH = 8;
/**
 * JSON bytes of one tool's schema past which further refs stay unresolved: well inside what
 * the tool catalog will load, and small enough that a full import stays a modest config.
 */
const MAX_OPENAPI_INLINED_SIZE = SELECTED_SCHEMA_MAX_BYTES / 5;
/** Keywords whose value is a schema or a list of schemas; all other values are literal data. */
const OPENAPI_SUBSCHEMA_KEYWORDS = new Set([
  "additionalItems",
  "additionalProperties",
  "allOf",
  "anyOf",
  "contains",
  "else",
  "if",
  "items",
  "not",
  "oneOf",
  "prefixItems",
  "propertyNames",
  "then",
  "unevaluatedItems",
  "unevaluatedProperties",
]);
/** Keywords whose value maps names to schemas. */
const OPENAPI_SUBSCHEMA_MAP_KEYWORDS = new Set([
  "$defs",
  "definitions",
  "dependentSchemas",
  "patternProperties",
  "properties",
]);

type OpenApiRefs = {
  document: Record<string, unknown>;
  /** JSON bytes reserved so far for the current operation's tool schema. */
  size: number;
  /** JSON bytes of each document node without following refs, measured once. */
  literalSizes: Map<object, number>;
};

/** Follow a Reference Object within the same document; remote refs are never fetched. */
function dereferenceOpenApi(document: Record<string, unknown>, value: unknown): unknown {
  const seen = new Set<string>();
  let current = value;
  while (asRecord(current) && typeof (current as { $ref?: unknown }).$ref === "string") {
    const ref = (current as { $ref: string }).$ref;
    if (seen.has(ref) || seen.size >= MAX_OPENAPI_REF_DEPTH) return undefined;
    seen.add(ref);
    current = localSchemaReference(document, ref);
  }
  return current;
}

/** Path-level parameters, each overridden by an operation parameter with the same name and location. */
function openApiParameters(
  document: Record<string, unknown>,
  ...lists: unknown[]
): Array<Record<string, unknown> & { name: string }> {
  const merged = new Map<string, Record<string, unknown> & { name: string }>();
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const value of list) {
      const parameter = asRecord(dereferenceOpenApi(document, value));
      if (typeof parameter?.name !== "string") continue;
      merged.set(`${String(parameter.in)}:${parameter.name}`, {
        ...parameter,
        name: parameter.name,
      });
    }
  }
  return [...merged.values()];
}

/**
 * Inline same-document schema refs so a stored tool schema stands alone; nothing is fetched.
 * A remote, missing, cyclic, or too-deep ref, or one whose target would not fit the tool's size
 * limit, keeps only its siblings and a `type`: the target's when known, otherwise
 * `unresolvedType` (a parameter is a string on the wire; anything else defaults to an object,
 * since tool-schema converters read a schema without a type as a string). A schema's full size
 * is reserved before its refs expand, so fields not yet visited always count.
 */
function inlineOpenApiSchema(refs: OpenApiRefs, schema: unknown, unresolvedType: string): unknown {
  refs.size += literalOpenApiSize(refs, schema);
  return expandOpenApiSchema(refs, schema, [], unresolvedType);
}

function expandOpenApiSchema(
  refs: OpenApiRefs,
  schema: unknown,
  chain: string[],
  unresolvedType = "object",
): unknown {
  const record = asRecord(schema);
  if (!record) return schema;
  const ref = typeof record.$ref === "string" ? record.$ref : undefined;
  const expand = (value: unknown) =>
    Array.isArray(value)
      ? value.map((item) => expandOpenApiSchema(refs, item, chain))
      : expandOpenApiSchema(refs, value, chain);
  const fields = Object.fromEntries(
    Object.entries(record)
      .filter(([key]) => !ref || key !== "$ref")
      .map(([key, value]) => {
        if (OPENAPI_SUBSCHEMA_KEYWORDS.has(key)) return [key, expand(value)];
        const schemas = OPENAPI_SUBSCHEMA_MAP_KEYWORDS.has(key) ? asRecord(value) : undefined;
        if (!schemas) return [key, value];
        return [
          key,
          Object.fromEntries(
            Object.entries(schemas).map(([name, item]) => [
              name,
              expandOpenApiSchema(refs, item, chain),
            ]),
          ),
        ];
      }),
  );
  if (!ref) return fields;
  const target = localSchemaReference(refs.document, ref);
  const unresolved = { ...openApiPlaceholder(target, unresolvedType), ...fields };
  if (
    target === undefined ||
    chain.includes(ref) ||
    chain.length >= MAX_OPENAPI_REF_DEPTH ||
    refs.size + literalOpenApiSize(refs, target) > MAX_OPENAPI_INLINED_SIZE
  ) {
    return unresolved;
  }
  refs.size += literalOpenApiSize(refs, target);
  const resolved = expandOpenApiSchema(refs, target, [...chain, ref], unresolvedType);
  if (Object.keys(fields).length === 0) return resolved;
  const resolvedRecord = asRecord(resolved);
  return resolvedRecord ? mergeOpenApiSchemas(resolvedRecord, fields) : unresolved;
}

/** The known target's type (and an array's item type) for a ref that is not inlined. */
function openApiPlaceholder(target: unknown, unresolvedType: string): Record<string, unknown> {
  const type = asRecord(target)?.type ?? unresolvedType;
  if (type !== "array") return { type };
  return { type, items: { type: asRecord(asRecord(target)?.items)?.type ?? "object" } };
}

/** Keywords that describe a schema without constraining it; a `$ref` sibling replaces them. */
const OPENAPI_ANNOTATION_KEYWORDS = new Set([
  "$comment",
  "default",
  "deprecated",
  "description",
  "example",
  "examples",
  "readOnly",
  "title",
  "writeOnly",
]);
const OPENAPI_LOWER_BOUNDS = new Set([
  "exclusiveMinimum",
  "minimum",
  "minItems",
  "minLength",
  "minProperties",
]);
const OPENAPI_UPPER_BOUNDS = new Set([
  "exclusiveMaximum",
  "maximum",
  "maxItems",
  "maxLength",
  "maxProperties",
]);
/** Keywords that decide which property names an object accepts. */
const OPENAPI_OBJECT_SHAPE_KEYWORDS = new Set([
  "additionalProperties",
  "patternProperties",
  "properties",
  "unevaluatedProperties",
]);

/**
 * Whether merging `other` into a closed object would admit names the closed side rejects:
 * its `additionalProperties`/`unevaluatedProperties` would then cover the other's properties.
 */
function widensClosedObject(closed: Record<string, unknown>, other: Record<string, unknown>) {
  const restricts = (value: unknown) => value !== undefined && value !== true;
  if (
    !restricts(closed.additionalProperties) &&
    !restricts(closed.unevaluatedProperties) &&
    closed.patternProperties === undefined
  ) {
    return false;
  }
  const declared = asRecord(closed.properties) ?? {};
  return (
    Object.keys(asRecord(other.properties) ?? {}).some((name) => !Object.hasOwn(declared, name)) ||
    (other.patternProperties !== undefined &&
      !isDeepStrictEqual(other.patternProperties, closed.patternProperties))
  );
}

/**
 * A `$ref` (`schema`) and its siblings (`other`) both apply in OpenAPI 3.1; combine them into
 * one schema that tool-schema converters read correctly. Annotations come from the siblings.
 * A constraint that can't be combined keeps the referenced schema's version: that can accept
 * more than the spec does, but never changes a value's type, and the API still validates.
 */
function mergeOpenApiSchemas(
  schema: Record<string, unknown>,
  other: Record<string, unknown>,
): Record<string, unknown> {
  const keepShape = widensClosedObject(schema, other) || widensClosedObject(other, schema);
  const merged = { ...schema };
  for (const [key, value] of Object.entries(other)) {
    const current = merged[key];
    if (keepShape && OPENAPI_OBJECT_SHAPE_KEYWORDS.has(key)) continue;
    if (
      current === undefined ||
      OPENAPI_ANNOTATION_KEYWORDS.has(key) ||
      key.startsWith("x-") ||
      isDeepStrictEqual(current, value)
    ) {
      merged[key] = value;
    } else if (key === "required" && Array.isArray(current) && Array.isArray(value)) {
      merged[key] = [...new Set([...current, ...value])];
    } else if (key === "enum" && Array.isArray(current) && Array.isArray(value)) {
      const allowed = current.filter((item) => value.some((each) => isDeepStrictEqual(item, each)));
      if (allowed.length > 0) merged[key] = allowed;
    } else if (
      typeof current === "number" &&
      typeof value === "number" &&
      OPENAPI_LOWER_BOUNDS.has(key)
    ) {
      merged[key] = Math.max(current, value);
    } else if (
      typeof current === "number" &&
      typeof value === "number" &&
      OPENAPI_UPPER_BOUNDS.has(key)
    ) {
      merged[key] = Math.min(current, value);
    } else if (key === "items" && asRecord(current) && asRecord(value)) {
      merged[key] = mergeOpenApiSchemas(
        current as Record<string, unknown>,
        value as Record<string, unknown>,
      );
    } else if (key === "properties" && asRecord(current) && asRecord(value)) {
      const properties = { ...(current as Record<string, unknown>) };
      for (const [name, property] of Object.entries(value as Record<string, unknown>)) {
        const existing = asRecord(properties[name]);
        const next = asRecord(property);
        if (properties[name] === undefined) properties[name] = property;
        else if (existing && next) properties[name] = mergeOpenApiSchemas(existing, next);
      }
      merged[key] = properties;
    }
  }
  return merged;
}

/** JSON bytes of one node, excluding its children. */
function openApiNodeSize(value: unknown): number {
  if (typeof value === "string") return Buffer.byteLength(JSON.stringify(value)) + 1;
  if (typeof value === "number") return String(value).length + 1;
  if (!value || typeof value !== "object") return 6;
  return Object.keys(value).reduce((size, key) => size + openApiNodeSize(key) + 1, 2);
}

function literalOpenApiSize(refs: OpenApiRefs, value: unknown): number {
  if (!value || typeof value !== "object") return openApiNodeSize(value);
  const known = refs.literalSizes.get(value);
  if (known !== undefined) return known;
  let size = openApiNodeSize(value);
  for (const field of Object.values(value)) size += literalOpenApiSize(refs, field);
  refs.literalSizes.set(value, size);
  return size;
}

/** Lead with the validated route; the provider's prose is bounded and labeled as the provider's. */
function operationDescription(route: string, provided: string | undefined): string {
  const prose = provided?.trim().slice(0, MAX_DESCRIPTION_LENGTH);
  return prose && prose !== route ? `${route}. Provider description: ${prose}` : route;
}

function connectorHeaders(
  config: z.infer<typeof McpConfigSchema>,
  credential?: string,
): Record<string, string> {
  const headers = { ...config.headers };
  if (!credential || config.auth.type === "none") return headers;
  const name = config.auth.type === "header" ? config.auth.name : "authorization";
  if (!name) throw new Error("Authentication header name is required");
  headers[name] = config.auth.type === "bearer" ? `Bearer ${credential}` : credential;
  return headers;
}

async function executeApiOperation(
  baseUrl: string,
  config: z.infer<typeof ApiConfigSchema>,
  operation: ApiOperation,
  args: Record<string, unknown>,
  credential: string | undefined,
  signal: AbortSignal,
  remote: RemoteRequestPolicy,
): Promise<unknown> {
  const consumed = new Set<string>();
  const path = operation.path.replace(/\{([^}]+)\}/g, (_match, name: string) => {
    const value = args[name];
    if (value == null) throw new Error(`Missing path parameter ${name}`);
    consumed.add(name);
    return encodeURIComponent(String(value));
  });
  const url = joinApiUrl(baseUrl, path);
  const headers: Record<string, string> = { accept: "application/json", ...config.headers };
  let body: string | undefined;
  for (const key of operation.headerParameters) {
    const value = args[key];
    consumed.add(key);
    if (value != null) headers[key] = String(value);
  }
  const declaredJsonBody =
    !consumed.has("body") &&
    !operation.queryParameters.includes("body") &&
    Object.hasOwn(asRecord(operation.inputSchema.properties) ?? {}, "body");
  const declaredDeleteBody =
    operation.method === "DELETE" && args.body !== undefined && declaredJsonBody;
  if (operation.method === "GET" || (operation.method === "DELETE" && !declaredDeleteBody)) {
    for (const [key, value] of Object.entries(args)) {
      if (consumed.has(key) || value == null) continue;
      if (appendFormQueryObject(url, operation, key, value)) continue;
      if (Array.isArray(value)) {
        if (operation.commaSeparatedQueryParameters?.includes(key)) {
          url.searchParams.set(key, value.map(String).join(","));
        } else {
          for (const item of value) url.searchParams.append(key, String(item));
        }
      } else if (typeof value !== "object") {
        url.searchParams.set(key, String(value));
      }
    }
  } else {
    for (const key of operation.queryParameters) {
      const value = args[key];
      consumed.add(key);
      if (value == null) continue;
      if (appendFormQueryObject(url, operation, key, value)) continue;
      if (Array.isArray(value)) {
        if (operation.commaSeparatedQueryParameters?.includes(key)) {
          url.searchParams.set(key, value.map(String).join(","));
        } else {
          for (const item of value) url.searchParams.append(key, String(item));
        }
      } else {
        url.searchParams.set(key, String(value));
      }
    }
    const payload =
      declaredJsonBody && args.body === null
        ? null
        : (args.body ??
          Object.fromEntries(Object.entries(args).filter(([key]) => !consumed.has(key))));
    body = JSON.stringify(payload);
    headers["content-type"] = "application/json";
  }
  applyCredential(url, headers, config.auth, credential);
  const safeFetch = createSafeRemoteFetch(remote.fetch, remote.resolveHostname, remote);
  try {
    const response = await safeFetch(url, {
      method: operation.method,
      headers,
      body,
      signal: combineSignals(signal, AbortSignal.timeout(30_000)),
    });
    const { text, truncated } = await readBoundedText(response, 1_000_000);
    let data: unknown = text;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      // Keep non-JSON API responses as bounded text.
    }
    if (!response.ok) {
      return {
        error: true,
        status: response.status,
        data,
        ...(truncated ? { truncated: true } : {}),
      };
    }
    return { status: response.status, data, ...(truncated ? { truncated: true } : {}) };
  } finally {
    await safeFetch.close().catch(() => undefined);
  }
}

/** Only imported form objects opt in; older installs keep their historical encoding. */
function appendFormQueryObject(
  url: URL,
  operation: ApiOperation,
  key: string,
  value: unknown,
): boolean {
  if (!operation.formObjectQueryParameters?.includes(key)) return false;
  const object = asRecord(value);
  if (!object) return false;
  const entries = Object.entries(object);
  if (entries.some(([, field]) => field !== null && typeof field === "object")) {
    throw new Error(`Query parameter ${key} must be a flat object`);
  }
  if (operation.commaSeparatedQueryParameters?.includes(key)) {
    url.searchParams.set(
      key,
      entries.flatMap(([name, field]) => [name, String(field ?? "")]).join(","),
    );
  } else {
    for (const [name, field] of entries) url.searchParams.append(name, String(field ?? ""));
  }
  return true;
}

function joinApiUrl(baseUrl: string, path: string): URL {
  const base = new URL(baseUrl);
  const prefix = base.pathname.replace(/\/$/, "");
  base.pathname = `${prefix}/${path.replace(/^\//, "")}`;
  base.search = "";
  base.hash = "";
  return base;
}
