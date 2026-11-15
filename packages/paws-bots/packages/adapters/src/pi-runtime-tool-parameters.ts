import type { ConnectorTool } from "@rakazo/adapter-kit";
import { BOT_INSTRUCTIONS_MAX_LENGTH, ThinkingLevelSchema } from "@rakazo/contracts";
import { getLogger } from "@rakazo/logging";
import { Type } from "typebox";
import { MAX_APPROVAL_DETAIL_LENGTH } from "./approval-ask.js";
import {
  normalizeOpenAiToolParameters,
  openAiToolParametersNeedNormalization,
} from "./openai-tool-parameters.js";
import { argumentGiven } from "./update-bot-patch.js";

export function parametersFor(tool: ConnectorTool) {
  const builtin = builtinParameters(tool);
  const schema = builtin
    ? withDeclaredDescriptions(builtin, tool.inputSchema)
    : safeJsonSchemaParameters(tool);
  // Type.Union (top-level oneOf/anyOf) serializes without type/properties, and
  // Anthropic rejects a root union, so it is flattened into one object schema.
  // Re-wrap only when needed so Type.Object schemas keep TypeBox Kind metadata.
  if (!openAiToolParametersNeedNormalization(schema)) return schema;
  return Type.Unsafe(
    normalizeOpenAiToolParameters(JSON.parse(JSON.stringify(schema))),
  ) as unknown as ReturnType<typeof Type.Object>;
}

/** builtinParameters hand-builds stricter schemas for some tools, and those carried none of
 * the parameter descriptions the tool declares. Copy each declared description onto the
 * matching top-level field. The schema is built fresh per call, so this mutates no shared
 * node. */
function withDeclaredDescriptions<T>(schema: T, declared: unknown): T {
  const fields = (schema as { properties?: Record<string, Record<string, unknown>> }).properties;
  const source = (
    declared as { properties?: Record<string, { description?: unknown }> } | undefined
  )?.properties;
  if (!fields || !source) return schema;
  for (const [key, spec] of Object.entries(source)) {
    const field = fields[key];
    if (
      field &&
      field.description === undefined &&
      typeof spec?.description === "string" &&
      spec.description
    ) {
      field.description = spec.description;
    }
  }
  return schema;
}

/** A remote MCP server controls its own schemas, so a shape TypeBox cannot express must
 * degrade to a permissive object instead of failing every turn for the whole bot. */
function safeJsonSchemaParameters(tool: ConnectorTool) {
  try {
    return jsonSchemaParameters(tool.inputSchema);
  } catch (error) {
    getLogger().error(`unsupported input schema for tool ${tool.name}`, error);
    return Type.Object({});
  }
}

function builtinParameters(tool: ConnectorTool) {
  if (tool.name === "write_file") {
    return Type.Object({ path: Type.String(), content: Type.String() });
  }
  if (tool.name === "request_takeover") {
    return Type.Object({ reason: Type.String() });
  }
  if (tool.name === "ask_user") {
    return Type.Object({
      question: Type.String({ maxLength: 240 }),
      detail: Type.Optional(Type.String({ maxLength: MAX_APPROVAL_DETAIL_LENGTH })),
      options: Type.Array(Type.String({ minLength: 1, maxLength: 80 }), {
        minItems: 2,
        maxItems: 4,
        uniqueItems: true,
      }),
    });
  }
  if (tool.name === "remember") {
    return Type.Object({ content: Type.String(), old_text: Type.Optional(Type.String()) });
  }
  if (tool.name === "shell" || tool.name === "user_computer_shell") {
    return Type.Object({
      command: Type.String(),
      cwd: Type.Optional(Type.String()),
    });
  }
  if (tool.name === "run_subagent") {
    return Type.Object({
      name: Type.String(),
      task: Type.String(),
      instructions: Type.Optional(Type.String()),
      model_provider: Type.Optional(Type.String()),
      model_id: Type.Optional(Type.String()),
      background: Type.Optional(Type.Boolean()),
    });
  }
  if (tool.name === "spawn_bot") {
    return Type.Object({
      name: Type.String(),
      description: Type.Optional(Type.String()),
      instructions: Type.Optional(Type.String()),
      prompt: Type.Optional(Type.String()),
      computer_mode: Type.Optional(stringEnum(["team", "dedicated"], {})),
    });
  }
  if (tool.name === "update_bot") {
    return Type.Object({
      name: Type.Optional(Type.String()),
      description: Type.Optional(Type.String()),
      instructions: Type.Optional(Type.String()),
      instructions_offset: Type.Optional(Type.Integer({ minimum: 0 })),
      color: Type.Optional(Type.String()),
      artifact_id: Type.Optional(Type.String()),
      use_attached_image: Type.Optional(Type.Boolean()),
      notifyOnFinish: Type.Optional(Type.Boolean()),
      dailyCheckIns: Type.Optional(Type.Boolean()),
      model: Type.Optional(Type.String()),
      thinkingLevel: Type.Optional(stringEnum(ThinkingLevelSchema.options, {})),
      readAloud: Type.Optional(Type.Boolean()),
      voice: Type.Optional(Type.String()),
      bot_id: Type.Optional(Type.String()),
    });
  }
  if (tool.name === "list_fleet") return Type.Object({ bot_id: Type.Optional(Type.String()) });
  if (tool.name === "create_group") {
    return Type.Object({
      name: Type.String({ minLength: 1 }),
      bot_ids: Type.Optional(Type.Array(Type.String())),
      bot_names: Type.Optional(Type.Array(Type.String())),
    });
  }
  if (tool.name === "update_group") {
    return Type.Object({
      group_id: Type.Optional(Type.String()),
      group_name: Type.Optional(Type.String()),
      name: Type.Optional(Type.String({ minLength: 1 })),
      add_bot_ids: Type.Optional(Type.Array(Type.String())),
      remove_bot_ids: Type.Optional(Type.Array(Type.String())),
    });
  }
  if (tool.name === "organize_bot") {
    return Type.Object({
      bot_id: Type.Optional(Type.String()),
      bot_name: Type.Optional(Type.String()),
      group_id: Type.Optional(Type.String()),
      group_name: Type.Optional(Type.String()),
      section: Type.Optional(Type.String({ minLength: 1 })),
      clear_section: Type.Optional(Type.Boolean()),
      pinned: Type.Optional(Type.Boolean()),
    });
  }
  if (tool.name === "set_child_instructions") {
    return Type.Object({
      bot_id: Type.Optional(Type.String()),
      bot_name: Type.Optional(Type.String()),
      instructions: Type.String({ minLength: 1, maxLength: BOT_INSTRUCTIONS_MAX_LENGTH }),
      expected_version: Type.String(),
    });
  }
  if (tool.name === "set_child_bot_model") {
    return Type.Object({
      bot_id: Type.Optional(Type.String()),
      bot_name: Type.Optional(Type.String()),
      provider: Type.Optional(Type.String()),
      model: Type.Optional(Type.String()),
      thinking_level: Type.Optional(Type.String()),
      clear: Type.Optional(Type.Boolean()),
    });
  }
  if (tool.name === "create_space") {
    return Type.Object({ name: Type.String({ minLength: 1, maxLength: 60 }) });
  }
  if (tool.name === "archive_bot") {
    return Type.Object({
      confirm_name: Type.String(),
      bot_id: Type.Optional(Type.String()),
    });
  }
  return undefined;
}

export function jsonSchemaParameters(
  schema: Record<string, unknown>,
  options: FieldOptions = {},
): ReturnType<typeof Type.Object> {
  // Keep intersections and union siblings intact until parametersFor flattens them.
  if (
    Array.isArray(schema.allOf) ||
    [schema.oneOf, schema.anyOf].some(
      (variants) =>
        Array.isArray(variants) &&
        variants.some(
          (variant) =>
            typeof variant === "boolean" ||
            (variant != null && typeof variant === "object" && "patternProperties" in variant),
        ),
    ) ||
    ((Array.isArray(schema.oneOf) || Array.isArray(schema.anyOf)) &&
      Object.keys(schema).some(
        (key) =>
          key !== "oneOf" &&
          key !== "anyOf" &&
          key !== "title" &&
          key !== "description" &&
          !(key === "type" && schema.type === "object"),
      )) ||
    (Array.isArray(schema.oneOf) && Array.isArray(schema.anyOf))
  ) {
    return Type.Unsafe({
      ...(enrichStringConsts({ ...schema, ...options }) as Record<string, unknown>),
    }) as unknown as ReturnType<typeof Type.Object>;
  }
  const alternatives = Array.isArray(schema.oneOf)
    ? schema.oneOf
    : Array.isArray(schema.anyOf)
      ? schema.anyOf
      : undefined;
  if (alternatives && alternatives.length > 0) {
    return Type.Union(
      alternatives.map((variant) => jsonSchemaParameters(variant as Record<string, unknown>)),
      options,
    ) as unknown as ReturnType<typeof Type.Object>;
  }
  // A property-less object (`{"type":"object"}`) describes a free-form object, and JSON Schema
  // treats it identically to `{"type":"object","properties":{}}`. Grammar-constrained tool
  // decoders do not: Fireworks reads the empty map as "no keys allowed" and emits `{}`, so a
  // lazily loaded tool's `arguments` arrived empty. Emit the source schema unchanged (minus the
  // map it never had) unless the object is explicitly closed.
  if (
    schema.properties == null &&
    schema.additionalProperties == null &&
    schema.patternProperties == null
  ) {
    return Type.Unsafe({ ...schema, ...options }) as unknown as ReturnType<typeof Type.Object>;
  }
  const properties = (schema.properties ?? {}) as Record<string, unknown>;
  const required = new Set(Array.isArray(schema.required) ? schema.required.map(String) : []);
  const fields: Record<string, ReturnType<typeof Type.Optional>> = {};
  for (const [key, spec] of Object.entries(properties)) {
    const field = jsonField(spec);
    fields[key] = (required.has(key) ? field : Type.Optional(field)) as unknown as ReturnType<
      typeof Type.Optional
    >;
  }
  // Nested fields can retain references to definitions on this object.
  const objectOptions = {
    ...(schema.$defs !== undefined ? { $defs: schema.$defs } : {}),
    ...options,
  };
  // Preserve closed objects (e.g. request_secret destination oneOf branches).
  // Type.Object defaults to open, which would let connectionId+replace match both
  // anyOf variants after conversion.
  if (schema.additionalProperties === false) {
    return Type.Object(fields, { ...objectOptions, additionalProperties: false });
  }
  // Several providers' constrained decoders read `{type: "object", properties: {}}` without
  // `additionalProperties` as closed and can only emit `{}`, so declared open maps (Composio's
  // COMPOSIO_MULTI_EXECUTE_TOOL `tools[].arguments`) must stay open on the wire. Typed values
  // are sent as `true`: jsonField cannot express every value schema (`$ref`, patternProperties).
  if (schema.additionalProperties != null) {
    return Type.Object(fields, { ...objectOptions, additionalProperties: true });
  }
  return Type.Object(fields, objectOptions);
}

type FieldOptions = { description?: string };

/** Add gateway-compatible string discriminators without rebuilding or mutating the schema. */
function enrichStringConsts(value: unknown): unknown {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return value;
  const schema = value as Record<string, unknown>;
  const result = { ...schema };
  if (typeof schema.const === "string") {
    if (!("type" in schema)) result.type = "string";
    if (!("enum" in schema) || (Array.isArray(schema.enum) && schema.enum.includes(schema.const))) {
      result.enum = [schema.const];
    }
  }

  for (const key of [
    "properties",
    "patternProperties",
    "$defs",
    "definitions",
    "dependentSchemas",
    "dependencies",
  ]) {
    const map = schema[key];
    if (map != null && typeof map === "object" && !Array.isArray(map)) {
      result[key] = Object.fromEntries(
        Object.entries(map).map(([name, child]) => [name, enrichStringConsts(child)]),
      );
    }
  }
  for (const key of ["allOf", "anyOf", "oneOf", "prefixItems"]) {
    const variants = schema[key];
    if (Array.isArray(variants)) result[key] = variants.map(enrichStringConsts);
  }
  for (const key of [
    "items",
    "additionalItems",
    "additionalProperties",
    "unevaluatedItems",
    "unevaluatedProperties",
    "contains",
    "propertyNames",
    "not",
    "if",
    "then",
    "else",
    "contentSchema",
  ]) {
    const child = schema[key];
    if (child !== undefined) {
      result[key] = Array.isArray(child)
        ? child.map(enrichStringConsts)
        : enrichStringConsts(child);
    }
  }
  return result;
}

/** Carry the parameter description when rebuilding its TypeBox node. */
function fieldOptions(definition: Record<string, unknown>): FieldOptions {
  return typeof definition.description === "string" && definition.description
    ? { description: definition.description }
    : {};
}

const FLEET_STRING_ARGS = [
  "bot_id",
  "bot_name",
  "group_id",
  "group_name",
  "name",
  "description",
  "color",
  "artifact_id",
  "provider",
  "model",
  "thinking_level",
  "thinkingLevel",
  "voice",
  "section",
  "instructions",
  "expected_version",
] as const;
const FLEET_LIST_ARGS = ["bot_ids", "bot_names", "add_bot_ids", "remove_bot_ids"] as const;
const FLEET_FLAG_ARGS = [
  "pinned",
  "clear_section",
  "clear",
  "use_attached_image",
  "readAloud",
] as const;

/**
 * Keeps only the fleet and `update_bot` arguments a model sent, coerced to their declared types.
 * Providers send omitted optional fields as null or blank, so those stay absent: `String(null)`
 * would otherwise become the text "null".
 */
export function prepareFleetArguments(
  toolName: string,
  raw: Record<string, unknown>,
): Record<string, unknown> {
  // A routine's timing fields are numbers and one-of branches; only the blanks are dropped.
  if (toolName === "create_child_routine") {
    return Object.fromEntries(Object.entries(raw).filter(([, value]) => argumentGiven(value)));
  }
  const out: Record<string, unknown> = {};
  for (const key of FLEET_STRING_ARGS) {
    if (toolName === "update_bot" && key === "expected_version") continue;
    if (argumentGiven(raw[key])) out[key] = String(raw[key]);
  }
  for (const key of FLEET_LIST_ARGS) {
    if (Array.isArray(raw[key])) out[key] = raw[key].map(String);
  }
  for (const key of FLEET_FLAG_ARGS) {
    if (argumentGiven(raw[key])) out[key] = raw[key];
  }
  if (argumentGiven(raw.dailyCheckIns)) out.dailyCheckIns = raw.dailyCheckIns;
  const notify = raw.notifyOnFinish ?? raw.notify_on_finish;
  if (argumentGiven(notify)) out.notifyOnFinish = notify;
  // The read pager's offset is a number; the handler validates it.
  if (toolName === "update_bot" && argumentGiven(raw.instructions_offset))
    out.instructions_offset = raw.instructions_offset;
  return out;
}

/** Use a plain string enum: some gateways discard the allowed values from anyOf/const unions. */
function stringEnum(values: readonly string[], options: FieldOptions) {
  return Type.Unsafe<string>({ type: "string", enum: [...values], ...options });
}

/** TypeBox only builds literals from primitives; anything else throws while the tool list is
 * being assembled, which would take down the whole turn. */
function enumUnion(values: readonly unknown[], options: FieldOptions = {}) {
  const members = values.map((value) =>
    value === null
      ? Type.Null()
      : typeof value === "string" || typeof value === "number" || typeof value === "boolean"
        ? Type.Literal(value)
        : undefined,
  );
  return members.every((member) => member !== undefined) ? Type.Union(members, options) : undefined;
}

export function jsonField(spec: unknown): ReturnType<typeof Type.String> {
  const definition = spec && typeof spec === "object" ? (spec as Record<string, unknown>) : {};
  const options = fieldOptions(definition);
  // Nested intersections need the same preservation as root schemas; otherwise an
  // allOf-only field falls back to string and loses its sibling constraints.
  if (Array.isArray(definition.allOf)) {
    return jsonSchemaParameters(definition, options) as never;
  }
  if (Array.isArray(definition.enum) && definition.enum.length > 0) {
    if (definition.enum.every((value) => typeof value === "string")) {
      return stringEnum(definition.enum as string[], options) as never;
    }
    const union = enumUnion(definition.enum, options);
    if (union) return union as never;
  }
  // Falling through to a bare string would tell the model nothing about which
  // discriminator value to send.
  if ("const" in definition) {
    // Keep `const` (discriminators such as request_secret's auth.type depend on it) and
    // add the equivalent one-value `enum`, which survives converters that drop `const`.
    if (typeof definition.const === "string") {
      return Type.Unsafe<string>({
        type: "string",
        const: definition.const,
        enum: [definition.const],
        ...options,
      }) as never;
    }
    const literal = enumUnion([definition.const], options);
    if (literal) return literal as never;
  }
  // A discriminated union arrives as oneOf/anyOf with no sibling `type`; the string
  // default would tell the model to send an object-valued field as a bare string.
  const variants = Array.isArray(definition.oneOf)
    ? definition.oneOf
    : Array.isArray(definition.anyOf)
      ? definition.anyOf
      : undefined;
  if (variants && variants.length > 0) {
    return Type.Union(
      variants.map((variant) => jsonField(variant)),
      options,
    ) as never;
  }
  if (Array.isArray(definition.type) && definition.type.length > 0) {
    // The description belongs on the union, not repeated on every member.
    const { description: _description, ...member } = definition;
    return Type.Union(
      definition.type.map((type) => jsonField({ ...member, type })),
      options,
    ) as never;
  }
  const type = "type" in definition ? String(definition.type) : "string";
  if (type === "null") return Type.Null(options) as never;
  if (type === "integer" || type === "number") {
    const numericOptions = {
      ...options,
      ...(typeof definition.minimum === "number" ? { minimum: definition.minimum } : {}),
      ...(typeof definition.maximum === "number" ? { maximum: definition.maximum } : {}),
    };
    return (
      type === "integer" ? Type.Integer(numericOptions) : Type.Number(numericOptions)
    ) as never;
  }
  if (type === "boolean") return Type.Boolean(options) as never;
  if (type === "array") {
    const arrayOptions: FieldOptions & {
      minItems?: number;
      maxItems?: number;
      uniqueItems?: boolean;
    } = { ...options };
    if (typeof definition.minItems === "number") arrayOptions.minItems = definition.minItems;
    if (typeof definition.maxItems === "number") arrayOptions.maxItems = definition.maxItems;
    if (definition.uniqueItems === true) arrayOptions.uniqueItems = true;
    return Type.Array(jsonField(definition.items), arrayOptions) as never;
  }
  if (type === "object") return jsonSchemaParameters(definition, options) as never;
  return Type.String({
    ...options,
    ...(typeof definition.minLength === "number" ? { minLength: definition.minLength } : {}),
    ...(typeof definition.maxLength === "number" ? { maxLength: definition.maxLength } : {}),
  });
}
