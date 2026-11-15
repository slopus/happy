import { describe, expect, it } from "vitest";
import { RoutineWatchSchema } from "./routine-watch.js";

describe("watch intervals", () => {
  it.each([
    { kind: "files", paths: ["inbox"] },
    { kind: "command", command: "echo changed" },
    { kind: "tool", tool: "read_changes" },
    { kind: "http", url: "https://example.com/status" },
  ])("requires at least five minutes for $kind", (watch) => {
    expect(RoutineWatchSchema.safeParse({ ...watch, everyMinutes: 4 }).success).toBe(false);
    expect(RoutineWatchSchema.safeParse({ ...watch, everyMinutes: 5 }).success).toBe(true);
    expect(RoutineWatchSchema.parse(watch).everyMinutes).toBe(15);
  });
});

describe("HTTP watches", () => {
  it.each([
    undefined,
    "",
    "not a url",
    "http://example.com/status",
    "file:///etc/passwd",
    "https://user:password@example.com/status",
    "https://example.com:8443/status",
    "https://example.com/status#fragment",
  ])("refuses an unsupported destination %s", (url) => {
    expect(RoutineWatchSchema.safeParse({ kind: "http", url }).success).toBe(false);
  });

  it("accepts a public HTTPS status endpoint and tracked fields", () => {
    expect(
      RoutineWatchSchema.parse({
        kind: "http",
        url: " https://example.com/status?filter=ready ",
        track: ["id", "updatedAt"],
      }),
    ).toMatchObject({
      kind: "http",
      url: "https://example.com/status?filter=ready",
      track: ["id", "updatedAt"],
    });
  });
});
