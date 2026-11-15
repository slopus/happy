/**
 * OpenAI chat-completions `tools[].function.parameters` must be a JSON Schema
 * object. Hosted proxies (OpenRouter) are lenient; local OpenAI-compatible
 * servers (LM Studio, etc.) reject missing `type: "object"` and often reject
 * zero-argument schemas that omit `properties`. Anthropic rejects the whole
 * request when a tool's root schema carries oneOf, anyOf, or allOf.
 *
 * Normalize at the adapter boundary so every provider path benefits.
 * Does not invent parameter names — only ensures the required envelope.
 */
export function normalizeOpenAiToolParameters(parameters: unknown): Record<string, unknown> {
  const schema = flattenRootUnion(isRecord(parameters) ? { ...parameters } : {});
  const properties = isRecord(schema.properties) ? schema.properties : {};
  return { ...schema, type: "object", properties };
}

/** True when a schema would fail stricter OpenAI-compatible tool validators. */
export function openAiToolParametersNeedNormalization(parameters: unknown): boolean {
  if (!isRecord(parameters)) return true;
  if (parameters.type !== "object") return true;
  if (rootUnionKey(parameters)) return true;
  return !isRecord(parameters.properties);
}

const ROOT_UNION_KEYS = ["oneOf", "anyOf", "allOf"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function rootUnionKey(schema: Record<string, unknown>) {
  return ROOT_UNION_KEYS.find((key) => Array.isArray(schema[key]));
}

/**
 * Merge root-level variants into one object schema: every variant's fields stay
 * visible, and only fields required by all oneOf/anyOf variants (any allOf
 * variant) stay required. Differing specs for the same field become a nested
 * anyOf, or a nested allOf when the root combinator is allOf. Exclusivity
 * between variants is lost on the wire, so the executor must keep validating
 * arguments against the original schema.
 */
function flattenRootUnion(
  schema: Record<string, unknown>,
  root = schema,
  references: ReadonlySet<string> = new Set(),
): Record<string, unknown> {
  const ref = schema.$ref;
  if (typeof ref === "string" && !references.has(ref)) {
    const target = localSchemaReference(root, ref);
    if (isRecord(target)) {
      const { $ref: _ref, ...siblings } = schema;
      return flattenRootUnion({ allOf: [target, siblings] }, root, new Set([...references, ref]));
    }
  }
  if (!rootUnionKey(schema)) return schema;
  const { oneOf: _oneOf, anyOf: _anyOf, allOf: _allOf, ...rest } = schema;
  const requiredOf = (source: Record<string, unknown>) =>
    Array.isArray(source.required) ? source.required.map(String) : [];
  const mergeProperties = (sources: Record<string, unknown>[], combinator: "allOf" | "anyOf") => {
    const specs = new Map<string, unknown[]>();
    for (const source of sources) {
      if (!isRecord(source.properties)) continue;
      for (const [name, spec] of Object.entries(source.properties)) {
        const seen = specs.get(name) ?? [];
        if (!seen.some((other) => JSON.stringify(other) === JSON.stringify(spec))) seen.push(spec);
        specs.set(name, seen);
      }
    }
    return Object.fromEntries(
      [...specs].map(([name, seen]) => [
        name,
        seen.length === 1 ? seen[0] : { [combinator]: seen },
      ]),
    );
  };

  const groups = (["allOf", "anyOf", "oneOf"] as const).flatMap((key) => {
    if (!Array.isArray(schema[key])) return [];
    const variants = schema[key]
      .map((variant) => (variant === true ? {} : variant))
      .filter(isRecord)
      .map((variant) => flattenRootUnion(variant, root, references));
    const variantRequired = variants.map(requiredOf);
    const required =
      key === "allOf"
        ? variantRequired.flat()
        : (variantRequired[0] ?? []).filter((name) =>
            variantRequired.every((items) => items.includes(name)),
          );
    return [
      {
        key,
        variants,
        hasTrueAlternative: key !== "allOf" && schema[key].includes(true),
        properties: mergeProperties(variants, key === "allOf" ? "allOf" : "anyOf"),
        required,
        ...(variants.length > 0 &&
        variants.every(
          (variant) => variant.additionalProperties === false && variant.patternProperties == null,
        )
          ? { additionalProperties: false }
          : {}),
      },
    ];
  });
  const siblingProperties = [rest, ...groups].map((source) =>
    isRecord(source.properties) ? new Set(Object.keys(source.properties)) : new Set<string>(),
  );
  for (const [index, group] of groups.entries()) {
    if (group.key === "allOf") continue;
    for (const name of Object.keys(group.properties)) {
      const hasSibling = siblingProperties.some((names, i) => i !== index + 1 && names.has(name));
      if (group.hasTrueAlternative) {
        if (hasSibling) delete group.properties[name];
        else group.properties[name] = {};
        continue;
      }
      if (!hasSibling) {
        continue;
      }
      const missing = group.variants.filter(
        (variant) => !isRecord(variant.properties) || !Object.hasOwn(variant.properties, name),
      );
      for (const variant of missing) {
        // A closed alternative without patterns cannot accept this property. An open
        // alternative permits it, so don't intersect with constraints from other
        // alternatives when a sibling already supplies the property's schema.
        if (variant.patternProperties == null && variant.additionalProperties === false) continue;
        if (variant.patternProperties == null && isRecord(variant.additionalProperties)) {
          group.properties[name] = {
            anyOf: [group.properties[name], variant.additionalProperties],
          };
        } else {
          delete group.properties[name];
          break;
        }
      }
    }
  }
  const sources = [rest, ...groups];
  const properties = mergeProperties(sources, "allOf");
  for (const names of siblingProperties) {
    for (const name of names) {
      if (!Object.hasOwn(properties, name)) properties[name] = {};
    }
  }
  const required = [...new Set(sources.flatMap(requiredOf))];
  const closed = sources.some((source) => source.additionalProperties === false);
  return {
    ...rest,
    properties,
    ...(required.length > 0 ? { required } : {}),
    ...(closed ? { additionalProperties: false } : {}),
  };
}

/** Resolve only same-document JSON pointers; never fetch external schemas. */
export function localSchemaReference(root: Record<string, unknown>, ref: string): unknown {
  if (ref === "#") return root;
  if (!ref.startsWith("#/")) return undefined;
  let pointer: string;
  try {
    pointer = decodeURIComponent(ref.slice(2));
  } catch {
    return undefined;
  }
  let value: unknown = root;
  for (const token of pointer.split("/")) {
    const key = token.replace(/~1/g, "/").replace(/~0/g, "~");
    if (!value || typeof value !== "object" || !Object.hasOwn(value, key)) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}
