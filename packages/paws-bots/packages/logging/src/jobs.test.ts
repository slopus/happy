import { afterEach, describe, expect, it } from "vitest";
import { runWithLogContext } from "./context.js";
import {
  createJobCorrelation,
  runCorrelatedJob,
  unwrapJobPayload,
  wrapJobPayload,
} from "./jobs.js";
import { createLogger, installLogger } from "./logger.js";
import { createTestSink } from "./test-sink.js";

afterEach(() => {
  installLogger(createLogger({ service: "rakazo", level: "off", sinks: [] }));
});

describe("job correlation envelope", () => {
  it("wraps payloads and still accepts legacy records", () => {
    const wrapped = wrapJobPayload(
      { runId: "run-1" },
      { jobId: "job-1", traceId: "a".repeat(32), parentSpanId: "b".repeat(16) },
    );
    expect(wrapped).toMatchObject({ runId: "run-1" });
    expect(unwrapJobPayload(wrapped)).toEqual({
      payload: { runId: "run-1" },
      correlation: { jobId: "job-1", traceId: "a".repeat(32), parentSpanId: "b".repeat(16) },
    });
    expect(unwrapJobPayload({ runId: "legacy" })).toEqual({ payload: { runId: "legacy" } });
    expect(
      unwrapJobPayload({
        v: 1,
        correlation: { jobId: "job-old", traceId: "c".repeat(32) },
        payload: { runId: "nested" },
      }),
    ).toEqual({
      payload: { runId: "nested" },
      correlation: { jobId: "job-old", traceId: "c".repeat(32) },
    });
  });

  it("uses a nested envelope for reserved keys and non-plain objects", () => {
    const correlation = { jobId: "job-2", traceId: "d".repeat(32) };
    const reserved = wrapJobPayload({ runId: "run-2", __rakazoLog: "keep" }, correlation);
    expect(reserved).toEqual({
      v: 1,
      correlation,
      payload: { runId: "run-2", __rakazoLog: "keep" },
    });
    expect(unwrapJobPayload(reserved)).toEqual({
      payload: { runId: "run-2", __rakazoLog: "keep" },
      correlation,
    });

    const when = new Date("2026-01-02T03:04:05.000Z");
    const nestedDate = wrapJobPayload(when, correlation);
    expect(nestedDate).toEqual({ v: 1, correlation, payload: when });
    expect(unwrapJobPayload(nestedDate)).toEqual({ payload: when, correlation });
  });

  it("inherits the active trace and creates a job id", () => {
    const correlation = runWithLogContext(
      { "trace.id": "c".repeat(32), "span.id": "d".repeat(16) },
      () => createJobCorrelation(),
    );
    expect(correlation.traceId).toBe("c".repeat(32));
    expect(correlation.parentSpanId).toBe("d".repeat(16));
    expect(correlation.jobId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it("starts a new trace root when no request context exists", () => {
    const correlation = createJobCorrelation();
    expect(correlation.traceId).toHaveLength(32);
    expect(correlation.parentSpanId).toBeUndefined();
  });

  it("restores context, logs completion, and rethrows failures", async () => {
    const sink = createTestSink();
    installLogger(createLogger({ service: "rakazo-worker", sinks: [sink] }));
    await runCorrelatedJob({
      name: "run.continue",
      payload: { runId: "run-9" },
      correlation: { jobId: "job-9", traceId: "e".repeat(32), parentSpanId: "f".repeat(16) },
      run: async () => undefined,
    });
    expect(sink.events[0]).toMatchObject({
      message: "job.completed",
      "job.outcome": "ok",
      "job.type": "run.continue",
      "job.id": "job-9",
      "run.id": "run-9",
      "trace.id": "e".repeat(32),
      "parent.span.id": "f".repeat(16),
    });

    await expect(
      runCorrelatedJob({
        name: "run.continue",
        payload: { runId: "run-fail" },
        run: async () => {
          throw new Error("handler failed");
        },
      }),
    ).rejects.toThrow("handler failed");
    const failed = sink.events.at(-1);
    expect(failed).toMatchObject({
      message: "job.completed",
      "job.outcome": "error",
      level: "error",
    });
  });
  it("keeps failed queue outcomes without reporting an already reported cause twice", async () => {
    const sink = createTestSink();
    const logger = createLogger({ service: "rakazo-worker", sinks: [sink] });
    installLogger(logger);
    const error = new Error("setup failed");
    await expect(
      runCorrelatedJob({
        name: "run.continue",
        payload: {},
        run: async () => {
          logger.error("run setup failed", error);
          throw new Error("retrying", { cause: error });
        },
      }),
    ).rejects.toThrow("retrying");
    expect(sink.events.at(-1)).toMatchObject({ "job.outcome": "error", "error.report": false });
    await expect(
      runCorrelatedJob({
        name: "run.continue",
        payload: {},
        run: async () => {
          logger.error("an earlier independent error", error);
          throw new Error("different failure");
        },
      }),
    ).rejects.toThrow("different failure");
    expect(sink.events.at(-1)).toMatchObject({ "error.report": true });
  });
});
