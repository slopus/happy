import { ORPCError } from "@orpc/server";
import { SandboxUnavailableError } from "@rakazo/adapter-kit";
import { databaseOutage } from "@rakazo/db";
import type { TestSink } from "@rakazo/logging";
import { createLogger, createTestSink, installLogger, runWithLogContext } from "@rakazo/logging";
import { requestLogging } from "@rakazo/logging/hono";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { authLibraryLogger, withAuthLibraryFailures } from "./app.js";
import { handleHttpError, handleRpcError, requestHitDatabaseOutage } from "./rpc-errors.js";

let sink: TestSink;
beforeEach(() => {
  installLogger(createLogger({ service: "rakazo-api", level: "off", sinks: [] }));
  databaseOutage.succeeded();
  sink = createTestSink();
  installLogger(createLogger({ service: "rakazo-api", sinks: [sink] }));
});
afterEach(() => {
  installLogger(createLogger({ service: "rakazo-api", level: "off", sinks: [] }));
  databaseOutage.succeeded();
});

/** Prisma's error while Postgres fails over. */
function unreachable() {
  return Object.assign(new Error("Can't reach database server at db:5432"), { code: "P1001" });
}

function app() {
  const app = new Hono();
  app.onError(handleHttpError);
  app.use("*", requestLogging());
  // The session lookup that runs before every signed-in request, failing as during the drill.
  app.use("/rpc/*", async () => {
    authLibraryLogger("auth.request.failed").log("error", "INTERNAL_SERVER_ERROR", unreachable());
    throw unreachable();
  });
  app.get("/boom", () => {
    throw new Error("boom");
  });
  return app;
}

const logged = () =>
  sink.events
    .filter((event) => event.level !== "info" && event.message !== "http.request.completed")
    .map((event) => `${event.level}:${event.message}`);

describe("a request during a database outage", () => {
  it("answers 503 with Retry-After and logs the outage once for every request it fails", async () => {
    const server = app();
    for (let request = 0; request < 3; request += 1) {
      const response = await server.request("/rpc/threads/send", { method: "POST" });
      expect(response.status).toBe(503);
      expect(response.headers.get("retry-after")).toBe("5");
    }
    expect(logged()).toEqual(["error:database unavailable; backing off"]);
    expect(
      sink.events
        .filter((event) => event.message === "http.request.completed")
        .map((event) => event.level),
    ).toEqual(["warn", "warn", "warn"]);
  });

  it("turns the auth library's own 500 during the outage into a 503", async () => {
    const response = await runWithLogContext({}, () =>
      withAuthLibraryFailures(async () => {
        authLibraryLogger("auth.request.failed").log(
          "error",
          "INTERNAL_SERVER_ERROR",
          unreachable(),
        );
        return new Response(null, { status: 500 });
      }),
    );
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("5");
    expect(logged().filter((line) => line.includes("auth.request.failed"))).toEqual([]);
  });

  it("still answers 500 and logs any other failure", async () => {
    const response = await app().request("/boom");
    expect(response.status).toBe(500);
    expect(logged()).toEqual(["error:http.request.failed"]);
  });

  it("answers an RPC procedure that hit it as unavailable, and only that 503 asks for a retry", () => {
    const rpcFailure = (error: unknown) =>
      runWithLogContext({}, () => {
        let thrown: unknown;
        try {
          handleRpcError(error, ["threads", "send"]);
        } catch (caught) {
          thrown = caught;
        }
        return { thrown, retry: requestHitDatabaseOutage() };
      });
    const outage = rpcFailure(unreachable());
    expect(outage.thrown).toBeInstanceOf(ORPCError);
    expect(outage.thrown).toMatchObject({ code: "SERVICE_UNAVAILABLE", status: 503 });
    expect(outage.retry).toBe(true);
    const provider = rpcFailure(new SandboxUnavailableError());
    expect(provider.thrown).toMatchObject({ status: 503 });
    expect(provider.retry).toBe(false);
  });
});
