import { cancelResponseBody } from "@rakazo/core";

/** Well above any legitimate tools/list page or tool result, which is projected to 1 MB anyway. */
export const MAX_MCP_RESPONSE_BYTES = 16 * 1024 * 1024;

const CR = 0x0d;
const LF = 0x0a;

export class McpResponseTooLargeError extends Error {
  constructor(maxBytes: number) {
    super(`MCP server response exceeds ${Math.round(maxBytes / 1024 / 1024)} MB`);
    this.name = "McpResponseTooLargeError";
  }
}

/**
 * Fails the body once it grows past `maxBytes`, before the MCP SDK buffers and parses it.
 * Event streams stay open for a whole session, so they are limited per event instead, but only
 * when the request asked for one and it succeeded: other callers (OAuth discovery) and failed
 * responses are buffered whole.
 */
export function limitMcpResponseBody(
  response: Response,
  requestHeaders: HeadersInit | undefined,
  maxBytes = MAX_MCP_RESPONSE_BYTES,
): Response {
  if (!response.body) return response;
  // A failed response is read whole by the SDK, so only a successful stream is limited per event.
  const eventStream =
    response.ok &&
    /text\/event-stream/i.test(new Headers(requestHeaders).get("accept") ?? "") &&
    /^\s*text\/event-stream/i.test(response.headers.get("content-type") ?? "");
  if (!eventStream && Number(response.headers.get("content-length")) > maxBytes) {
    cancelResponseBody(response);
    throw new McpResponseTooLargeError(maxBytes);
  }
  let size = 0;
  let previous = 0;
  let lineStart = false;
  const exceeds = (chunk: Uint8Array): boolean => {
    if (!eventStream) {
      size += chunk.byteLength;
      return size > maxBytes;
    }
    // An empty line (CR, LF, or CRLF right after another line break) ends an event.
    for (const byte of chunk) {
      if (byte === LF && previous === CR) {
        previous = byte;
        if (++size > maxBytes) return true;
        continue;
      }
      if (byte === CR || byte === LF) {
        if (lineStart) size = 0;
        lineStart = true;
      } else {
        lineStart = false;
      }
      previous = byte;
      if (++size > maxBytes) return true;
    }
    return false;
  };
  const reader = response.body.getReader();
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        const next = await reader.read();
        if (next.done) {
          controller.close();
          return;
        }
        if (exceeds(next.value)) {
          void reader.cancel().catch(() => undefined);
          controller.error(new McpResponseTooLargeError(maxBytes));
          return;
        }
        controller.enqueue(next.value);
      },
      cancel(reason) {
        return reader.cancel(reason);
      },
    },
    { highWaterMark: 0 },
  );
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
