import { z } from "zod";

const HeaderValue = z.string().max(2_048);
export const HeaderName = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/, "Invalid HTTP header name")
  .refine((name) => !isTransportHeader(name), "Transport-level headers cannot be customized");
export const AuthSchema = z
  .object({
    type: z.enum(["none", "bearer", "header", "query"]).default("none"),
    name: HeaderName.optional(),
  })
  .default({ type: "none" });

export const PublicHeadersSchema = z
  .record(HeaderName, HeaderValue)
  .default({})
  .superRefine((headers, context) => {
    for (const name of Object.keys(headers)) {
      if (isSensitiveHeader(name)) {
        context.addIssue({
          code: "custom",
          message: `Sensitive header ${name} must use the encrypted credential field`,
        });
      } else if (isTransportHeader(name)) {
        context.addIssue({
          code: "custom",
          message: `Transport-level header ${name} cannot be customized`,
        });
      }
    }
  });

export function requireCredential(auth: z.infer<typeof AuthSchema>, credential?: string): void {
  if (auth.type !== "none" && !credential) throw new Error("This connector requires a credential");
}

export function applyCredential(
  url: URL,
  headers: Record<string, string>,
  auth: z.infer<typeof AuthSchema>,
  credential?: string,
): void {
  if (!credential || auth.type === "none") return;
  if (auth.type === "query") {
    if (!auth.name) throw new Error("Authentication query name is required");
    url.searchParams.set(auth.name, credential);
    return;
  }
  const name = auth.type === "header" ? auth.name : "authorization";
  if (!name) throw new Error("Authentication header name is required");
  headers[name] = auth.type === "bearer" ? `Bearer ${credential}` : credential;
}

export function isSensitiveHeader(name: string): boolean {
  return /(authorization|cookie|api[-_]?key|token|secret)/i.test(name);
}

export function isTransportHeader(name: string): boolean {
  return /^(connection|content-length|host|proxy-authorization|proxy-connection|te|trailer|transfer-encoding|upgrade)$/i.test(
    name,
  );
}

export function assertNoSensitiveQuery(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Connector URL is invalid");
  }
  const name = sensitiveQueryParameter(url);
  if (name) throw new Error(`Connector URL must put ${name} in the encrypted credential field`);
}

export function sensitiveQueryParameter(url: URL): string | undefined {
  return [...url.searchParams.keys()].find((name) =>
    /(auth|credential|key|password|secret|token)/i.test(name),
  );
}

export async function readBoundedText(
  response: Response,
  maximumBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  if (!response.body) return { text: "", truncated: false };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) return { text: text + decoder.decode(), truncated: false };
    const remaining = maximumBytes - bytes;
    if (value.byteLength > remaining) {
      if (remaining > 0) text += decoder.decode(value.subarray(0, remaining), { stream: true });
      await reader.cancel().catch(() => undefined);
      // Do not flush an incomplete sequence at the byte boundary: TextDecoder
      // would turn it into U+FFFD instead of returning the valid UTF-8 prefix.
      return { text, truncated: true };
    }
    bytes += value.byteLength;
    text += decoder.decode(value, { stream: true });
  }
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
