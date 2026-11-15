import { z } from "zod";
import {
  AuthSchema,
  applyCredential,
  asRecord,
  assertNoSensitiveQuery,
  PublicHeadersSchema,
  readBoundedText,
  requireCredential,
} from "./connector-http.js";
import { combineSignals } from "./connector-safety.js";
import type { RemoteTransportDependencies, RemoteUrlPolicy } from "./remote-mcp.js";
import { assertSafeRemoteUrl, createSafeRemoteFetch } from "./remote-mcp.js";

const MAX_GRAPHQL_SELECTION_CHARS = 6_000;
const MAX_GRAPHQL_RESULT_BYTES = 1_000_000;
const MAX_GRAPHQL_VALIDATION_BYTES = 2_000_000;

export const GraphqlOperationSchema = z.object({
  id: z.string().min(1).max(160),
  name: z.string().min(1).max(160).optional(),
  description: z.string().max(2_000).optional(),
  operationType: z.enum(["query", "mutation"]),
  fieldName: z.string().min(1).max(160),
  variableTypes: z.record(z.string(), z.string().min(1).max(200)).default({}),
  inputSchema: z.record(z.string(), z.unknown()).default({
    type: "object",
    properties: {},
  }),
  readOnly: z.boolean().default(false),
  selection: z.string().max(8_000).default(""),
});

export const GraphqlConfigSchema = z.object({
  auth: AuthSchema,
  headers: PublicHeadersSchema,
  operations: z.array(GraphqlOperationSchema).min(1).max(100),
});

export type GraphqlOperation = z.infer<typeof GraphqlOperationSchema>;
export type GraphqlConfig = z.infer<typeof GraphqlConfigSchema>;
export type RemoteGraphqlDependencies = RemoteTransportDependencies & RemoteUrlPolicy;

const INTROSPECTION_QUERY = `query RakazoIntrospection {
  __schema {
    queryType { name }
    mutationType { name }
    types {
      kind
      name
      fields(includeDeprecated: true) {
        name
        description
        args {
          name
          description
          type { ...TypeRef }
          defaultValue
        }
        type { ...TypeRef }
      }
      inputFields {
        name
        description
        type { ...TypeRef }
        defaultValue
      }
      enumValues(includeDeprecated: true) { name }
      possibleTypes { kind name }
    }
  }
}
fragment TypeRef on __Type {
  kind
  name
  ofType {
    kind
    name
    ofType {
      kind
      name
      ofType {
        kind
        name
        ofType {
          kind
          name
          ofType {
            kind
            name
            ofType {
              kind
              name
              ofType { kind name }
            }
          }
        }
      }
    }
  }
}`;

type GqlTypeRef = {
  kind?: string;
  name?: string | null;
  ofType?: GqlTypeRef | null;
};

type GqlArg = {
  name?: string;
  description?: string | null;
  type?: GqlTypeRef;
  defaultValue?: string | null;
};

type GqlField = {
  name?: string;
  description?: string | null;
  args?: GqlArg[];
  type?: GqlTypeRef;
};

type GqlType = {
  kind?: string;
  name?: string | null;
  fields?: GqlField[] | null;
  inputFields?: GqlArg[] | null;
  enumValues?: Array<{ name?: string }> | null;
  possibleTypes?: GqlTypeRef[] | null;
};

function graphqlRequestHeaders(
  url: URL,
  publicHeaders: Record<string, string>,
  auth: GraphqlConfig["auth"],
  credential?: string,
): Record<string, string> {
  const headers = new Headers({ accept: "application/json", "content-type": "application/json" });
  for (const [name, value] of Object.entries(publicHeaders)) headers.set(name, value);
  const credentialHeaders: Record<string, string> = {};
  applyCredential(url, credentialHeaders, auth, credential);
  for (const [name, value] of Object.entries(credentialHeaders)) headers.set(name, value);
  return Object.fromEntries(headers);
}

/** Introspect a GraphQL HTTP endpoint and persist query/mutation fields as tools. */
export async function prepareGraphqlInstall(input: {
  source: string;
  config: Record<string, unknown>;
  credential?: string;
  signal?: AbortSignal;
  remote?: RemoteTransportDependencies;
  /** Loopback / LAN endpoint escape: operator-configured instance flag. */
  allowPrivateEndpoint?: boolean;
}): Promise<{ source: string; config: Record<string, unknown>; operationCount: number }> {
  const auth = AuthSchema.parse(input.config.auth);
  requireCredential(auth, input.credential);
  const headers = PublicHeadersSchema.parse(input.config.headers);
  assertNoSensitiveQuery(input.source);
  const remote = { ...input.remote, allowPrivateEndpoint: input.allowPrivateEndpoint };
  await assertSafeRemoteUrl(input.source, remote.resolveHostname, remote);

  const endpoint = new URL(input.source);
  const requestHeaders = graphqlRequestHeaders(endpoint, headers, auth, input.credential);
  const document = await introspectGraphqlEndpoint(endpoint, requestHeaders, input.signal, remote);
  const operations = importGraphqlSchema(document);
  const config = GraphqlConfigSchema.parse({ auth, headers, operations });
  return {
    source: input.source,
    config,
    operationCount: config.operations.length,
  };
}

export function importGraphqlSchema(document: Record<string, unknown>): GraphqlOperation[] {
  const data = asRecord(document.data) ?? document;
  const schema = asRecord(data.__schema);
  if (!schema) throw new Error("GraphQL introspection returned no schema");

  const types = Array.isArray(schema.types) ? (schema.types as GqlType[]) : [];
  const typeMap = new Map<string, GqlType>();
  for (const type of types) {
    if (typeof type.name === "string" && type.name) typeMap.set(type.name, type);
  }

  const queries: GraphqlOperation[] = [];
  const mutations: GraphqlOperation[] = [];
  const roots: Array<{
    operationType: "query" | "mutation";
    typeName: string | undefined;
    sink: GraphqlOperation[];
  }> = [
    {
      operationType: "query",
      typeName: stringName(asRecord(schema.queryType)?.name),
      sink: queries,
    },
    {
      operationType: "mutation",
      typeName: stringName(asRecord(schema.mutationType)?.name),
      sink: mutations,
    },
  ];

  for (const root of roots) {
    if (!root.typeName) continue;
    const rootType = typeMap.get(root.typeName);
    if (!rootType?.fields) continue;
    for (const field of rootType.fields) {
      if (!field.name || field.name.startsWith("__")) continue;
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      const variableTypes: Record<string, string> = {};
      for (const arg of field.args ?? []) {
        if (!arg.name) continue;
        variableTypes[arg.name] = printGraphqlType(
          isNonNull(arg.type) && arg.defaultValue != null
            ? (arg.type?.ofType ?? undefined)
            : arg.type,
        );
        properties[arg.name] = {
          ...graphqlTypeToJsonSchema(arg.type, typeMap, 0),
          ...(arg.description ? { description: arg.description } : {}),
        };
        if (isNonNull(arg.type) && arg.defaultValue == null) required.push(arg.name);
      }
      const id = `${root.operationType}_${field.name}`.slice(0, 160);
      root.sink.push({
        id,
        name: field.name,
        description: field.description ?? `${root.operationType} ${field.name}`,
        operationType: root.operationType,
        fieldName: field.name,
        variableTypes,
        inputSchema: {
          type: "object",
          properties,
          ...(required.length > 0 ? { required: [...new Set(required)] } : {}),
        },
        readOnly: root.operationType === "query",
        selection: buildSelection(field.type, typeMap, 0),
      });
    }
  }

  const operations = boundGraphqlOperations(queries, mutations, 100);
  if (operations.length === 0) {
    throw new Error("GraphQL schema has no query or mutation fields");
  }
  return operations;
}

function boundGraphqlOperations(
  queries: GraphqlOperation[],
  mutations: GraphqlOperation[],
  maximum: number,
): GraphqlOperation[] {
  if (queries.length + mutations.length <= maximum) return [...queries, ...mutations];
  // Keep both roots represented when the catalog is truncated.
  const mutationTake = Math.min(mutations.length, Math.floor(maximum / 2));
  const queryTake = Math.min(queries.length, maximum - mutationTake);
  const remaining = maximum - queryTake - mutationTake;
  const extraMutations = Math.min(Math.max(0, mutations.length - mutationTake), remaining);
  return [...queries.slice(0, queryTake), ...mutations.slice(0, mutationTake + extraMutations)];
}

export async function executeGraphqlOperation(
  endpoint: string,
  config: GraphqlConfig,
  operation: GraphqlOperation,
  args: Record<string, unknown>,
  credential: string | undefined,
  signal: AbortSignal,
  remote: RemoteGraphqlDependencies = {},
): Promise<unknown> {
  assertNoSensitiveQuery(endpoint);
  const url = new URL(endpoint);
  const headers = graphqlRequestHeaders(url, config.headers, config.auth, credential);

  const variableEntries = Object.entries(operation.variableTypes);
  const variableDefinitions = variableEntries
    .map(([name, typeName]) => `$${name}: ${typeName}`)
    .join(", ");
  const argumentPass = variableEntries.map(([name]) => `${name}: $${name}`).join(", ");
  const selection = operation.selection.trim();
  const selectionSet = selection ? ` { ${selection} }` : "";
  const opName = sanitizeOperationName(operation.id);
  const document = `${operation.operationType} ${opName}${
    variableDefinitions ? `(${variableDefinitions})` : ""
  } { ${operation.fieldName}${argumentPass ? `(${argumentPass})` : ""}${selectionSet} }`;

  const variables: Record<string, unknown> = {};
  for (const name of Object.keys(operation.variableTypes)) {
    if (name in args) variables[name] = args[name];
  }

  const safeFetch = createSafeRemoteFetch(remote.fetch, remote.resolveHostname, remote);
  try {
    const response = await safeFetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ query: document, variables, operationName: opName }),
      signal: combineSignals(signal, AbortSignal.timeout(30_000)),
    });
    const { text, truncated: validationTruncated } = await readBoundedText(
      response,
      MAX_GRAPHQL_VALIDATION_BYTES,
    );
    if (!response.ok) {
      throw new Error(`GraphQL request returned HTTP ${response.status}`);
    }
    if (validationTruncated) {
      throw new Error("GraphQL response exceeded the validation limit");
    }
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error("GraphQL response was not valid JSON");
    }
    const record = asRecord(payload);
    if (!record) {
      throw new Error("GraphQL response was not a JSON object");
    }
    if ("errors" in record && (!Array.isArray(record.errors) || record.errors.length === 0)) {
      throw new Error("GraphQL response contained invalid errors");
    }
    const graphqlErrors = Array.isArray(record.errors) ? record.errors : [];
    if (graphqlErrors.length > 0) {
      const first = asRecord(graphqlErrors[0]);
      const message =
        typeof first?.message === "string" && first.message
          ? first.message
          : "GraphQL operation failed";
      throw new Error(message);
    }
    if (!asRecord(record.data)) {
      throw new Error("GraphQL response contained no valid data");
    }
    const bounded = boundUtf8Text(text, MAX_GRAPHQL_RESULT_BYTES);
    if (bounded.truncated) {
      return { status: response.status, data: bounded.text, truncated: true };
    }
    return {
      status: response.status,
      data: record.data,
    };
  } finally {
    await safeFetch.close().catch(() => undefined);
  }
}

async function introspectGraphqlEndpoint(
  url: URL,
  headers: Record<string, string>,
  signal?: AbortSignal,
  remote: RemoteGraphqlDependencies = {},
): Promise<Record<string, unknown>> {
  const safeFetch = createSafeRemoteFetch(remote.fetch, remote.resolveHostname, remote);
  try {
    const response = await safeFetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ query: INTROSPECTION_QUERY, operationName: "RakazoIntrospection" }),
      signal: combineSignals(signal, AbortSignal.timeout(15_000)),
    });
    if (!response.ok) throw new Error(`GraphQL introspection returned HTTP ${response.status}`);
    const size = Number(response.headers.get("content-length") ?? 0);
    if (size > 2_000_000) throw new Error("GraphQL introspection response is too large");
    const { text, truncated } = await readBoundedText(response, 2_000_000);
    if (truncated) throw new Error("GraphQL introspection response is too large");
    const payload = JSON.parse(text) as Record<string, unknown>;
    const errors = Array.isArray(payload.errors) ? payload.errors : [];
    if (errors.length > 0) {
      const message =
        typeof asRecord(errors[0])?.message === "string"
          ? String(asRecord(errors[0])?.message)
          : "GraphQL introspection failed";
      throw new Error(message);
    }
    return payload;
  } finally {
    await safeFetch.close().catch(() => undefined);
  }
}

function buildSelection(
  type: GqlTypeRef | undefined,
  typeMap: Map<string, GqlType>,
  depth: number,
): string {
  const named = unwrapNamedType(type);
  if (!named?.name) return "";
  if (named.kind === "SCALAR" || named.kind === "ENUM") return "";
  if (depth >= 2) return "__typename";
  const resolved = typeMap.get(named.name);
  if (named.kind === "UNION") {
    const parts = selectionParts("__typename");
    for (const possible of resolved?.possibleTypes ?? []) {
      if (!possible.name || possible.kind !== "OBJECT") continue;
      const selection = buildSelection(possible, typeMap, depth);
      const candidate = `... on ${possible.name} { ${selection || "__typename"} }`;
      if (!parts.append(candidate)) break;
    }
    return parts.value();
  }
  if (!resolved?.fields?.length) return "__typename";

  const parts = selectionParts();
  for (const field of resolved.fields) {
    if (!field.name || field.name.startsWith("__")) continue;
    // Skip fields that require arguments; generated documents cannot invent them.
    // Nullable or defaulted args may be omitted, so those fields stay selectable.
    if (fieldRequiresArguments(field)) continue;
    const fieldNamed = unwrapNamedType(field.type);
    if (!fieldNamed) continue;
    if (fieldNamed.kind === "SCALAR" || fieldNamed.kind === "ENUM") {
      if (!parts.append(field.name)) break;
      continue;
    }
    if (
      depth === 0 &&
      (fieldNamed.kind === "OBJECT" ||
        fieldNamed.kind === "INTERFACE" ||
        fieldNamed.kind === "UNION")
    ) {
      const nested = buildSelection(field.type, typeMap, depth + 1);
      if (nested && !parts.append(`${field.name} { ${nested} }`)) break;
    }
  }
  return parts.value() || "__typename";
}

function selectionParts(initial = "") {
  const parts: string[] = initial ? [initial] : [];
  let length = initial.length;
  return {
    append(candidate: string): boolean {
      const nextLength = length + (parts.length > 0 ? 1 : 0) + candidate.length;
      if (nextLength > MAX_GRAPHQL_SELECTION_CHARS) return false;
      parts.push(candidate);
      length = nextLength;
      return true;
    },
    value: () => parts.join(" "),
  };
}

function fieldRequiresArguments(field: GqlField): boolean {
  return (field.args ?? []).some((arg) => isNonNull(arg.type) && arg.defaultValue == null);
}

function graphqlTypeToJsonSchema(
  type: GqlTypeRef | undefined,
  typeMap: Map<string, GqlType>,
  depth: number,
): Record<string, unknown> {
  if (!type) return {};
  if (type.kind === "NON_NULL") {
    return graphqlNonNullTypeToJsonSchema(type.ofType ?? undefined, typeMap, depth);
  }
  // GraphQL distinguishes an omitted input from an explicit null. Preserve that
  // distinction for arguments, input fields and list items through tool validation.
  return {
    anyOf: [graphqlNonNullTypeToJsonSchema(type, typeMap, depth), { type: "null" }],
  };
}

function graphqlNonNullTypeToJsonSchema(
  type: GqlTypeRef | undefined,
  typeMap: Map<string, GqlType>,
  depth: number,
): Record<string, unknown> {
  if (!type) return {};
  if (type.kind === "LIST") {
    return {
      type: "array",
      items: graphqlTypeToJsonSchema(type.ofType ?? undefined, typeMap, depth),
    };
  }
  if (type.kind === "SCALAR") {
    switch (type.name) {
      case "Int":
      case "Long":
        return { type: "integer" };
      case "Float":
        return { type: "number" };
      case "Boolean":
        return { type: "boolean" };
      default:
        return { type: "string" };
    }
  }
  if (type.kind === "ENUM" && type.name) {
    const values = (typeMap.get(type.name)?.enumValues ?? [])
      .map((value) => value.name)
      .filter((name): name is string => Boolean(name));
    return values.length > 0 ? { type: "string", enum: values } : { type: "string" };
  }
  if ((type.kind === "INPUT_OBJECT" || type.kind === "OBJECT") && type.name && depth < 2) {
    const resolved = typeMap.get(type.name);
    const fields = resolved?.inputFields ?? resolved?.fields ?? [];
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const field of fields) {
      if (!field.name) continue;
      properties[field.name] = {
        ...graphqlTypeToJsonSchema(field.type, typeMap, depth + 1),
        ...(field.description ? { description: field.description } : {}),
      };
      const defaultValue = "defaultValue" in field ? field.defaultValue : undefined;
      if (isNonNull(field.type) && defaultValue == null) required.push(field.name);
    }
    return {
      type: "object",
      properties,
      ...(required.length > 0 ? { required } : {}),
    };
  }
  return { type: "object" };
}

function printGraphqlType(type: GqlTypeRef | undefined): string {
  if (!type) return "String";
  if (type.kind === "NON_NULL") return `${printGraphqlType(type.ofType ?? undefined)}!`;
  if (type.kind === "LIST") return `[${printGraphqlType(type.ofType ?? undefined)}]`;
  return type.name || "String";
}

function unwrapNamedType(type: GqlTypeRef | undefined): GqlTypeRef | undefined {
  let current = type;
  while (current && (current.kind === "NON_NULL" || current.kind === "LIST")) {
    current = current.ofType ?? undefined;
  }
  return current;
}

function isNonNull(type: GqlTypeRef | undefined): boolean {
  return type?.kind === "NON_NULL";
}

function sanitizeOperationName(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9_]/g, "_");
  return /^[A-Za-z_]/.test(cleaned) ? cleaned.slice(0, 80) : `op_${cleaned}`.slice(0, 80);
}

function stringName(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function boundUtf8Text(value: string, maximumBytes: number): { text: string; truncated: boolean } {
  const encoded = new TextEncoder().encode(value);
  if (encoded.byteLength <= maximumBytes) return { text: value, truncated: false };
  let end = maximumBytes;
  while (end > 0) {
    try {
      return {
        text: new TextDecoder("utf-8", { fatal: true }).decode(encoded.subarray(0, end)),
        truncated: true,
      };
    } catch {
      end -= 1;
    }
  }
  return { text: "", truncated: true };
}
