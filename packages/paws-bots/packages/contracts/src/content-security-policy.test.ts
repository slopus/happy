import { describe, expect, it } from "vitest";
import {
  APP_CONTENT_SECURITY_POLICY,
  appContentSecurityPolicy,
  COMPUTER_SCREEN_PATH,
  COMPUTER_SCREEN_RUNTIME_PATH,
  CSP_REPORT_PATH,
  CSP_REPORTING_ENDPOINTS,
  contentSecurityPolicyFor,
  HTML_VIEWER_PATH,
  MCP_APP_VIEWER_PATH,
  parseContentSecuritySources,
  parseCrispWebsiteId,
} from "./content-security-policy.js";

function directives(policy: string) {
  return new Map(
    policy.split(";").map((part) => {
      const [name = "", ...sources] = part.trim().split(/\s+/);
      return [name, sources] as const;
    }),
  );
}

describe("app content security policy", () => {
  const policy = directives(APP_CONTENT_SECURITY_POLICY);

  it("runs only same-origin script files", () => {
    expect(policy.get("script-src")).toEqual(["'self'"]);
    expect(policy.get("default-src")).toEqual(["'self'"]);
    expect(APP_CONTENT_SECURITY_POLICY).not.toContain("'unsafe-eval'");
  });

  it("locks down plugins, base URLs, forms and framing of the app", () => {
    expect(policy.get("object-src")).toEqual(["'none'"]);
    expect(policy.get("base-uri")).toEqual(["'self'"]);
    expect(policy.get("form-action")).toEqual(["'self'"]);
    expect(policy.get("frame-ancestors")).toEqual(["'none'"]);
  });

  it("talks only to its own origin, which hosts the API, RPC, monitoring tunnel and screen proxy", () => {
    expect(policy.get("connect-src")).toEqual(["'self'"]);
    expect(policy.get("frame-src")).toEqual(["'self'", "blob:"]);
  });

  it("reports violations to the same-origin API endpoint with both mechanisms", () => {
    expect(CSP_REPORT_PATH).toBe("/api/csp-report");
    expect(policy.get("report-uri")).toEqual([CSP_REPORT_PATH]);
    expect(policy.get("report-to")).toEqual(["csp"]);
    expect(CSP_REPORTING_ENDPOINTS).toBe('csp="/api/csp-report"');
    // The endpoint sits under /api, which 'self' already allows and the edge routes to the API.
    expect(contentSecurityPolicyFor(CSP_REPORT_PATH)).toBeNull();
    const extended = directives(
      appContentSecurityPolicy({ connectSrc: ["https://x.example.com"] }),
    );
    expect(extended.get("report-uri")).toEqual([CSP_REPORT_PATH]);
    expect(extended.get("report-to")).toEqual(["csp"]);
  });

  it("does not apply to proxied responses that carry their own policy", () => {
    for (const path of ["/api", "/api/monitoring/tunnel", "/rpc/me", "/novnc/session/view/x"]) {
      expect(contentSecurityPolicyFor(path)).toBeNull();
    }
    expect(contentSecurityPolicyFor("/apiary")).toBe(APP_CONTENT_SECURITY_POLICY);
    expect(contentSecurityPolicyFor("/")).toBe(APP_CONTENT_SECURITY_POLICY);
    expect(contentSecurityPolicyFor("/bots/123")).toBe(APP_CONTENT_SECURITY_POLICY);
  });

  it("lets only the app frame the HTML viewer shell, whose own meta CSP governs it", () => {
    expect(contentSecurityPolicyFor(HTML_VIEWER_PATH)).toBe("frame-ancestors 'self'");
    expect(contentSecurityPolicyFor(MCP_APP_VIEWER_PATH)).toBe("frame-ancestors 'self'");
  });

  it("applies an injected screen policy only to embedded screen paths", () => {
    const policy = {
      screen: "default-src 'none'; sandbox allow-scripts; frame-ancestors 'self'",
      runtime: "default-src 'none'; sandbox allow-scripts",
    };
    const select = (path: string) => contentSecurityPolicyFor(path, undefined, policy);
    expect(select(COMPUTER_SCREEN_RUNTIME_PATH)).toBe(policy.runtime);
    for (const path of [
      COMPUTER_SCREEN_PATH,
      "/computer-screen/",
      "/computer-screen/other.html",
      `${COMPUTER_SCREEN_RUNTIME_PATH}/`,
      `${COMPUTER_SCREEN_RUNTIME_PATH}.extra`,
    ]) {
      expect(select(path)).toBe(policy.screen);
    }
    expect(select("/chat")).toBe(APP_CONTENT_SECURITY_POLICY);
    expect(select("/computer-screen-other")).toBe(APP_CONTENT_SECURITY_POLICY);
    expect(contentSecurityPolicyFor(COMPUTER_SCREEN_PATH)).toBe(
      "default-src 'none'; sandbox; frame-ancestors 'self'",
    );
    expect(contentSecurityPolicyFor(COMPUTER_SCREEN_RUNTIME_PATH)).toContain(
      "frame-ancestors 'self'",
    );
  });
});

describe("operator-added origins", () => {
  it("parses space- or comma-separated https origins, deduplicated and lowercased", () => {
    expect(parseContentSecuritySources("SETTING", undefined)).toEqual([]);
    expect(parseContentSecuritySources("SETTING", "  ")).toEqual([]);
    expect(
      parseContentSecuritySources(
        "SETTING",
        " https://static.example.com\nhttps://*.Example.net:8443,https://static.example.com ",
      ),
    ).toEqual(["https://static.example.com", "https://*.example.net:8443"]);
    expect(
      parseContentSecuritySources("SETTING", "https://localhost https://cdn.example.com:65535"),
    ).toEqual(["https://localhost", "https://cdn.example.com:65535"]);
  });

  it.each([
    "*",
    "'self'",
    "'unsafe-inline'",
    "'unsafe-eval'",
    "'strict-dynamic'",
    "'nonce-abc'",
    "'sha256-abc='",
    "data:",
    "blob:",
    "https:",
    "http:",
    "http://cdn.example.com",
    "wss://cdn.example.com",
    "cdn.example.com",
    "https://*",
    "https://*.com",
    "https://cdn.*.example.com",
    "https://cdn.example.com/",
    "https://cdn.example.com/beacon.js",
    "https://cdn.example.com?x=1",
    "https://user@cdn.example.com",
    "https://cdn.example.com:",
    "https://cdn.example.com:0",
    "https://cdn.example.com:65536",
    "https://cdn.example.com:99999",
    "https://-cdn.example.com",
    "https://cdn.example.com;script-src",
  ])("rejects %s and names the setting", (source) => {
    expect(() =>
      parseContentSecuritySources("RAKAZO_CSP_SCRIPT_SRC", `https://ok.example.com ${source}`),
    ).toThrow(/^RAKAZO_CSP_SCRIPT_SRC accepts only https:\/\/ origins.*Invalid: /);
  });

  it("adds them to script-src and connect-src only, after 'self'", () => {
    const extended = directives(
      appContentSecurityPolicy({
        scriptSrc: ["https://static.example.com"],
        connectSrc: ["https://beacon.example.com", "https://*.example.net"],
      }),
    );
    expect(extended.get("script-src")).toEqual(["'self'", "https://static.example.com"]);
    expect(extended.get("connect-src")).toEqual([
      "'self'",
      "https://beacon.example.com",
      "https://*.example.net",
    ]);
    const base = directives(APP_CONTENT_SECURITY_POLICY);
    for (const [name, sources] of base) {
      if (name !== "script-src" && name !== "connect-src")
        expect(extended.get(name)).toEqual(sources);
    }
    expect(appContentSecurityPolicy()).toBe(APP_CONTENT_SECURITY_POLICY);
  });

  it("serves the extended policy on app paths and leaves the others alone", () => {
    const extended = appContentSecurityPolicy({ scriptSrc: ["https://static.example.com"] });
    expect(contentSecurityPolicyFor("/", extended)).toBe(extended);
    expect(contentSecurityPolicyFor("/rpc/me", extended)).toBeNull();
    expect(contentSecurityPolicyFor(HTML_VIEWER_PATH, extended)).toBe("frame-ancestors 'self'");
  });
});

describe("Crisp chat widget", () => {
  it("adds Crisp's origins only when the deployment configures it", () => {
    const crisp = directives(
      appContentSecurityPolicy({ crisp: true, scriptSrc: ["https://static.example.com"] }),
    );
    expect(crisp.get("script-src")).toEqual([
      "'self'",
      "https://static.example.com",
      "https://client.crisp.chat",
    ]);
    expect(crisp.get("connect-src")).toContain("wss://client.relay.crisp.chat");
    expect(crisp.get("style-src")).toEqual([
      "'self'",
      "'unsafe-inline'",
      "https://client.crisp.chat",
    ]);
    expect(crisp.get("worker-src")).toEqual(["'self'", "blob:", "https://client.crisp.chat"]);
    expect(crisp.get("frame-ancestors")).toEqual(["'none'"]);
    expect(APP_CONTENT_SECURITY_POLICY).not.toContain("crisp");
  });

  it("accepts only a website ID", () => {
    expect(parseCrispWebsiteId(undefined)).toBeNull();
    expect(parseCrispWebsiteId(" ")).toBeNull();
    expect(parseCrispWebsiteId(" C2C27EA6-4FDB-4350-A9FC-4B5B052DC5EC ")).toBe(
      "c2c27ea6-4fdb-4350-a9fc-4b5b052dc5ec",
    );
    for (const value of ["nope", 'c2c27ea6-4fdb-4350-a9fc-4b5b052dc5ec"; alert(1)//']) {
      expect(() => parseCrispWebsiteId(value)).toThrow("CRISP_WEBSITE_ID");
    }
  });
});
