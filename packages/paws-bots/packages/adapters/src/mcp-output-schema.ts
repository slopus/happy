import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import type {
  JsonSchemaType,
  JsonSchemaValidator,
  JsonSchemaValidatorResult,
  jsonSchemaValidator,
} from "@modelcontextprotocol/sdk/validation/types.js";
import { getLogger } from "@rakazo/logging";

const PATTERN_PREVIEW_CHARS = 160;
const REASON_PREVIEW_CHARS = 300;
const MAX_LOGGED_PATTERNS = 8;
const LITERAL_KEYWORDS = new Set(["const", "enum", "default", "examples", "example"]);
const SCHEMA_MAP_KEYWORDS = new Set(["properties", "patternProperties", "$defs", "definitions"]);

/**
 * Compiler for MCP tool output schemas.
 *
 * Listing tools compiles every output schema before the list is returned, so one
 * `pattern` Ajv rejects under its unicode flag (for example `\:`) hides every
 * tool on that server. Valid schemas keep Ajv's default unicode regular
 * expressions. A schema that cannot be compiled is checked without the patterns
 * that failed, and if it still cannot be compiled that tool's output is accepted
 * and the failure is logged.
 */
export function createMcpJsonSchemaValidator(): jsonSchemaValidator {
  const strict = new AjvJsonSchemaValidator();
  return {
    getValidator<T>(schema: JsonSchemaType): JsonSchemaValidator<T> {
      try {
        return strict.getValidator(schema);
      } catch (error) {
        return compileWithoutInvalidPatterns(schema, error);
      }
    },
  };
}

/** An MCP client whose tool-output checks survive one uncompilable schema. */
export function createMcpClient(
  info: { name: string; version: string },
  options?: NonNullable<ConstructorParameters<typeof Client>[1]>,
): Client {
  return new Client(info, {
    ...options,
    jsonSchemaValidator: createMcpJsonSchemaValidator(),
  });
}

function compileWithoutInvalidPatterns<T>(
  schema: JsonSchemaType,
  error: unknown,
): JsonSchemaValidator<T> {
  const dropped: string[] = [];
  let degraded: JsonSchemaType;
  try {
    degraded = withoutInvalidUnicodePatterns(schema, dropped);
  } catch (cloneError) {
    return skipOutputValidation(cloneError);
  }
  try {
    // A failed compile stays cached under the schema's $id, so the repaired
    // schema has to be compiled by a new instance.
    const validator = new AjvJsonSchemaValidator().getValidator<T>(degraded);
    if (dropped.length > 0) {
      getLogger().warn(
        "mcp output schema pattern is invalid under unicode regular expressions; validating without it",
        {
          patterns: dropped
            .slice(0, MAX_LOGGED_PATTERNS)
            .map((pattern) => preview(pattern, PATTERN_PREVIEW_CHARS)),
          patternCount: dropped.length,
          reason: preview(errorText(error), REASON_PREVIEW_CHARS),
        },
      );
    }
    return validator;
  } catch (retryError) {
    return skipOutputValidation(retryError);
  }
}

function skipOutputValidation<T>(error: unknown): JsonSchemaValidator<T> {
  getLogger().warn(
    "mcp output schema could not be compiled; skipping output validation for that tool",
    {
      reason: preview(errorText(error), REASON_PREVIEW_CHARS),
    },
  );
  return (input: unknown): JsonSchemaValidatorResult<T> => ({
    valid: true,
    data: input as T,
    errorMessage: undefined,
  });
}

/** A copy of `schema` with `pattern` values and `patternProperties` keys that
 * `new RegExp(pattern, "u")` rejects removed. The original is left unchanged. */
function withoutInvalidUnicodePatterns(schema: JsonSchemaType, dropped: string[]): JsonSchemaType {
  const copy = structuredClone(schema);
  stripInvalidUnicodePatterns(copy, dropped);
  return copy;
}

function stripInvalidUnicodePatterns(value: unknown, dropped: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) stripInvalidUnicodePatterns(item, dropped);
    return;
  }
  if (value === null || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  if (typeof record.pattern === "string" && !compilesWithUnicodeFlag(record.pattern)) {
    dropped.push(record.pattern);
    delete record.pattern;
  }
  const properties = record.patternProperties;
  if (isRecord(properties)) {
    for (const key of Object.keys(properties)) {
      if (!compilesWithUnicodeFlag(key)) {
        dropped.push(key);
        delete properties[key];
      }
    }
  }
  for (const [key, child] of Object.entries(record)) {
    if (LITERAL_KEYWORDS.has(key)) continue;
    if (SCHEMA_MAP_KEYWORDS.has(key) && isRecord(child)) {
      for (const schema of Object.values(child)) stripInvalidUnicodePatterns(schema, dropped);
    } else {
      stripInvalidUnicodePatterns(child, dropped);
    }
  }
}

function compilesWithUnicodeFlag(pattern: string): boolean {
  try {
    new RegExp(pattern, "u");
    return true;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function preview(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}...` : value;
}
