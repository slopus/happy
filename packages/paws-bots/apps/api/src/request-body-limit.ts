import { ATTACHMENT_MAX_BYTES, attachmentSizeLabel } from "@rakazo/contracts";
import type { Context, Hono, MiddlewareHandler } from "hono";
import { cancelBody } from "./http-body.js";

export const MAX_AUTH_REQUEST_BYTES = 64 * 1024;
export const MAX_RPC_REQUEST_BYTES = 16 * 1024 * 1024;

/** Bound JSON entry points before their framework parsers buffer the request. */
export function requestBodyLimit(maxSize: number, tooLargeMessage?: string): MiddlewareHandler {
  if (!Number.isSafeInteger(maxSize) || maxSize <= 0) {
    throw new Error("Request body limit must be a positive integer");
  }
  return async (c, next) => (await limitRequestBody(c, maxSize, tooLargeMessage)) ?? next();
}

/** The 413 response for a body over maxSize; otherwise the body stays readable downstream. */
async function limitRequestBody(
  c: Context,
  maxSize: number,
  tooLargeMessage = "Request body is too large.",
): Promise<Response | undefined> {
  const request = c.req.raw;
  if (!request.body) return undefined;

  const contentLength = request.headers.get("content-length");
  if (contentLength !== null && !request.headers.has("transfer-encoding")) {
    const declared = /^[0-9]+$/.test(contentLength) ? Number(contentLength) : Number.NaN;
    if (!Number.isSafeInteger(declared) || declared < 0 || declared > maxSize) {
      cancelBody(request.body);
      return c.json({ error: tooLargeMessage }, 413);
    }
    return undefined;
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxSize) {
        cancelBody(reader);
        return c.json({ error: tooLargeMessage }, 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  c.req.raw = new Request(request, {
    body: new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    }),
    duplex: "half",
  } as RequestInit & { duplex: "half" });
  return undefined;
}

/** Allow base64 expansion plus room for the RPC JSON envelope. */
export function rpcRequestMaxBytes(maxUploadSizeBytes = ATTACHMENT_MAX_BYTES): number {
  return Math.max(MAX_RPC_REQUEST_BYTES, Math.ceil(maxUploadSizeBytes / 3) * 4 + 1024 * 1024);
}

/** Install limits only on framework-parsed JSON surfaces with known payload contracts. */
export function mountApiRequestBodyLimits(app: Hono): void {
  app.use("/api/auth/*", requestBodyLimit(MAX_AUTH_REQUEST_BYTES));
}

/**
 * Signed out, only the bodiless `health` procedure is callable, so the body
 * is discarded unread and oRPC answers as it would anyway: 401, or health.
 */
export function rpcBodyLimit(maxUploadSizeBytes = ATTACHMENT_MAX_BYTES) {
  const signedInLimit = rpcRequestMaxBytes(maxUploadSizeBytes);
  const message = `Request body is too large. Upload limit: ${attachmentSizeLabel(maxUploadSizeBytes)} per file.`;
  return async (c: Context, signedIn: boolean) => {
    if (signedIn) return limitRequestBody(c, signedInLimit, message);
    const request = c.req.raw;
    if (request.body) {
      cancelBody(request.body);
      const headers = new Headers(request.headers);
      headers.delete("content-length");
      headers.delete("transfer-encoding");
      c.req.raw = new Request(request.url, {
        method: request.method,
        headers,
        signal: request.signal,
      });
    }
    return undefined;
  };
}
