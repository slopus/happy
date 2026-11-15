import type { TestSink } from "@rakazo/logging";
import { createLogger, createTestSink, installLogger } from "@rakazo/logging";
import { afterEach, beforeEach, expect, it } from "vitest";
import { authLibraryLogger, withAuthLibraryFailures } from "./app.js";

let sink: TestSink;
beforeEach(() => {
  sink = createTestSink();
  installLogger(createLogger({ service: "rakazo-api", sinks: [sink] }));
});
afterEach(() => installLogger(createLogger({ service: "rakazo-api", level: "off", sinks: [] })));

const logger = authLibraryLogger("auth.request.failed");
const answer = (status: number) => async () => {
  logger.log("error", "Failed to verify registration", new Error("Unexpected origin"));
  return new Response(null, { status });
};

it("warns about the auth library's failures when the request answers a client error", async () => {
  await withAuthLibraryFailures(answer(400));
  expect(sink.events).toMatchObject([
    {
      level: "warn",
      message: "auth.request.failed",
      "error.message": "Failed to verify registration",
      error: { message: "Unexpected origin" },
    },
  ]);
});

it("reports the auth library's failure with its error when the request answers 5xx", async () => {
  await withAuthLibraryFailures(answer(500));
  expect(sink.events).toMatchObject([
    { level: "error", message: "auth.request.failed", error: { message: "Unexpected origin" } },
  ]);
});
