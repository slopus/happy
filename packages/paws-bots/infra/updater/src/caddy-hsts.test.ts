import { readFileSync } from "node:fs";
import path from "node:path";
import { COMPUTER_SCREEN_RUNTIME_PATH } from "@rakazo/contracts/content-security-policy";
import { describe, expect, it } from "vitest";

const composeDir = path.resolve(import.meta.dirname, "../../compose");
const caddyfiles = ["Caddyfile.prod", "Caddyfile.cloudflare.example"];

describe.each(caddyfiles)("%s HSTS", (filename) => {
  const config = readFileSync(path.join(composeDir, filename), "utf8");
  const httpsSite = config.slice(config.lastIndexOf("{$RAKAZO_HOST:app.example.com} {"));

  it("sends HSTS from the HTTPS site without preloading", () => {
    expect(httpsSite).toContain('header @hsts Strict-Transport-Security "max-age=31536000"');
    expect(config).not.toContain("preload");
  });

  it("never pins HTTPS onto localhost", () => {
    expect(httpsSite).toContain("@hsts not host localhost 127.0.0.1");
  });

  it("stops other sites framing the app and sniffing responses", () => {
    expect(httpsSite).toContain("X-Content-Type-Options nosniff");
    expect(httpsSite).toContain("header @framed X-Frame-Options SAMEORIGIN");
    expect(httpsSite).not.toContain("frame-ancestors 'none'");
  });

  it("keeps shared page links out of search results and Referer headers", () => {
    expect(httpsSite).toContain(
      '@sharedPage path /p/*\n\theader @sharedPage {\n\t\tX-Robots-Tag "noindex, nofollow"\n\t\tReferrer-Policy no-referrer\n\t}',
    );
  });

  it("lets the embedded screen frame its SDK runtime from an opaque origin", () => {
    expect(httpsSite).toContain(`@framed not path ${COMPUTER_SCREEN_RUNTIME_PATH}`);
    expect(httpsSite).not.toContain("not path /computer-screen/*");
  });

  it("replaces the client-supplied forwarding header on API and RPC requests", () => {
    expect(config).toMatch(
      /\(api\) \{\s*reverse_proxy \{[\s\S]*?header_up X-Forwarded-For \{client_ip\}\n/,
    );
    expect(httpsSite).toContain("handle @api {\n\t\timport api\n\t}");
    expect(config).not.toContain("{remote_host}");
  });
});
