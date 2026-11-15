import { withAbort } from "./async.js";
import { cancelResponseBody } from "./http-response.js";

/** Read a response within a byte budget, releasing failed streams without waiting for cancellation.
 * Callers own header validation and wrap lazy read operations in their request deadline.
 */
export async function readBoundedResponseBytes(
  response: Response,
  options: {
    maxBytes: number;
    tooLargeMessage: string;
    read: <T>(operation: () => Promise<T>) => Promise<T>;
  },
): Promise<Uint8Array> {
  const { maxBytes, tooLargeMessage, read } = options;
  if (!response.body) {
    const buffer = await read(() => response.arrayBuffer());
    if (buffer.byteLength > maxBytes) throw new Error(tooLargeMessage);
    return new Uint8Array(buffer);
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await read(() => reader.read());
      if (done) break;
      if (!value?.byteLength) continue;
      total += value.byteLength;
      if (total > maxBytes) throw new Error(tooLargeMessage);
      chunks.push(value);
    }
  } catch (error) {
    try {
      void Promise.resolve(reader.cancel()).catch(() => undefined);
    } catch {
      // Best-effort release, including injected streams that throw synchronously.
    }
    throw error;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Already cancelled or released.
    }
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * Read a response within a byte budget, refusing an oversized declared length before reading and
 * rejecting as soon as `signal` aborts.
 */
export async function readResponseWithin(
  response: Response,
  options: { maxBytes: number; tooLargeMessage: string; signal: AbortSignal },
): Promise<Uint8Array> {
  const { maxBytes, tooLargeMessage, signal } = options;
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > maxBytes) {
    cancelResponseBody(response);
    throw new Error(tooLargeMessage);
  }
  return readBoundedResponseBytes(response, {
    maxBytes,
    tooLargeMessage,
    read: (operation) => withAbort(operation(), signal),
  });
}

/** A JSON object body read with `readResponseWithin`; any other body reads as `{}`. */
export async function readJsonObjectWithin<T extends object>(
  response: Response,
  options: { maxBytes: number; tooLargeMessage: string; signal: AbortSignal },
): Promise<Partial<T>> {
  const bytes = await readResponseWithin(response, options);
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Partial<T>) : {};
  } catch {
    return {};
  }
}
