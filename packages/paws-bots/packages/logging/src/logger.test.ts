import { describe, expect, it, vi } from "vitest";
import { createConsoleSink } from "./console-sink.js";
import { createLogger } from "./logger.js";
import { sanitizedError } from "./monitoring.js";
import { serializeError } from "./serialize-error.js";
import { createTestSink } from "./test-sink.js";

describe("logger", () => {
  it("filters levels including off", () => {
    const sink = createTestSink();
    const logger = createLogger({ service: "rakazo-api", level: "warn", sinks: [sink] });
    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");
    expect(sink.events.map((event) => event.message)).toEqual(["w", "e"]);

    const silent = createLogger({ service: "rakazo-api", level: "off", sinks: [sink] });
    silent.error("never");
    expect(sink.events.map((event) => event.message)).toEqual(["w", "e"]);
  });

  it("merges child bindings under call-site bindings", () => {
    const sink = createTestSink();
    const logger = createLogger({
      service: "rakazo-api",
      sinks: [sink],
      bindings: { "service.role": "api" },
    });
    logger.child({ "job.type": "run.continue" }).info("hello", { "job.type": "override" });
    expect(sink.events[0]).toMatchObject({
      message: "hello",
      "service.name": "rakazo-api",
      "service.role": "api",
      "job.type": "override",
    });
  });

  it("serializes a warning's error binding like an error log's error", () => {
    const sink = createTestSink();
    const logger = createLogger({ service: "rakazo-api", sinks: [sink] });
    const cause = new Error("could not prepare the workspace");
    logger.warn("computer.provision_failed", {
      provider: "fake",
      error: new AggregateError([cause, new Error("rollback failed")], "provisioning failed"),
    });
    expect(sink.events[0]).toMatchObject({
      provider: "fake",
      error: {
        name: "AggregateError",
        message: "provisioning failed",
        cause: { name: "Error", message: "could not prepare the workspace" },
      },
    });
  });

  it("serializes an error bound on a child logger", () => {
    const sink = createTestSink();
    const logger = createLogger({ service: "rakazo-api", sinks: [sink] });
    logger.child({ error: new TypeError("bound failure") }).warn("child");
    expect(sink.events[0]?.error).toMatchObject({ name: "TypeError", message: "bound failure" });
  });

  it("keeps the configured service name when bindings try to overwrite it", () => {
    const sink = createTestSink();
    const logger = createLogger({ service: "rakazo-api", sinks: [sink] });
    logger.info("svc", { "service.name": "spoofed" });
    expect(sink.events[0]?.["service.name"]).toBe("rakazo-api");
  });

  it("prefers explicit bindings over async context", () => {
    const sink = createTestSink();
    const logger = createLogger({ service: "rakazo-api", sinks: [sink] });
    logger.withContext({ "request.id": "als" }, () => {
      logger.info("ctx", { "request.id": "call" });
    });
    expect(sink.events[0]?.["request.id"]).toBe("call");
  });

  it("isolates concurrent async contexts", async () => {
    const sink = createTestSink();
    const logger = createLogger({ service: "rakazo-api", sinks: [sink] });
    let releaseFirst!: () => void;
    const firstHold = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = logger.withContext({ "request.id": "a" }, async () => {
      await firstHold;
      logger.info("first");
    });
    const second = logger.withContext({ "request.id": "b" }, async () => {
      logger.info("second");
      releaseFirst();
    });
    await Promise.all([first, second]);
    expect(sink.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: "first", "request.id": "a" }),
        expect.objectContaining({ message: "second", "request.id": "b" }),
      ]),
    );
  });

  it("keeps logging when a sink throws", () => {
    const sink = createTestSink();
    const logger = createLogger({
      service: "rakazo-api",
      sinks: [
        {
          write() {
            throw new Error("sink down");
          },
        },
        sink,
      ],
    });
    expect(() => logger.info("still works")).not.toThrow();
    expect(sink.events).toHaveLength(1);
  });

  it("flushes sinks and respects a timeout", async () => {
    let flushed = false;
    const logger = createLogger({
      service: "rakazo-api",
      sinks: [
        {
          write() {},
          async flush() {
            flushed = true;
          },
        },
      ],
    });
    await logger.flush({ timeoutMs: 50 });
    expect(flushed).toBe(true);

    const hanging = createLogger({
      service: "rakazo-api",
      sinks: [
        {
          write() {},
          flush() {
            return new Promise(() => undefined);
          },
        },
      ],
    });
    await expect(hanging.flush({ timeoutMs: 20 })).resolves.toBeUndefined();
  });
});

describe("error serialization", () => {
  it("records cause chains", () => {
    const error = new Error("outer", { cause: new Error("inner", { cause: new Error("root") }) });
    expect(serializeError(error)).toMatchObject({
      message: "outer",
      cause: { message: "inner", cause: { message: "root" } },
    });
  });

  it("redacts secrets in error messages and stacks", () => {
    const error = new Error("unauthorized Bearer supersecret for person@example.com");
    const serialized = serializeError(error);
    expect(JSON.stringify(serialized)).not.toContain("supersecret");
    expect(JSON.stringify(serialized)).not.toContain("person@example.com");
    expect(serialized.message).toContain("[Redacted]");
  });

  it("redacts user profile paths in error messages and stacks", () => {
    const error = new Error("cannot open /home/example-user/app.db");
    error.stack = `Error: cannot open /home/example-user/app.db\n    at run (/Users/example-user/app/index.js:1:1)\n    at load (C:\\Users\\example-user\\app\\index.js:2:1)`;
    const serialized = serializeError(error);
    expect(serialized.message).toBe("cannot open /[user]/app.db");
    expect(serialized.stack).toBe(
      "Error: cannot open /[user]/app.db\n    at run (/[user]/app/index.js:1:1)\n    at load ([user]\\app\\index.js:2:1)",
    );
    expect(JSON.stringify(serialized)).not.toContain("example-user");
  });

  it("redacts secrets interpolated into the log message", () => {
    const sink = createTestSink();
    const logger = createLogger({ service: "rakazo-api", sinks: [sink] });
    logger.error("render_plot failed: Bearer supersecret for person@example.com");
    expect(JSON.stringify(sink.events[0])).not.toContain("supersecret");
    expect(JSON.stringify(sink.events[0])).not.toContain("person@example.com");
  });
});

describe("pretty console errors", () => {
  it("keeps a database error's code and meta after a long message", () => {
    const error = Object.assign(
      new Error(
        `\nInvalid \`tx.steeringMessage.updateMany()\` invocation in\n/app/events.ts:1719:32\n\n${"  context line\n".repeat(20)}Transaction API error: A query cannot be executed on an expired transaction.`,
      ),
      {
        name: "PrismaClientKnownRequestError",
        code: "P2028",
        meta: { modelName: "SteeringMessage", timeout: 5000, timeTaken: 5998 },
      },
    );
    const lines: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((line: string) => {
      lines.push(line);
    });
    try {
      createLogger({
        service: "rakazo-api",
        sinks: [createConsoleSink({ format: "pretty" })],
      }).error("run.failed", sanitizedError(error));
    } finally {
      spy.mockRestore();
    }
    expect(lines[0]).toContain(
      "error=PrismaClientKnownRequestError: P2028 steeringMessage.updateMany:",
    );
    expect(lines[0]).toContain("expired transaction");
    expect(lines[0]).toContain(
      'meta={"modelName":"SteeringMessage","timeout":5000,"timeTaken":5998}',
    );
  });
});
