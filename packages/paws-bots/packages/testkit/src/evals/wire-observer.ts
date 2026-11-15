import { createHash } from "node:crypto";

/** Synthetic eval transport evidence, after SDK serialization. No prompt or request identifiers. */
export type DiagnosticWireObservation = {
  request: number;
  availability: "observed" | "unavailable";
  reason?: "unsupported-body" | "oversized-body" | "unsupported-protocol" | "invalid-json";
  results?: Array<{
    position: number;
    bytes: number;
    /** SHA-256 of the result as sent, so a rewrite shows without retaining text. */
    contentDigest: string;
    jsonValid: boolean;
    cursor?: string;
    segment?: number;
    nextCursorPresent: boolean;
    nextCursor?: string | null;
    contextTruncated: boolean;
    controlsValidated: boolean;
  }>;
};
const cursors = new Set([
  "start",
  ...Array.from({ length: 11 }, (_, i) => `segment-${Math.imul(i + 74, 48271) >>> 0}`),
]);
const cursor = (value: unknown): value is string => typeof value === "string" && cursors.has(value);
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The upstream receives the exact input/init; only whitelisted synthetic controls survive parsing. */
export function diagnosticWireFetch(
  upstream: typeof fetch,
  modelId: string,
  observations: DiagnosticWireObservation[],
): typeof fetch {
  return (input, init) => {
    if (observations.length < 60) {
      let observation: DiagnosticWireObservation | undefined;
      try {
        if (typeof init?.body !== "string") {
          observation = {
            request: observations.length + 1,
            availability: "unavailable",
            reason: "unsupported-body",
          };
        } else if (Buffer.byteLength(init.body) > 2 * 1024 * 1024) {
          observation = {
            request: observations.length + 1,
            availability: "unavailable",
            reason: "oversized-body",
          };
        } else {
          const body: unknown = JSON.parse(init.body);
          if (object(body) && body.model === modelId) {
            observation = {
              request: observations.length + 1,
              availability: "unavailable",
              reason: "unsupported-protocol",
            };
            if (Array.isArray(body.messages)) {
              const calls = new Map<string, string | undefined>();
              for (const message of body.messages) {
                if (!object(message) || !Array.isArray(message.tool_calls)) continue;
                for (const call of message.tool_calls) {
                  if (
                    !object(call) ||
                    typeof call.id !== "string" ||
                    !object(call.function) ||
                    call.function.name !== "CRM_READ_DIAGNOSTIC"
                  )
                    continue;
                  let args: unknown;
                  try {
                    args = JSON.parse(String(call.function.arguments));
                  } catch {
                    /* Unavailable controls remain unknown. */
                  }
                  calls.set(call.id, object(args) && cursor(args.cursor) ? args.cursor : undefined);
                }
              }
              const results: NonNullable<DiagnosticWireObservation["results"]> = [];
              for (const message of body.messages) {
                if (results.length >= 30) break;
                if (
                  !object(message) ||
                  message.role !== "tool" ||
                  typeof message.tool_call_id !== "string" ||
                  !calls.has(message.tool_call_id) ||
                  typeof message.content !== "string"
                )
                  continue;
                let result: unknown;
                try {
                  result = JSON.parse(message.content);
                } catch {
                  /* JSON validity is evidence; text is never retained. */
                }
                const parsed = object(result) ? result : undefined;
                const valid = parsed !== undefined;
                const nextCursorPresent = valid && Object.hasOwn(parsed, "nextCursor");
                const next =
                  valid && (parsed.nextCursor === null || cursor(parsed.nextCursor))
                    ? parsed.nextCursor
                    : undefined;
                const segment =
                  valid &&
                  Number.isInteger(parsed.segment) &&
                  Number(parsed.segment) >= 1 &&
                  Number(parsed.segment) <= 12
                    ? Number(parsed.segment)
                    : undefined;
                results.push({
                  position: results.length + 1,
                  bytes: Buffer.byteLength(message.content),
                  contentDigest: createHash("sha256").update(message.content).digest("hex"),
                  jsonValid: valid,
                  ...(calls.get(message.tool_call_id)
                    ? { cursor: calls.get(message.tool_call_id) }
                    : {}),
                  ...(segment !== undefined ? { segment } : {}),
                  nextCursorPresent,
                  ...(next !== undefined ? { nextCursor: next } : {}),
                  contextTruncated: valid && parsed.contextTruncated === true,
                  controlsValidated:
                    valid &&
                    segment !== undefined &&
                    nextCursorPresent &&
                    next !== undefined &&
                    calls.get(message.tool_call_id) !== undefined,
                });
              }
              observation = { request: observations.length + 1, availability: "observed", results };
            }
          }
        }
      } catch {
        observation = {
          request: observations.length + 1,
          availability: "unavailable",
          reason: "invalid-json",
        };
      }
      if (observation) observations.push(observation);
    }
    return upstream(input, init);
  };
}
