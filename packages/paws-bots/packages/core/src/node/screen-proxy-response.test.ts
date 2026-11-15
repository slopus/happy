import { describe, expect, it } from "vitest";
import {
  safeScreenProxyResponseHeaders,
  stripSensitiveHandshakeHeaders,
} from "./screen-proxy-response.js";

describe("screen proxy response isolation", () => {
  it("removes connection-specific headers before enforcing the screen sandbox", () => {
    const headers = safeScreenProxyResponseHeaders({
      Connection: [
        "keep-alive, Content-Security-Policy",
        "X-Upstream-Hop, Access-Control-Allow-Origin",
      ],
      "keep-alive": "timeout=5",
      "proxy-connection": "keep-alive",
      "proxy-authenticate": "Basic realm=screen",
      "proxy-authorization": "Basic fake-token",
      te: "trailers",
      trailer: "x-upstream-trailer",
      "transfer-encoding": "chunked",
      upgrade: "websocket",
      "X-Upstream-Hop": "private-hop-value",
      "content-security-policy": "sandbox allow-same-origin allow-scripts",
      "content-type": "text/html",
      "content-length": "123",
    });
    expect(headers).toEqual({
      "content-type": "text/html",
      "content-length": "123",
      "content-security-policy": ["sandbox allow-scripts allow-pointer-lock"],
      "access-control-allow-origin": "*",
      "cache-control": "no-transform",
    });
  });

  it.each(["text/html", "application/xhtml+xml", "image/svg+xml", "text/javascript", undefined])(
    "sandboxes every response, including direct navigation with content type %s",
    (contentType) => {
      const headers = safeScreenProxyResponseHeaders({ "content-type": contentType });
      expect(headers["content-security-policy"]).toEqual([
        "sandbox allow-scripts allow-pointer-lock",
      ]);
      expect(headers["access-control-allow-origin"]).toBe("*");
      expect(headers["cache-control"]).toBe("no-transform");
      expect(headers["content-type"]).toBe(contentType);
    },
  );

  it("retains upstream restrictions as separate policies that cannot loosen the sandbox", () => {
    const policies = [
      "sandbox allow-same-origin allow-scripts",
      "frame-ancestors https://app.example",
    ];
    expect(safeScreenProxyResponseHeaders({ "Content-Security-Policy": policies })).toEqual({
      "content-security-policy": [...policies, "sandbox allow-scripts allow-pointer-lock"],
      "access-control-allow-origin": "*",
      "cache-control": "no-transform",
    });
    expect(policies).toHaveLength(2);
    expect(
      safeScreenProxyResponseHeaders({ "content-security-policy": "script-src 'self'" })[
        "content-security-policy"
      ],
    ).toEqual(["script-src 'self'", "sandbox allow-scripts allow-pointer-lock"]);
  });

  it("preserves asset and framing headers while dropping origin mutations and pseudo-headers", () => {
    expect(
      safeScreenProxyResponseHeaders({
        ":status": "200",
        "content-type": "text/javascript",
        "content-encoding": "gzip",
        "cache-control": "max-age=3600",
        "x-frame-options": "SAMEORIGIN",
        "Set-Cookie": ["session=attacker"],
        "set-cookie2": "session=attacker",
        "Clear-Site-Data": '"cookies"',
        "access-control-allow-origin": "https://upstream.example",
      }),
    ).toEqual({
      "content-type": "text/javascript",
      "content-encoding": "gzip",
      "cache-control": "max-age=3600, no-transform",
      "x-frame-options": "SAMEORIGIN",
      "content-security-policy": ["sandbox allow-scripts allow-pointer-lock"],
      "access-control-allow-origin": "*",
    });
  });

  it("preserves WebSocket negotiation and bytes without accepting origin mutations", () => {
    const handshake = Buffer.from(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: fake-accept\r\nSet-Cookie: session=attacker\r\nClear-Site-Data: "cookies"\r\n\r\n\u0082\u0001x',
      "latin1",
    );
    expect(stripSensitiveHandshakeHeaders(handshake)?.toString("latin1")).toBe(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: fake-accept\r\n\r\n\u0082\u0001x",
    );
    expect(stripSensitiveHandshakeHeaders(Buffer.from("HTTP/1.1 101"))).toBeNull();
  });
});
