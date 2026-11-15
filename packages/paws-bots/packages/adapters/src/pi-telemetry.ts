import { AsyncLocalStorage } from "node:async_hooks";
import type { SpanAttributes, TelemetryContext, TelemetrySpan } from "@earendil-works/pi-telemetry";
import type { AgentRunRequest } from "@rakazo/adapter-kit";

const current = new AsyncLocalStorage<TelemetryContext>();
let exporter: Promise<{ context: TelemetryContext; shutdown(): Promise<void> }> | undefined;

/** Disabled deployments never load or initialize the OTel SDK. */
export async function withPiTelemetry<T>(
  request: Pick<AgentRunRequest, "botId" | "runId" | "routineId">,
  work: (span?: TelemetrySpan) => Promise<T>,
): Promise<T> {
  if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim()) return work();
  exporter ??= import("./pi-telemetry-otel.js").then(({ createPiTelemetryExporter }) =>
    createPiTelemetryExporter(),
  );
  let telemetry: TelemetryContext;
  try {
    telemetry = (await exporter).context;
  } catch {
    // Invalid optional observability configuration must not fail a run or log headers.
    return work();
  }
  return telemetry.startSpan(
    {
      name: "rakazo.agent.run",
      attributes: {
        "rakazo.bot.id": request.botId,
        "rakazo.run.id": request.runId,
        "rakazo.routine.id": request.routineId ?? undefined,
      },
    },
    (span) => current.run(span, () => work(span)),
  );
}

export function withPiTelemetrySpan<T>(
  name: string,
  attributes: SpanAttributes,
  work: (span?: TelemetrySpan) => Promise<T>,
): Promise<T> {
  const parent = current.getStore();
  if (!parent) return work();
  return parent.startSpan({ name, attributes }, (span) => current.run(span, () => work(span)));
}

export async function shutdownPiTelemetry(): Promise<void> {
  if (!exporter) return;
  try {
    await (await exporter).shutdown();
  } catch {
    /* Export failures are best effort. */
  }
  exporter = undefined;
}

/** Content serialization is optional and must never interrupt model/tool execution. */
export function recordPiTelemetryContent(
  span: TelemetrySpan | undefined,
  key: string,
  value: unknown,
): void {
  if (!span || process.env.OTEL_CAPTURE_CONTENT !== "true") return;
  try {
    span.setAttributes({ [key]: JSON.stringify(value) });
  } catch {
    /* Non-serializable content is omitted. */
  }
}
