import { describe, expect, it } from "vitest";
import { appendForwardedFor } from "./forwarded-for.js";

describe("appendForwardedFor", () => {
  it("appends the peer this proxy saw to a caller-supplied chain", () => {
    expect(
      appendForwardedFor({
        headers: { "x-forwarded-for": "203.0.113.5" },
        socket: { remoteAddress: "172.18.0.1" },
      }),
    ).toBe("203.0.113.5, 172.18.0.1");
  });

  it("starts the chain when none arrived", () => {
    expect(appendForwardedFor({ headers: {}, socket: { remoteAddress: "172.18.0.1" } })).toBe(
      "172.18.0.1",
    );
  });

  it("joins repeated headers in order", () => {
    expect(
      appendForwardedFor({
        headers: { "x-forwarded-for": ["192.0.2.1", "198.51.100.2"] },
        socket: { remoteAddress: "127.0.0.1" },
      }),
    ).toBe("192.0.2.1, 198.51.100.2, 127.0.0.1");
  });
});
