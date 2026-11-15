import { describe, expect, it } from "vitest";
import { redactConnectorPayload, sanitizeConnectorError } from "./connector-safety.js";

describe("redactConnectorPayload", () => {
  it("redacts secrets that JSON escapes in property names and values", () => {
    const secret = 'api"key';

    expect(
      redactConnectorPayload(
        {
          [secret]: `prefix ${secret} suffix`,
          nested: { value: secret },
          list: [secret, "kept"],
        },
        [secret],
      ),
    ).toEqual({
      "[redacted]": "prefix [redacted] suffix",
      nested: { value: "[redacted]" },
      list: ["[redacted]", "kept"],
    });
  });

  it("falls back to an inert result when the payload is not JSON serializable", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(redactConnectorPayload(circular, ["secret"])).toEqual({ ok: true });
  });

  it("redacts secrets represented by non-string JSON leaves", () => {
    expect(
      redactConnectorPayload({ number: 123, boolean: true, empty: null }, ["123", "true", "null"]),
    ).toEqual({ number: "[redacted]", boolean: "[redacted]", empty: "[redacted]" });
  });
});

describe("sanitizeConnectorError", () => {
  it("describes an error without a message instead of returning an empty string", () => {
    const refused = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:8080"), {
      code: "ECONNREFUSED",
    });
    expect(sanitizeConnectorError(new AggregateError([refused], ""))).toBe(
      "connect ECONNREFUSED 127.0.0.1:8080",
    );
    expect(sanitizeConnectorError(new Error("", { cause: new Error("socket hang up") }))).toBe(
      "socket hang up",
    );
    expect(sanitizeConnectorError(Object.assign(new Error(""), { code: "EPIPE" }))).toBe(
      "Error EPIPE",
    );
    expect(sanitizeConnectorError(new TypeError(""))).toBe("TypeError without a message");
    expect(sanitizeConnectorError("")).toBe("unknown error");
  });
});
