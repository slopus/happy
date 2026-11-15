import { z } from "zod";

const RESERVED_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "host",
  "content-length",
  "content-type",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "upgrade",
  "te",
  "trailer",
  "expect",
]);

export function allowedModelHeaderName(name: string): boolean {
  const lower = name.trim().toLowerCase();
  return !RESERVED_HEADERS.has(lower) && !lower.startsWith("proxy-") && !lower.startsWith("sec-");
}

const ModelHeaderNameSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[\t ]*[!#$%&'*+.^_`|~0-9A-Za-z-]+[\t ]*$/)
  .refine(allowedModelHeaderName, "Invalid custom headers");
const ModelHeaderValueSchema = z
  .string()
  .min(1)
  .max(1024)
  .regex(/^[\x20-\x7e]*$/);

function validHeaderNames(names: string[]): boolean {
  return (
    names.length <= 8 &&
    new Set(names.map((name) => name.trim().toLowerCase())).size === names.length
  );
}

/** Validated before storage and again at the transport boundary. Never include values in errors. */
export const ModelHeadersSchema = z
  .record(ModelHeaderNameSchema, ModelHeaderValueSchema)
  .refine((headers) => validHeaderNames(Object.keys(headers)), "Invalid custom headers")
  .transform((headers) =>
    Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.trim(), value])),
  );

export function parseModelHeaders(input: unknown): Record<string, string> {
  const parsed = ModelHeadersSchema.safeParse(input);
  if (!parsed.success) throw new Error("Invalid custom headers");
  return parsed.data;
}

export const ModelHeaderRowsSchema = z
  .array(z.strictObject({ name: ModelHeaderNameSchema, value: ModelHeaderValueSchema }))
  .refine((rows) => validHeaderNames(rows.map((row) => row.name)), "Invalid custom headers");
export type ModelHeaderRow = z.infer<typeof ModelHeaderRowsSchema>[number];

/** Untouched keeps saved secrets; an empty replacement explicitly removes them. */
export function modelHeadersInput(
  rows: ModelHeaderRow[] | null,
): Record<string, string> | undefined {
  if (rows === null) return undefined;
  const parsed = ModelHeaderRowsSchema.safeParse(rows);
  if (!parsed.success) throw new Error("Invalid custom headers");
  return Object.fromEntries(parsed.data.map(({ name, value }) => [name.trim(), value]));
}
