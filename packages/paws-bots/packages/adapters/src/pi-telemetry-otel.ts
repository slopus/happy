import type {
  SpanAttributes,
  SpanLink,
  TelemetryContext,
  TelemetrySpan,
} from "@earendil-works/pi-telemetry";
import type { Attributes, Context, Link, Span, SpanContext, Tracer } from "@opentelemetry/api";
import { getLogContext } from "@rakazo/logging";

// The OTel packages load on demand: this module is only reached through a dynamic import, and
// bundling inlines it, so static imports here would still load with every server bundle.
const { ROOT_CONTEXT, SpanStatusCode, trace } = await import("@opentelemetry/api");

// Allowlist metadata: unknown attributes (including future Pi payload fields) stay private.
const safeAttributes = new Set([
  "rakazo.bot.id",
  "rakazo.run.id",
  "rakazo.routine.id",
  "pi.ai.operation",
  "pi.ai.provider",
  "pi.ai.model",
  "pi.ai.api",
  "pi.ai.streaming",
  "pi.ai.response.stop_reason",
  "pi.ai.usage.input_tokens",
  "pi.ai.usage.output_tokens",
  "pi.ai.usage.cache_read_tokens",
  "pi.ai.usage.cache_write_tokens",
  "pi.ai.usage.reasoning_tokens",
  "pi.ai.usage.total_tokens",
  "pi.ai.usage.cost",
  "pi.agent.tool.name",
  "pi.agent.tool.success",
]);
const contentAttributes = new Set([
  "pi.ai.prompt",
  "pi.ai.response",
  "pi.agent.tool.arguments",
  "pi.agent.tool.result",
]);

function attributes(values: SpanAttributes = {}, captureContent: boolean): Attributes {
  return Object.fromEntries(
    Object.entries(values)
      .filter(
        ([key, value]) =>
          value !== undefined &&
          (safeAttributes.has(key) || (captureContent && contentAttributes.has(key))),
      )
      .map(([key, value]) => [key, Array.isArray(value) ? [...value] : value]),
  ) as Attributes;
}

/** The OTel span behind each Pi context this bridge hands out, so a Pi span link can name it. */
const spanContexts = new WeakMap<TelemetryContext, SpanContext>();

/** A link to a context from another telemetry adapter has no OTel span to point at; drop it. */
function links(values: readonly SpanLink[] = [], captureContent: boolean): Link[] {
  return values.flatMap((link) => {
    const context = spanContexts.get(link.context);
    return context ? [{ context, attributes: attributes(link.attributes, captureContent) }] : [];
  });
}

/** Explicit parent contexts preserve concurrent run/tool hierarchy without global registration. */
export function otelPiContext(
  tracer: Tracer,
  captureContent: boolean,
  ids: SpanAttributes = {},
  parent?: Context,
): TelemetryContext {
  return {
    async startSpan(options, callback) {
      const correlation = {
        ...ids,
        ...Object.fromEntries(
          Object.entries(options.attributes ?? {}).filter(([key]) => key.startsWith("rakazo.")),
        ),
      };
      const parentContext = parent ?? correlatedLogContext();
      const span: Span = tracer.startSpan(
        options.name,
        {
          attributes: attributes({ ...options.attributes, ...correlation }, captureContent),
          links: links(options.links, captureContent),
        },
        parentContext,
      );
      const child = otelPiContext(
        tracer,
        captureContent,
        correlation,
        trace.setSpan(parentContext, span),
      );
      const bridge: TelemetrySpan = {
        ...child,
        addLink: (link) => {
          for (const value of links([link], captureContent)) span.addLink(value);
        },
        addEvent: (name, values) => {
          span.addEvent(name, attributes(values, captureContent));
        },
        setAttributes: (values) => {
          span.setAttributes(attributes(values, captureContent));
        },
        setStatus: (status) => {
          span.setStatus({
            code: status.status === "error" ? SpanStatusCode.ERROR : SpanStatusCode.OK,
          });
        },
      };
      spanContexts.set(bridge, span.spanContext());
      try {
        return await callback(bridge);
      } catch (error) {
        // Exception messages/stacks may contain prompts, credentials or tool arguments.
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    },
  };
}

export async function createPiTelemetryExporter() {
  const [
    { BatchSpanProcessor, TracerProvider },
    { OTLPTraceExporter },
    { resourceFromAttributes },
  ] = await Promise.all([
    import("@opentelemetry/sdk-trace"),
    import("@opentelemetry/exporter-trace-otlp-http"),
    import("@opentelemetry/resources"),
  ]);
  const provider = new TracerProvider({
    resource: resourceFromAttributes({
      "service.name": process.env.OTEL_SERVICE_NAME?.trim() || "rakazo-worker",
    }),
    // The exporter honors standard OTLP endpoint and header env vars, including /v1/traces.
    spanProcessors: [
      new BatchSpanProcessor({ exporter: new OTLPTraceExporter(), exportTimeoutMillis: 2_000 }),
    ],
  });
  return {
    context: otelPiContext(
      provider.getTracer("rakazo.pi", "0.87.1"),
      process.env.OTEL_CAPTURE_CONTENT === "true",
    ),
    shutdown: () => provider.shutdown(),
  };
}

function correlatedLogContext(): Context {
  const log = getLogContext();
  const traceId = log["trace.id"];
  const spanId = log["span.id"];
  if (
    typeof traceId !== "string" ||
    !/^[a-f0-9]{32}$/.test(traceId) ||
    /^0+$/.test(traceId) ||
    typeof spanId !== "string" ||
    !/^[a-f0-9]{16}$/.test(spanId) ||
    /^0+$/.test(spanId)
  )
    return ROOT_CONTEXT;
  return trace.setSpanContext(ROOT_CONTEXT, { traceId, spanId, traceFlags: 1, isRemote: true });
}
