import type { AdapterContext, AgentRunRequest, AgentRuntime } from "@rakazo/adapter-kit";
import { redact } from "./report.js";

export type DiagnosticToolObservation = {
  cursor?: string;
  resultKind?: string;
  resultKeys?: string[];
  resultBytes?: number;
  jsonValid?: boolean;
  segment?: number;
  nextCursor?: string | null;
  failed: boolean;
};
const syntheticCursor = (value: unknown): value is string =>
  typeof value === "string" && /^(?:start|segment-\d{1,12})$/.test(value);

export type HistoryDiagnostic = {
  tool: "search_history" | "read_history";
  query?: string;
  before?: string;
  after?: string;
  limit?: number;
  beforeSeq?: number;
  nextBeforeSeq?: number | null;
  textOffset?: number;
  resultCount: number | null;
  failed: boolean;
};
/** Eval-only observation of synthetic history. Never retain arguments, IDs or result text. */
export function observeSyntheticHistory(
  runtime: AgentRuntime,
  diagnostics: HistoryDiagnostic[],
  secrets: readonly string[] = [],
  toolLoopDiagnostics?: DiagnosticToolObservation[],
): AgentRuntime {
  return {
    describe: () => runtime.describe(),
    abort: (id) => runtime.abort(id),
    run(request: AgentRunRequest, context: AdapterContext) {
      const execute = request.executeTool;
      if (!execute) return runtime.run(request, context);
      return runtime.run(
        {
          ...request,
          executeTool: async (name, args, id, route) => {
            if (
              name === "CRM_READ_DIAGNOSTIC" &&
              toolLoopDiagnostics &&
              toolLoopDiagnostics.length < 60
            ) {
              const entry: DiagnosticToolObservation = { failed: false };
              if (syntheticCursor(args.cursor)) entry.cursor = args.cursor;
              toolLoopDiagnostics.push(entry);
              try {
                const result = await execute(name, args, id, route);
                entry.resultKind =
                  result === null ? "null" : Array.isArray(result) ? "array" : typeof result;
                let parsed: unknown = result;
                if (typeof result === "string") {
                  entry.resultBytes = Buffer.byteLength(result, "utf8");
                  try {
                    parsed = JSON.parse(result);
                    entry.jsonValid = true;
                  } catch {
                    entry.jsonValid = false;
                  }
                } else {
                  try {
                    const encoded = JSON.stringify(result);
                    entry.resultBytes = encoded ? Buffer.byteLength(encoded, "utf8") : 0;
                    entry.jsonValid = encoded !== undefined;
                  } catch {
                    entry.jsonValid = false;
                  }
                }
                if (parsed && typeof parsed === "object") {
                  const object = parsed as Record<string, unknown>;
                  entry.resultKeys = ["segment", "nextCursor", "diagnostic", "error"].filter(
                    (key) => key in object,
                  );
                  if (
                    Number.isSafeInteger(object.segment) &&
                    Number(object.segment) >= 1 &&
                    Number(object.segment) <= 12
                  )
                    entry.segment = Number(object.segment);
                  if (object.nextCursor === null || syntheticCursor(object.nextCursor))
                    entry.nextCursor = object.nextCursor;
                }
                return result;
              } catch (error) {
                entry.failed = true;
                throw error;
              }
            }
            if (name !== "search_history" && name !== "read_history")
              return execute(name, args, id, route);
            const entry: HistoryDiagnostic = { tool: name, resultCount: null, failed: false };
            if (name === "search_history" && typeof args.query === "string")
              entry.query = redact(args.query, secrets)
                .replace(/\bc[a-z0-9]{20,}\b/gi, "[reference]")
                .slice(0, 500);
            for (const key of ["before", "after"] as const)
              if (typeof args[key] === "string" && /^\d{4}-\d{2}-\d{2}T/.test(args[key]))
                entry[key] = args[key].slice(0, 30);
            for (const key of ["limit", "textOffset", "beforeSeq"] as const)
              if (
                typeof args[key] === "number" &&
                Number.isSafeInteger(args[key]) &&
                args[key] >= 0
              )
                entry[key] = args[key];
            diagnostics.push(entry);
            try {
              const result = await execute(name, args, id, route);
              if (
                result &&
                typeof result === "object" &&
                "messages" in result &&
                Array.isArray(result.messages)
              )
                entry.resultCount = result.messages.length;
              if (result && typeof result === "object" && "nextBeforeSeq" in result) {
                const cursor = result.nextBeforeSeq;
                if (
                  cursor === null ||
                  (typeof cursor === "number" && Number.isSafeInteger(cursor) && cursor >= 0)
                )
                  entry.nextBeforeSeq = cursor;
              }
              return result;
            } catch (error) {
              entry.failed = true;
              throw error;
            }
          },
        },
        context,
      );
    },
  };
}
