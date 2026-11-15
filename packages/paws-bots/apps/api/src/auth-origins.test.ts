import { createAuth } from "@rakazo/auth";
import { describe, expect, it } from "vitest";
import { isTrustedOrigin, MOBILE_AUTH_ORIGINS, trustedRequestOrigins } from "./app.js";

// Better Auth skips its origin middleware under NODE_ENV=test, so check the
// matcher that production uses for callback URLs and request origins.
async function trusted(url: string) {
  const auth = createAuth({} as never, {
    secret: "offline-auth-secret-at-least-32-characters",
    baseURL: "https://api.example.test",
    webOrigin: "https://app.example.test",
    signupsEnabled: undefined,
    signupAllowlist: undefined,
    extraOrigins: MOBILE_AUTH_ORIGINS,
  });
  return (await auth.$context).isTrustedOrigin(url);
}

const env = {
  webOrigin: "http://127.0.0.1:5173",
  apiUrl: "http://127.0.0.1:3100",
  authUrl: "http://127.0.0.1:5173",
};

describe("CORS origins", () => {
  it("allows the configured site, its loopback twin, and the mobile dev servers", () => {
    for (const origin of [
      "http://127.0.0.1:5173",
      "http://localhost:5173",
      "http://127.0.0.1:3100",
      "http://localhost:8081",
      "http://127.0.0.1:19006",
      "http://[::1]:8081",
      "rakazo://sign-in",
      "",
    ]) {
      expect(isTrustedOrigin(origin, env), origin).toBe(true);
    }
  });

  it("accepts the configured site when env values keep a trailing slash", () => {
    const envWithSlash = {
      webOrigin: "http://127.0.0.1:5173/",
      apiUrl: "http://127.0.0.1:3100/",
      authUrl: "http://127.0.0.1:5173/",
    };
    expect(isTrustedOrigin("http://127.0.0.1:5173", envWithSlash)).toBe(true);
    expect(isTrustedOrigin("http://localhost:5173", envWithSlash)).toBe(true);
  });

  it("rejects any other loopback port and any public origin", () => {
    for (const origin of [
      "http://127.0.0.1:9",
      "http://localhost:45173",
      "http://[::1]:9",
      "https://evil.example",
      "exp://192.168.1.20:8081",
    ]) {
      expect(isTrustedOrigin(origin, env), origin).toBe(false);
    }
  });
});

describe("request origin list", () => {
  // The CORS list before the API and Better Auth shared one builder.
  function previousRequestOrigins(env: { webOrigin: string; apiUrl: string; authUrl: string }) {
    return new Set(
      [env.webOrigin, env.apiUrl, env.authUrl, ...MOBILE_AUTH_ORIGINS].flatMap(previousVariants),
    );
  }

  function previousVariants(origin: string): string[] {
    if (!origin || origin === "rakazo://") return [];
    const variants = [origin, ...previousLoopbackTwins(origin)];
    try {
      const url = new URL(origin);
      if (url.protocol === "http:" || url.protocol === "https:") {
        variants.push(url.origin);
      }
      if (url.hostname === "localhost" || url.hostname === "127.0.0.1") {
        const v6 = new URL(origin);
        v6.hostname = "[::1]";
        variants.push(v6.origin);
      }
    } catch {
      return variants;
    }
    return variants;
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

  it.each([
    env,
    {
      webOrigin: "http://127.0.0.1:5173/",
      apiUrl: "http://127.0.0.1:3100/",
      authUrl: "http://127.0.0.1:5173/",
    },
    {
      webOrigin: "https://app.example.test",
      apiUrl: "https://api.example.test",
      authUrl: "https://app.example.test",
    },
    {
      webOrigin: "https://app.example.test/",
      apiUrl: "",
      authUrl: "https://auth.example.test/base",
    },
    { webOrigin: "http://localhost:5173", apiUrl: "http://[::1]:3100", authUrl: "not a url" },
  ])("matches the previous list for $webOrigin, $apiUrl, $authUrl", (config) => {
    const current = trustedRequestOrigins(config);
    expect(new Set(current)).toEqual(previousRequestOrigins(config));
    expect(current).toHaveLength(new Set(current).size);
  });
});

describe("mobile auth origins", () => {
  it("does not trust an arbitrary Expo host as a callback", async () => {
    for (const url of [
      "exp://attacker.example.test:19000/--/verification-lure",
      "exp://192.168.1.20:8081",
      "exp://",
    ]) {
      expect(await trusted(url), url).toBe(false);
    }
  });

  it("keeps the app scheme, Expo web dev server and web origin", async () => {
    for (const url of [
      "rakazo://sign-in",
      "http://localhost:8081/sign-in",
      "https://app.example.test/sign-in",
    ]) {
      expect(await trusted(url), url).toBe(true);
    }
  });
});

describe("extra auth origins", () => {
  it("adds nothing by default", () => {
    expect(trustedRequestOrigins(env)).toEqual(
      trustedRequestOrigins({ ...env, extraAuthOrigins: [] }),
    );
    expect(isTrustedOrigin("https://host.tailnet.ts.net", env)).toBe(false);
  });

  it("trusts a configured extra origin for requests and sign-in callbacks", async () => {
    const extra = "https://host.tailnet.ts.net";
    expect(isTrustedOrigin(extra, { ...env, extraAuthOrigins: [extra] })).toBe(true);
    expect(
      isTrustedOrigin("https://other.tailnet.ts.net", { ...env, extraAuthOrigins: [extra] }),
    ).toBe(false);
  });

  it("trusts a loopback extra exactly, not its twins", () => {
    const withExtra = { ...env, extraAuthOrigins: ["http://localhost:6000"] };
    expect(isTrustedOrigin("http://localhost:6000", withExtra)).toBe(true);
    expect(isTrustedOrigin("http://127.0.0.1:6000", withExtra)).toBe(false);
    expect(isTrustedOrigin("http://[::1]:6000", withExtra)).toBe(false);
  });
});
