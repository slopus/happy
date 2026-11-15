import type { ModelHeaderRow } from "./model-headers.js";
import { ModelHeaderRowsSchema, ModelHeadersSchema } from "./model-headers.js";

/** Rakazo names its own request headers; a configured header must not replace them. */
function allowedServerHeaderName(name: string): boolean {
  const lower = name.trim().toLowerCase();
  return (
    ![
      "origin",
      "referer",
      "cookie2",
      "set-cookie",
      "via",
      "forwarded",
      "x-forwarded-for",
      "x-forwarded-host",
      "x-forwarded-proto",
    ].includes(lower) && !lower.startsWith("x-rakazo-")
  );
}

/**
 * Headers a client sends with every request to one server, such as an access proxy's
 * service credentials. Validated before storage and again when read back.
 */
export const ServerHeadersSchema = ModelHeadersSchema.refine(
  (headers) => Object.keys(headers).every(allowedServerHeaderName),
  "Invalid custom headers",
);

/** Null for anything unusable, so a damaged saved value never reaches a request. */
export function parseServerHeaders(input: unknown): Record<string, string> | null {
  const parsed = ServerHeadersSchema.safeParse(input);
  return parsed.success ? parsed.data : null;
}

export function serverHeadersFromRows(rows: ModelHeaderRow[]): Record<string, string> {
  const filled = rows.filter((row) => row.name.trim() !== "" || row.value !== "");
  const parsed = ModelHeaderRowsSchema.safeParse(filled);
  const headers = parsed.success
    ? parseServerHeaders(Object.fromEntries(parsed.data.map((row) => [row.name, row.value])))
    : null;
  if (headers === null) throw new Error("Invalid custom headers");
  return headers;
}
