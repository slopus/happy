import * as Sentry from "@sentry/node";
import { afterEach, describe, expect, it } from "vitest";
import { createRootLogger } from "./axiom.js";
import { createLogger } from "./logger.js";
import { monitoringUserId } from "./pseudonym.js";
import { createSentrySink, createSentrySinkFromEnv, sentryConfigFromEnv } from "./sentry.js";

const DSN = "https://publickey@errors.example.com/7";

function recordingTransport() {
  const events: Array<Record<string, any>> = [];
  const transport = (options: Parameters<typeof Sentry.createTransport>[0]) =>
    Sentry.createTransport(options, async (request) => {
      const body =
        typeof request.body === "string" ? request.body : new TextDecoder().decode(request.body);
      const lines = body.split("\n");
      for (let index = 1; index < lines.length - 1; index += 2) {
        if (JSON.parse(lines[index]!).type === "event") events.push(JSON.parse(lines[index + 1]!));
      }
      return { statusCode: 200 };
    });
  return { events, transport };
}

afterEach(async () => {
  await Sentry.close();
});

describe("sentry sink", () => {
  it("reads config from the environment", async () => {
    expect(sentryConfigFromEnv({})).toEqual({});
    expect(sentryConfigFromEnv({ SENTRY_DSN: "  " })).toEqual({});
    expect(sentryConfigFromEnv({ SENTRY_DSN: "https://errors.example.com/7" }).warning).toContain(
      "not a valid DSN",
    );
    expect(sentryConfigFromEnv({ SENTRY_DSN: "not a dsn" }).warning).toBeDefined();
    expect(
      sentryConfigFromEnv({
        SENTRY_DSN: DSN,
        SENTRY_ENVIRONMENT: " prod-acme ",
        GIT_SHA: "abc123",
      }),
    ).toEqual({ config: { dsn: DSN, environment: "prod-acme", release: "abc123" } });
    expect(
      sentryConfigFromEnv({ SENTRY_DSN: DSN, SENTRY_RELEASE: "v1", GIT_SHA: "abc" }).config
        ?.release,
    ).toBe("v1");
    expect(sentryConfigFromEnv({ SENTRY_DSN: DSN, GIT_SHA: "unknown" }).config?.release).toBe(
      undefined,
    );
    expect(
      (await createSentrySinkFromEnv("rakazo-api", { SENTRY_DSN: "bad" })).sink,
    ).toBeUndefined();
  });

  it("passes the root logger service to the SDK scope", async () => {
    await createRootLogger("rakazo-worker", { SENTRY_DSN: DSN });
    expect(Sentry.getIsolationScope().getScopeData().tags.service).toBe("rakazo-worker");
  });

  it("tags exceptions captured outside log writes with the service", async () => {
    const { events, transport } = recordingTransport();
    const sink = await createSentrySink("rakazo-api", { dsn: DSN }, transport);
    Sentry.captureException(new Error("unexpected failure"));
    await sink.flush?.();

    expect(events).toHaveLength(1);
    expect(events[0]?.tags).toEqual({ service: "rakazo-api" });
  });

  it("redacts stack frame paths on exceptions the SDK captures directly", async () => {
    const { events, transport } = recordingTransport();
    const sink = await createSentrySink("rakazo-api", { dsn: DSN }, transport);
    const error = new Error("unexpected failure");
    error.stack = "Error: unexpected failure\n    at run (/home/ada@example.com/app/index.js:1:1)";
    Sentry.captureException(error);
    await sink.flush?.();

    expect(JSON.stringify(events[0]?.exception)).not.toContain("ada@example.com");
  });

  it("redacts user profile paths from reported errors", async () => {
    const { events, transport } = recordingTransport();
    const logger = createLogger({
      service: "rakazo-api",
      sinks: [await createSentrySink("rakazo-api", { dsn: DSN }, transport)],
    });
    const error = new Error("cannot read /home/example-user/state.json");
    error.stack =
      "Error: cannot read /home/example-user/state.json\n    at run (/Users/example-user/app/index.js:1:1)";
    logger.error("restore failed", error);
    await logger.flush();

    expect(JSON.stringify(events)).not.toContain("example-user");
  });

  it("reports error logs with the exception chain, tags, and no log context", async () => {
    const { events, transport } = recordingTransport();
    const sink = await createSentrySink(
      "rakazo-worker",
      { dsn: DSN, environment: "prod-acme", release: "abc" },
      transport,
    );
    const logger = createLogger({ service: "rakazo-worker", sinks: [sink] });
    const error = new Error("run failed", { cause: new TypeError("bad input") });
    logger.error("job crashed", error, {
      "job.id": "j1",
      "run.id": "r1",
      "model.provider": "openai-compatible",
      "model.id": "local-model",
      apiKey: "sk-secret",
      content: "private message",
      "user.id": "u1",
    });
    await logger.flush();

    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event).toMatchObject({
      environment: "prod-acme",
      release: "abc",
      level: "error",
      tags: {
        service: "rakazo-worker",
        "job.id": "j1",
        "run.id": "r1",
        "model.provider": "openai-compatible",
        "model.id": "local-model",
      },
      extra: { "log.message": "job crashed" },
    });
    expect(event.extra).toEqual({ "log.message": "job crashed" });
    expect(event.tags["user.id"]).toBeUndefined();
    expect(JSON.stringify(event)).not.toMatch(/apiKey|private message|sk-secret/);
    const values = event.exception.values;
    expect(values.map((value: { type: string }) => value.type)).toEqual(["TypeError", "Error"]);
    expect(values[1].stacktrace.frames.at(-1).filename).toContain("sentry.test.ts");
  });

  it("titles database errors by code and model operation", async () => {
    const { events, transport } = recordingTransport();
    const logger = createLogger({
      service: "rakazo-api",
      sinks: [await createSentrySink("rakazo-api", { dsn: DSN }, transport)],
    });
    const error = Object.assign(
      new Error(
        "\nInvalid `prisma.connection.findMany()` invocation:\n\n\nTransaction API error: expired transaction.",
      ),
      { name: "PrismaClientKnownRequestError", code: "P2028" },
    );
    logger.error("rpc connections/begin failed", error);
    logger.error(
      "socket closed",
      Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
    );
    await logger.flush();

    expect(events.map((event) => event.exception.values.at(-1).value)).toEqual([
      "P2028 connection.findMany: Transaction API error: expired transaction.",
      "read ECONNRESET",
    ]);
  });

  it("redacts what it copies out when handed an event directly", async () => {
    const { events, transport } = recordingTransport();
    const sink = await createSentrySink("rakazo-api", { dsn: DSN }, transport);
    sink.write({
      timestamp: new Date().toISOString(),
      level: "error",
      message: "login failed for ada@example.com",
      "service.name": "rakazo-api",
      "request.id": "Bearer abc.def",
      password: "hunter2",
      runId: "x".repeat(201),
      jobId: 123,
      error: {
        name: "Error",
        message: "token=sk-live-123456789",
        stack: "Error: token=sk-live-123456789",
      },
    });
    await sink.flush?.();

    const event = events[0]!;
    expect(event.extra["log.message"]).toBe("login failed for [Redacted]");
    expect(event.extra).toEqual({ "log.message": "login failed for [Redacted]" });
    expect(event.tags.runId).toBeUndefined();
    expect(event.tags.jobId).toBeUndefined();
    expect(event.tags["request.id"]).toBe("Bearer [Redacted]");
    expect(JSON.stringify(event)).not.toMatch(/hunter2|sk-live|ada@example/);
  });

  it("names the user only by a keyed hash of the logged account id", async () => {
    const { events, transport } = recordingTransport();
    const secret = "test-pseudonym-secret";
    const sink = await createSentrySink(
      "rakazo-api",
      { dsn: DSN, pseudonymSecret: secret },
      transport,
    );
    const logger = createLogger({ service: "rakazo-api", sinks: [sink] });
    await logger.withContext({ "user.id": "user-raw-1", "space.id": "space-1" }, async () => {
      logger.error("rpc failed for ada@example.com", new Error("boom"));
    });
    logger.error("no user here", new Error("boom"));
    await logger.flush();

    expect(events).toHaveLength(2);
    expect(events[0]!.user).toEqual({
      id: monitoringUserId(secret, "user-raw-1"),
      ip_address: null,
    });
    expect(events[1]!.user).toEqual({ ip_address: null });
    expect(JSON.stringify(events)).not.toMatch(/user-raw-1|ada@example\.com/);
  });

  it("sends no user without a pseudonym secret", async () => {
    const { events, transport } = recordingTransport();
    const sink = await createSentrySink("rakazo-api", { dsn: DSN }, transport);
    const logger = createLogger({ service: "rakazo-api", sinks: [sink] });
    logger.error("failed", new Error("boom"), { "user.id": "user-raw-2" });
    await logger.flush();
    expect(events[0]!.user).toEqual({ ip_address: null });
    expect(JSON.stringify(events)).not.toContain("user-raw-2");
    expect(
      sentryConfigFromEnv({ SENTRY_DSN: DSN, ANALYTICS_PSEUDONYM_SECRET: " s " }).config
        ?.pseudonymSecret,
    ).toBe("s");
  });

  it("scrubs SDK and scope metadata before sending", async () => {
    const { events, transport } = recordingTransport();
    const sink = await createSentrySink("rakazo-api", { dsn: DSN }, transport);
    Sentry.withScope((scope) => {
      scope.setUser({ id: "private-user", email: "private@example.com" });
      scope.setExtra("content", "private content");
      scope.setExtra("log.message", "token=sk-live-123456789");
      scope.addEventProcessor((event) => ({
        ...event,
        server_name: "private-host",
        request: { url: "https://example.com/?token=secret", headers: { cookie: "secret" } },
        breadcrumbs: [{ category: "console", message: "private output" }],
      }));
      Sentry.captureException(new Error("unexpected failure"));
    });
    await sink.flush?.();
    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.request).toBeUndefined();
    expect(event.user).toEqual({ ip_address: null });
    expect(event.breadcrumbs).toBeUndefined();
    expect(event.server_name).toBeUndefined();
    expect(event.extra).toEqual({ "log.message": "token=[Redacted]" });
    expect(JSON.stringify(event)).not.toMatch(/private-|private content|private output/);
    const options = Sentry.getClient()!.getOptions();
    expect(options.sampleRate).toBeUndefined();
    expect(options.tracesSampleRate).toBeUndefined();
    expect(options).not.toHaveProperty("profilesSampleRate");
  });

  it("reports error logs without an error as messages and ignores lower levels", async () => {
    const { events, transport } = recordingTransport();
    const logger = createLogger({
      service: "rakazo-api",
      sinks: [await createSentrySink("rakazo-api", { dsn: DSN }, transport)],
    });
    logger.info("started");
    logger.warn("slow");
    logger.error("http.request.completed", { "error.report": false });
    logger.error("queue unavailable", { "request.id": "req-1" });
    logger.error("mail sync failed");
    await logger.flush();

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      level: "error",
      message: "queue unavailable",
      tags: { service: "rakazo-api", "request.id": "req-1" },
    });
    // No synthetic stack: the collector titles and groups these by their message.
    expect(events.map((event) => event.exception)).toEqual([undefined, undefined]);
    expect(events[1]!.message).toBe("mail sync failed");
  });

  it("groups a report by its logged fingerprint on top of the default grouping", async () => {
    const { events, transport } = recordingTransport();
    const logger = createLogger({
      service: "rakazo-worker",
      sinks: [await createSentrySink("rakazo-worker", { dsn: DSN }, transport)],
    });
    logger.error("run.failed", new Error("provider error"), {
      "error.fingerprint": ["run.failed", "openrouter", "rate", "429"],
    });
    logger.error("job crashed", new Error("unexpected failure"));
    await logger.flush();

    expect(events.map((event) => event.fingerprint)).toEqual([
      ["{{ default }}", "run.failed", "openrouter", "rate", "429"],
      undefined,
    ]);
  });

  it("attaches logged error details as a redacted extra", async () => {
    const { events, transport } = recordingTransport();
    const logger = createLogger({
      service: "rakazo-worker",
      sinks: [await createSentrySink("rakazo-worker", { dsn: DSN }, transport)],
    });
    logger.error("run.failed", new Error("Bad Request"), {
      "error.details": '{"status":400,"note":"token=sk-live-123456789"}',
    });
    await logger.flush();

    expect(events[0]?.extra["log.message"]).toBe("run.failed");
    expect(events[0]?.extra["error.details"]).toContain('"status":400');
    expect(events[0]?.extra["error.details"]).not.toContain("sk-live");
  });

  it("titles a failed request report by its method, route and status", async () => {
    const { events, transport } = recordingTransport();
    const logger = createLogger({
      service: "rakazo-api",
      sinks: [await createSentrySink("rakazo-api", { dsn: DSN }, transport)],
    });
    logger.error("http.request.completed", {
      "http.method": "POST",
      "http.route": "/api/voice/speak",
      "http.status": 502,
    });
    await logger.flush();

    expect(events[0]?.message).toBe("http.request.completed POST /api/voice/speak 502");
  });
});
