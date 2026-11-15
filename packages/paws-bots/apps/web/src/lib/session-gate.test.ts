import { describe, expect, it } from "vitest";
import {
  holdAnonymousGate,
  holdUnreachableGate,
  sessionGate,
  sessionRetryDelayMs,
  showSessionUnavailable,
} from "./session-gate.js";

const user = { user: { id: "u_1" } };

describe("session gate", () => {
  it("shows the app once a session resolves", () => {
    expect(sessionGate({ data: user, isPending: false, error: null })).toBe("authenticated");
  });

  it("waits while the first lookup is in flight", () => {
    expect(sessionGate({ data: null, isPending: true, error: null })).toBe("loading");
  });

  it("sends a signed-out visitor to sign-in", () => {
    expect(sessionGate({ data: null, isPending: false, error: null })).toBe("anonymous");
  });

  it("treats 401 as a real sign-out", () => {
    expect(sessionGate({ data: null, isPending: false, error: { status: 401 } })).toBe("anonymous");
  });

  it("does not sign out a cold load that could not reach the server", () => {
    expect(sessionGate({ data: null, isPending: false, error: { status: 503 } })).toBe(
      "unreachable",
    );
    // A thrown fetch has no status at all.
    expect(sessionGate({ data: null, isPending: false, error: {} })).toBe("unreachable");
  });

  it("keeps showing the app when a refresh fails for an established session", () => {
    expect(sessionGate({ data: user, isPending: false, error: { status: 500 } })).toBe(
      "authenticated",
    );
  });

  it("holds the reconnect screen across a null-session refetch", () => {
    expect(holdUnreachableGate("unreachable", false)).toBe(true);
    expect(holdUnreachableGate("loading", true)).toBe(true);
    expect(holdUnreachableGate("authenticated", true)).toBe(false);
    expect(holdUnreachableGate("anonymous", true)).toBe(false);
    expect(showSessionUnavailable("loading", true)).toBe(true);
    expect(showSessionUnavailable("loading", false)).toBe(false);
  });

  it("keeps the signed-out pages across a refetch", () => {
    expect(holdAnonymousGate("anonymous", false)).toBe(true);
    expect(holdAnonymousGate("loading", true)).toBe(true);
    expect(holdAnonymousGate("loading", false)).toBe(false);
    expect(holdAnonymousGate("authenticated", true)).toBe(false);
    expect(holdAnonymousGate("unreachable", true)).toBe(false);
  });

  it("backs off between retries and stops growing", () => {
    const exact = () => 0;
    expect(sessionRetryDelayMs(0, exact)).toBe(1_000);
    expect(sessionRetryDelayMs(1, exact)).toBe(2_000);
    expect(sessionRetryDelayMs(3, exact)).toBe(8_000);
    expect(sessionRetryDelayMs(20, exact)).toBe(15_000);
  });

  it("jitters each retry so clients that lost the server together come back apart", () => {
    expect(sessionRetryDelayMs(3, () => 1)).toBe(4_000);
  });
});
