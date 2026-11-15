import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  authRateLimitOptions,
  buildTrustedOrigins,
  createAuth,
  isBlockedAuthPath,
  passwordResetEmail,
  signInCodeEmail,
} from "./index.js";

describe("auth policy", () => {
  it("closes every organization plugin route", () => {
    for (const path of [
      "/organization/delete",
      "/organization/update",
      "/organization/leave",
      "/organization/create",
      "/organization/invite-member",
      "/organization/cancel-invitation",
      "/organization/set-active",
      "/organization/list",
      "/organization/create-team",
      "/organization/some-future-route",
    ]) {
      expect(isBlockedAuthPath(path), path).toBe(true);
    }
  });

  it("keeps the account routes the apps call", () => {
    for (const path of [
      "/sign-up/email",
      "/sign-in/email",
      "/sign-out",
      "/get-session",
      "/change-password",
      "/request-password-reset",
      "/reset-password",
      "/delete-user",
    ]) {
      expect(isBlockedAuthPath(path), path).toBe(false);
    }
  });

  it.each(["sign-in/email", "sign-up/email"])("logs internal failures from %s", async (path) => {
    const error = new Error("database unavailable");
    const log = vi.fn();
    const auth = createAuth(
      {
        user: {
          findFirst: vi.fn().mockRejectedValue(error),
          findMany: vi.fn().mockRejectedValue(error),
          count: vi.fn().mockRejectedValue(error),
          create: vi.fn().mockRejectedValue(error),
        },
      } as never,
      {
        secret: "offline-auth-secret-at-least-32-characters",
        baseURL: "https://api.example.test",
        webOrigin: "https://app.example.test",
        signupsEnabled: "true",
        signupAllowlist: "",
        logger: { level: "error", log },
      },
    );
    const response = await auth.handler(
      new Request(`https://api.example.test/api/auth/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://app.example.test" },
        body: JSON.stringify({
          email: "test@example.test",
          password: "test-password-123",
          name: "Test",
        }),
      }),
    );
    expect(response.status).toBe(500);
    expect(log).toHaveBeenCalledWith("error", expect.any(String), error);
  });

  it("disables organization deletion inside Better Auth as well", async () => {
    const auth = createAuth({} as never, {
      secret: "test-secret-that-is-long-enough-for-better-auth",
      baseURL: "http://127.0.0.1:3100",
      webOrigin: "http://127.0.0.1:5173",
      signupsEnabled: undefined,
      signupAllowlist: undefined,
    });

    const res = await auth.handler(
      new Request("http://127.0.0.1:3100/api/auth/organization/delete", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://127.0.0.1:5173" },
        body: JSON.stringify({ organizationId: "space-1" }),
      }),
    );

    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: "ORGANIZATION_DELETION_DISABLED" });
  });
});

describe("authRateLimitOptions", () => {
  it("caps credential routes at 10 attempts per 15 minutes in a shared table", () => {
    expect(authRateLimitOptions("production")).toEqual({
      enabled: true,
      storage: "database",
      customRules: {
        "/request-account-deletion": { window: 600, max: 3 },
        "/request-identity-code": { window: 600, max: 3 },
        "/confirm-identity": { window: 15 * 60, max: 10 },
        "/sign-in/email": { window: 15 * 60, max: 10 },
        "/sign-up/email": { window: 15 * 60, max: 10 },
        "/request-password-reset": { window: 15 * 60, max: 10 },
        "/email-otp/send-verification-otp": { window: 15 * 60, max: 10 },
        "/sign-in/email-otp": { window: 15 * 60, max: 10 },
        "/passkey/verify-authentication": { window: 15 * 60, max: 10 },
        "/passkey/verify-registration": { window: 15 * 60, max: 10 },
        "/passkey/generate-authenticate-options": { window: 60, max: 30 },
      },
    });
  });

  it("stays off outside production so the test suite can sign in", () => {
    expect(authRateLimitOptions("test").enabled).toBe(false);
  });
});

describe("buildTrustedOrigins", () => {
  it("adds the localhost twin for a 127.0.0.1 web origin", () => {
    expect(
      buildTrustedOrigins({ origins: ["http://127.0.0.1:5173", "http://127.0.0.1:5173"] }),
    ).toEqual(expect.arrayContaining(["http://127.0.0.1:5173", "http://localhost:5173"]));
  });

  it("keeps extraOrigins and does not twin non-loopback hosts", () => {
    expect(
      buildTrustedOrigins({
        origins: ["https://app.example.test", "https://api.example.test"],
        extraOrigins: ["https://extra.example.test"],
      }),
    ).toEqual([
      "https://app.example.test",
      "https://api.example.test",
      "https://extra.example.test",
    ]);
  });

  // The list Better Auth received before both callers shared one builder.
  function previousAuthOrigins(env: {
    webOrigin: string;
    baseURL: string;
    extraOrigins?: string[];
  }) {
    const configured = [env.webOrigin, env.baseURL, ...(env.extraOrigins ?? [])];
    const twins = [env.webOrigin, env.baseURL].flatMap(previousLoopbackTwins);
    return [...new Set([...configured, ...twins])];
  }

  function previousLoopbackTwins(origin: string): string[] {
    try {
      const url = new URL(origin);
      if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname)) return [];
      const twins: string[] = [];
      for (const host of ["localhost", "127.0.0.1"]) {
        if (host === url.hostname) continue;
        const twin = new URL(origin);
        twin.hostname = host;
        twins.push(twin.origin);
      }
      return twins;
    } catch {
      return [];
    }
  }

  const mobile = [
    "rakazo://",
    "http://localhost:8081",
    "http://127.0.0.1:8081",
    "http://localhost:19006",
    "http://127.0.0.1:19006",
  ];

  it.each([
    { webOrigin: "https://app.example.test", baseURL: "https://app.example.test" },
    {
      webOrigin: "https://app.example.test",
      baseURL: "https://auth.example.test/",
      extraOrigins: mobile,
    },
    { webOrigin: "http://127.0.0.1:5173", baseURL: "http://127.0.0.1:5173", extraOrigins: mobile },
    { webOrigin: "http://localhost:5173/", baseURL: "http://[::1]:3100", extraOrigins: [] },
    { webOrigin: "http://localhost:5173", baseURL: "not a url", extraOrigins: mobile },
  ])("gives Better Auth the same list as before for $webOrigin and $baseURL", (env) => {
    expect(
      buildTrustedOrigins({
        origins: [env.webOrigin, env.baseURL],
        extraOrigins: env.extraOrigins,
      }),
    ).toEqual(previousAuthOrigins(env));
  });
});

describe("passwordResetEmail", () => {
  it("keeps the reset URL in text and escapes user-controlled HTML", async () => {
    const message = await passwordResetEmail(
      { id: "user-1", email: "ada@example.test", name: '<Ada & "team">' },
      "https://rakazo.test/reset-password?token=secret&next=1",
    );

    expect(message).toMatchObject({
      to: "ada@example.test",
      subject: "Reset your Rakazo password",
    });
    expect(message.text).toContain("https://rakazo.test/reset-password?token=secret&next=1");
    expect(message.html).toContain("&lt;Ada &amp; &quot;team&quot;&gt;");
    expect(message.html).toContain("token=secret&amp;next=1");
    expect(message.html).not.toContain('<Ada & "team">');
  });
});

describe("signInCodeEmail", () => {
  it("puts the code in plain text and HTML without links", async () => {
    const message = await signInCodeEmail("ada@example.test", "042517");
    expect(message).toMatchObject({ to: "ada@example.test", subject: "Your Rakazo sign-in code" });
    expect(message.text).toContain("042517");
    expect(message.html).toContain("042517");
    expect(message.text).not.toMatch(/https?:/);
    expect(message.html).not.toContain("<a ");
  });
});

describe("stored account names", () => {
  const auth = createAuth({} as never, {
    secret: "offline-auth-secret-at-least-32-characters",
    baseURL: "https://api.example.test",
    webOrigin: "https://app.example.test",
    signupsEnabled: "true",
    signupAllowlist: "",
  });
  it.each(["", " ", "__TestTok1__", "550e8400-e29b-41d4-a716-446655440000"])(
    "normalizes unusable names on creation and updates: %s",
    async (name) => {
      const hooks = auth.options.databaseHooks!.user!;
      expect(
        await hooks.create!.before!({ name, email: "demo@example.com" } as never),
      ).toMatchObject({ data: { name: "" } });
      expect(await hooks.update!.before!({ name })).toMatchObject({ data: { name: "" } });
    },
  );
  it("preserves real names and does not change names during unrelated updates", async () => {
    const hook = auth.options.databaseHooks!.user!.update!.before!;
    expect(await hook({ name: " 李雷 " })).toMatchObject({ data: { name: "李雷" } });
    const result = await hook({ emailVerified: true });
    expect(result).toEqual({ data: { emailVerified: true } });
  });
});

it("preserves readable numbered account names on writes", async () => {
  const auth = createAuth({} as never, {
    secret: "offline-auth-secret-at-least-32-characters",
    baseURL: "https://api.example.test",
    webOrigin: "https://app.example.test",
    signupsEnabled: "true",
    signupAllowlist: "",
  });
  expect(
    await auth.options.databaseHooks!.user!.create!.before!({
      name: "CustomerSupportBot2026",
      email: "demo@example.com",
    } as never),
  ).toMatchObject({ data: { name: "CustomerSupportBot2026" } });
});

describe("bearer sessions", () => {
  const secret = "offline-auth-secret-at-least-32-characters";
  const token = "fakeSessionToken0123456789abcdef";

  function authWithSessionLookups() {
    const lookups: unknown[] = [];
    const model = new Proxy(
      {},
      {
        get: () =>
          vi.fn(async (query: unknown) => {
            lookups.push(query);
            return null;
          }),
      },
    );
    const prisma = new Proxy({}, { get: (_target, name) => (name === "then" ? undefined : model) });
    const auth = createAuth(prisma as never, {
      secret,
      baseURL: "https://api.example.test",
      webOrigin: "https://app.example.test",
      signupsEnabled: "true",
      signupAllowlist: "",
    });
    return { auth, lookups };
  }

  function signed(value: string, key = secret) {
    return `${value}.${createHmac("sha256", key).update(value).digest("base64")}`;
  }

  it.each([
    ["a raw session token", token],
    ["a token signed with another key", signed(token, "another-secret-of-at-least-32-chars")],
  ])("never looks up a session for %s", async (_label, bearer) => {
    const { auth, lookups } = authWithSessionLookups();
    const session = await auth.api.getSession({
      headers: new Headers({ authorization: `Bearer ${bearer}` }),
    });
    expect(session).toBeNull();
    expect(JSON.stringify(lookups)).not.toContain(token);
  });

  it.each([
    ["raw", signed(token)],
    ["URL-encoded", encodeURIComponent(signed(token))],
  ])("looks up the session for a %s signed token", async (_label, bearer) => {
    const { auth, lookups } = authWithSessionLookups();
    await auth.api.getSession({ headers: new Headers({ authorization: `Bearer ${bearer}` }) });
    expect(JSON.stringify(lookups)).toContain(token);
  });
});
