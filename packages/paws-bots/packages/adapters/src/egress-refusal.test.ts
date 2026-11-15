import { createLogger, createTestSink, installLogger } from "@rakazo/logging";
import { beforeEach, describe, expect, it } from "vitest";
import { egressRefused, isEgressRefused } from "./network-address.js";
import { assertSafeRemoteUrl, createSafeLookup } from "./remote-mcp.js";
import { assertSafeWebUrl } from "./web-ssrf.js";

let sink: ReturnType<typeof createTestSink>;

beforeEach(() => {
  sink = createTestSink();
  installLogger(createLogger({ service: "rakazo-worker", sinks: [sink] }));
});

const refusals = () =>
  sink.events
    .filter((event) => event["security.event.type"] === "egress.refused")
    .map((event) => event["security.event.metadata"]);

describe("egress refusals", () => {
  it("records a web fetch that resolves to a private address", async () => {
    const resolve = async () => [{ address: "10.0.0.5", family: 4 }];
    await expect(assertSafeWebUrl("https://intranet.example.test/", resolve)).rejects.toThrow(
      "private",
    );
    expect(refusals()).toEqual([
      { host: "intranet.example.test", reason: "URL resolves to a private address" },
    ]);
  });

  it("records a connector URL aimed at the cloud metadata endpoint", async () => {
    const refusal = assertSafeRemoteUrl("https://169.254.169.254/latest/meta-data");
    // Metadata hosts stay blocked even with the private-endpoint setting, so the refusal must not offer it.
    await expect(refusal).rejects.toThrow("private host");
    await expect(refusal).rejects.not.toThrow("MCP_ALLOW_PRIVATE_ENDPOINT");
    expect(refusals()).toEqual([
      { host: "169.254.169.254", reason: "Connector URL targets a private host" },
    ]);
  });

  it("records a connect-time DNS answer that rebinds to a private address", async () => {
    const lookup = createSafeLookup(async () => [{ address: "192.168.1.20", family: 4 }]);
    const error = await new Promise<Error | null>((resolve) =>
      lookup("rebind.example.test", {}, (failure) => resolve(failure)),
    );
    expect(error?.message).toContain("private");
    expect(refusals()).toEqual([
      { host: "rebind.example.test", reason: "Connector URL resolves to a private address" },
    ]);
  });

  it("records nothing for a public destination", async () => {
    const resolve = async () => [{ address: "93.184.215.14", family: 4 }];
    await assertSafeWebUrl("https://public.example.test/", resolve);
    expect(refusals()).toEqual([]);
  });
});

it("preserves typed refusal errors and recognizes them through transport causes", () => {
  class PrivateEndpointRequiredError extends Error {}
  const original = new PrivateEndpointRequiredError("private endpoint requires permission");
  const marked = egressRefused("private.example.test", original);
  expect(marked).toBe(original);
  expect(marked).toBeInstanceOf(PrivateEndpointRequiredError);
  expect(isEgressRefused(marked)).toBe(true);
  expect(isEgressRefused(new TypeError("fetch failed", { cause: marked }))).toBe(true);
  expect(isEgressRefused(new Error("temporary DNS failure"))).toBe(false);
  const circular = new Error("circular");
  circular.cause = circular;
  expect(isEgressRefused(circular)).toBe(false);
});
