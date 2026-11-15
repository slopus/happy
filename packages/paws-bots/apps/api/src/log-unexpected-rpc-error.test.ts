import { ORPCError, onError, os } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import {
  SandboxAllowanceUsedError,
  SandboxDamagedError,
  SandboxRateLimitError,
  SandboxUnavailableError,
  SandboxUnresponsiveError,
  VoiceAccountError,
} from "@rakazo/adapter-kit";
import { ThreadMessagePageSchema } from "@rakazo/contracts";
import { MODEL_IMAGE_INPUT_ERROR } from "@rakazo/core";
import { IsolationError, SpaceDeletionInProgressError } from "@rakazo/db";
import { createLogger, createTestSink, installLogger } from "@rakazo/logging";
import { markExpectedFailure, requestLogging } from "@rakazo/logging/hono";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { handleRpcError, logUnexpectedRpcError } from "./rpc-errors.js";

describe("logUnexpectedRpcError", () => {
  afterEach(() => {
    installLogger(createLogger({ service: "rakazo-api", level: "off", sinks: [] }));
  });

  it("stays quiet for an error the router chose to return", () => {
    const sink = createTestSink();
    installLogger(createLogger({ service: "rakazo-api", sinks: [sink] }));

    logUnexpectedRpcError(new ORPCError("BAD_REQUEST", { message: "file is too large" }), [
      "computer",
      "readFile",
    ]);

    expect(sink.events).toEqual([]);
  });

  it("reports a procedure's own 5xx under the procedure with its cause", () => {
    const sink = createTestSink();
    installLogger(createLogger({ service: "rakazo-api", sinks: [sink] }));
    const cause = new Error("key service unreachable");

    logUnexpectedRpcError(new ORPCError("SERVICE_UNAVAILABLE", { cause }), ["models", "list"]);

    expect(sink.events[0]).toMatchObject({
      level: "error",
      message: "rpc models/list failed",
      error: { cause: { message: "key service unreachable" } },
    });
  });

  it("completes a request the provider outage answered with 503 as a warning", async () => {
    const sink = createTestSink();
    const logger = createLogger({ service: "rakazo-api", sinks: [sink] });
    installLogger(logger);
    const rpc = new RPCHandler(
      {
        boot: os.handler(() => {
          throw new SandboxUnresponsiveError("Boat API request failed (HTTP 525)");
        }),
      },
      { clientInterceptors: [onError((error, { path }) => handleRpcError(error, path))] },
    );
    const app = new Hono();
    app.use("*", requestLogging(logger));
    app.post("/rpc/*", async (c) => {
      const { response } = await rpc.handle(c.req.raw, { prefix: "/rpc", context: {} });
      return response ?? c.notFound();
    });

    const response = await app.request("/rpc/boot", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(503);
    expect(sink.events.map((event) => [event.level, event.message])).toEqual([
      ["warn", "rpc boot computer unavailable"],
      ["warn", "http.request.completed"],
    ]);
  });

  it("leaves a 5xx out of error reports when the procedure marked its outage expected", async () => {
    const sink = createTestSink();
    const logger = createLogger({ service: "rakazo-api", sinks: [sink] });
    installLogger(logger);
    const rpc = new RPCHandler(
      {
        begin: os.handler(() => {
          logger.warn("provider sign-in unavailable");
          markExpectedFailure();
          throw new ORPCError("SERVICE_UNAVAILABLE");
        }),
      },
      { clientInterceptors: [onError((error, { path }) => handleRpcError(error, path))] },
    );
    const app = new Hono();
    app.use("*", requestLogging(logger));
    app.post("/rpc/*", async (c) => {
      const { response } = await rpc.handle(c.req.raw, { prefix: "/rpc", context: {} });
      return response ?? c.notFound();
    });

    const response = await app.request("/rpc/begin", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(503);
    expect(sink.events.map((event) => [event.level, event.message])).toEqual([
      ["warn", "provider sign-in unavailable"],
      ["warn", "http.request.completed"],
    ]);
  });

  it("keeps an image send the model cannot read out of error reports", () => {
    const sink = createTestSink();
    installLogger(createLogger({ service: "rakazo-api", sinks: [sink] }));
    const rejection = new ORPCError("CONFLICT", {
      message: MODEL_IMAGE_INPUT_ERROR,
      data: { reason: "model_image_input_unsupported" },
    });

    expect(() => handleRpcError(rejection, ["threads", "send"])).not.toThrow();
    expect(sink.events).toEqual([]);
  });

  it("answers work refused in a Space being deleted as a conflict, without an error report", () => {
    const sink = createTestSink();
    installLogger(createLogger({ service: "rakazo-api", sinks: [sink] }));

    expect(() => handleRpcError(new SpaceDeletionInProgressError(), ["threads", "send"])).toThrow(
      expect.objectContaining({ code: "CONFLICT" }),
    );
    expect(sink.events.filter((event) => event.level === "error")).toEqual([]);
  });

  it("names the fields a procedure's output got wrong, without their values", async () => {
    const sink = createTestSink();
    installLogger(createLogger({ service: "rakazo-api", sinks: [sink] }));
    const router = {
      messages: os.output(ThreadMessagePageSchema).handler(() => ({
        threadId: "thread-1",
        olderCursor: null,
        messages: [
          {
            id: "message-1",
            threadId: "thread-1",
            seq: 1,
            role: "user" as const,
            blocks: [{ kind: "text" as const, text: 42 as unknown as string, private: "secret" }],
            createdAt: "2026-11-06T00:00:00.000Z",
          },
        ],
      })),
    };
    const rpc = new RPCHandler(router, {
      clientInterceptors: [onError((error, { path }) => handleRpcError(error, path))],
    });

    await rpc.handle(
      new Request("http://localhost/rpc/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
      { prefix: "/rpc", context: {} },
    );

    expect(sink.events).toEqual([
      expect.objectContaining({
        level: "error",
        message: "rpc messages failed",
        "validation.issues":
          "messages.0.blocks.0.text: Invalid input: expected string, received number",
      }),
    ]);
    expect(JSON.stringify(sink.events)).not.toContain("secret");
  });

  it("names the procedure and every cause behind an opaque failure", () => {
    const sink = createTestSink();
    installLogger(createLogger({ service: "rakazo-api", sinks: [sink] }));
    const error = new Error("fetch failed", {
      cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:7091"), {
        code: "ECONNREFUSED",
      }),
    });

    logUnexpectedRpcError(error, ["computer", "screenUrl"]);

    expect(sink.events[0]).toMatchObject({
      message: "rpc computer/screenUrl failed",
      error: {
        message: "fetch failed",
        cause: { message: "connect ECONNREFUSED 127.0.0.1:7091" },
      },
    });
  });

  it("keeps a failure after the client disconnected out of error reports", async () => {
    const sink = createTestSink();
    installLogger(createLogger({ service: "rakazo-api", sinks: [sink] }));
    const client = new AbortController();
    const router = {
      voices: os.handler(() => {
        client.abort("Client connection prematurely closed.");
        throw new Error("Client connection prematurely closed.");
      }),
    };
    const rpc = new RPCHandler(router, {
      clientInterceptors: [
        onError((error, { path, signal }) => handleRpcError(error, path, signal)),
      ],
    });

    await rpc.handle(
      new Request("http://localhost/rpc/voices", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
        signal: client.signal,
      }),
      { prefix: "/rpc", context: {} },
    );

    expect(sink.events.map((event) => [event.level, event.message])).toEqual([
      ["warn", "rpc voices client disconnected"],
    ]);
  });

  it("returns a provider rate limit as too many requests without an error report", () => {
    const sink = createTestSink();
    installLogger(createLogger({ service: "rakazo-api", sinks: [sink] }));
    const error = new SandboxRateLimitError({ cause: new Error("HTTP 429, rate_limited") });

    let thrown: unknown;
    try {
      handleRpcError(error, ["computer", "boot"]);
    } catch (failure) {
      thrown = failure;
    }

    expect(thrown).toBeInstanceOf(ORPCError);
    expect(thrown).toMatchObject({ code: "TOO_MANY_REQUESTS", message: error.message });
    expect(sink.events).toEqual([
      expect.objectContaining({
        level: "warn",
        message: "rpc computer/boot computer rate limited",
        reason: "HTTP 429, rate_limited",
      }),
    ]);
  });

  it("returns a computer the provider never started as a retryable 503 without an error report", () => {
    const sink = createTestSink();
    installLogger(createLogger({ service: "rakazo-api", sinks: [sink] }));
    const error = new SandboxUnavailableError({ cause: new Error("sandbox did not become ready") });

    let thrown: unknown;
    try {
      handleRpcError(error, ["computer", "boot"]);
    } catch (failure) {
      thrown = failure;
    }

    expect(thrown).toBeInstanceOf(ORPCError);
    expect(thrown).toMatchObject({ code: "SERVICE_UNAVAILABLE", message: error.message });
    expect(sink.events).toEqual([
      expect.objectContaining({
        level: "warn",
        message: "rpc computer/boot computer unavailable",
        reason: "sandbox did not become ready",
      }),
    ]);
  });

  it("returns an unreachable computer provider as a retryable 503 without an error report", () => {
    const sink = createTestSink();
    installLogger(createLogger({ service: "rakazo-api", sinks: [sink] }));
    const error = new SandboxUnresponsiveError("Boat API request failed (HTTP 502)");

    let thrown: unknown;
    try {
      handleRpcError(error, ["computer", "screenUrl"]);
    } catch (failure) {
      thrown = failure;
    }

    expect(thrown).toBeInstanceOf(ORPCError);
    expect(thrown).toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      message: new SandboxUnavailableError().message,
    });
    expect(sink.events).toEqual([
      expect.objectContaining({
        level: "warn",
        message: "rpc computer/screenUrl computer unavailable",
        reason: "Boat API request failed (HTTP 502)",
      }),
    ]);
  });

  it("returns a spent computer allowance with its message and no error report", () => {
    const sink = createTestSink();
    installLogger(createLogger({ service: "rakazo-api", sinks: [sink] }));
    const error = new SandboxAllowanceUsedError();

    let thrown: unknown;
    try {
      handleRpcError(error, ["computer", "boot"]);
    } catch (failure) {
      thrown = failure;
    }

    expect(thrown).toMatchObject({ code: "FORBIDDEN", status: 403, message: error.message });
    expect(sink.events.map((event) => [event.level, event.message])).toEqual([
      ["warn", "rpc computer/boot computer allowance used up"],
    ]);
  });

  it("returns a damaged computer's Recover message as a conflict without an error report", () => {
    const sink = createTestSink();
    installLogger(createLogger({ service: "rakazo-api", sinks: [sink] }));
    const error = new SandboxDamagedError();

    let thrown: unknown;
    try {
      handleRpcError(error, ["computer", "boot"]);
    } catch (failure) {
      thrown = failure;
    }

    expect(thrown).toBeInstanceOf(ORPCError);
    expect(thrown).toMatchObject({ code: "CONFLICT", status: 409, message: error.message });
    expect(sink.events.map((event) => [event.level, event.message])).toEqual([
      ["warn", "rpc computer/boot computer damaged"],
    ]);
  });

  it("sends a provider rate limit to the client as HTTP 429 with the plain message", async () => {
    installLogger(createLogger({ service: "rakazo-api", sinks: [createTestSink()] }));
    const router = {
      boot: os.handler(() => {
        throw new SandboxRateLimitError({ cause: new Error("HTTP 429, rate_limited") });
      }),
    };
    const rpc = new RPCHandler(router, {
      clientInterceptors: [onError((error, { path }) => handleRpcError(error, path))],
    });

    const { response } = await rpc.handle(
      new Request("http://localhost/rpc/boot", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
      { prefix: "/rpc", context: {} },
    );

    expect(response?.status).toBe(429);
    expect(await response?.text()).toContain("Too many computer requests. Try again later.");
  });

  it("sends a spent voice provider account to the client as HTTP 402 with its code and no error report", async () => {
    const sink = createTestSink();
    installLogger(createLogger({ service: "rakazo-api", sinks: [sink] }));
    const router = {
      voices: os.handler(() => {
        throw new VoiceAccountError(
          "VOICE_OUT_OF_CREDIT",
          "OpenAI says this account is out of credit.",
        );
      }),
    };
    const rpc = new RPCHandler(router, {
      clientInterceptors: [onError((error, { path }) => handleRpcError(error, path))],
    });

    const { response } = await rpc.handle(
      new Request("http://localhost/rpc/voices", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
      { prefix: "/rpc", context: {} },
    );

    expect(response?.status).toBe(402);
    expect(await response?.json()).toMatchObject({
      json: { code: "VOICE_OUT_OF_CREDIT", message: "OpenAI says this account is out of credit." },
    });
    expect(sink.events.map((event) => event.level)).toEqual(["warn"]);
  });

  it("sends a missing or foreign resource to the client as HTTP 404 without an error report", async () => {
    const sink = createTestSink();
    installLogger(createLogger({ service: "rakazo-api", sinks: [sink] }));
    const router = {
      read: os.handler(() => {
        throw new IsolationError();
      }),
    };
    const rpc = new RPCHandler(router, {
      clientInterceptors: [onError((error, { path }) => handleRpcError(error, path))],
    });

    const { response } = await rpc.handle(
      new Request("http://localhost/rpc/read", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
      { prefix: "/rpc", context: {} },
    );

    expect(response?.status).toBe(404);
    expect(await response?.json()).toMatchObject({
      json: { code: "NOT_FOUND", message: "Resource not found" },
    });
    expect(sink.events.map((event) => [event.level, event.message])).toEqual([
      ["warn", "rpc read not found"],
    ]);
  });
});
