import { afterEach, describe, expect, it, vi } from "vitest";
import { callClientNonce, callIdFromClientNonce, isCallClientNonce } from "./call-nonce.js";
import { newClientId } from "./client-id.js";

describe("call client nonce", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("round-trips the call id", () => {
    const nonce = callClientNonce("call-1");
    expect(isCallClientNonce(nonce)).toBe(true);
    expect(callIdFromClientNonce(nonce)).toBe("call-1");
  });

  it("stays unique per message within one call", () => {
    expect(callClientNonce("call-1")).not.toBe(callClientNonce("call-1"));
  });

  it("rejects a call id that would blur the nonce format", () => {
    expect(() => callClientNonce("call:1")).toThrow();
  });

  it("reads the id up to the unique suffix, not the first colon", () => {
    expect(callIdFromClientNonce("call:call:1:abc")).toBe("call:1");
    expect(callIdFromClientNonce("call:call-1")).toBeUndefined();
    expect(callIdFromClientNonce("call::abc")).toBeUndefined();
  });

  it("rejects plain nonces and other prefixed nonces", () => {
    for (const nonce of [null, undefined, "", "abc-123", "user-progress:run-1:0:x:y"]) {
      expect(isCallClientNonce(nonce)).toBe(false);
      expect(callIdFromClientNonce(nonce)).toBeUndefined();
    }
  });

  it("makes unique call ids without crypto.randomUUID", () => {
    vi.stubGlobal("crypto", undefined);
    const first = newClientId();
    expect(first).not.toContain(":");
    expect(newClientId()).not.toBe(first);
    expect(callIdFromClientNonce(callClientNonce(first))).toBe(first);
  });
});
