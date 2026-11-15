import { afterEach, describe, expect, it, vi } from "vitest";
import { newClientId } from "./client-id.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("newClientId", () => {
  it("uses crypto.randomUUID when the method is available", () => {
    vi.stubGlobal("crypto", {
      randomUUID: () => "11111111-2222-4333-8444-555555555555",
    });
    expect(newClientId()).toBe("11111111-2222-4333-8444-555555555555");
  });

  it("does not throw when randomUUID is missing", () => {
    vi.stubGlobal("crypto", {
      getRandomValues: (bytes: Uint8Array) => {
        bytes.fill(7);
        return bytes;
      },
    });
    expect(() => newClientId()).not.toThrow();
    expect(newClientId()).toMatch(UUID);
  });

  it("does not throw when randomUUID rejects an insecure context", () => {
    vi.stubGlobal("crypto", {
      randomUUID: () => {
        throw new Error("secure context required");
      },
      getRandomValues: (bytes: Uint8Array) => {
        bytes.fill(9);
        return bytes;
      },
    });
    expect(() => newClientId()).not.toThrow();
    expect(newClientId()).toMatch(UUID);
  });

  it("falls back when Web Crypto is absent", () => {
    vi.stubGlobal("crypto", undefined);
    expect(() => newClientId()).not.toThrow();
    expect(newClientId()).toMatch(UUID);
  });
});
