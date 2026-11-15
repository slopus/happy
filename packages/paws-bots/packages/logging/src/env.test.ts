import { describe, expect, it } from "vitest";
import { resolveLogEnv } from "./env.js";

describe("resolveLogEnv", () => {
  it("defaults to info and pretty outside production", () => {
    expect(resolveLogEnv({})).toEqual({ level: "info", format: "pretty" });
    expect(resolveLogEnv({ NODE_ENV: "production" })).toEqual({
      level: "info",
      format: "json",
    });
  });

  it("honors explicit level and format", () => {
    expect(resolveLogEnv({ LOG_LEVEL: "DEBUG", LOG_FORMAT: "json" })).toEqual({
      level: "debug",
      format: "json",
    });
    expect(
      resolveLogEnv({ LOG_LEVEL: "nope", LOG_FORMAT: "pretty", NODE_ENV: "production" }),
    ).toEqual({
      level: "info",
      format: "pretty",
    });
  });
});
