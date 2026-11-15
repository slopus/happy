import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from "@rakazo/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAuth } from "./index.js";

// Better Auth's real routes and hashing over its offline memory adapter.
vi.mock("better-auth/adapters/prisma", async () => {
  const { memoryAdapter } = await import("better-auth/adapters/memory");
  return {
    prismaAdapter: (prisma: { authData: Record<string, unknown[]> }) =>
      memoryAdapter(prisma.authData),
  };
});
vi.mock("@rakazo/db", () => ({
  bootstrapUserSpace: vi.fn(async () => ({ spaceId: "space-1" })),
  leaveInvitedSpaces: vi.fn(async () => ({ ownedOrganizationIds: [] })),
  recordSecurityEvent: vi.fn(async () => undefined),
}));

const baseURL = "http://auth.example.test";
const webOrigin = "http://web.example.test";
const strongPassword = "offline-password-1234";

function fixture({ breachedPasswordCheck = false } = {}) {
  const data: Record<string, Record<string, unknown>[]> = {
    user: [],
    account: [],
    session: [],
    verification: [],
  };
  const prisma = {
    authData: data,
    deploymentSettings: {
      findUnique: vi.fn(async () => ({
        signupsEnabled: true,
        signupAllowlist: "",
        signupPolicyInitialized: true,
      })),
    },
    spaceMember: { findFirst: vi.fn(async () => ({ spaceId: "space-1" })) },
  };
  const log = vi.fn();
  const auth = createAuth(prisma as never, {
    secret: "offline-auth-secret-at-least-32-characters",
    baseURL,
    webOrigin,
    signupsEnabled: "true",
    signupAllowlist: "",
    breachedPasswordCheck,
    logger: { level: "error", log },
  });
  const request = (path: string, body: unknown, token?: string) =>
    auth.handler(
      new Request(`${baseURL}/api/auth${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: webOrigin,
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
      }),
    );
  const signup = (password: string) =>
    request("/sign-up/email", { email: "ada@example.test", password, name: "Ada" });
  return { data, request, signup, log };
}

/** A Have I Been Pwned range response listing `password` as breached. */
async function pwnedRange(password: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(password));
  const hex = Buffer.from(digest).toString("hex").toUpperCase();
  return `${hex.slice(5)}:42\r\n0000000000000000000000000000000000A:0`;
}

afterEach(() => vi.unstubAllGlobals());

describe("password length", () => {
  it("enforces the shared minimum on new passwords", async () => {
    const f = fixture();
    const short = await f.signup("x".repeat(MIN_PASSWORD_LENGTH - 1));
    expect(short.status).toBe(400);
    expect(await short.json()).toMatchObject({ code: "PASSWORD_TOO_SHORT" });
    expect((await f.signup("x".repeat(MIN_PASSWORD_LENGTH))).status).toBe(200);
  });

  it("enforces the shared maximum on new passwords", async () => {
    const long = await fixture().signup("x".repeat(MAX_PASSWORD_LENGTH + 1));
    expect(long.status).toBe(400);
    expect(await long.json()).toMatchObject({ code: "PASSWORD_TOO_LONG" });
  });
});

describe("breached password check", () => {
  it("never contacts the breach service unless enabled", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect((await fixture().signup(strongPassword)).status).toBe(200);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects a breached new password and sends only a hash prefix", async () => {
    const fetch = vi.fn(async () => new Response(await pwnedRange(strongPassword)));
    vi.stubGlobal("fetch", fetch);
    const f = fixture({ breachedPasswordCheck: true });
    const signup = await f.signup(strongPassword);
    expect(signup.status).toBe(400);
    expect(await signup.json()).toMatchObject({ code: "PASSWORD_COMPROMISED" });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/^https:\/\/api\.pwnedpasswords\.com\/range\/[0-9A-F]{5}$/);
    expect(url).not.toContain(strongPassword);
    // The deadline aborts the request itself, so a stalled lookup does not outlive sign-up.
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("fails open when the service returns an error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 503 })),
    );
    const f = fixture({ breachedPasswordCheck: true });
    expect((await f.signup(strongPassword)).status).toBe(200);
    expect(f.log).toHaveBeenCalled();
  });

  it("fails open without reading an oversized range response", async () => {
    const response = new Response(await pwnedRange(strongPassword), {
      headers: { "content-length": String(1024 * 1024 * 1024) },
    });
    const cancel = vi.spyOn(response.body!, "cancel");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response),
    );
    const f = fixture({ breachedPasswordCheck: true });
    expect((await f.signup(strongPassword)).status).toBe(200);
    expect(f.log).toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("accepts a password the service does not list", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(await pwnedRange("some-other-password"))),
    );
    expect((await fixture({ breachedPasswordCheck: true }).signup(strongPassword)).status).toBe(
      200,
    );
  });

  it("fails open and logs when the service is unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    const f = fixture({ breachedPasswordCheck: true });
    expect((await f.signup(strongPassword)).status).toBe(200);
    expect(f.log).toHaveBeenCalledWith(
      "error",
      "Breached password check unavailable",
      expect.anything(),
    );
  });

  it("does not check passwords at sign-in", async () => {
    const f = fixture({ breachedPasswordCheck: true });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("")),
    );
    expect((await f.signup(strongPassword)).status).toBe(200);
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const signin = await f.request("/sign-in/email", {
      email: "ada@example.test",
      password: strongPassword,
    });
    expect(signin.status).toBe(200);
    expect(fetch).not.toHaveBeenCalled();
  });
});
